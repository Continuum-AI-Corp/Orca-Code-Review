// Contract tests for diff-guard.mjs — the oversized-diff skip decision.
//
// The guard runs BEFORE the review engine: on "skip" the driver (action.yml)
// posts a notice and passes the check without ever starting the engine.
// Decisions are DATA, not errors — the script always exits 0 (execFileSync
// throwing anywhere below would fail the test), and anything unreadable fails
// OPEN to "review" so a guard glitch can never silently disable the review.
//
// Limits: --max-kb (default 5000) on byte size, --max-files (default 2000) on
// `diff --git` headers. AT a limit still reviews; only strictly-over skips.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "diff-guard.mjs");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "diff-guard-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Runs the guard and returns the parsed JSON decision. execFileSync throws on
// a nonzero exit, so every call also asserts the exit-0 contract.
function run(args) {
  return JSON.parse(execFileSync("node", [GUARD, ...args], { encoding: "utf8" }));
}

function writeDiff(content) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.diff`);
  writeFileSync(file, content);
  return file;
}

// One well-formed single-file hunk (~90 bytes).
const fileBlock = (i) =>
  `diff --git a/f${i}.js b/f${i}.js\n` +
  `index 0000000..1111111 100644\n--- a/f${i}.js\n+++ b/f${i}.js\n@@ -1 +1 @@\n-old\n+new\n`;

describe("size threshold (--max-kb)", () => {
  test("under the limit -> review, with size and file count reported", () => {
    const out = run(["--diff", writeDiff(fileBlock(1)), "--max-kb", "1", "--max-files", "300"]);
    assert.equal(out.decision, "review");
    assert.equal(out.files, 1);
    assert.ok(out.size_kb > 0 && out.size_kb <= 1);
    assert.ok(out.reason.length > 0, "review decisions carry a reason too");
  });

  test("exactly AT the limit -> review (only strictly-over skips)", () => {
    const head = "diff --git a/a b/a\n";
    const pad = `+${"x".repeat(1024 - head.length - 2)}\n`;
    const content = head + pad;
    assert.equal(content.length, 1024, "fixture must be exactly 1 KB");
    const out = run(["--diff", writeDiff(content), "--max-kb", "1"]);
    assert.equal(out.decision, "review");
  });

  test("one byte over the limit -> skip, reason names the limit", () => {
    const head = "diff --git a/a b/a\n";
    const pad = `+${"x".repeat(1024 - head.length - 2)}\nx`;
    const content = head + pad;
    assert.equal(content.length, 1025, "fixture must be one byte over 1 KB");
    const out = run(["--diff", writeDiff(content), "--max-kb", "1"]);
    assert.equal(out.decision, "skip");
    assert.match(out.reason, /over the 1 KB limit/);
    // The size decision short-circuits on stat alone — an oversized diff is
    // never read into memory, so no file count is computed.
    assert.equal(out.files, 0);
    assert.ok(out.size_kb > 0, "the stat-derived size is still reported");
  });
});

describe("file-count threshold (--max-files)", () => {
  test("exactly AT the limit -> review", () => {
    const out = run(["--diff", writeDiff(fileBlock(1) + fileBlock(2)), "--max-files", "2"]);
    assert.equal(out.decision, "review");
    assert.equal(out.files, 2);
  });

  test("over the limit -> skip, reason names the limit", () => {
    const out = run([
      "--diff",
      writeDiff(fileBlock(1) + fileBlock(2) + fileBlock(3)),
      "--max-files",
      "2",
    ]);
    assert.equal(out.decision, "skip");
    assert.equal(out.files, 3);
    assert.match(out.reason, /over the 2-file limit/);
  });

  test("only real `diff --git` headers count — content lines never do", () => {
    // In a unified diff every content line is prefixed (' ', '+', '-'), so a
    // header string INSIDE a change must not be counted as a file.
    const content =
      fileBlock(1) +
      `diff --git a/b.sh b/b.sh\n@@ -1 +1 @@\n-echo hi\n+diff --git a/fake b/fake\n`;
    const out = run(["--diff", writeDiff(content), "--max-files", "300"]);
    assert.equal(out.files, 2);
  });
});

describe("defaults (5000 KB / 2000 files)", () => {
  test("a >5000 KB diff skips with no flags given", () => {
    const out = run(["--diff", writeDiff(`diff --git a/a b/a\n+${"x".repeat(5001 * 1024)}\n`)]);
    assert.equal(out.decision, "skip");
    assert.match(out.reason, /over the 5000 KB limit/);
  });

  test("2001 files skips, 2000 reviews, with no flags given", () => {
    // ~90 bytes per block, so 2001 of them is ~180 KB — far under the size
    // limit, which is what makes this a file-COUNT test and not a size one.
    let many = "";
    for (let i = 0; i < 2001; i += 1) many += fileBlock(i);
    assert.equal(run(["--diff", writeDiff(many)]).decision, "skip");

    let exactly = "";
    for (let i = 0; i < 2000; i += 1) exactly += fileBlock(i);
    assert.equal(run(["--diff", writeDiff(exactly)]).decision, "review");
  });

  test("a non-numeric limit falls back to its default instead of crashing", () => {
    const out = run(["--diff", writeDiff(fileBlock(1)), "--max-kb", "banana"]);
    assert.equal(out.decision, "review");
  });
});

// THE FALLBACK AND THE DOCUMENTED DEFAULT ARE ONE NUMBER IN TWO PLACES, and
// this pins them together. action.yml passes `--max-kb "$MAX_KB"` QUOTED, so a
// workspace that sets `max-diff-kb: ""` reaches this script as an empty
// argument and lands on the fallback — which means a stale number here would
// silently enforce a limit nobody documented, and no test would notice.
//
// Read out of action.yml rather than restated, so editing one side without the
// other fails here instead of in production.
describe("the script's fallbacks match action.yml's documented defaults", () => {
  // NEWLINES NORMALIZED, because this repo has no `.gitattributes` and
  // `core.autocrlf` is the Windows default: every Windows checkout gets a CRLF
  // action.yml, and the anchors below are written with bare "\\n". Without this the
  // test passes on Linux CI and fails on every Windows machine — a shape worth
  // avoiding on purpose, since CI green would be read as "works".
  const actionYml = () =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "action.yml"), "utf8").replace(
      /\r\n/g,
      "\n",
    );

  // The block for ONE input: from its key to the next key at the same indent.
  // Bounded rather than a non-greedy scan of the whole file, so an input with
  // no numeric default fails the assert instead of quietly borrowing a later
  // input's.
  function inputDefault(name) {
    const yml = actionYml();
    const start = yml.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start, -1, `${name} must exist in action.yml`);
    const rest = yml.slice(start + 1);
    const next = rest.search(/\n  [a-z][a-z0-9-]*:\n/);
    const block = next === -1 ? rest : rest.slice(0, next);
    const m = block.match(/\n    default: "(\d+)"/);
    assert.ok(m, `${name} must have a numeric default in action.yml`);
    return Number(m[1]);
  }

  test("an empty --max-kb enforces action.yml's max-diff-kb", () => {
    const documented = inputDefault("max-diff-kb");
    const oversized = `diff --git a/a b/a\n+${"x".repeat((documented + 1) * 1024)}\n`;
    const out = run(["--diff", writeDiff(oversized), "--max-kb", ""]);
    assert.equal(out.decision, "skip");
    assert.match(out.reason, new RegExp(`over the ${documented} KB limit`));
  });

  test("an empty --max-files enforces action.yml's max-diff-files", () => {
    const documented = inputDefault("max-diff-files");
    let many = "";
    for (let i = 0; i < documented + 1; i += 1) many += fileBlock(i);
    const out = run(["--diff", writeDiff(many), "--max-files", ""]);
    assert.equal(out.decision, "skip");
    assert.match(out.reason, new RegExp(`over the ${documented}-file limit`));
  });
});

describe("action.yml wiring (oversized-diff outcome)", () => {
  const actionYml = () =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "action.yml"), "utf8");

  test("`on-oversized-diff` defaults to \"fail\" — a padded diff cannot bypass a required merge gate", () => {
    const yml = actionYml();
    const inputs = yml.slice(yml.indexOf("inputs:"), yml.indexOf("runs:"));
    const declaration = inputs.slice(inputs.indexOf("on-oversized-diff:"));
    assert.ok(declaration.length > 0, "the on-oversized-diff input must be declared");
    assert.match(
      declaration.slice(0, declaration.indexOf("settings:")),
      /default: "fail"/,
      "the default outcome must be fail (secure by default)",
    );
  });

  test("the skip step consumes the input and fails the check unless it is exactly \"pass\"", () => {
    const yml = actionYml();
    const skip = yml.slice(yml.indexOf("- name: Skip review (diff too large)"), yml.indexOf("- name: Install review engine"));
    assert.match(skip, /ON_OVERSIZED/, "the step must receive the input");
    assert.match(skip, /=== 'pass'/, "anything but an explicit pass fails (fail-safe)");
    assert.match(skip, /setFailed/, "fail mode must fail the check");
  });
});

describe("fail-open (malformed / empty input)", () => {
  test("empty diff -> review, with a fail-open reason", () => {
    const out = run(["--diff", writeDiff("")]);
    assert.equal(out.decision, "review");
    assert.match(out.reason, /failing open/);
    assert.equal(out.size_kb, 0);
    assert.equal(out.files, 0);
  });

  test("missing diff file -> review (exit 0), with a fail-open reason", () => {
    const out = run(["--diff", join(dir, "does-not-exist.diff")]);
    assert.equal(out.decision, "review");
    assert.match(out.reason, /failing open/);
  });

  test("no --diff at all -> review (exit 0), never crashes", () => {
    const out = run([]);
    assert.equal(out.decision, "review");
    assert.match(out.reason, /failing open/);
  });

  test("non-diff garbage content -> review with files: 0", () => {
    const out = run(["--diff", writeDiff("this is not a diff at all\njust some text\n")]);
    assert.equal(out.decision, "review");
    assert.equal(out.files, 0);
  });
});
