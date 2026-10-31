// The "Fetch review settings" step, run for real (bash, through the YAML
// parser) with settings.mjs stood in by a stub that writes a chosen file.
//
// What is pinned here is the merge gate's FAIL DIRECTION when the dashboard
// cannot be read. block_on's built-in default (P0,P1) is looser than plenty of
// dashboard values it may stand in for, so a settings outage used to replace a
// stricter dashboard policy with P0,P1 — silently. Now:
//   - an explicit `block-on:` in the workflow is authoritative, outage or not;
//   - a workflow that defers to the dashboard (block-on left at its default)
//     blocks on EVERY severity while the dashboard's value is unknown, so an
//     outage can only tighten the gate, never loosen it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { step, runBashStep } from "./test-helpers/action-yaml.mjs";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-wiring-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const DEFAULTS = {
  auto_review: true,
  trigger: "every_push",
  exhaustive: false,
  quiet: false,
  fix_first: "P0,P1",
  block_on: "P0,P1",
  report_on: "P0,P1",
  rubric: "",
};

let n = 0;
// Runs the step with a stub settings.mjs that writes `written` (an object, or
// null to write nothing at all — settings.mjs died before its --out write).
function runSettings({ written, inputBlockOn = "P0,P1", extraEnv = {} }) {
  n += 1;
  const stubScript = path.join(dir, `settings-${n}.mjs`);
  const json = path.join(dir, `settings-${n}.json`);
  const out = path.join(dir, `out-${n}`);
  fs.writeFileSync(out, "");
  fs.writeFileSync(
    stubScript,
    written === null
      ? "process.exit(0);\n"
      : `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(json)}, ${JSON.stringify(JSON.stringify(written))});\n`,
  );
  const r = runBashStep(step("settings").run, {
    env: {
      SETTINGS_SCRIPT: stubScript,
      SETTINGS_ENABLED: "true",
      ORCAROUTER_URL: "http://127.0.0.1:9/v1/chat/completions",
      ORCAROUTER_API_KEY: "k",
      REPO: "o/r",
      SETTINGS_JSON: json,
      RUBRIC_FILE: path.join(dir, `rubric-${n}.md`),
      INPUT_FIX_FIRST: "P0,P1",
      INPUT_BLOCK_ON: inputBlockOn,
      EVENT_NAME: "pull_request_target",
      IS_DRAFT: "false",
      AUTHOR_ASSOC: "OWNER",
      AUTO_REVIEW_AUTHORS: "",
      REPO_PRIVATE: "true",
      GITHUB_OUTPUT: out,
      ...extraEnv,
    },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const outputs = Object.fromEntries(
    fs
      .readFileSync(out, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { outputs, log: r.stdout + r.stderr };
}

const ALL = Object.keys(DEFAULTS);

describe("settings outage never loosens block_on", () => {
  test("a reachable dashboard's stricter block_on is used", () => {
    const { outputs } = runSettings({ written: { ...DEFAULTS, block_on: "P0,P1,P2" } });
    assert.equal(outputs.block_on, "P0,P1,P2");
  });

  test("a reachable dashboard may still say 'block on nothing'", () => {
    const { outputs } = runSettings({ written: { ...DEFAULTS, block_on: "" } });
    assert.equal(outputs.block_on, "");
  });

  test("outage + workflow deferring to the dashboard -> block on every severity, loudly", () => {
    const { outputs, log } = runSettings({ written: { ...DEFAULTS, unresolved: ALL } });
    assert.equal(outputs.block_on, "P0,P1,P2,P3");
    assert.match(log, /::warning::.*(could not|unavailable|unreachable)/i);
  });

  test("outage + an explicit workflow block-on -> the workflow's value", () => {
    const { outputs } = runSettings({ written: { ...DEFAULTS, unresolved: ALL }, inputBlockOn: "P0" });
    assert.equal(outputs.block_on, "P0");
  });

  test("an invalid block_on from the server is treated like an outage for that field", () => {
    const { outputs } = runSettings({ written: { ...DEFAULTS, unresolved: ["block_on"] } });
    assert.equal(outputs.block_on, "P0,P1,P2,P3");
  });

  test("an unrelated field falling back leaves block_on as the dashboard said", () => {
    const { outputs } = runSettings({ written: { ...DEFAULTS, block_on: "P0", unresolved: ["rubric"] } });
    assert.equal(outputs.block_on, "P0");
  });

  test("no settings file at all (settings.mjs died) -> every severity, never the P0,P1 fallback", () => {
    const { outputs } = runSettings({ written: null });
    assert.equal(outputs.block_on, "P0,P1,P2,P3");
  });
});
