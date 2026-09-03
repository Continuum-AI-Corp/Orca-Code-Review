// The harness surface — the half of OrcaCode Review an outside agent drives.
//
// What is worth testing here is the CONTRACT, not the prose: the result shape
// the pipeline shares with the Action, the gate's fail-safe, the porcelain
// parsing that decides which files are in scope, and the promises the plan makes
// to a model that cannot ask a follow-up question.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeT } from "../bin/i18n.mjs";
import {
  LANGUAGE_NAMES,
  MODE_REASON,
  SCHEMA_VERSION,
  WORK_DIR,
  anchorLine,
  buildPlan,
  gate,
  renderPlan,
  renderReport,
  renderReportMarkdown,
  resolveMode,
  resolvePr,
  selectFiles,
  splitFinding,
  validateResult,
} from "../bin/harness.mjs";

// ------------------------------------------------------------- validation ---

test("a bare `line` is widened to the start/end pair the pipeline speaks", () => {
  // postfilter.mjs, judge.mjs, exhaustive-merge.mjs and the Action's poster all
  // read start_line/end_line. A finding carrying only `line` would keep a stale
  // anchor through a re-home, so the widening has to happen at the boundary.
  const r = validateResult({ comments: [{ path: "a.ts", line: 7, content: "[P1] x" }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.comments[0], { path: "a.ts", start_line: 7, end_line: 7, content: "[P1] x" });
  assert.equal("line" in r.comments[0], false, "the alias must not survive alongside the pair");
});

test("the short hand-back form — four fields, no warnings key — is accepted", () => {
  // What the plan actually asks an agent to write. If this ever stops being
  // valid, every review starts failing at the last step.
  const short = {
    comments: [{ path: "a.ts", line: 7, existing_code: "  x();", content: "[P1] **T**\n\nbody" }],
  };
  const r = validateResult(short);
  assert.equal(r.ok, true);
  assert.deepEqual(
    { s: r.comments[0].start_line, e: r.comments[0].end_line, line: r.comments[0].line },
    { s: 7, e: 7, line: undefined },
    "the bare line must be widened and consumed, not left alongside the pair",
  );
});

test("an explicit start/end range is left exactly as written", () => {
  const c = { path: "a.ts", start_line: 4, end_line: 9, content: "[P2] x" };
  assert.deepEqual(validateResult({ comments: [c] }).comments[0], c);
});

test("a partial review is rejected rather than passed", () => {
  // The whole point of failing closed: "some files could not be read" must never
  // render as a clean review, or a broken run silently clears a change.
  const r = validateResult({ comments: [], warnings: ["could not read src/b.ts"] });
  assert.equal(r.ok, false);
  assert.match(r.error, /partial/);
});

test("a finding without a path or content is malformed, not silently dropped", () => {
  assert.match(validateResult({ comments: [{ content: "[P1] x" }] }).error, /`path`/);
  assert.match(validateResult({ comments: [{ path: "a.ts" }] }).error, /`content`/);
});

test("a result that is not an object, or has no comments array, is unusable", () => {
  assert.equal(validateResult(null).ok, false);
  assert.equal(validateResult({}).ok, false);
  assert.equal(validateResult({ comments: "none" }).ok, false);
});

// ------------------------------------------------------------------- gate ---

const finding = (content) => ({ path: "a.ts", content });

test("the gate blocks on the configured severities and nothing else", () => {
  const r = gate([finding("[P0] a"), finding("[P2] b"), finding("[P3] c")], "P0,P1");
  assert.equal(r.blocked, true);
  assert.equal(r.blocking.length, 1);
  assert.deepEqual(r.counts, { P0: 1, P1: 0, P2: 1, P3: 1 });
});

test("an untagged finding counts as P1, so a missing tag escalates", () => {
  // severity.mjs owns this rule; the test is here because the harness is a new
  // caller of it and the fail-safe is the reason an agent can be trusted to tag.
  const r = gate([finding("no tag at all")], "P0,P1");
  assert.equal(r.blocked, true);
  assert.equal(r.counts.P1, 1);
});

test("an empty --block-on never blocks", () => {
  const r = gate([finding("[P0] a")], "");
  assert.equal(r.blocked, false);
  assert.deepEqual(r.wanted, []);
});

test("block-on is case- and space-insensitive", () => {
  assert.equal(gate([finding("[P0] a")], " p0 , p1 ").blocked, true);
});

// ---------------------------------------------------------------- anchors ---

test("the anchor prefers end_line, falls back to start_line, and may be absent", () => {
  assert.equal(anchorLine({ start_line: 3, end_line: 9 }), 9);
  assert.equal(anchorLine({ start_line: 3 }), 3);
  // Cleared by a re-home whose new line could not be resolved: rendering the
  // stale number would point at unrelated code in the new file.
  assert.equal(anchorLine({ start_line: null, end_line: null }), null);
  assert.equal(anchorLine({}), null);
});

test("the bold title is split off the body, and a shapeless finding still renders", () => {
  const ok = splitFinding("[P1] **Loop drops the last item**\n\nThe bound is off by one.");
  assert.deepEqual(ok, { title: "Loop drops the last item", rest: "The bound is off by one." });

  const shapeless = splitFinding("[P3] just a sentence, no bold");
  assert.equal(shapeless.title, "just a sentence, no bold");
});

// ------------------------------------------------------------ output shape ---

// rules/output-shape.md is injected into BOTH prompts — action.yml's OUTPUT_SHAPE
// and this harness's rubric — so the Action's PR comments and a local review are
// shaped by the same file. Nothing else guarded it.
const SHAPE = fs.readFileSync(new URL("../rules/output-shape.md", import.meta.url), "utf8");

test("the output shape mandates a title, an explanation, and a separate fix", () => {
  assert.match(SHAPE, /\*\*Fix:\*\*/);
  assert.match(SHAPE, /THE FIX IS ITS OWN PARAGRAPH/);
  assert.match(SHAPE, /last thing in the comment/);
});

test("the output shape shows a wrong/right pair for the title, not just a rule", () => {
  // Observed on a real PR: a P1 titled "Serialize the budget-cap check per key;
  // the atomicity claim only holds on SQLite" — an instruction, sixteen words,
  // with a semicolon. The prose rule was already there; the counter-example is
  // what makes it land.
  assert.match(SHAPE, /WRONG\s+\*\*/);
  assert.match(SHAPE, /RIGHT\s+\*\*/);
  assert.match(SHAPE, /No semicolon/);
  assert.match(SHAPE, /statement of what is WRONG/);
});

test("the plan hands the reviewer that exact file, not a paraphrase of it", (t) => {
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");
  const text = renderPlan(buildPlan({ from: "main~1", to: "HEAD" }, dir));
  assert.ok(text.includes("THE FIX IS ITS OWN PARAGRAPH"), "the local review must be shaped by the shared rule");
});

// --------------------------------------------------------- submit, for real ---

const CLI = fileURLToPath(new URL("../bin/orcacode-review.mjs", import.meta.url));

// The bug this guards: postfilter.mjs reads a FILE, so handing it the result as
// the agent wrote it — with a bare `line` — returned every finding anchorless.
// Only an end-to-end run catches that; the widening in validateResult looks
// correct in isolation and is simply bypassed.
test("a finding written in the short form keeps its line through the position check", (t) => {
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "x.js"), "export function f(a) {\n  return a.b;\n}\n");
  run("add", "-A");
  run("commit", "-q", "-m", "x");

  const work = path.join(dir, WORK_DIR);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    path.join(work, "result.json"),
    JSON.stringify({
      comments: [{ path: "x.js", line: 2, existing_code: "  return a.b;", content: "[P0] **Null deref**\n\nbody" }],
    }),
  );
  fs.writeFileSync(
    path.join(work, "plan.json"),
    JSON.stringify({ ground_truth_ref: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim() }),
  );

  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, [CLI, "review", "submit", "--format", "md", "--lang", "en"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    out = e.stdout || "";
    code = e.status;
  }

  assert.equal(code, 0, "a review that ran exits 0; the verdict is in the report");
  assert.match(out, /❌ BLOCKED/, "a P0 must block");
  assert.match(out, /`x\.js:2`/, "the anchor must survive postfilter, not be dropped to a bare path");
  assert.ok(!fs.existsSync(path.join(work, "result.normalized.json")), "the scratch file must not be left behind");
  assert.ok(fs.existsSync(path.join(work, "report.md")), "the markdown report is always saved");
});

