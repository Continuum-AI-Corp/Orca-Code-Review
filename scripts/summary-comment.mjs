#!/usr/bin/env node
// Edit-in-place PR summary comment for the OrcaCode Review action.
//
//   node summary-comment.mjs <result.json> --tier cheap|strong --push <n>
//     --gate pass|blocked [--prev <file with the previous comment body>]
//     [--passes <n>] [--quiet] [--block-on P0,P1] [--excluded <file.json>]
//     [--lockfiles <file.json>]
//
// --lockfiles names guard-diff.mjs's list of changed lockfiles the diff-size
// limit did not count (the engine still read them); listed the same way.
//
// --excluded names excluded-files.mjs's output: the changed files the engine
// skips (tests, fixtures, generated code, binaries, unsupported types). They
// are listed under the gate line, so a reader sees what the verdict does NOT
// cover. File names are attacker-controlled, so each renders inside a code span
// with control characters, backticks and pipes neutralised.
//
// Prints the summary MARKDOWN to stdout. The driver (action.yml) writes it into
// a marker-delimited region of the PR DESCRIPTION body (scripts/inject-summary.mjs),
// replacing that region in place on every push — ONE summary per PR, pinned at
// the top of the description, so the comment timeline is never spammed. The
// marker line below still leads the markdown (inject-summary wraps it) so the
// next push can read the machine-state line back for the push counter + Δ column.
//
// Structure (locked by summary-comment.test.mjs; the wording is deliberately
// stable — downstream tooling greps it):
//   line 1  <!-- orca-code-review-summary -->   upsert marker; keep in sync
//                                               with the action.yml step
//   line 2  <!-- orca-cr-state: {"p0":…,"p1":…,"p2":…,"p3":…,"push":…} -->
//           machine state: the NEXT run feeds this body back via --prev for
//           the Δ column, and reads .push to number itself
//   then    "## OrcaCode Review — push N", the severity table (the
//           "Δ vs previous push" column appears only when --prev carries a
//           parseable state line), a tier-state line, and a gate line.
//
// Mode notes: `--passes <n>` (default 1) adds "exhaustive: N passes" after
// the tier line when N > 1 — the exhaustive loop made extra engine passes for
// this result; `--quiet` adds "quiet mode: P2 shown in summary only" — the
// driver muted inline P2 comments, so this table is where P2s live. Neither
// note touches the machine-state line.
//
// Severity counts use the shared severity.mjs (leading tag, untagged->P1
// fail-safe) — the same numbers the gate and the run report see. The gate
// line's blocking COUNT is normally computed over the `--block-on` set (default
// "P0,P1"; the driver passes the effective, dashboard-aware value, so a repo
// blocking on P2 sees its P2 count, not a hardcoded P0+P1). The pass/blocked
// verdict itself always comes from --gate, which the driver computes with the
// same configuration.
//
// ALWAYS over block-on, with no exception. There used to be one: a held run —
// a cheap pass withholding the strong review over a fix-first finding — counted
// over the fix-first set instead, because block-on need not contain those
// severities and "❌ 0 findings block merge" beside a "held" tier line
// contradicts itself. The cascade went, and the tier line with it, so the count
// and the gate read the same set, which is the property that matters: the
// summary cannot claim something the merge gate does not enforce.
//
// --held and --fix-first went with it here, having been parsed and then read by
// nothing for as long as the exception has been gone. fix-first REMAINS an action
// input — it stops the exhaustive loop early, see action.yml — and must not be
// wired back into this count on the strength of that name: the two answer
// different questions, which is what the paragraph above is about.

import fs from "node:fs";
import { SEVERITIES, countSeverities } from "./severity.mjs";

const MARKER = "<!-- orca-code-review-summary -->";
const STATE_RE = /<!-- orca-cr-state: (\{.*?\}) -->/;

const usage = () => {
  console.error(
    "usage: node summary-comment.mjs <result.json> --tier cheap|strong --push <n> " +
      "--gate pass|blocked [--prev <file>] [--passes <n>] [--quiet] [--block-on P0,P1]",
  );
  process.exit(2);
};

const [file, ...rest] = process.argv.slice(2);
const opts = { passes: "1", blockOn: "P0,P1" };
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--tier") opts.tier = rest[++i];
  else if (rest[i] === "--push") opts.push = rest[++i];
  else if (rest[i] === "--gate") opts.gate = rest[++i];
  else if (rest[i] === "--prev") opts.prev = rest[++i];
  else if (rest[i] === "--passes") opts.passes = rest[++i];
  else if (rest[i] === "--quiet") opts.quiet = true;
  else if (rest[i] === "--block-on") opts.blockOn = rest[++i];
  else if (rest[i] === "--excluded") opts.excluded = rest[++i];
  else if (rest[i] === "--lockfiles") opts.lockfiles = rest[++i];
  // NO else: an unrecognised flag, and the value that follows it, are skipped
  // one token at a time. That is what makes removing --fix-first safe to ship
  // ahead of the caller that still passes it — the pair falls through without
  // shifting the flags after it.
}
const push = Number(opts.push);
const passes = Number(opts.passes);
// Severity-set normalization for --block-on: trim + uppercase, empty = the
// empty set (valid — a deliberate "block on nothing").
const parseSet = (v) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
const blockOn = parseSet(opts.blockOn);
if (
  !file ||
  !["pass", "blocked"].includes(opts.gate) ||
  !Number.isInteger(push) ||
  push < 1 ||
  !Number.isInteger(passes) ||
  passes < 1 ||
  blockOn.some((s) => !SEVERITIES.includes(s))
) {
  usage();
}

