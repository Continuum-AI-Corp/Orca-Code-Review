// How action.yml READS gate.mjs's verdict.
//
// gate.mjs answers with distinct exit codes (0 = a blocking finding, 10 = none,
// anything else = it could not decide). Every step that turns that into a merge
// decision must take only those two codes as answers and fail closed on the
// rest — a crash (node exits 1), an unreadable result (3) or a killed process
// (137) is not evidence of a clean review. Before this, the enforce step read
// "any non-zero exit" as "gate passed".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { step, runBashStep, runGithubScript, fakeCore, ROOT } from "./test-helpers/action-yaml.mjs";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-wiring-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// A stand-in gate.mjs that exits with whatever STUB_RC says.
function stubGate(rc) {
  const file = path.join(dir, `gate-${rc}.mjs`);
  fs.writeFileSync(file, `process.exit(${rc});\n`);
  return file;
}

const RESULT = () => {
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify({ comments: [] }));
  return file;
};

describe("Enforce severity gate", () => {
  const run = (gate, result = RESULT()) =>
    runBashStep(step("Enforce severity gate").run, {
      env: { BRAND: "OrcaCode Review", BLOCK_ON: "P0,P1", GATE: gate, RESULT: result },
    });

  test("exit 0 (a blocking finding) fails the step", () => {
    assert.notEqual(run(stubGate(0)).status, 0);
  });

  test("exit 10 (no blocking finding) passes", () => {
    const r = run(stubGate(10));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  for (const rc of [1, 2, 3, 137]) {
    test(`exit ${rc} (the gate could not decide) fails closed`, () => {
      const r = run(stubGate(rc));
      assert.notEqual(r.status, 0, `rc=${rc} passed the merge gate`);
      assert.match(r.stdout + r.stderr, /could not (decide|read)/i);
    });
  }

  test("the real gate on an unreadable result fails the step", () => {
    const r = run(path.join(ROOT, "scripts", "gate.mjs"), path.join(dir, "missing.json"));
    assert.notEqual(r.status, 0);
  });

  test("the real gate on a clean result passes the step", () => {
    const r = run(path.join(ROOT, "scripts", "gate.mjs"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe("Report run", () => {
  function report(rc) {
    const log = path.join(dir, `report-${rc}.log`);
    const stubReport = path.join(dir, "report.mjs");
    fs.writeFileSync(
      stubReport,
      `import fs from "node:fs";\nfs.writeFileSync(process.env.LOG, process.argv.slice(2).join(" "));\n`,
    );
    const r = runBashStep(step("Report run").run, {
      env: {
        REPORT: stubReport,
        GATE: stubGate(rc),
        RESULT_FINAL: RESULT(),
        BLOCK_ON: "P0,P1",
        REPO: "o/r",
        PR_NUMBER: "1",
        HEAD_SHA: "abc",
        ORCAROUTER_URL: "http://127.0.0.1:9/v1/chat/completions",
        ORCAROUTER_API_KEY: "k",
        ENGINE_VERSION: "1.3.13",
        LOG: log,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(log, "utf8");
  }

  test("only exit 10 reports a pass", () => {
    assert.match(report(10), /--gate pass/);
  });

  for (const rc of [0, 1, 3]) {
    test(`exit ${rc} reports blocked, never pass`, () => {
      assert.match(report(rc), /--gate blocked/);
    });
  }
});

describe("Summary (PR description)", () => {
  async function summaryGate(rc) {
    const summaryStub = path.join(dir, "summary.mjs");
    fs.writeFileSync(summaryStub, "process.stdout.write('ARGS ' + process.argv.slice(2).join(' '));\n");
    const result = path.join(dir, "reported.json");
    fs.writeFileSync(result, JSON.stringify({ comments: [] }));
    let updated = null;
    const github = {
      paginate: async () => [],
      rest: {
        issues: { listComments: () => {}, deleteComment: async () => {} },
        pulls: {
          get: async () => ({ data: { body: "author text" } }),
          update: async (args) => {
            updated = args.body;
          },
        },
      },
    };
    const { core } = fakeCore();
    await runGithubScript(step("Summary (PR description)").with.script, {
      github,
      core,
      context: { repo: { owner: "o", repo: "r" }, payload: {} },
      env: {
        PR_NUMBER: "1",
        RESULT: result,
        PREV_BODY: path.join(dir, "prev.md"),
        SUMMARY_SCRIPT: summaryStub,
        INJECT_SCRIPT: path.join(ROOT, "scripts", "inject-summary.mjs"),
        GATE: stubGate(rc),
        BLOCK_ON: "P0,P1",
        QUIET: "false",
        PASSES: "1",
      },
    });
    return updated;
  }

  test("exit 10 renders a pass", async () => {
    assert.match(await summaryGate(10), /--gate pass/);
  });

  for (const rc of [0, 1, 3]) {
    test(`exit ${rc} renders blocked, never pass`, async () => {
      assert.match(await summaryGate(rc), /--gate blocked/);
    });
  }
});