// Runs the real CLI and reports what a caller actually observes.
function submit(dir, args) {
  const r = spawnSync(process.execPath, [CLI, "review", "submit", "--lang", "en", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// A blocking P0 seeded into a repo, ready to submit.
function repoWithABlockingFinding(t, result) {
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "x.js"), "export function f(a) {\n  return a.b;\n}\n");
  run("add", "-A");
  run("commit", "-q", "-m", "x");

  const work = path.join(dir, WORK_DIR);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    path.join(work, "result.json"),
    JSON.stringify(
      result ?? {
        comments: [{ path: "x.js", line: 2, existing_code: "  return a.b;", content: "[P0] **Null deref**\n\nbody" }],
      },
    ),
  );
  fs.writeFileSync(
    path.join(work, "plan.json"),
    JSON.stringify({ ground_truth_ref: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim() }),
  );
  return { dir, work };
}

// Why the default is 0: the local harness exists to tell an agent what the
// bugs are, and the agent reads the report. Its shell tool stamps any non-zero
// exit "Error" — which, twice, turned a working review into an apparent crash
// in front of a real user.
test("a blocked review exits 0 by default and carries the verdict in the report", (t) => {
  const { dir, work } = repoWithABlockingFinding(t);
  const r = submit(dir, ["--format", "md"]);
  assert.equal(r.code, 0, "the process must not fail on a verdict");
  assert.match(r.out, /❌ BLOCKED/, "the verdict lives in the report, not the exit code");
  assert.match(fs.readFileSync(path.join(work, "report.md"), "utf8"), /❌ BLOCKED/);
});

