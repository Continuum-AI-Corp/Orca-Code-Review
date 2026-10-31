// The Review step, run for real: action.yml's own bash (through the YAML
// parser, with its env: block resolved the way the runner resolves it), the
// real fact-proxy, and a stand-in `ocr` that behaves like a hostile engine.
//
// What the engine can see is the point. It reads the fork's files and follows
// the instructions in them as well as any LLM agent does, so whatever is in its
// environment, its parent's, or reachable through a symlink in the checkout is
// one prompt injection away from being quoted in a PR comment.

import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

import { step } from "./test-helpers/action-yaml.mjs";
import { REAL_KEY, makeRepo, runReview, cleanupReviewHarness } from "./test-helpers/review-harness.mjs";

after(cleanupReviewHarness);

describe("the engine never holds the real OrcaRouter key", () => {
  test("the Review step's env: names no secret input", () => {
    const env = step("review").env;
    for (const [k, v] of Object.entries(env)) {
      assert.doesNotMatch(String(v), /inputs\.orcarouter-api-key|inputs\.github-token|secrets\./, `Review env ${k}`);
    }
    assert.doesNotMatch(String(env.OCR_LLM_TOKEN), /\$\{\{/, "OCR_LLM_TOKEN must be a literal placeholder");
  });

  test("the engine sees a placeholder, the gateway gets the real key, and no process exposes it", async () => {
    const { repo, sha } = makeRepo("key", (d) => fs.writeFileSync(path.join(d, "app.js"), "export const a = 2;\n"));
    const { r, seen, upstream, temp } = await runReview({ repo, sha });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(seen, "the engine stand-in never ran");

    assert.notEqual(seen.env.OCR_LLM_TOKEN, REAL_KEY);
    for (const [k, v] of Object.entries(seen.env)) {
      assert.ok(!String(v).includes(REAL_KEY), `the engine's env carries the key in ${k}`);
    }
    if (seen.proc.length) {
      assert.ok(
        !seen.proc.some((t) => t.includes(REAL_KEY)),
        "some /proc/<pid>/environ or cmdline the engine can read carries the key",
      );
    }

    assert.equal(seen.call, 200, "the engine's call through the proxy failed");
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].headers.authorization, `Bearer ${REAL_KEY}`);

    assert.deepEqual(
      fs
        .readdirSync(temp)
        .filter((f) => fs.statSync(path.join(temp, f)).isFile())
        .filter((f) => fs.readFileSync(path.join(temp, f), "latin1").includes(REAL_KEY)),
      [],
      "a file under RUNNER_TEMP still holds the key after the proxy started",
    );
  });
});

describe("the engine sees no symlink and no PR-controlled config", () => {
  test("tracked and untracked symlinks are gone before the engine starts", async () => {
    const { repo, sha } = makeRepo("links", (d) => {
      fs.symlinkSync("/proc/self/environ", path.join(d, "notes.md"));
      fs.mkdirSync(path.join(d, ".opencodereview"));
      fs.writeFileSync(path.join(d, ".opencodereview", "rule.json"), '{"exclude":["**"]}');
    });
    fs.symlinkSync("/root", path.join(repo, "untracked-link"));
    const { r, seen } = await runReview({ repo, sha });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(seen.symlinks, []);
    assert.equal(fs.existsSync(path.join(repo, ".opencodereview")), false);
  });
});

describe("action.yml: the checkout is hardened before anything reads it", () => {
  test("a Harden step runs after the PR-head fetch and before the size guard", async () => {
    const { actionSteps } = await import("./test-helpers/action-yaml.mjs");
    const names = actionSteps().map((s) => s.id || s.name);
    const fetch = names.indexOf("Fetch PR head (covers fork PRs)");
    const harden = names.indexOf("harden");
    const guard = names.indexOf("guard");
    assert.ok(harden > fetch && harden < guard, `order: fetch=${fetch} harden=${harden} guard=${guard}`);
    assert.match(step("harden").run, /harden-checkout\.mjs|\$HARDEN/);
    assert.match(step("harden").run, /excluded-files\.mjs|\$EXCLUDED/);
  });

  test("the summary is handed the list of skipped files", async () => {
    const script = step("Summary (PR description)").with.script;
    assert.match(script, /--excluded/);
    assert.ok(step("Summary (PR description)").env.EXCLUDED_FILE, "the summary step needs EXCLUDED_FILE");
  });
});
