// The helpers that run action.yml's steps must not hand those steps the
// runner's own workflow-command files.
//
// runBashStep / runBashStepAsync used to start each step from `...process.env`,
// and runGithubScript ran in the test process with its env as it was. On a CI
// runner that env carries GITHUB_OUTPUT, GITHUB_ENV, GITHUB_PATH,
// GITHUB_STEP_SUMMARY and RUNNER_TEMP for the TEST job — so a step under test
// wrote its outputs into the real job's files, prepended to its PATH, and read
// GITHUB_EVENT_NAME=push from the test workflow. A test then passes or fails
// depending on where it runs, and a step can quietly set outputs on the job
// that is testing it.
//
// Each helper now starts from an environment with every GITHUB_*, RUNNER_* and
// ACTIONS_* variable removed; a test passes the ones it means explicitly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { runBashStep, runBashStepAsync, runGithubScript, fakeCore } from "./test-helpers/action-yaml.mjs";

const WORKFLOW_FILES = ["GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_STEP_SUMMARY", "GITHUB_STATE"];
const PLANTED_VALUES = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY: "planted/parent",
  RUNNER_DEBUG: "1",
  ACTIONS_RUNTIME_TOKEN: "planted-runtime-token",
};

let dir;
const saved = {};
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "isolation-"));
  // Plant the parent: what a CI runner's test job would carry.
  for (const k of [...WORKFLOW_FILES, "RUNNER_TEMP", ...Object.keys(PLANTED_VALUES)]) saved[k] = process.env[k];
  for (const k of WORKFLOW_FILES) {
    const f = path.join(dir, `parent-${k}`);
    fs.writeFileSync(f, "");
    process.env[k] = f;
  }
  fs.mkdirSync(path.join(dir, "parent-temp"));
  process.env.RUNNER_TEMP = path.join(dir, "parent-temp");
  Object.assign(process.env, PLANTED_VALUES);
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const parentFilesUntouched = () => {
  for (const k of WORKFLOW_FILES) {
    assert.equal(fs.readFileSync(path.join(dir, `parent-${k}`), "utf8"), "", `a step wrote into the parent's ${k}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, "parent-temp")), [], "a step wrote into the parent's RUNNER_TEMP");
};

// What a step does with the workflow-command files when they are set, and
// what it saw of the runner's identity.
const SCRIPT = `
for f in GITHUB_OUTPUT GITHUB_ENV GITHUB_PATH GITHUB_STEP_SUMMARY GITHUB_STATE; do
  eval "target=\\\${$f:-}"
  if [ -n "$target" ]; then echo "leaked=1" >> "$target"; fi
done
if [ -n "\${RUNNER_TEMP:-}" ]; then : > "$RUNNER_TEMP/leaked"; fi
echo "event=\${GITHUB_EVENT_NAME:-unset} repo=\${GITHUB_REPOSITORY:-unset} debug=\${RUNNER_DEBUG:-unset} token=\${ACTIONS_RUNTIME_TOKEN:-unset}"
`;

describe("the step runners start from a clean environment", () => {
  test("runBashStep: no parent GITHUB_*/RUNNER_*/ACTIONS_* reaches the step", () => {
    const r = runBashStep(SCRIPT);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /event=unset repo=unset debug=unset token=unset/);
    parentFilesUntouched();
  });

  test("runBashStepAsync: the same", async () => {
    const r = await runBashStepAsync(SCRIPT);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /event=unset repo=unset debug=unset token=unset/);
    parentFilesUntouched();
  });

  test("an output the test passes explicitly lands in the test's own file, never the parent's", () => {
    const own = path.join(dir, "own-output");
    fs.writeFileSync(own, "");
    const r = runBashStep('echo "verdict=pass" >> "$GITHUB_OUTPUT"', { env: { GITHUB_OUTPUT: own } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(own, "utf8"), "verdict=pass\n");
    parentFilesUntouched();
  });

  test("runGithubScript: the script sees none of the parent's runner variables, and they come back after", async () => {
    const { core } = fakeCore();
    const serverUrlBefore = process.env.GITHUB_SERVER_URL;
    const seen = await runGithubScript(
      `return {
         event: process.env.GITHUB_EVENT_NAME, out: process.env.GITHUB_OUTPUT,
         temp: process.env.RUNNER_TEMP, token: process.env.ACTIONS_RUNTIME_TOKEN,
         mine: process.env.GITHUB_SERVER_URL,
       };`,
      { core, github: {}, context: {}, env: { GITHUB_SERVER_URL: "https://example.test" } },
    );
    assert.deepEqual(seen, { event: undefined, out: undefined, temp: undefined, token: undefined, mine: "https://example.test" });
    assert.equal(process.env.GITHUB_EVENT_NAME, "push", "the parent's environment is restored afterwards");
    assert.equal(process.env.GITHUB_OUTPUT, path.join(dir, "parent-GITHUB_OUTPUT"));
    assert.equal(process.env.GITHUB_SERVER_URL, serverUrlBefore, "a variable the test passed does not outlive the run");
    parentFilesUntouched();
  });
});