test("--fail-on-block is the opt-in that turns the verdict into a status", (t) => {
  const { dir } = repoWithABlockingFinding(t);
  const r = submit(dir, ["--format", "md", "--fail-on-block"]);
  assert.equal(r.code, 1, "a hook or CI step that asked for it gets the 1");
  assert.match(r.out, /❌ BLOCKED/, "and still gets the report");
});

test("the machine-readable verdict does not follow the exit code", (t) => {
  const { dir } = repoWithABlockingFinding(t);
  const r = submit(dir, ["--format", "json"]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).blocked, true);
});

test("the default terminal report says BLOCKED without failing the process", (t) => {
  const { dir } = repoWithABlockingFinding(t);
  const r = submit(dir, []);
  assert.equal(r.code, 0);
  assert.match(r.out, /❌ BLOCKED/, "the terminal renderer shouts it; the markdown one does not");
});

// The one thing the 0 default must never cover. A masked 2 turns "the review
// did not happen" into "the review passed", which is the failure this pipeline
// exists to prevent.
test("an unusable result still exits 2", (t) => {
  const { dir } = repoWithABlockingFinding(t, { comments: [], warnings: ["could not read src/a.ts"] });
  const r = submit(dir, ["--format", "md"]);
  assert.equal(r.code, 2, "a partial review is a failure, not a verdict");
  assert.ok(!/✅ PASSED/.test(r.out), "and it must never render as a pass");
});

test("a clean review exits 0 with or without --fail-on-block", (t) => {
  const { dir } = repoWithABlockingFinding(t, { comments: [] });
  assert.equal(submit(dir, ["--format", "md"]).code, 0);
  assert.equal(submit(dir, ["--format", "md", "--fail-on-block"]).code, 0);
});

// ------------------------------------------------------------- language ---

