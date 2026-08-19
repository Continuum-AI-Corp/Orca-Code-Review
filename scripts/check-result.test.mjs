// Contract tests for check-result.mjs — the availability gate that decides
// whether the engine produced a review we are allowed to trust.
//
// Called from action.yml as `node "$CHECK" "$1" "$rc"` with the engine's exit
// code. Its whole job is to FAIL CLOSED: a nonzero engine exit, unparseable
// output, a missing `comments` array, or a partial review (any `warnings`)
// must exit 1. The failure this prevents is silent and expensive — converting
// a bad key, a gateway outage, or a CLI crash into a clean "no issues found"
// would clear a PR that was never actually reviewed.
//
// The one case that must NOT be swept up: a genuinely clean review. `comments:
// []` with no warnings is a real, complete result and has to exit 0, or every
// clean PR would be reported as broken.
//
// All diagnostics go to stderr; stdout stays empty because the caller captures
// it.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const CHECK = join(SCRIPTS, "check-result.mjs");

let dir;
let seq = 0;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "check-result-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// `body` is written verbatim when a string, so a test can inject invalid JSON.
function writeResult(body) {
  const file = join(dir, `${(seq += 1)}-result.json`);
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

function run(...args) {
  const r = spawnSync("node", [CHECK, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const OK = { comments: [] };

describe("engine exit code is checked before anything else", () => {
  test("a zero exit with a usable result passes", () => {
    const r = run(writeResult(OK), "0");
    assert.equal(r.status, 0, r.stderr);
  });

  test("a nonzero engine exit fails closed and names the code", () => {
    const r = run(writeResult(OK), "1");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /review unavailable: engine exited 1/);
  });

  test("a signal-shaped exit (137 = OOM/timeout kill) fails closed", () => {
    const r = run(writeResult(OK), "137");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /engine exited 137/);
  });

  test("a non-numeric exit code fails closed rather than being coerced to 0", () => {
    const r = run(writeResult(OK), "abc");
    assert.equal(r.status, 1, "NaN must not be mistaken for success");
  });

  test("the exit code is checked BEFORE the file is read", () => {
    // A nonzero code short-circuits, so a missing file is never reached.
    const r = run(join(dir, "does-not-exist.json"), "2");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /engine exited 2/);
    assert.doesNotMatch(r.stderr, /no parseable result/);
  });

  test("an omitted exit code is treated as 0", () => {
    const r = run(writeResult(OK));
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("the result file must be readable and engine-shaped", () => {
  test("a missing file is unavailable, not empty", () => {
    const missing = join(dir, "nope.json");
    const r = run(missing, "0");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /review unavailable: no parseable result/);
  });

  test("unparseable JSON is unavailable", () => {
    const r = run(writeResult("{not json"), "0");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no parseable result/);
  });

  test("valid JSON with no comments key is unavailable", () => {
    const r = run(writeResult({ warnings: [] }), "0");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no `comments` array/);
  });

  test("a non-array comments value is unavailable", () => {
    for (const comments of [{}, "two", 2, null]) {
      const r = run(writeResult({ comments }), "0");
      assert.equal(r.status, 1, `comments: ${JSON.stringify(comments)}`);
      assert.match(r.stderr, /no `comments` array/);
    }
  });
});

describe("a partial review is not a usable review", () => {
  test("any warning fails closed and reports the count", () => {
    const r = run(writeResult({ comments: [], warnings: ["skipped a.js"] }), "0");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /review partial: 1 warning\(s\)/);
    assert.match(r.stderr, /skipped a\.js/);
  });

  test("multiple warnings are all surfaced", () => {
    const r = run(writeResult({ comments: [], warnings: ["a failed", "b skipped"] }), "0");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2 warning\(s\)/);
    assert.match(r.stderr, /a failed; b skipped/);
  });

  test("warnings outrank findings: a partial review with comments still fails", () => {
    const result = { comments: [{ content: "[P0] real bug" }], warnings: ["c skipped"] };
    const r = run(writeResult(result), "0");
    assert.equal(r.status, 1, "partial coverage means the clean files were never checked");
  });

  test("an empty warnings array is not a warning", () => {
    const r = run(writeResult({ comments: [], warnings: [] }), "0");
    assert.equal(r.status, 0, r.stderr);
  });

  test("a non-array warnings value is ignored rather than treated as partial", () => {
    const r = run(writeResult({ comments: [], warnings: "oops" }), "0");
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("a complete review passes", () => {
  test("zero findings is a REAL result, not a failure", () => {
    const r = run(writeResult({ comments: [] }), "0");
    assert.equal(r.status, 0, "a clean PR must not be reported as unavailable");
    assert.match(r.stderr, /review available: 0 finding\(s\)/);
  });

  test("findings are counted", () => {
    const comments = [{ content: "[P0] a" }, { content: "[P2] b" }, { content: "c" }];
    const r = run(writeResult({ comments }), "0");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /review available: 3 finding\(s\)/);
  });

  test("unknown extra keys do not affect availability", () => {
    const r = run(writeResult({ comments: [], model: "x", elapsed_ms: 12 }), "0");
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("output contract", () => {
  test("nothing is written to stdout on success or failure", () => {
    assert.equal(run(writeResult(OK), "0").stdout, "");
    assert.equal(run(writeResult(OK), "1").stdout, "");
    assert.equal(run(writeResult("{bad"), "0").stdout, "");
  });
});
