// Contract tests for summary-comment.mjs — the single edit-in-place PR
// summary comment.
//
// The structure is load-bearing: the driver (action.yml) upserts the comment
// by the MARKER line, and the NEXT run parses the orca-cr-state line out of
// the previous body for the push counter and the Δ column. These tests pin:
// marker first, state JSON round-trips, table rows for P0/P1/P2/P3 always
// present (even at 0), delta math including negative deltas, the three
// tier-state lines, and the gate line.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SUMMARY = join(dirname(fileURLToPath(import.meta.url)), "summary-comment.mjs");
const MARKER = "<!-- orca-code-review-summary -->";
const STATE_RE = /<!-- orca-cr-state: (\{.*?\}) -->/;
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "summary-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Renders the comment for a result with the given comment bodies. `prevBody`
// (a previous comment body, usually a previous run() output) enables the Δ column.
function run(contents, flags, prevBody) {
  const id = Math.random().toString(36).slice(2);
  const resultFile = join(dir, `${id}.json`);
  writeFileSync(resultFile, JSON.stringify({ comments: contents.map((content) => ({ content })) }));
  const args = [SUMMARY, resultFile, ...flags];
  if (prevBody !== undefined) {
    const prevFile = join(dir, `${id}-prev.md`);
    writeFileSync(prevFile, prevBody);
    args.push("--prev", prevFile);
  }
  return execFileSync("node", args, { encoding: "utf8" });
}