test("the plan tells the reviewer which language to write findings in", (t) => {
  // The rubric is English and shared with the Action; the findings are for a
  // person, and that person asked in their own language.
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "a.ts"), "1\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");
  const zh = renderPlan(buildPlan({ from: "main~1", to: "HEAD", language: "zh" }, dir));
  assert.match(zh, /## Language/);
  assert.match(zh, /in 简体中文 \(Simplified Chinese\)\./);
  assert.match(zh, /review submit --format md --lang zh/, "the hand-back command carries the same language");
  // The structure rule survives the language change.
  assert.match(zh, /severity tag stays exactly `\[P0\]`…`\[P3\]`/);

  const dflt = buildPlan({ from: "main~1", to: "HEAD" }, dir);
  assert.equal(dflt.language, "en");
  const bogus = buildPlan({ from: "main~1", to: "HEAD", language: "tlh" }, dir);
  assert.equal(bogus.language, "en", "an unknown language falls back rather than being echoed into a prompt");
  for (const code of ["en", "zh", "ja", "ko"]) assert.ok(LANGUAGE_NAMES[code], `a name for ${code}`);
});

test("the report skeleton follows the language, the findings are left alone", () => {
  const comments = [mdFinding("a.ts", 1, "[P1] **空指针解引用**\n\n调用方传 undefined 会崩。\n\n**修复：**先判空。")];
  const result = gate(comments, "P0,P1");
  const zh = renderReportMarkdown(comments, result, { t: makeT("zh") });
  assert.match(zh, /\*\*❌ 已拦截\*\* — 共 1 条发现，其中 1 条达到 P0, P1 级别。/, "and a Chinese full stop, not a Latin one");
  assert.match(zh, /空指针解引用/, "the finding text is the agent's and is not touched");
  const en = renderReportMarkdown(comments, result);
  assert.match(en, /\*\*❌ BLOCKED\*\* — 1 of 1 finding at P0, P1\./, "no translator means English");

  const plain = { bold: (s) => s, dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s, cyan: (s) => s };
  const term = renderReport(comments, result, { color: plain, t: makeT("zh") }).split("\n");
  assert.match(term[0], /❌ 已拦截\s+共 1 条发现/);
  assert.match(term[1], /这是评审结果，不是程序崩溃/);
});

