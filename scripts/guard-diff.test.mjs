// The diff the oversized-diff guard measures, and the lockfiles it leaves out.
//
// The checkout hardening writes `* !diff` so a fork's `.gitattributes` cannot
// turn its change into "Binary files differ". That also took away what most
// repositories mark `-diff` on purpose: their lockfiles. A PR bumping one
// dependency regenerates package-lock.json or go.sum, and the whole lockfile
// diff — megabytes — now counted toward max-diff-kb, so ordinary PRs started
// skipping (and, by default, failing) on size.
//
// The guard now measures the merge-base diff WITHOUT files whose name is a
// standard lockfile's (by name, not by any attribute a PR could set — leaving a
// file out of the count can only make the guard review MORE). The engine still
// reads the hardened checkout's full diff. The lockfiles left out are listed in
// the PR summary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

import { step, runBashStep, ROOT } from "./test-helpers/action-yaml.mjs";
import { makeRepo, cleanupReviewHarness } from "./test-helpers/review-harness.mjs";
import { LOCKFILE_NAMES } from "./guard-diff.mjs";

after(cleanupReviewHarness);

const big = (kb) => `${"x".repeat(1023)}\n`.repeat(kb);

function prWithLockfiles(name) {
  return makeRepo(name, (repo) => {
    fs.writeFileSync(path.join(repo, "app.js"), "export const a = 2;\n");
    fs.writeFileSync(path.join(repo, "package-lock.json"), big(6000)); // over the 5000 KB default alone
    fs.mkdirSync(path.join(repo, "web"));
    fs.writeFileSync(path.join(repo, "web", "yarn.lock"), big(300));
    fs.writeFileSync(path.join(repo, "Cargo.lock"), "lock\n");
    // Look-alikes are counted: the match is the exact file name.
    fs.writeFileSync(path.join(repo, "package-lock.json.bak"), "bak\n");
    fs.writeFileSync(path.join(repo, "my-go.sum"), "sum\n");
    // A repository that marked its lockfile -diff, as many do.
    fs.writeFileSync(path.join(repo, ".gitattributes"), "package-lock.json -diff\n");
  });
}

describe("the standard lockfile names", () => {
  test("are exactly these", () => {
    assert.deepEqual(
      [...LOCKFILE_NAMES].sort(),
      ["Cargo.lock", "Gemfile.lock", "bun.lockb", "composer.lock", "go.sum", "package-lock.json", "pnpm-lock.yaml", "poetry.lock", "yarn.lock"],
    );
  });
});

