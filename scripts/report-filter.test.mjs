// Contract tests for report-filter.mjs — the publish-side severity filter.
//
// The seam worth pinning is three-valued, and the middle value is the one that
// already went wrong once in action.yml: NO --show means "no setting, pass
// everything through", an EMPTY --show means "publish only what blocks", and a
// populated --show means that set UNION block_on. Collapsing the first two
// published every severity for a workspace that had asked for the opposite.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const FILTER = join(SCRIPTS, "report-filter.mjs");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "report-filter-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = ["[P0] sqli", "[P1] null deref", "[P2] conditional bug", "[P3] naming", "untagged"];

let n = 0;
function run(contents, args, extra = {}) {
  n += 1;
  const input = join(dir, `in-${n}.json`);
  const out = join(dir, `out-${n}.json`);
  if (contents !== null) {
    writeFileSync(input, JSON.stringify({ engine: "ocr", comments: contents.map((content) => ({ content })) }));
  }
  const r = spawnSync("node", [FILTER, extra.file ?? input, ...args, "--out", out], { encoding: "utf8" });
  let result = null;
  try {
    result = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    /* the script may legitimately not have written it (usage errors) */
  }
  return { ...r, result, kept: (result?.comments ?? []).map((c) => c.content) };
}

describe("the three states of --show", () => {
  test("NO --show: pass-through, and the envelope survives", () => {
    const r = run(FIXTURE, ["--block-on", "P0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.kept, FIXTURE, "an absent setting must not drop anything");
    assert.equal(r.result.engine, "ocr", "sibling keys must be carried through");
    assert.deepEqual(JSON.parse(r.stdout), { shown: 5, withheld: 0 });
  });

  test("EMPTY --show: only what blocks", () => {
    const r = run(FIXTURE, ["--show", "", "--block-on", "P0,P1"]);
    assert.equal(r.status, 0, r.stderr);
    // "untagged" is P1 by the shared fail-safe, so it blocks and therefore shows.
    assert.deepEqual(r.kept, ["[P0] sqli", "[P1] null deref", "untagged"]);
    assert.deepEqual(JSON.parse(r.stdout), { shown: 3, withheld: 2 });
  });

  test("populated --show: the union with block-on, never the difference", () => {
    // The workspace asked to see P3 only, and blocks on P0. Hiding the P0 would
    // fail the merge with nothing on the diff explaining why.
    const r = run(FIXTURE, ["--show", "P3", "--block-on", "P0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.kept, ["[P0] sqli", "[P3] naming"]);
  });

  test("a block-on severity cannot be withheld even when show excludes all of it", () => {
    const r = run(["[P0] one", "[P1] two"], ["--show", "P2,P3", "--block-on", "P0,P1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.kept, ["[P0] one", "[P1] two"]);
    assert.deepEqual(JSON.parse(r.stdout), { shown: 2, withheld: 0 });
  });
});

describe("severity parsing is the shared one", () => {
  test("an untagged finding is P1, and a tag is case-insensitive", () => {
    const r = run(["untagged", "[p2] lower"], ["--show", "P1", "--block-on", ""]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.kept, ["untagged"], "untagged -> P1 kept; [p2] parsed as P2 and dropped");
  });

  test("a tag that is not leading does not count", () => {
    const r = run(["see [P0] in the example above"], ["--show", "P0", "--block-on", ""]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.kept, [], "prose mentioning [P0] is an untagged P1, not a P0");
  });
});

describe("failure behavior", () => {
  test("missing input -> empty result, exit 0 (display must not fail the job)", () => {
    const r = run(null, ["--show", "P0"], { file: join(dir, "nope.json") });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.result, { comments: [] });
    assert.deepEqual(JSON.parse(r.stdout), { shown: 0, withheld: 0 });
  });

  test("unparseable input -> empty result, exit 0", () => {
    const input = join(dir, "garbage.json");
    writeFileSync(input, "{not json");
    const out = join(dir, "garbage-out.json");
    const r = spawnSync("node", [FILTER, input, "--show", "P0", "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { comments: [] });
  });

  test("an unknown severity is a WIRING bug -> exit 2", () => {
    const r = run(FIXTURE, ["--show", "P1,P9"]);
    assert.equal(r.status, 2, "a bad severity set must be loud, not silently narrowed");
    assert.match(r.stderr, /unknown severity/);
  });

  test("--show swallowing the next flag -> exit 2, not a wrong severity set", () => {
    // What an empty `${{ ... }}` expansion looks like from the shell.
    const r = run(FIXTURE, ["--show", "--block-on", "P0"]);
    assert.equal(r.status, 2, "a flag is never a value");
    assert.match(r.stderr, /usage/);
  });

  test("no --out -> exit 2", () => {
    const input = join(dir, "no-out.json");
    writeFileSync(input, JSON.stringify({ comments: [] }));
    const r = spawnSync("node", [FILTER, input, "--show", "P0"], { encoding: "utf8" });
    assert.equal(r.status, 2);
  });
});

describe("action.yml wiring", () => {
  test("the filter runs BEFORE quiet, and only posting reads the end of the chain", () => {
    const yml = readFileSync(join(SCRIPTS, "..", "action.yml"), "utf8");
    const reportOn = yml.indexOf("- name: report_on severity filter");
    const quiet = yml.indexOf("- name: Quiet mode filter");
    const post = yml.indexOf("- name: Post review comments");
    assert.ok(reportOn > 0 && quiet > reportOn && post > quiet, "report_on -> quiet -> post");
    // The gate and the run report must not see the filtered copies at all —
    // covered structurally in settings.test.mjs; here just pin that the two
    // intermediate files are distinct, so neither stage overwrites the other's
    // input and the raw result stays raw.
    for (const f of ["result.json", "result-reported.json", "result-posted.json"]) {
      assert.ok(yml.includes(f), `${f} must be wired`);
    }
  });
});