test("--lang reaches the submitted report end to end", (t) => {
  const { dir } = repoWithABlockingFinding(t);
  const r = spawnSync(process.execPath, [CLI, "review", "submit", "--format", "md", "--lang", "zh"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\*\*❌ 已拦截\*\*/);
});

// ------------------------------------------------------ markdown reporting ---

const mdFinding = (path, line, content) => ({ path, start_line: line, end_line: line, content });

test("the terminal report leads with the verdict, because the tail gets truncated", () => {
  // Agent shells cut the middle out of long output. With the verdict at the
  // bottom, all the reader is left with is the top of a findings list and no
  // idea whether any of it blocks.
  const plain = { bold: (s) => s, dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s, cyan: (s) => s };
  const comments = [mdFinding("a.ts", 1, "[P1] **High**\n\nbody"), mdFinding("a.ts", 2, "[P3] **Nit**\n\nbody")];

  const blocked = renderReport(comments, gate(comments, "P0,P1"), { color: plain }).split("\n");
  assert.match(blocked[0], /❌ BLOCKED\s+1 of 2 findings at P0,P1/);
  assert.match(blocked[1], /this is a review result, not a crash/);

  const passed = renderReport(comments, gate(comments, "P0"), { color: plain }).split("\n");
  assert.match(passed[0], /✅ PASSED\s+nothing at P0/);

  // The counts belong with the verdict, not repeated at the far end.
  assert.equal(blocked.filter((l) => /P0 \d+ /.test(l)).length, 1);
});

test("the markdown report leads with the verdict, not with the first finding", () => {
  const comments = [mdFinding("a.ts", 1, "[P2] **Nit**\n\nbody")];
  const clean = renderReportMarkdown([], gate([], "P0,P1"));
  assert.match(clean, /✅ PASSED\*\* — no findings\./);

  const passed = renderReportMarkdown(comments, gate(comments, "P0,P1"));
  assert.match(passed.split("\n")[2], /✅ PASSED/);
  assert.match(passed, /1 finding to read\./);

  const p0 = [mdFinding("a.ts", 1, "[P0] **Boom**\n\nbody")];
  assert.match(renderReportMarkdown(p0, gate(p0, "P0,P1")).split("\n")[2], /❌ BLOCKED/);
});

test("the markdown report groups by file and puts the blocking file first", () => {
  const comments = [
    mdFinding("z.ts", 1, "[P3] **Nit in z**\n\nbody"),
    mdFinding("a.ts", 9, "[P0] **Boom in a**\n\nbody"),
    mdFinding("a.ts", 2, "[P2] **Advisory in a**\n\nbody"),
  ];
  const md = renderReportMarkdown(comments, gate(comments, "P0,P1"));
  assert.ok(md.indexOf("### `a.ts`") < md.indexOf("### `z.ts`"), "the file that blocks must sort first");
  // Within a file: worst first, and only one heading per file.
  assert.ok(md.indexOf("Boom in a") < md.indexOf("Advisory in a"));
  assert.equal(md.match(/### `a\.ts`/g).length, 1);
});

test("the ❌ mark follows the gate that ran, not the severity in the abstract", () => {
  const comments = [mdFinding("a.ts", 1, "[P1] **High**\n\nbody")];
  assert.match(renderReportMarkdown(comments, gate(comments, "P0,P1")), /❌ P1/);
  // Same finding, narrower gate: reported, but this run does not block on it.
  const narrow = renderReportMarkdown(comments, gate(comments, "P0"));
  assert.match(narrow, /💬 P1/);
  assert.ok(!narrow.includes("❌ P1"));
});

test("the markdown report keeps the body as prose rather than pre-formatted text", () => {
  const long =
    "[P0] **Title**\n\n" +
    "A body long enough that the terminal renderer would hard-wrap it at seventy-eight columns and destroy it.";
  const md = renderReportMarkdown([mdFinding("a.ts", 1, long)], gate([], "P0,P1"));
  // One unbroken line — the reader reflows, we do not.
  assert.match(md, /^A body long enough that the terminal renderer would hard-wrap it at seventy-eight columns and destroy it\.$/m);
  assert.ok(!md.includes("["), "no ANSI escapes may reach a chat transcript");
});

// --------------------------------------------------------------- git modes ---

// A throwaway repo, because every mode decision is a question about real git
// state and mocking git would only prove the mock agrees with itself.
function scratchRepo(t) {
  // realpath because macOS resolves /var -> /private/var, and git reports the
  // resolved form — an unresolved base would make every path comparison fail.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ocr-harness-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  run("commit", "-q", "--allow-empty", "-m", "root");
  return { dir, run };
}

test("an explicit flag always wins over the auto-detection", (t) => {
  const { dir } = scratchRepo(t);
  assert.equal(resolveMode({ commit: "abc123" }, dir).mode, "commit");
  assert.equal(resolveMode({ worktree: true }, dir).mode, "workspace");
  assert.equal(resolveMode({ from: "main", to: "HEAD" }, dir).mode, "range");
});

// ------------------------------------------------------------ pull request ---

test("a pull request range is labelled as one, so the plan can explain itself", (t) => {
  const { dir } = scratchRepo(t);
  // resolvePr() has already done the network half; resolveMode only labels.
  const range = resolveMode({ from: "refs/orcacode/pr/7/base", to: "refs/orcacode/pr/7/head", pr: 7 }, dir);
  assert.equal(range.mode, "range");
  assert.equal(range.code, "pr");
  assert.equal(range.pr, 7);
  assert.ok(MODE_REASON.pr, "the prompt must be able to render the reason");
});

test("a range the user typed is not mistaken for a pull request", (t) => {
  const { dir } = scratchRepo(t);
  const range = resolveMode({ from: "main", to: "HEAD" }, dir);
  assert.equal(range.code, "explicit");
  assert.equal(range.pr, undefined);
});

test("a pull request number that is not one fails before anything is fetched", (t) => {
  const { dir } = scratchRepo(t);
  for (const bad of ["", "abc", "12x", undefined, "-3"]) {
    const r = resolvePr(bad, dir);
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad-number", `${bad} should be rejected as a number`);
  }
  // A leading # is how people write it, and is not an error.
  assert.notEqual(resolvePr("#556", dir).code, "bad-number");
});

test("the plan carries pull request metadata only when there is a pull request", (t) => {
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");
  const plan = buildPlan({ from: "main~1", to: "HEAD" }, dir);
  assert.equal(plan.pr, null, "no --pr means no pr block, not a partial one");
  assert.ok(!renderPlan(plan).includes("pull request:"));
});

test("the prompt names the pull request and warns when its head is a fork", (t) => {
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");
  const plan = buildPlan(
    {
      from: "main~1",
      to: "HEAD",
      pr: 556,
      prMeta: { number: 556, title: "Fix the thing", url: "https://x/556", fork: true, head: "feat/x", base: "main" },
    },
    dir,
  );
  const text = renderPlan(plan);
  assert.match(text, /pull request: #556 Fix the thing/);
  assert.match(text, /https:\/\/x\/556/);
  assert.match(text, /from a fork/);
});

test("a multi-line background becomes its own section instead of eating the scope list", (t) => {
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");

  const oneLine = renderPlan(buildPlan({ from: "main~1", to: "HEAD", background: "make it fast" }, dir));
  assert.match(oneLine, /- background: make it fast/);
  assert.ok(!oneLine.includes("### Background"));

  // A PR body is always multi-line; inlined after "- background:" it swallows
  // the rest of the bullet list.
  const body = renderPlan(buildPlan({ from: "main~1", to: "HEAD", background: "Title\n\nSecond para" }, dir));
  assert.ok(!body.includes("- background:"));
  assert.match(body, /### Background/);
  assert.match(body, /^> Title$/m);
  assert.match(body, /^> Second para$/m);
  // The scope list must still be intact below it.
  assert.match(body, /### Files to review \(1\)/);
  // And the reviewer must be told the description is a claim, not a fact.
  assert.match(body, /disagrees with the code is itself a finding/);
});

test("a dirty tree auto-selects workspace, and says so", (t) => {
  const { dir } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  const r = resolveMode({}, dir);
  assert.equal(r.mode, "workspace");
  assert.equal(r.code, "auto-dirty");
});

test("a clean tree with nothing ahead of the base has nothing to review", (t) => {
  const { dir } = scratchRepo(t);
  const r = resolveMode({}, dir);
  assert.equal(r.mode, "empty");
  assert.equal(r.code, "not-ahead");
});

test("a clean tree ahead of the base auto-selects the range CI would use", (t) => {
  const { dir, run } = scratchRepo(t);
  run("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  run("add", "-A");
  run("commit", "-q", "-m", "add a");
  const r = resolveMode({}, dir);
  assert.equal(r.mode, "range");
  assert.equal(r.code, "auto-ahead");
  assert.equal(r.to, "HEAD");
});

test("porcelain's leading status space does not eat the first path", (t) => {
  // `git status --porcelain` is fixed-column: " M foo" for an unstaged edit.
  // Trimming the buffer strips that space off the FIRST line only, which
  // silently truncates one path per run and looks like a git bug, not ours.
  // (.ts, not .txt: the selector now drops unsupported types, and this test is
  // about porcelain parsing, not about what is reviewable.)
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "tracked.ts"), "one\n");
  run("add", "-A");
  run("commit", "-q", "-m", "tracked");
  fs.writeFileSync(path.join(dir, "tracked.ts"), "two\n");
  fs.writeFileSync(path.join(dir, "untracked.ts"), "new\n");

  const { files } = selectFiles({ mode: "workspace" }, dir);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["tracked.ts", "untracked.ts"]);
});

test("an untracked directory is expanded into files, not reported as a directory", (t) => {
  const { dir } = scratchRepo(t);
  fs.mkdirSync(path.join(dir, "nested", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "nested", "deep", "x.ts"), "x\n");
  const { files } = selectFiles({ mode: "workspace" }, dir);
  assert.deepEqual(files.map((f) => f.path), ["nested/deep/x.ts"]);
});

test("a deleted file is not offered for review", (t) => {
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "gone.txt"), "bye\n");
  run("add", "-A");
  run("commit", "-q", "-m", "add");
  fs.rmSync(path.join(dir, "gone.txt"));
  const { files } = selectFiles({ mode: "workspace" }, dir);
  assert.deepEqual(files, [], "there is no code left to file a finding against");
});

// ------------------------------------------------------------------- plan ---

test("the plan carries everything a reviewer needs and nothing it must ask for", (t) => {
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# House rules\n\nTabs, not spaces.\n");
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  run("add", "-A");
  run("commit", "-q", "-m", "c");
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 2;\n");

  const plan = buildPlan({}, dir);
  assert.equal(plan.schema_version, SCHEMA_VERSION);
  assert.equal(plan.mode, "workspace");
  assert.equal(plan.result_path, path.join(dir, WORK_DIR, "result.json"));

  const text = renderPlan(plan);
  // The severity contract, in full — a reviewer that has to go find the rubric
  // will use one it already knows, and that one is not P0-P3.
  assert.match(text, /\[P0\].*\[P1\].*\[P2\].*\[P3\]/s);
  assert.match(text, /calibration, not suppression/, "the P2/P3 emit rule must survive");
  assert.match(text, /start_line/);
  assert.match(text, /existing_code/);
  assert.match(text, /review submit/, "the reviewer must be told how to hand back");
  // Project conventions, wrapped in the untrusted-data framing the Action uses.
  assert.match(text, /House rules/);
  assert.match(text, /untrusted project conventions/);
});

test("the plan filters files with the bundled rules and says why each one is out", (t) => {
  // Before: `ocr delegate preview` if the binary happened to be installed,
  // plain git otherwise, and the plan had to confess which. Now there is one
  // path, it needs nothing installed, and every exclusion names its reason.
  const { dir, run } = scratchRepo(t);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "src/a.test.ts"), "test();\n");
  fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  fs.writeFileSync(path.join(dir, "Makefile"), "all:\n");
  run("add", "-A");
  run("commit", "-q", "-m", "files");
  const plan = buildPlan({ from: "main~1", to: "HEAD" }, dir);

  assert.equal(plan.selector, "builtin");
  assert.deepEqual(plan.files.map((f) => f.path).sort(), ["Makefile", "src/a.ts"]);
  assert.deepEqual(
    plan.excluded.map((f) => [f.path, f.code]).sort(),
    [["logo.png", "binary"], ["src/a.test.ts", "default_path"]],
  );
  // The .ts file resolves to a real checklist, not the default one.
  const ts = plan.rule_groups.find((g) => g.files.includes("src/a.ts"));
  assert.ok(ts, "a rule group for the .ts file");
  assert.notEqual(ts.pattern, "default");

  const text = renderPlan(plan);
  assert.match(text, /bundled Open Code Review rules/);
  assert.match(text, /### Excluded \(2\)/);
  assert.match(text, /`logo\.png` — binary/);
  assert.ok(!/ocr not installed/.test(text), "the old fallback confession is gone");
});

test("a deleted file is listed as excluded, not silently dropped", (t) => {
  const { dir, run } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "gone.ts"), "1\n");
  run("add", "-A");
  run("commit", "-q", "-m", "add");
  run("rm", "-q", "gone.ts");
  run("commit", "-q", "-m", "rm");
  const plan = buildPlan({ from: "main~1", to: "HEAD" }, dir);
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.excluded.map((f) => [f.path, f.code]), [["gone.ts", "deleted"]]);
});