// Counts render as zeros when the result is unreadable: this comment reports
// state; the gate step (not this script) owns failing the run.
let comments = [];
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(parsed.comments)) comments = parsed.comments;
} catch (e) {
  console.error(`summary-comment: could not read findings from ${file} (${e.message}) — rendering zero counts`);
}
const counts = countSeverities(comments);

// Previous push's state, for the Δ column. Absent/garbled state (first push,
// hand-edited comment) just omits the column — never an error.
let prev = null;
if (opts.prev) {
  try {
    const m = fs.readFileSync(opts.prev, "utf8").match(STATE_RE);
    const s = m ? JSON.parse(m[1]) : null;
    if (s && ["p0", "p1", "p2"].every((k) => Number.isFinite(s[k]))) prev = s;
  } catch {
    prev = null;
  }
}

const delta = (d) => (d > 0 ? `+${d}` : String(d));
const state = { p0: counts.P0, p1: counts.P1, p2: counts.P2, p3: counts.P3, push };

const lines = [MARKER, `<!-- orca-cr-state: ${JSON.stringify(state)} -->`, ""];
lines.push(`## OrcaCode Review — push ${push}`, "");
if (prev) {
  lines.push("| Severity | Count | Δ vs previous push |", "|---|---|---|");
  for (const s of SEVERITIES) {
    lines.push(`| ${s} | ${counts[s]} | ${delta(counts[s] - (prev[s.toLowerCase()] ?? 0))} |`);
  }
} else {
  lines.push("| Severity | Count |", "|---|---|");
  for (const s of SEVERITIES) lines.push(`| ${s} | ${counts[s]} |`);
}
lines.push("");

// NO TIER LINE. It used to read "Tier: STRONG (final pass) — pass" and there is
// one tier now, so the line said nothing the ✅/❌ verdict below does not already
// say — and while the cascade existed it was also the only place a reader learned
// their P0/P1 findings were withholding a second review. That mechanism is gone;
// leaving its label behind would describe a decision nothing makes.
//
// Mode notes keep the status block they shared with it.
if (passes > 1) lines.push(`exhaustive: ${passes} passes`);
if (opts.quiet) lines.push("quiet mode: P2 shown in summary only");
lines.push("");

// Counted over block-on, which is what the gate enforces. The --held variant
// (count over fix-first instead) went with the cascade: it existed so a withheld
// escalation would not render "❌ 0 findings block merge" beside a held tier line,
// and there is neither withholding nor a tier line any more. See the header.
const blockingSet = blockOn;
const blocking = blockingSet.reduce((n, s) => n + counts[s], 0);
lines.push(
  opts.gate === "blocked"
    ? `❌ ${blocking} finding${blocking === 1 ? "" : "s"} block${blocking === 1 ? "s" : ""} merge`
    : "✅ no blocking findings",
);

// What the verdict above does not cover. Best-effort: an unreadable list
// renders nothing rather than failing the summary.
let skipped = { excluded: [], omitted: 0 };
if (opts.excluded) {
  try {
    const j = JSON.parse(fs.readFileSync(opts.excluded, "utf8"));
    if (Array.isArray(j.excluded)) skipped = { excluded: j.excluded, omitted: Number(j.omitted) || 0 };
  } catch {
    /* no list */
  }
}
// One table cell of attacker-controlled text: no line breaks or control
// characters (they would end the table), no backticks (they would end the code
// span), pipes escaped (they would end the cell), and a bounded length.
const cell = (v, max) =>
  String(v ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/`/g, "'")
    .slice(0, max)
    .replace(/\|/g, "\\|");
if (skipped.excluded.length) {
  const total = skipped.excluded.length + skipped.omitted;
  lines.push(
    "",
    `<details><summary>Not reviewed: ${total} changed file${total === 1 ? "" : "s"} the review engine skips</summary>`,
    "",
    "| File | Why |",
    "|---|---|",
    ...skipped.excluded.map((e) => `| \`${cell(e.path, 200)}\` | ${cell(e.reason, 120)} |`),
  );
  if (skipped.omitted) lines.push("", `…and ${skipped.omitted} more.`);
  lines.push("", "</details>");
}

// Lockfiles the diff-size limit did not count (guard-diff.mjs). Best-effort.
let lockfiles = [];
if (opts.lockfiles) {
  try {
    const j = JSON.parse(fs.readFileSync(opts.lockfiles, "utf8"));
    if (Array.isArray(j.lockfiles)) lockfiles = j.lockfiles.slice(0, 50);
  } catch {
    /* no list */
  }
}
if (lockfiles.length) {
  lines.push(
    "",
    `Lockfiles not counted toward the diff-size limit: ${lockfiles.map((p) => `\`${cell(p, 200)}\``).join(", ")}.`,
  );
}

process.stdout.write(`${lines.join("\n")}\n`);