describe("marker and machine state", () => {
  test("marker is the very first line; state JSON round-trips (untagged -> P1)", () => {
    const out = run(["[P0] a", "untagged bug"], ["--tier", "cheap", "--push", "1", "--gate", "blocked"]);
    assert.equal(out.split("\n")[0], MARKER);
    const m = out.match(STATE_RE);
    assert.ok(m, "state line must be present");
    assert.deepEqual(JSON.parse(m[1]), { p0: 1, p1: 1, p2: 0, p3: 0, push: 1 });
  });

  test("header names the push number", () => {
    const out = run([], ["--tier", "strong", "--push", "4", "--gate", "pass"]);
    assert.match(out, /## OrcaCode Review — push 4/);
  });
});

describe("severity table", () => {
  test("P0/P1/P2/P3 rows are always present, even at 0 — and no Δ column without --prev", () => {
    const out = run([], ["--tier", "strong", "--push", "1", "--gate", "pass"]);
    assert.ok(out.includes("| Severity | Count |"));
    assert.ok(out.includes("| P0 | 0 |"));
    assert.ok(out.includes("| P1 | 0 |"));
    assert.ok(out.includes("| P2 | 0 |"));
    assert.ok(out.includes("| P3 | 0 |"));
    assert.ok(!out.includes("Δ"), "no Δ column when there is no previous state");
  });

  test("Δ vs previous push: negative, positive, and zero deltas (incl. P3)", () => {
    // push 1: p0:1 p1:2 p2:1 p3:2 -> push 2: p0:0 p1:3 p2:1 p3:1
    const push1 = run(
      ["[P0] a", "[P1] b", "[P1] c", "[P2] d", "[P3] e", "[P3] f"],
      ["--tier", "cheap", "--push", "1", "--gate", "blocked"],
    );
    const push2 = run(
      ["[P1] x", "[P1] y", "[P1] z", "[P2] w", "[P3] v"],
      ["--tier", "cheap", "--push", "2", "--gate", "blocked"],
      push1,
    );
    assert.ok(push2.includes("| Severity | Count | Δ vs previous push |"));
    assert.ok(push2.includes("| P0 | 0 | -1 |"), "negative delta");
    assert.ok(push2.includes("| P1 | 3 | +1 |"), "positive delta");
    assert.ok(push2.includes("| P2 | 1 | 0 |"), "zero delta");
    assert.ok(push2.includes("| P3 | 1 | -1 |"), "P3 delta is numeric, never NaN");
    assert.deepEqual(JSON.parse(push2.match(STATE_RE)[1]), { p0: 0, p1: 3, p2: 1, p3: 1, push: 2 });
  });

  test("a prior state written without p3 (older format) yields a numeric P3 delta, not NaN", () => {
    const legacyPrev = '<!-- orca-cr-state: {"p0":0,"p1":0,"p2":0,"push":1} -->';
    const out = run(["[P3] nit"], ["--tier", "strong", "--push", "2", "--gate", "pass"], legacyPrev);
    assert.ok(out.includes("| P3 | 1 | +1 |"), "missing prev.p3 treated as 0");
    assert.ok(!out.includes("NaN"), "no NaN anywhere in the table");
  });

  test("a previous body without a parseable state line just omits the Δ column", () => {
    const out = run(
      ["[P2] nit"],
      ["--tier", "strong", "--push", "3", "--gate", "pass"],
      "some earlier comment with no state marker",
    );
    assert.ok(!out.includes("Δ"));
    assert.ok(out.includes("| P2 | 1 |"));
  });
});

describe("gate line", () => {
  test("blocked -> ❌ with the blocking (P0+P1) count", () => {
    const out = run(
      ["[P0] a", "[P1] b", "[P2] c"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked"],
    );
    assert.ok(out.includes("❌ 2 findings block merge"));
  });

  test("blocked with a single finding reads singular", () => {
    const out = run(["[P0] a"], ["--tier", "strong", "--push", "1", "--gate", "blocked"]);
    assert.ok(out.includes("❌ 1 finding blocks merge"));
  });

  test("pass -> ✅ no blocking findings", () => {
    const out = run(["[P2] nit"], ["--tier", "strong", "--push", "1", "--gate", "pass"]);
    assert.ok(out.includes("✅ no blocking findings"));
  });

  test("--block-on P2: the blocking count follows the configured set, not a hardcoded P0+P1", () => {
    const out = run(
      ["[P0] a", "[P2] b", "[P2] c"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked", "--block-on", "P2"],
    );
    assert.ok(out.includes("❌ 2 findings block merge"), `got:\n${out}`);
  });

  test("--block-on accepts a CSV set and normalizes case/whitespace", () => {
    const out = run(
      ["[P1] a", "[P2] b", "[P2] c"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked", "--block-on", " p1 , p2 "],
    );
    assert.ok(out.includes("❌ 3 findings block merge"));
  });

  test("an empty --block-on ('block on nothing') renders the ✅ pass wording", () => {
    const out = run(
      ["[P0] a", "[P1] b"],
      ["--tier", "strong", "--push", "1", "--gate", "pass", "--block-on", ""],
    );
    assert.ok(out.includes("✅ no blocking findings"));
  });

  test("no --block-on keeps the default P0+P1 count (back-compat)", () => {
    const out = run(
      ["[P0] a", "[P1] b", "[P1] c", "[P2] d"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked"],
    );
    assert.ok(out.includes("❌ 3 findings block merge"));
  });

  test("an unknown severity in --block-on exits 2 — a wiring bug must be loud", () => {
    const r = spawnSync(
      "node",
      [SUMMARY, join(dir, "x.json"), "--tier", "strong", "--push", "1", "--gate", "pass", "--block-on", "P0,P5"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2);
  });
});

describe("the ❌ count follows block-on", () => {
  // What used to be the "held run" suite. The cascade could withhold the strong
  // review on fix-first findings, and the count then had to follow FIX-FIRST or
  // the summary read "❌ 0 findings block merge" beside a held tier line. There is
  // no withholding any more, so what survives is the case that was never about
  // held runs at all.
  test("the count follows --block-on, not --fix-first", () => {
    // --fix-first is deliberately a DIFFERENT set here: it used to steer this
    // count on a held run, and now it must not steer it at all.
    const out = run(
      ["[P0] a", "[P2] b"],
      ["--push", "1", "--gate", "blocked", "--block-on", "P2", "--fix-first", "P0"],
    );
    assert.ok(out.includes("❌ 1 finding blocks merge"), `got:
${out}`);
  });
});

describe("mode notes (exhaustive / quiet)", () => {
  test("--passes > 1 renders the exhaustive note; state JSON is unchanged", () => {
    const out = run(["[P0] a"], ["--tier", "strong", "--push", "2", "--gate", "blocked", "--passes", "3"]);
    assert.ok(out.includes("exhaustive: 3 passes"));
    assert.deepEqual(JSON.parse(out.match(STATE_RE)[1]), { p0: 1, p1: 0, p2: 0, p3: 0, push: 2 });
  });

  test("--passes 1 (and no --passes at all) renders NO exhaustive note", () => {
    const explicit = run([], ["--tier", "strong", "--push", "1", "--gate", "pass", "--passes", "1"]);
    assert.ok(!explicit.includes("exhaustive"));
    const absent = run([], ["--tier", "strong", "--push", "1", "--gate", "pass"]);
    assert.ok(!absent.includes("exhaustive"));
  });

  test("--quiet renders the P2 note next to the TRUE counts", () => {
    const out = run(
      ["[P0] a", "[P2] nit"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked", "--quiet"],
    );
    assert.ok(out.includes("quiet mode: P2 shown in summary only"));
    assert.ok(out.includes("| P2 | 1 |"), "the summary must keep the true P2 count");
  });

  test("no --quiet -> no quiet note", () => {
    const out = run(["[P2] nit"], ["--tier", "strong", "--push", "1", "--gate", "pass"]);
    assert.ok(!out.includes("quiet mode"));
  });

  test("a non-numeric or sub-1 --passes exits 2 — a wiring bug must be loud", () => {
    for (const passes of ["zero", "0", "-1"]) {
      const r = spawnSync(
        "node",
        [SUMMARY, join(dir, "x.json"), "--tier", "strong", "--push", "1", "--gate", "pass", "--passes", passes],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 2, `--passes ${passes} must exit 2`);
    }
  });
});

describe("robustness", () => {
  test("unreadable result.json still renders (zero counts), exit 0", () => {
    const r = spawnSync(
      "node",
      [SUMMARY, join(dir, "missing.json"), "--tier", "strong", "--push", "1", "--gate", "pass"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("| P0 | 0 |"));
  });

  test("bad usage (missing/invalid flags) exits 2 — a wiring bug must be loud", () => {
    for (const args of [
      [],
      ["--push", "1"], // no --gate
      ["--push", "zero", "--gate", "pass"], // bad push
      // No bad-tier case: --tier is no longer validated here. There is one tier,
      // the summary stopped rendering it, and the value the control plane records
      // is checked by report.mjs and the gateway instead.
    ]) {
      const r = spawnSync("node", [SUMMARY, join(dir, "x.json"), ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, `args ${JSON.stringify(args)} must exit 2`);
    }
  });
});