test("numstat gives real line counts and survives a rename", (t) => {
  const { dir, run } = scratchRepo(t);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/old.ts"), "a\nb\nc\n");
  run("add", "-A");
  run("commit", "-q", "-m", "one");
  run("mv", "src/old.ts", "src/new.ts");
  fs.appendFileSync(path.join(dir, "src/new.ts"), "d\n");
  run("add", "-A");
  run("commit", "-q", "-m", "two");
  const plan = buildPlan({ from: "main~1", to: "HEAD" }, dir);
  const f = plan.files.find((x) => x.path === "src/new.ts");
  assert.ok(f, "the renamed file is listed under its new name");
  assert.equal(f.insertions, 1);
  assert.equal(f.deletions, 0);
});

test("a repo with nothing to review yields no plan rather than an empty one", (t) => {
  const { dir } = scratchRepo(t);
  const plan = buildPlan({}, dir);
  assert.equal(plan.range.mode, "empty");
  assert.deepEqual(plan.files, []);
});

// ------------------------------------------------------------------ skill ---

// The skill is a prompt, and the rules below are the ones an editor is most
// likely to soften without noticing what they were load-bearing for.
const SKILL = fs.readFileSync(new URL("../skills/orca-review/SKILL.md", import.meta.url), "utf8");

test("the skill routes Action setup to the OTHER skill instead of absorbing it", () => {
  // Two skills install together. If this one starts explaining CI setup, an
  // agent will half-configure a workflow from a file that never mentions the
  // secret, and the user gets a workflow that fails on auth.
  assert.match(SKILL, /orca-review-action/);
  assert.match(SKILL, /\*\*Not this skill\.\*\*/);
});

