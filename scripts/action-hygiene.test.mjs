// Hygiene invariants for action.yml's own scripts: what GitHub writes into the
// step script on disk, and what a credential may appear in.
//
// GitHub expands every `${{ … }}` in a `run:` (and in a github-script
// `script:`) BEFORE the shell or node sees it — comments included, since the
// expander does not know bash. A comment that merely NAMES `${{ github.token }}`
// therefore writes the live token into the step script under $RUNNER_TEMP. So
// the rule is absolute: expressions reach code only through `env:`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { actionSteps, step, shellCommentLines, runBashStep, stub } from "./test-helpers/action-yaml.mjs";

const bodyOf = (s) => s.run ?? s.with?.script ?? "";

describe("action.yml: no ${{ }} expression inside step code", () => {
  test("no comment line of any run: script carries ${{", () => {
    const offenders = [];
    for (const s of actionSteps()) {
      if (!s.run) continue;
      for (const { n, line } of shellCommentLines(s.run)) {
        if (line.includes("${{")) offenders.push(`${s.name || s.id}: line ${n}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, [], "a comment naming an expression gets it expanded onto disk");
  });

  test("no run: or script: body carries ${{ at all — expressions arrive through env:", () => {
    const steps = actionSteps().filter((s) => bodyOf(s));
    assert.ok(steps.length > 10, "the parser found almost no step bodies — is this test hollow?");
    const offenders = steps.filter((s) => bodyOf(s).includes("${{")).map((s) => s.name || s.id);
    assert.deepEqual(offenders, []);
  });
});

describe("action.yml: the PR-head fetch keeps the token off argv", () => {
  const TOKEN = "ghs_FAKEtoken0123456789abcdefABCDEF";

  function runFetch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-step-"));
    try {
      const log = path.join(dir, "git.log");
      // The stub records argv one per line, then every GIT_CONFIG_* variable
      // and the whole environment, so the test can tell where the header went.
      stub(
        dir,
        "git",
        `{ echo "ARGV"; for a in "$@"; do printf '%s\\n' "$a"; done; echo "ENV"; env | grep '^GIT_CONFIG_' | sort; } >> "${log}"`,
      );
      const r = runBashStep(step("Fetch PR head (covers fork PRs)").run, {
        env: { GH_TOKEN: TOKEN, PR_NUMBER: "42", GITHUB_SERVER_URL: "https://github.com" },
        stubDir: dir,
      });
      assert.equal(r.status, 0, r.stderr);
      return fs.readFileSync(log, "utf8");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("git's argv holds neither the token nor its Basic-auth encoding", () => {
    const out = runFetch();
    const argv = out.slice(out.indexOf("ARGV"), out.indexOf("ENV"));
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    assert.ok(argv.includes("fetch"), "the stub never saw a fetch — is the test hollow?");
    assert.ok(!argv.includes(TOKEN), "the raw token is on git's command line");
    assert.ok(!argv.includes(basic), "the encoded token is on git's command line");
    assert.ok(!/extraheader/i.test(argv), "an extraheader is still passed with -c");
  });

  test("the auth header travels in GIT_CONFIG_* env, scoped to the server", () => {
    const out = runFetch();
    const env = out.slice(out.indexOf("ENV"));
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    assert.match(env, /^GIT_CONFIG_COUNT=1$/m);
    assert.match(env, /^GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader$/m);
    assert.ok(env.includes(`GIT_CONFIG_VALUE_0=AUTHORIZATION: basic ${basic}`), env);
  });
});
