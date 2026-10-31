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
//
// THE EXIT CODES ARE DISTINCT, AND "NO MATCH" IS NOT 1. Node exits 1 on any
// uncaught exception, and the enforce step used to read every non-zero exit
// as "gate passed" — so a gate that crashed, or a result it could not read,
// passed the merge gate. Now:
//   0  a finding matches --has   (block / stop adding passes)
//   10 no finding matches        (pass)
//   2  usage error
//   3  the result could not be read as a review result
// and the enforce step fails closed on anything but 0 or 10.

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
// exit code (0 = at least one finding matches --has, 10 = none match).
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
const NO_MATCH = 10;

describe("exhaustive early-stop decision (--has FIX_FIRST)", () => {
  test("P0 present -> match (stop adding passes; fix that first)", () => {
    assert.equal(gate(["[P0] sql injection", "[P2] use const"], FIX_FIRST), 0);
  });

  test("P1 present -> match (stop adding passes)", () => {
    assert.equal(gate(["[P1] possible null deref"], FIX_FIRST), 0);
  });

  test("P2-only -> no match (extra depth may still find something)", () => {
    assert.equal(gate(["[P2] use const", "[P2] dead code"], FIX_FIRST), NO_MATCH);
  });

  test("clean (no findings) -> no match (extra depth may still find something)", () => {
    assert.equal(gate([], FIX_FIRST), NO_MATCH);
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
    assert.equal(gate(["[P1] race condition"], BLOCK_ON), NO_MATCH);
  });

  test("untagged (P1 fail-safe) does not block on P0", () => {
    assert.equal(gate(["untagged bug"], BLOCK_ON), NO_MATCH);
  });
});

describe("robustness", () => {
  // This used to pin "missing / unparseable file -> no match (exit 1)", i.e.
  // an unreadable result PASSED the merge gate. That was the fail-open: a
  // result nobody could read is not evidence of a clean review.
  test("missing file -> exit 3 (unreadable), never the pass code", () => {
    assert.throws(
      () =>
        execFileSync(
          "node",
          [GATE, join(dir, "does-not-exist.json"), "--has", "P0"],
          { stdio: "pipe" },
        ),
      (e) => e.status === 3,
    );
  });

  test("unparseable file -> exit 3 (unreadable)", () => {
    const file = join(dir, "garbage.json");
    writeFileSync(file, "{not json");
    assert.throws(
      () => execFileSync("node", [GATE, file, "--has", "P0"], { stdio: "pipe" }),
      (e) => e.status === 3,
    );
  });

  test("a result with no comments array -> exit 3, not a clean pass", () => {
    const file = join(dir, "no-comments.json");
    writeFileSync(file, JSON.stringify({ summary: "looks fine" }));
    assert.throws(
      () => execFileSync("node", [GATE, file, "--has", "P0"], { stdio: "pipe" }),
      (e) => e.status === 3,
    );
  });

  test("usage error -> exit 2", () => {
    assert.throws(
      () => execFileSync("node", [GATE], { stdio: "pipe" }),
      (e) => e.status === 2,
    );
  });

  test("tag is case-insensitive", () => {
    assert.equal(gate(["[p0] lowercase tag still counts"], BLOCK_ON), 0);
  });
});