test("the skill forbids substituting a summary for the gate", () => {
  // The position check re-homes and deduplicates, so the findings the agent is
  // holding are NOT the findings that survive. Summarising instead of running
  // `submit` reports a set that the merge gate never agreed to.
  assert.match(SKILL, /Relay that markdown to the user verbatim/);
  assert.match(SKILL, /Do not re-summarise it/i);
  assert.match(SKILL, /the gate decides what blocks, not you/i);
});

test("the skill reads the verdict from the report, not from the exit code", () => {
  // Observed in the wild, twice: the host rendered exit 1 as "Error: Exit code
  // 1", and both the agent and the user read a working review as a crash. Exit
  // 0 is now the default, so the skill must be explicit that 0 ≠ passed.
  assert.match(SKILL, /The exit code is not the verdict/);
  // The verdict word is localized now, so the skill teaches the mark, not the word.
  assert.match(SKILL, /❌ \(`Blocked`,\s+`已拦截`/);
  assert.match(SKILL, /✅ means nothing/);
});

test("the skill keeps exit 2 a failure", () => {
  // The one thing the 0 default must not teach: an unusable result is not a pass.
  assert.match(SKILL, /Exit `2` is the only failure, and it is never a pass/);
});

test("the skill asks for the markdown report, not the terminal one", () => {
  // The default is ANSI hard-wrapped at 78 columns; pasted into a chat it is a
  // wall of pre-formatted text, which is the whole reason --format md exists.
  // The bare form: no extra flag an agent could forget.
  assert.match(SKILL, /review submit --format md --lang en/);
  // Observed: an agent copied the example's `--lang zh` verbatim for an English
  // request. The example must not carry a language that looks like an answer.
  assert.match(SKILL, /Do not copy the example's value; read the conversation/);
});

test("the skill states the credential posture, because that is the reason it exists", () => {
  assert.match(SKILL, /no OrcaRouter account, no API key/i);
  assert.match(SKILL, /Nothing here talks to OrcaRouter/);
});

test("the skill keeps P2/P3 reportable and warns off a foreign severity scheme", () => {
  assert.match(SKILL, /Do not drop P2 and P3/);
  assert.match(SKILL, /High\/Medium\/Low is a different tool's\s+vocabulary/);
  // Untagged defaults to P1 and blocks; an agent that does not know this will
  // ship untagged findings and be surprised by a red gate.
  assert.match(SKILL, /Untagged findings default to P1/);
});

test("the skill names the verification key and why a paraphrase breaks it", () => {
  assert.match(SKILL, /existing_code/);
  assert.match(SKILL, /copied verbatim/i);
  assert.match(SKILL, /start_line/);
});

test("the skill forbids checking a branch out to review a pull request", () => {
  // The whole point of --pr is that it is non-destructive. An agent that
  // "helpfully" checks out first can destroy uncommitted work.
  assert.match(SKILL, /--pr 556/);
  assert.match(SKILL, /do \*\*not\*\* check the branch out first/i);
  assert.match(SKILL, /Do not switch branches to review a PR/i);
});

test("the skill tells the agent to hand gh problems back rather than fix them", () => {
  assert.match(SKILL, /gh pr checkout/);
  assert.match(SKILL, /Do not run it for them|do not try to install or\s*\n?authenticate it/i);
});

test("the skill and the plan agree on where the result goes", () => {
  assert.ok(SKILL.includes(`${WORK_DIR}/result.json`), `SKILL.md must name ${WORK_DIR}/result.json`);
});
