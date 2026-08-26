// Contract tests for gate.mjs — the decision primitive behind the merge gate and
// the exhaustive loop's early stop.
//
// Two callers depend on its exit code:
//   - the merge gate: `gate --has $BLOCK_ON` TRUE  -> fail the check
//                                            FALSE -> pass
//   - the exhaustive loop: `gate --has $FIX_FIRST` TRUE -> stop adding passes,
//     because the gate already blocks on what is in hand
//
// So the exit code IS the policy, and reading it backwards inverts both. Run
// these before changing anything about severity behaviour.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "gate.mjs");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Runs the gate against a result with the given comment bodies and returns the
// exit code (0 = at least one finding matches --has, 1 = none match / no input).
function gate(contents, has) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  const comments = contents.map((content) => ({ content }));
  writeFileSync(file, JSON.stringify({ comments }));
  try {
    execFileSync("node", [GATE, file, "--has", has], { stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status;
  }
}

const FIX_FIRST = "P0,P1"; // severities the exhaustive loop stops on
const BLOCK_ON = "P0"; // severities that block the merge

describe("exhaustive early-stop decision (--has FIX_FIRST)", () => {
  test("P0 present -> match (stop adding passes; fix that first)", () => {
    assert.equal(gate(["[P0] sql injection", "[P2] use const"], FIX_FIRST), 0);
  });

  test("P1 present -> match (stop adding passes)", () => {
    assert.equal(gate(["[P1] possible null deref"], FIX_FIRST), 0);
  });

  test("P2-only -> no match (extra depth may still find something)", () => {
    assert.equal(gate(["[P2] use const", "[P2] dead code"], FIX_FIRST), 1);
  });

  test("clean (no findings) -> no match (extra depth may still find something)", () => {
    assert.equal(gate([], FIX_FIRST), 1);
  });

  test("untagged finding -> treated as P1 (stop, fail-safe)", () => {
    assert.equal(gate(["no severity tag, but a real bug"], FIX_FIRST), 0);
  });
});

describe("merge gate (--has BLOCK_ON)", () => {
  test("P0 present -> match (block the merge)", () => {
    assert.equal(gate(["[P0] exposed secret"], BLOCK_ON), 0);
  });

  test("P1-only -> no match (gate passes)", () => {
    assert.equal(gate(["[P1] race condition"], BLOCK_ON), 1);
  });

  test("untagged (P1 fail-safe) does not block on P0", () => {
    assert.equal(gate(["untagged bug"], BLOCK_ON), 1);
  });
});

describe("robustness", () => {
  test("missing / unparseable file -> no match (exit 1), never crashes", () => {
    assert.throws(
      () =>
        execFileSync(
          "node",
          [GATE, join(dir, "does-not-exist.json"), "--has", "P0"],
          { stdio: "pipe" },
        ),
      (e) => e.status === 1,
    );
  });

  test("tag is case-insensitive", () => {
    assert.equal(gate(["[p0] lowercase tag still counts"], BLOCK_ON), 0);
  });
});
