// The "Fetch review settings" step, run for real (bash, through the YAML
// parser) with settings.mjs stood in by a stub that writes a chosen file.
//
// What is pinned here is what the step does when the dashboard does not answer.
//
// The first cut of the CR-16 fix escalated an unreadable block_on to every
// severity. An ordinary (non-CI) key gets a 403 from the settings endpoint on
// EVERY run, so that blocked on P0-P3 forever for every such customer. Now a
// failed fetch never escalates past the workflow:
//   - a 4xx (or success:false) means "this key has no dashboard settings": the
//     workflow's inputs are authoritative, exactly as with `settings: "false"`,
//     and a notice says why;
//   - a 5xx, a timeout or a network failure does the same, with a warning
//     naming the cause. The hole CR-16 was about — an outage loosening a
//     stricter dashboard block_on — is closed by the workflow, not by guessing:
//     its `block-on` is the outage floor (documented), and the outage path
//     never goes below it;
//   - a dashboard that answered but with an invalid block_on uses the
//     workflow's block-on for that field.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import http from "node:http";

import { step, runBashStep, runBashStepAsync, ROOT } from "./test-helpers/action-yaml.mjs";

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
function runSettings({ written, inputBlockOn = "P0,P1", inputFixFirst = "P0,P1", extraEnv = {} }) {
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
      INPUT_FIX_FIRST: inputFixFirst,
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

// What `settings: "false"` writes: the workflow's inputs, the dashboard's
// switches at their documented defaults, every severity displayed.
const workflowAuthoritative = (blockOn, fixFirst = "P0,P1") => ({
  auto_review: "true",
  trigger: "every_push",
  exhaustive: "false",
  quiet: "false",
  fix_first: fixFirst,
  block_on: blockOn,
  report_on: "P0,P1,P2,P3",
  rubric_file: "",
  decision: "review",
  reason: "",
});

describe("a reachable dashboard", () => {
  test("its stricter block_on is used", () => {
    const { outputs } = runSettings({ written: { ...DEFAULTS, block_on: "P0,P1,P2" } });
    assert.equal(outputs.block_on, "P0,P1,P2");
  });

  test("it may still say 'block on nothing'", () => {
    const { outputs } = runSettings({ written: { ...DEFAULTS, block_on: "" } });
    assert.equal(outputs.block_on, "");
  });

  test("an invalid block_on from it -> the workflow's block-on, with a warning", () => {
    const { outputs, log } = runSettings({ written: { ...DEFAULTS, unresolved: ["block_on"] }, inputBlockOn: "P0,P1" });
    assert.equal(outputs.block_on, "P0,P1");
    assert.match(log, /::warning::.*block_on/);
  });

  test("an unrelated field falling back leaves block_on as the dashboard said", () => {
    const { outputs } = runSettings({ written: { ...DEFAULTS, block_on: "P0", unresolved: ["rubric"] } });
    assert.equal(outputs.block_on, "P0");
  });
});

describe("no dashboard settings for this key (4xx): the workflow's inputs, as with settings: false", () => {
  for (const blockOn of ["P0,P1", "P0", "P0,P1,P2", ""]) {
    test(`block-on ${JSON.stringify(blockOn)} -> exactly the settings: "false" outputs, and a notice`, () => {
      const { outputs, log } = runSettings({
        written: { ...DEFAULTS, unresolved: ALL, status: "no_settings", cause: "HTTP 403" },
        inputBlockOn: blockOn,
      });
      assert.deepEqual(outputs, workflowAuthoritative(blockOn));
      assert.match(log, /::notice::.*HTTP 403/);
      assert.doesNotMatch(log, /P0,P1,P2,P3.*block/i, "a 4xx never escalates the gate");
    });
  }
});

describe("the dashboard could not be read (outage): the workflow's inputs, never more", () => {
  for (const cause of ["HTTP 500", "timed out after 5000ms", "network error (ECONNREFUSED)"]) {
    test(`${cause} -> the workflow's inputs, with a warning naming the cause`, () => {
      const { outputs, log } = runSettings({
        written: { ...DEFAULTS, unresolved: ALL, status: "unavailable", cause },
        inputBlockOn: "P0,P1",
        inputFixFirst: "P0",
      });
      assert.deepEqual(outputs, workflowAuthoritative("P0,P1", "P0"));
      assert.ok(log.includes(`::warning::`) && log.includes(cause), log);
      assert.match(log, /block-on/, "the warning says the workflow's block-on is the outage floor");
    });
  }

  test("no settings file at all (settings.mjs died) -> the workflow's inputs, with a warning", () => {
    const { outputs, log } = runSettings({ written: null, inputBlockOn: "P0" });
    assert.deepEqual(outputs, workflowAuthoritative("P0"));
    assert.match(log, /::warning::/);
  });
});

// The step and the real settings.mjs together, against a gateway double.
describe("end to end: the real settings fetch answering 403, 404, 500, or never", () => {
  async function gateway(mode) {
    const hung = [];
    const server = http.createServer((req, res) => {
      if (mode === "hang") return void hung.push(res);
      res.writeHead(mode, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "x" }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return {
      port: server.address().port,
      close: () => {
        for (const res of hung) res.destroy();
        return new Promise((r) => server.close(r));
      },
    };
  }

  for (const [mode, kind, cause] of [
    [403, "notice", /HTTP 403/],
    [404, "notice", /HTTP 404/],
    [500, "warning", /HTTP 500/],
    ["hang", "warning", /timed out/],
  ]) {
    test(`${mode} -> the workflow's block-on and inputs (${kind} names the cause)`, async () => {
      const gw = await gateway(mode);
      n += 1;
      const out = path.join(dir, `e2e-out-${n}`);
      fs.writeFileSync(out, "");
      try {
        const r = await runBashStepAsync(step("settings").run, {
          env: {
            SETTINGS_SCRIPT: path.join(ROOT, "scripts", "settings.mjs"),
            SETTINGS_ENABLED: "true",
            ORCAROUTER_URL: `http://127.0.0.1:${gw.port}/v1/chat/completions`,
            ORCAROUTER_API_KEY: "k",
            CR_SETTINGS_TIMEOUT_MS: "200",
            REPO: "o/r",
            SETTINGS_JSON: path.join(dir, `e2e-${n}.json`),
            RUBRIC_FILE: path.join(dir, `e2e-rubric-${n}.md`),
            INPUT_FIX_FIRST: "P0,P1",
            INPUT_BLOCK_ON: "P0",
            EVENT_NAME: "pull_request_target",
            IS_DRAFT: "false",
            AUTHOR_ASSOC: "OWNER",
            AUTO_REVIEW_AUTHORS: "",
            REPO_PRIVATE: "true",
            BRAND: "OrcaCode Review",
            GITHUB_OUTPUT: out,
          },
        });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const outputs = Object.fromEntries(
          fs.readFileSync(out, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
        );
        assert.deepEqual(outputs, workflowAuthoritative("P0"));
        const line = (r.stdout + r.stderr).split("\n").find((l) => l.startsWith(`::${kind}::`) && cause.test(l));
        assert.ok(line, `no ::${kind}:: naming the cause in:\n${r.stdout}${r.stderr}`);
      } finally {
        await gw.close();
      }
    });
  }
});