function runGuardStep(repo, sha, { maxKb = "5000" } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-step-"));
  const out = path.join(temp, "out");
  fs.writeFileSync(out, "");
  const harden = runBashStep(step("harden").run, {
    cwd: repo,
    env: {
      HARDEN: path.join(ROOT, "scripts", "harden-checkout.mjs"),
      EXCLUDED: path.join(ROOT, "scripts", "excluded-files.mjs"),
      BASE: "origin/main",
      HEAD: sha,
      EXCLUDED_FILE: path.join(temp, "cr-excluded.json"),
      GITHUB_OUTPUT: out,
    },
  });
  assert.equal(harden.status, 0, harden.stderr);
  const r = runBashStep(step("guard").run, {
    cwd: repo,
    env: {
      BRAND: "OrcaCode Review",
      BASE: "origin/main",
      HEAD: sha,
      GUARD: path.join(ROOT, "scripts", "diff-guard.mjs"),
      GUARD_DIFF: path.join(ROOT, "scripts", "guard-diff.mjs"),
      MAX_KB: maxKb,
      MAX_FILES: "2000",
      DIFF_FILE: path.join(temp, "pr.diff"),
      GUARD_JSON: path.join(temp, "diff-guard.json"),
      LOCKFILES_FILE: path.join(temp, "cr-lockfiles.json"),
      GITHUB_OUTPUT: out,
    },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const outputs = Object.fromEntries(
    fs.readFileSync(out, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { outputs, temp, log: r.stdout + r.stderr };
}

describe("the guard step on a hardened checkout", () => {
  test("a PR whose only large change is a lockfile is reviewed, not skipped", () => {
    const { repo, sha } = prWithLockfiles("big-lockfile");
    const { outputs, temp } = runGuardStep(repo, sha);
    assert.equal(outputs.decision, "review", outputs.reason);
    const diff = fs.readFileSync(path.join(temp, "pr.diff"), "utf8");
    assert.match(diff, /^diff --git a\/app\.js /m);
    assert.match(diff, /^diff --git a\/package-lock\.json\.bak /m, "a look-alike name still counts");
    assert.match(diff, /^diff --git a\/my-go\.sum /m);
    assert.doesNotMatch(diff, /^diff --git a\/(package-lock\.json|web\/yarn\.lock|Cargo\.lock) /m);
  });

  test("the lockfiles left out are written down, for the summary", () => {
    const { repo, sha } = prWithLockfiles("listed");
    const { temp, outputs } = runGuardStep(repo, sha);
    const listed = JSON.parse(fs.readFileSync(path.join(temp, "cr-lockfiles.json"), "utf8"));
    assert.deepEqual(listed.lockfiles, ["Cargo.lock", "package-lock.json", "web/yarn.lock"]);
    assert.equal(outputs.lockfiles, "3");
  });

  test("everything else still counts: a large non-lockfile change skips as before", () => {
    const { repo, sha } = makeRepo("big-code", (r) => fs.writeFileSync(path.join(r, "gen.js"), big(6000)));
    assert.equal(runGuardStep(repo, sha).outputs.decision, "skip");
  });

  test("the engine's view is untouched: the checkout keeps `* !diff`, and the full diff shows the lockfile", () => {
    const { repo, sha } = prWithLockfiles("engine-view");
    runGuardStep(repo, sha);
    const attrs = fs.readFileSync(path.join(repo, ".git", "info", "attributes"), "utf8");
    assert.match(attrs, /^\* !diff$/m);
    const full = spawnSync("git", ["diff", "--stat", "origin/main", sha], { cwd: repo, encoding: "utf8" }).stdout;
    assert.match(full, /package-lock\.json\s+\|\s+6000 \+/, "the engine-side diff still carries the lockfile's lines");
    const engine = step("review").run.match(/ocr review --from[\s\S]*?--format json/);
    assert.ok(engine, "the engine invocation moved");
    assert.doesNotMatch(engine[0], /:\(|\s--\s|lock/i, "the engine's diff takes no exclusions");
  });

  test("an unreadable range fails open to an empty diff (review), with a warning", () => {
    const { repo } = makeRepo("no-range");
    const { outputs, log } = runGuardStep(repo, "0000000000000000000000000000000000000000");
    assert.equal(outputs.decision, "review");
    assert.match(log, /::warning::/);
  });
});

describe("the summary lists the lockfiles left out of the size count", () => {
  const summary = (lockfiles) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-lock-"));
    const result = path.join(dir, "r.json");
    fs.writeFileSync(result, JSON.stringify({ comments: [] }));
    const lf = path.join(dir, "lf.json");
    fs.writeFileSync(lf, JSON.stringify({ lockfiles }));
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "summary-comment.mjs"), result, "--tier", "standard", "--push", "1", "--gate", "pass", "--lockfiles", lf], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };

  test("each, as a code span that cannot break out", () => {
    const md = summary(["package-lock.json", "web/yarn.lock", "evil`|\n## x/go.sum"]);
    assert.match(md, /not counted toward the diff-size limit/i);
    assert.match(md, /`package-lock\.json`/);
    assert.match(md, /`web\/yarn\.lock`/);
    assert.doesNotMatch(md, /^## x/m);
  });

  test("nothing when there are none", () => {
    assert.doesNotMatch(summary([]), /not counted toward/i);
  });

  test("the summary step hands it the list, and the run files are cleared", () => {
    const s = step("Summary (PR description)");
    assert.equal(s.env.LOCKFILES_FILE, "${{ runner.temp }}/cr-lockfiles.json");
    assert.match(s.with.script, /'--lockfiles', process\.env\.LOCKFILES_FILE/);
    for (const name of ["Clear stale run files", "Clean up engine output"]) {
      assert.match(step(name).run, /"\$RUNNER_TEMP\/cr-lockfiles\.json"/, name);
    }
  });
});
