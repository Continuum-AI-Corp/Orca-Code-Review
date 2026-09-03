// The harness surface: what an outside AI agent calls to run a review itself.
//
// The Action drives a review by paying an engine to think (Open Code Review's
// `ocr review`, against OrcaRouter). This file drives one WITHOUT buying any
// thinking: the caller — Claude Code, Codex, Cursor, whatever is holding the
// file — supplies the model out of its own subscription, and we supply
// everything that must not be left to a language model.
//
// Two commands, deliberately split at the point where judgement enters:
//
//   review plan     ->  everything BEFORE the model: which files are in scope,
//                       which rules apply to each, the severity rubric, the
//                       project's own conventions, and the exact result shape.
//   review submit   ->  everything AFTER the model: shape validation, the L1
//                       position check, the severity gate, the report, the exit
//                       code.
//
// WHY A SPLIT AND NOT ONE COMMAND. We cannot call the agent — the agent is
// calling us. So the surface has to be two halves it can sandwich itself
// between. That also makes both halves ordinary CLI commands any harness can
// script, which is the whole point of shipping a surface rather than a prompt.
//
// WHERE THE FILE SELECTION COMES FROM. The same place CI's engine gets it: Open
// Code Review's exclusion rules and per-language checklists, vendored as data
// under vendor/open-code-review and read by a port of its matcher in
// selection.mjs. No binary to install — the engine is 50 MB per platform and
// the review here needs a few hundred KB of it. What is NOT borrowed is the
// output contract: its own guidance is High/Medium/Low with "Low — discard
// silently"; ours is P0-P3 with calibrated boundaries and an explicit "P2 and
// P3 are all still emitted", because those tags feed a merge gate. So: their
// file selection, our severity semantics, one result.json shape shared with
// the Action.
//
// NOTHING HERE TALKS TO ORCAROUTER. No API key, no gateway, no control plane.
// A repo that never installs the Action can still use this.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SEVERITIES, severityOf, countSeverities } from "../scripts/severity.mjs";
import { partition, groupRules } from "./selection.mjs";
import { loadLocalConfig } from "./localconfig.mjs";
import { LANGUAGES, makeT } from "./i18n.mjs";

// How the plan names the language findings must be written in. Addressed to a
// model, so each name is given in the language itself and in English: the
// model must recognise it whatever language it happens to be thinking in.
export const LANGUAGE_NAMES = Object.freeze({
  en: "English",
  zh: "简体中文 (Simplified Chinese)",
  ja: "日本語 (Japanese)",
  ko: "한국어 (Korean)",
});

const englishT = makeT("en");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");

// Bumped only when the shape of `review plan --json` changes incompatibly, so a
// harness that pinned an older reading can detect the break instead of silently
// misreading a renamed field. Mirrors `ocr delegate`'s own schema_version.
export const SCHEMA_VERSION = "1";

// Where the request and the result live. Inside the work tree (every agent
// sandbox can write there — .git and $TMPDIR are not reliably writable under
// Codex's workspace-write or a container mount), but excluded from git via
// .git/info/exclude rather than .gitignore, so reviewing a repo never dirties
// it with a file the user then has to decide whether to commit.
export const WORK_DIR = ".orcacode-review";

// Four fields, and every one of them is load-bearing — see the field notes in
// renderPlan(). Deliberately the SHORT form: `line` rather than the
// `start_line`/`end_line` pair the pipeline speaks internally, and no
// `warnings` key. Both are widened at the boundary in validateResult(), and the
// difference is a third of the bytes an agent has to emit — which is a third
// less of an unreadable blob scrolling past the person watching it work.
const RESULT_SHAPE = `{
  "comments": [
    {
      "path": "src/auth.ts",
      "line": 41,
      "existing_code": "  if (token === expected) {",
      "content": "[P0] **Token comparison is not constant-time**\\n\\n\`===\` on a secret leaks its prefix through timing. Use \`crypto.timingSafeEqual\`."
    }
  ]
}`;

// The line a finding is anchored to, by the same rule the Action's posting step
// uses: the end of the range if there is one, else the start. Null when the
// position check cleared it — a re-homed finding whose line could not be
// resolved in its new file must render without one rather than with the stale
// number from the file it was wrongly filed on.
export function anchorLine(c) {
  if (Number(c?.end_line) >= 1) return Number(c.end_line);
  if (Number(c?.start_line) >= 1) return Number(c.start_line);
  return null;
}

// ------------------------------------------------------------------- git ---

// `raw: true` skips the trim. Porcelain is a fixed-column format whose first
// column can be a space (" M foo"), and trimming the whole buffer eats that
// space off the FIRST line only — which silently truncates one path per run and
// looks like a git bug rather than ours.
function git(args, cwd, { raw = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  const out = r.stdout || "";
  return { ok: r.status === 0, out: raw ? out.replace(/\n$/, "") : out.trim(), err: (r.stderr || "").trim() };
}

export function repoRoot(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  return r.ok ? r.out : null;
}

// Where `info/exclude` lives. In a linked worktree `.git` is a FILE pointing at
// the real store, so joining root + ".git" lands on a path that is not a
// directory and the exclude write silently does nothing.
export function gitCommonDir(cwd) {
  const r = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (r.ok && r.out) return r.out;
  // --path-format landed in git 2.31; fall back to the relative form.
  const rel = git(["rev-parse", "--git-common-dir"], cwd);
  if (!rel.ok || !rel.out) return null;
  return path.isAbsolute(rel.out) ? rel.out : path.resolve(cwd, rel.out);
}

// The branch a PR would target. Tried in the order that gets it right most
// often: what the remote actually says its HEAD is, then the conventional
// names. Returns null rather than guessing "main" — a wrong base produces a
// diff full of other people's work, which is worse than asking the caller.
export function defaultBranch(cwd) {
  const sym = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  if (sym.ok && sym.out) return sym.out.replace(/^refs\/remotes\//, "");
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).ok) return ref;
  }
  return null;
}

export function isDirty(cwd) {
  const r = git(["status", "--porcelain"], cwd);
  return r.ok && r.out.length > 0;
}

/**
 * Decides what "review my changes" means here.
 *
 * Explicit flags always win. With none, we pick between the two things a person
 * standing in a repo could mean, and SAY which we picked and why — an implicit
 * choice the user cannot see is a bug report waiting to happen:
 *
 *   dirty work tree            -> workspace (they are mid-change; that is the
 *                                 review they want before committing)
 *   clean, ahead of the base   -> range     (the branch, i.e. what CI will see)
 *   clean, not ahead           -> nothing to review
 */
export function resolveMode({ from, to, commit, worktree, pr }, cwd) {
  if (commit) return { mode: "commit", commit, code: "explicit" };
  if (worktree) return { mode: "workspace", code: "explicit" };
  if (from || to) {
    const base = from || defaultBranch(cwd);
    if (!base) return { mode: "error", code: "no-base" };
    // `pr` is only a label here — resolvePr() has already turned the number into
    // the two refs handed in as from/to. Keeping the resolution out of this
    // function keeps it synchronous, offline, and testable.
    const range = { mode: "range", from: base, to: to || "HEAD", code: pr ? "pr" : "explicit" };
    return pr ? { ...range, pr } : range;
  }

  if (isDirty(cwd)) return { mode: "workspace", code: "auto-dirty" };

  const base = defaultBranch(cwd);
  if (!base) return { mode: "error", code: "no-base" };
  const mb = git(["merge-base", base, "HEAD"], cwd);
  const head = git(["rev-parse", "HEAD"], cwd);
  if (!mb.ok || !head.ok) return { mode: "error", code: "no-compare", base };
  if (mb.out === head.out) return { mode: "empty", code: "not-ahead", base };
  return { mode: "range", from: base, to: "HEAD", code: "auto-ahead", base };
}

// The English rendering of `code`, for the plan prompt only. The terminal says
// the same thing through i18n — the prompt is never translated because it is
// model input, not user prose.
export const MODE_REASON = Object.freeze({
  explicit: "you asked for it",
  pr: "you named a pull request",
  "auto-dirty": "the work tree has uncommitted changes",
  "auto-ahead": "clean work tree, ahead of the base branch",
  "not-ahead": "HEAD has no commits beyond the base branch",
  "no-base": "no base branch could be resolved",
  "no-compare": "HEAD could not be compared with the base branch",
});

// ------------------------------------------------------------- pull request ---

// Namespaced so the fetch never creates a branch, never shows up in `git
// branch`, and never collides with anything the user owns. Re-fetching the same
// PR just moves these two refs.
const PR_REF_NS = "refs/orcacode/pr";

function gh(args, cwd) {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 1 << 24 });
  return {
    ok: r.status === 0,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
    missing: r.error?.code === "ENOENT",
  };
}

const firstLine = (s) => (s || "").split("\n").find((l) => l.trim()) || "";

// `refs/pull/N/head` lives on the BASE repository, which in a fork workflow is
// not `origin`. Ask gh which repo it resolved, then find the remote pointing at
// it, so a fork checkout fetches from upstream rather than failing.
function baseRemote(cwd) {
  const remotes = git(["remote"], cwd);
  const names = remotes.ok ? remotes.out.split("\n").filter(Boolean) : [];
  const slug = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd);
  if (slug.ok && slug.out) {
    const want = slug.out.toLowerCase();
    for (const name of names) {
      const url = git(["remote", "get-url", name], cwd);
      if (!url.ok) continue;
      const got = url.out
        .toLowerCase()
        .replace(/\.git$/, "")
        .replace(/^.*[:/]([^/:]+\/[^/]+)$/, "$1");
      if (got === want) return name;
    }
  }
  return names.includes("origin") ? "origin" : names[0] || "origin";
}

const refExists = (ref, cwd) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).ok;

/**
 * Turn a PR number into a reviewable range, without touching the work tree.
 *
 * Deliberately does NOT check the branch out. Checking out would stash-or-fail
 * on a dirty tree, move the user off what they were doing, and leave them
 * somewhere else when the review ends. Fetching the PR into a private ref
 * namespace gets the same diff and is invisible.
 *
 * `gh` is a soft dependency: absent, this returns `no-gh` and the caller tells
 * the user to check the branch out by hand. Nothing else in the harness needs
 * it, and nothing about the review changes when it is missing.
 *
 * Returns { ok: true, from, to, background, pr } or { ok: false, code, detail }.
 */
export function parsePrNumber(value) {
  const n = String(value ?? "")
    .trim()
    .replace(/^#/, "");
  return /^\d+$/.test(n) ? n : null;
}

export function resolvePr(number, cwd) {
  const n = parsePrNumber(number);
  if (!n) return { ok: false, code: "bad-number", detail: String(number ?? "") };

  if (gh(["--version"], cwd).missing) return { ok: false, code: "no-gh" };

  const fields = "number,title,body,url,state,baseRefName,headRefName,headRefOid,isCrossRepository";
  const view = gh(["pr", "view", n, "--json", fields], cwd);
  if (!view.ok) {
    const detail = firstLine(view.err);
    if (/auth|logged in|gh auth login/i.test(detail)) return { ok: false, code: "no-auth", detail };
    return { ok: false, code: "gh-failed", detail };
  }

  let meta;
  try {
    meta = JSON.parse(view.out);
  } catch {
    return { ok: false, code: "gh-failed", detail: "gh returned output that is not JSON" };
  }

  const remote = baseRemote(cwd);
  const head = `${PR_REF_NS}/${n}/head`;
  const base = `${PR_REF_NS}/${n}/base`;

  // Two fetches, not one refspec pair: a base branch deleted after merge must
  // not take the head fetch down with it.
  const headFetch = git(["fetch", "--no-tags", "--quiet", remote, `+refs/pull/${n}/head:${head}`], cwd);
  if (!headFetch.ok && !refExists(meta.headRefOid || head, cwd)) {
    return { ok: false, code: "fetch-failed", detail: firstLine(headFetch.err) };
  }

  git(["fetch", "--no-tags", "--quiet", remote, `+refs/heads/${meta.baseRefName}:${base}`], cwd);
  const from = refExists(base, cwd)
    ? base
    : [`${remote}/${meta.baseRefName}`, meta.baseRefName].find((r) => refExists(r, cwd)) || "";
  if (!from) return { ok: false, code: "no-base-ref", detail: meta.baseRefName };

  return {
    ok: true,
    from,
    to: refExists(head, cwd) ? head : meta.headRefOid,
    // The PR description is exactly the business context the rubric asks for —
    // what the change is FOR. Capped because a template-heavy body can dwarf the
    // rest of the prompt. An explicit --background still wins; see the caller.
    background: [meta.title, (meta.body || "").trim()].filter(Boolean).join("\n\n").slice(0, 4000),
    pr: {
      number: Number(n),
      title: meta.title || "",
      url: meta.url || "",
      state: meta.state || "",
      base: meta.baseRefName || "",
      head: meta.headRefName || "",
      fork: Boolean(meta.isCrossRepository),
    },
  };
}

export function mergeBaseOf(range, cwd) {
  if (range.mode !== "range") return "";
  const r = git(["merge-base", range.from, range.to], cwd);
  return r.ok ? r.out : "";
}

// The commit whose tree the L1 position check greps. Empty in workspace mode:
// uncommitted code is in no tree, so there is nothing to grep and the check has
// to be skipped rather than silently reporting every finding as unlocatable.
export function groundTruthRef(range, cwd) {
  if (range.mode === "commit") return range.commit;
  if (range.mode === "range") {
    const r = git(["rev-parse", range.to], cwd);
    return r.ok ? r.out : range.to;
  }
  return "";
}

// The git incantation the agent should run per file to see the change. Handed
// over as a string rather than run for them: the agent already has shell and a
// repo checkout, and a diff we paste into the plan would be a second copy that
// can disagree with the tree they are reading.
export function diffRecipe(range, mergeBase) {
  switch (range.mode) {
    case "range":
      return `git diff ${mergeBase || range.from}..${range.to} -- <path>`;
    case "commit":
      return `git show ${range.commit} -- <path>`;
    default:
      return "git diff HEAD -- <path>   # and for an untracked file, just read it";
  }
}

// --------------------------------------------------------------- selector ---

/**
 * Which files are in scope, and why the others are not.
 *
 * Git says what changed; the vendored Open Code Review rules say what is worth
 * a reviewer's time — binaries, deleted files, unsupported types, tests and
 * fixtures and generated code by default pattern, anything under .gitignore or
 * an always-skipped directory. Each exclusion carries a REASON, which plain git
 * cannot give and which the plan shows so a reviewer never wonders where a file
 * went.
 *
 * Returns { selector, files, excluded, merge_base }.
 */
export function selectFiles(range, cwd, { exclude = [] } = {}) {
  const { files, excluded } = partition(gitFiles(range, cwd).files, cwd, { exclude });
  return { selector: "builtin", files, excluded, merge_base: "" };
}

function gitFiles(range, cwd) {
  const args =
    range.mode === "commit"
      ? ["show", "--name-status", "--format=", range.commit]
      : range.mode === "range"
        ? ["diff", "--name-status", `${range.from}...${range.to}`]
        : // -uall expands an untracked DIRECTORY into its files; without it
          // porcelain reports "newdir/" and the reviewer gets a path that is
          // not a file.
          ["status", "--porcelain", "-uall"];

  const r = git(args, cwd, { raw: range.mode === "workspace" });
  if (!r.ok || !r.out) return { files: [], excluded: [] };

  const stats = numstat(range, cwd);
  const files = [];
  for (const raw of r.out.split("\n")) {
    // NOT trimmed. Porcelain is a fixed-column format — "XY path" where either
    // status column may be a SPACE (" M foo" = modified, unstaged). Trimming
    // the line shifts the path left and slices characters off the front of it.
    if (!raw.trim()) continue;

    let status;
    let file;
    if (range.mode === "workspace") {
      status = raw.slice(0, 2);
      file = raw.slice(3);
    } else {
      // --name-status is "X\tpath", and a rename is "R100\told\tnew" — the new
      // path is the one that exists now.
      const parts = raw.split("\t");
      status = parts[0];
      file = parts[parts.length - 1];
    }

    // A rename in porcelain is "R  old -> new" on one line.
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) file = file.slice(arrow + 4);
    // Porcelain quotes any path with unusual characters and escapes them; the
    // quotes are not part of the name.
    file = file.replace(/^"(.*)"$/, "$1");
    if (!file) continue;

    // A deleted file is kept HERE and excluded by the selector, with the reason
    // stated — dropping it silently left a reviewer counting files that were
    // never listed.
    const st = stats.get(file) || { insertions: 0, deletions: 0, binary: false };
    files.push({
      path: file,
      status: status.trim(),
      insertions: st.insertions,
      deletions: st.deletions,
      binary: st.binary,
      deleted: status.trim().startsWith("D"),
    });
  }
  return { files, excluded: [] };
}

// Per-file line counts and the binary flag, from --numstat, keyed by the path
// that exists now. A binary shows as "-\t-\tpath". A rename shows either as
// "old => new" or with the changed part braced, "dir/{old => new}/file"; both
// are reduced to the new name so they join the --name-status row.
function numstat(range, cwd) {
  const args =
    range.mode === "commit"
      ? ["show", "--numstat", "--format=", range.commit]
      : range.mode === "range"
        ? ["diff", "--numstat", `${range.from}...${range.to}`]
        : ["diff", "--numstat", "HEAD"];
  const r = git(args, cwd);
  const out = new Map();
  if (!r.ok || !r.out) return out;
  for (const line of r.out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    let file = m[3].replace(/^"(.*)"$/, "$1");
    file = file.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1").replace(/\/\//g, "/");
    const arrow = file.indexOf(" => ");
    if (arrow >= 0) file = file.slice(arrow + 4);
    out.set(file, {
      binary: m[1] === "-",
      insertions: m[1] === "-" ? 0 : Number(m[1]),
      deletions: m[2] === "-" ? 0 : Number(m[2]),
    });
  }
  return out;
}

/**
 * Review rules per file, grouped so files sharing a checklist appear once.
 *
 * The checklist corpus is Open Code Review's, keyed on file type (go.md,
 * java.md, package_json.md, …) and vendored here; selection.mjs resolves each
 * path against it. `ref` is the side of the diff to read a file at when the
 * rule depends on content (the ".m" MATLAB/Objective-C sniff), so a commit that
 * is not checked out still resolves correctly.
 */
export function ruleGroups(files, cwd, range, rules = []) {
  if (files.length === 0) return [];
  const ref = range?.mode === "commit" ? range.commit : range?.mode === "range" ? range.to : "";
  return groupRules(
    files.map((f) => f.path),
    { repoDir: cwd, ref, rules },
  );
}

// ---------------------------------------------------------------- rubric ---

const readRule = (name) => fs.readFileSync(path.join(PKG_ROOT, "rules", name), "utf8").trim();

// The project's own conventions doc, wrapped in the same untrusted-data framing
// the Action uses. Read from the work tree here (the local user owns their
// checkout) rather than from the base revision (where CI reads it, because
// there a PR author could otherwise rewrite the rules being applied to them).
export function conventions(cwd) {
  for (const name of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]) {
    const file = path.join(cwd, name);
    let doc;
    try {
      doc = fs.readFileSync(file, "utf8").trim();
    } catch {
      continue;
    }
    if (!doc) continue;
    return {
      file: name,
      text: [
        readRule("conventions-directive.md"),
        "",
        `----- BEGIN ${name} (untrusted project conventions; read-only reference) -----`,
        doc,
        `----- END ${name} -----`,
      ].join("\n"),
    };
  }
  return { file: null, text: "" };
}

export function rubric(cwd) {
  return {
    severity: readRule("severity-instruction.md"),
    output_shape: readRule("output-shape.md"),
    conventions: conventions(cwd),
  };
}

// ------------------------------------------------------------------ plan ---

export function buildPlan(opts, cwd) {
  const range = resolveMode(opts, cwd);
  if (range.mode === "error" || range.mode === "empty") return { range, files: [] };

  // The repo's own settings. An invalid file is the caller's to report (see
  // cmdReviewPlan) — here it counts as absent so buildPlan stays total.
  const loaded = opts.config ?? loadLocalConfig(cwd);
  const config = loaded.ok ? loaded.config : {};

  const selection = selectFiles(range, cwd, { exclude: config.exclude || [] });
  const mergeBase = selection.merge_base || mergeBaseOf(range, cwd);

  return {
    schema_version: SCHEMA_VERSION,
    range,
    mode: range.mode,
    repository: cwd,
    from: range.from || "",
    to: range.to || "",
    commit: range.commit || "",
    merge_base: mergeBase,
    pr: opts.prMeta || null,
    background: opts.background || "",
    // The language the findings are to be written in — the user's, as resolved
    // by the CLI (locale, or --lang). The rubric stays English regardless: it is
    // a contract shared with the Action, and tags like [P1] are tokens.
    language: LANGUAGES.includes(opts.language) ? opts.language : "en",
    config: loaded.ok && loaded.file ? { file: loaded.file, ...config, rules: (config.rules || []).map((r) => ({ path: r.path, replace: r.replace, source: r.source })) } : null,
    selector: selection.selector,
    files: selection.files,
    excluded: selection.excluded,
    rule_groups: ruleGroups(selection.files, cwd, range, config.rules || []),
    diff_recipe: diffRecipe(range, mergeBase),
    rubric: rubric(cwd),
    result_path: path.join(cwd, WORK_DIR, "result.json"),
    result_shape: RESULT_SHAPE,
  };
}

/**
 * The plan as the prompt an agent actually follows.
 *
 * Written in the imperative, addressed to the reviewer, because that is what it
 * is: this text is pasted into a model's context. It is deliberately NOT
 * translated — flags, rule text, and severity tags are verbatim tokens, and the
 * rubric it embeds is English.
 */
export function renderPlan(plan) {
  const L = [];
  const p = (s = "") => L.push(s);

  p("# OrcaCode Review — review request");
  p();
  p("You are the reviewer. Everything below is fixed; follow it exactly.");
  p();
  p("## Scope");
  p();
  p(`- mode: ${plan.mode} (${MODE_REASON[plan.range.code] || plan.range.code})`);
  if (plan.pr) {
    p(`- pull request: #${plan.pr.number} ${plan.pr.title}`.trimEnd());
    if (plan.pr.url) p(`- pull request url: ${plan.pr.url}`);
    // Said out loud because it changes how to read the diff: a fork PR's head is
    // not in this repo's branches, and the base is where it is going, not where
    // it came from.
    if (plan.pr.fork) p(`- from a fork; head branch \`${plan.pr.head}\` is not a branch of this repository`);
  }
  if (plan.from) p(`- from: ${plan.from}`);
  if (plan.to) p(`- to: ${plan.to}`);
  if (plan.commit) p(`- commit: ${plan.commit}`);
  if (plan.merge_base) p(`- merge_base: ${plan.merge_base}`);
  // One line stays a bullet. Anything longer gets its own section — a PR body
  // pasted after "- background:" swallows the rest of the list into itself and
  // the reader (a model) loses where the scope ends.
  if (plan.background && !plan.background.includes("\n")) p(`- background: ${plan.background}`);
  p("- file selection: git, filtered by the bundled Open Code Review rules (exclusions and per-language checklists)");
  if (plan.config) p(`- project settings: \`${plan.config.file}\`${plan.config.exclude?.length ? ` (${plan.config.exclude.length} extra exclude${plan.config.exclude.length === 1 ? "" : "s"})` : ""}${plan.config.rules?.length ? ` (${plan.config.rules.length} project rule${plan.config.rules.length === 1 ? "" : "s"})` : ""}`);
  if (plan.background && plan.background.includes("\n")) {
    p();
    p("### Background — what this change is for");
    p();
    p("Judge the change against this intent, but do not treat it as true: a");
    p("description that disagrees with the code is itself a finding.");
    p();
    for (const line of plan.background.split("\n")) p(`> ${line}`.trimEnd());
  }
  p();
  p(`### Files to review (${plan.files.length})`);
  p();
  for (const f of plan.files) p(`- \`${f.path}\`${f.status ? ` [${f.status}]` : ""}`);
  if (plan.excluded.length) {
    p();
    p(`### Excluded (${plan.excluded.length}) — do not review these`);
    p();
    for (const f of plan.excluded) p(`- \`${f.path}\` — ${f.reason}`);
  }
  p();
  p("Review only the changed lines. See each file's change with:");
  p();
  p("```bash");
  p(plan.diff_recipe);
  p("```");
  p();
  p("Read the surrounding file when you need context — you have the repo, and a");
  p("finding you could not confirm by reading the code is a finding to drop.");

  if (plan.rule_groups.length) {
    p();
    p("## Review rules");
    p();
    p("Each group is the checklist for the files listed under it.");
    for (const g of plan.rule_groups) {
      p();
      p(`### Group ${g.group_id}${g.pattern ? ` — \`${g.pattern}\`` : ""}`);
      p();
      for (const f of g.files || []) p(`- \`${f}\``);
      p();
      p(g.rule);
    }
  }

  p();
  p("## Language");
  p();
  p(`Write every finding — its title, its explanation, and its **Fix:** paragraph — in ${LANGUAGE_NAMES[plan.language] || plan.language}.`);
  p("That is the language the user is working in; a finding they have to translate is a");
  p("finding they will skim. The severity tag stays exactly `[P0]`…`[P3]`, the title stays");
  p("bold, and the fix stays its own final paragraph — only the prose changes language.");
  p("The **Fix:** label may be written in that language too. Identifiers, file paths, and");
  p("code stay verbatim, whatever the language.");
  p();
  p("## Severity");
  p();
  p(plan.rubric.severity);
  p();
  p(plan.rubric.output_shape);

  if (plan.rubric.conventions.text) {
    p();
    p("## Project conventions");
    p();
    p(plan.rubric.conventions.text);
  }

  p();
  p("## How to hand back your findings");
  p();
  p(`Write JSON to \`${plan.result_path}\` in exactly this shape:`);
  p();
  p("```json");
  p(plan.result_shape);
  p("```");
  p();
  p("Those four fields are all of it. Write no others — anything extra is ignored,");
  p("and a longer file is only a longer wall of JSON for the person watching.");
  p();
  p("- `path` — repo-relative, and it must be the file that actually contains the code you describe.");
  p("- `line` — the line in the post-change file. For a finding that genuinely spans");
  p("  several lines, write `start_line` and `end_line` instead of `line`.");
  p("- `existing_code` — the source you are quoting, copied VERBATIM from the file.");
  p("  This is load-bearing: it is grepped against the tree to verify the finding is");
  p("  filed on the right file, and a finding whose snippet matches nowhere may be dropped.");
  p("  One line is enough. Do not paste a whole function.");
  p("- `content` — the severity tag, then the bold title, then the body, per the rubric above.");
  p();
  p("Found nothing? Write `{\"comments\": []}`. That is a clean review, not a failure.");
  p();
  p("There is one optional key, `warnings`: a list of files you could not review at all.");
  p("A non-empty `warnings` means the review is PARTIAL and will be REJECTED rather than");
  p("passed, so omit it entirely unless something genuinely failed.");
  p();
  p("Do not print the findings to the terminal; the file is the deliverable.");
  p();
  p("Then run:");
  p();
  p("```bash");
  p(`npx @orcarouter/code-review review submit --format md --lang ${plan.language}`);
  p("```");
  p();
  p("It validates the shape, verifies each finding's position, applies the merge gate,");
  p("and prints the report. Show the user its output. Do not summarise the findings");
  p("yourself before running it — the gate decides what is blocking, not you.");

  if (!plan.config) {
    // The onboarding moment, placed where it is acted on: AFTER the report, so
    // the first review costs the user nothing extra, and they decide with the
    // actual output in front of them rather than in the abstract. Stateless on
    // purpose — "no file" is the whole definition of "first run here".
    p();
    p("## First review in this repository");
    p();
    p("There is no `.orcacode-review.json` here, so this run used the defaults: blocking on");
    p(`P0 and P1, findings in ${LANGUAGE_NAMES[plan.language] || plan.language}, no extra exclusions.`);
    p();
    p("After you have shown the report — not before — offer ONCE, in one sentence, to");
    p("save these as the repository's settings, and say what would change if they do:");
    p("the next review here picks them up without flags, for them and for anyone else.");
    p("If they say yes, run:");
    p();
    p("```bash");
    p(`npx @orcarouter/code-review review config init --lang ${plan.language}`);
    p("```");
    p();
    p("then apply anything they asked for on top (\"only block on P0\" → `--block-on P0` on");
    p("that command, or edit the key afterwards) and show them the file. If they say no,");
    p("do not bring it up again in this conversation. Do not create the file unasked.");
  }

  return L.join("\n");
}

// ---------------------------------------------------------------- submit ---

/**
 * Is this a result we can trust? Mirrors check-result.mjs, which is what the
 * Action asks of the engine — the same answer must not depend on who reviewed.
 *
 * Fail-closed on anything partial: converting "some files could not be read"
 * into a clean pass is how a broken review silently clears a change.
 */
export function validateResult(parsed) {
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "result is not a JSON object" };
  if (!Array.isArray(parsed.comments)) return { ok: false, error: "result has no `comments` array" };

  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  if (warnings.length > 0) {
    return { ok: false, error: `review is partial: ${warnings.join("; ")}` };
  }

  const bad = [];
  parsed.comments.forEach((c, i) => {
    if (!c || typeof c !== "object") return bad.push(`#${i} is not an object`);
    if (typeof c.path !== "string" || !c.path) bad.push(`#${i} has no \`path\``);
    if (typeof c.content !== "string" || !c.content) bad.push(`#${i} has no \`content\``);
  });
  if (bad.length) return { ok: false, error: `malformed findings: ${bad.join(", ")}` };

  // A single `line` is what a model reaches for, but the pipeline — postfilter,
  // the exhaustive merge, the judge, the Action's poster — is written against
  // `start_line`/`end_line`. Widen it here, at the boundary, so exactly one
  // shape flows downstream and a re-home can clear the anchor properly.
  const comments = parsed.comments.map((c) => {
    if (c.start_line === undefined && c.end_line === undefined && Number(c.line) >= 1) {
      const { line, ...rest } = c;
      return { ...rest, start_line: Number(line), end_line: Number(line) };
    }
    return c;
  });

  return { ok: true, comments };
}

/**
 * The L1 position check, run by shelling out to the SAME postfilter.mjs the
 * Action runs. Not reimplemented: two copies of "is this finding filed on the
 * right file" would drift, and the whole point is that a local P1 and a CI P1
 * mean the same thing.
 *
 * Skipped in workspace mode — it greps a commit, and uncommitted code is in no
 * commit. Fail-soft everywhere else: a postfilter that errors leaves the
 * findings untouched rather than losing them.
 */
export function positionCheck(resultFile, cwd, ref) {
  if (!ref) return { ran: false, code: "no-commit" };

  const script = path.join(PKG_ROOT, "scripts", "postfilter.mjs");
  const out = `${resultFile.replace(/\.json$/, "")}.l1.json`;
  const r = spawnSync(process.execPath, [script, resultFile, cwd, ref, "--out", out], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (r.status !== 0 || !fs.existsSync(out)) {
    return { ran: false, code: "failed", detail: (r.stderr || "").trim().split("\n").pop() || "" };
  }
  return { ran: true, out, log: (r.stderr || "").trim() };
}

export function gate(comments, blockOn) {
  const wanted = new Set(
    String(blockOn || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  const blocking = comments.filter((c) => wanted.has(severityOf(c)));
  return { counts: countSeverities(comments), blocking, blocked: blocking.length > 0, wanted: [...wanted] };
}

// -------------------------------------------------------------- rendering ---

// Wraps at a fixed width rather than the terminal's: a report that reflows
// differently per window cannot be diffed or pasted into an issue intact.
const WIDTH = 78;

function wrap(text, indent) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = indent;
    for (const word of para.split(/\s+/)) {
      if (line.length > indent.length && line.length + 1 + word.length > WIDTH) {
        out.push(line);
        line = indent;
      }
      line += (line.length > indent.length ? " " : "") + word;
    }
    out.push(line);
  }
  return out.join("\n");
}

// The bold title the output shape mandates, split off so the report can lead
// with it. Falls back to the whole body when a finding ignored the shape —
// degraded, but never lossy.
export function splitFinding(content) {
  const body = String(content).replace(/^\s*\[P[0-3]\]\s*/i, "");
  const m = body.match(/^\*\*(.+?)\*\*\s*\n?([\s\S]*)$/);
  if (!m) return { title: body.split("\n")[0].trim(), rest: body.split("\n").slice(1).join("\n").trim() };
  return { title: m[1].trim(), rest: m[2].trim() };
}

export function renderReport(comments, result, { color, t = englishT }) {
  const c = color;
  const mark = { P0: c.red("●"), P1: c.yellow("●"), P2: c.cyan("○"), P3: c.dim("○") };
  const L = [];

  // The verdict goes FIRST, before a single finding.
  //
  // A blocked review exits 1, and every agent shell renders a non-zero exit as
  // "Error: Exit code 1" and then TRUNCATES the middle of the output. With the
  // verdict at the bottom — where it used to be — what survives is an error
  // banner wrapped around some findings, and the reader cannot tell a working
  // merge gate from a crashed command. Whatever gets cut, the first line has to
  // say what happened.
  const list = result.wanted.join(",") || "—";
  L.push(
    result.blocked
      ? `  ${c.red(c.bold(t("report.verdictBlocked")))}  ${t("report.blockedTail", result.blocking.length, comments.length, list)}`
      : `  ${c.green(c.bold(t("report.verdictPassed")))}  ${t("report.passedTail", list, comments.length)}`,
  );
  L.push(
    `  ${SEVERITIES.map((s) => `${s} ${result.counts[s]}`).join(c.dim("  ·  "))}` +
      c.dim(`     ${c.bold(t("report.notCrash"))}`),
  );

  for (const sev of SEVERITIES) {
    for (const finding of comments.filter((x) => severityOf(x) === sev)) {
      const { title, rest } = splitFinding(finding.content);
      const at = anchorLine(finding);
      const where = `${finding.path}${at ? `:${at}` : ""}`;
      L.push("");
      L.push(`  ${mark[sev]} ${c.bold(sev)}  ${c.cyan(where)}`);
      L.push(`     ${c.bold(title)}`);
      if (rest) {
        L.push("");
        L.push(wrap(rest, "     "));
      }
    }
  }

  return L.join("\n");
}

/**
 * The same report as markdown, for an agent to paste into its conversation.
 *
 * The terminal renderer above is ANSI and hard-wrapped at 78 columns — pasted
 * into a chat it arrives as a wall of pre-formatted text with escape codes.
 * This one is the same data with markdown structure, so the host renders it as
 * headings and prose. No colour, no wrapping: the reader reflows it.
 *
 * Grouped by file, because a reviewer fixes one file at a time, and the file
 * with the blocking finding sorts first so the thing that stops the merge is
 * not below the fold.
 */
export function renderReportMarkdown(comments, result, { t = englishT } = {}) {
  const blocking = new Set(result.blocking);
  const rank = (c) => SEVERITIES.indexOf(severityOf(c));

  const byFile = new Map();
  for (const finding of comments) {
    if (!byFile.has(finding.path)) byFile.set(finding.path, []);
    byFile.get(finding.path).push(finding);
  }
  const files = [...byFile.entries()].sort(
    (a, b) => Math.min(...a[1].map(rank)) - Math.min(...b[1].map(rank)) || a[0].localeCompare(b[0]),
  );

  const L = [];
  const p = (s = "") => L.push(s);

  p("## OrcaCode Review");
  p();
  const list = result.wanted.join(", ") || "—";
  // The full stop is a translated string: "。" in Chinese and Japanese, "." in
  // English and Korean. Hard-coding "." put a Latin period on a Chinese line.
  const stop = t("report.stop");
  if (comments.length === 0) {
    p(`**${t("report.verdictPassed")}** — ${t("report.clean")}${stop}`);
    return L.join("\n");
  }
  if (result.blocked) {
    p(`**${t("report.verdictBlocked")}** — ${t("report.blockedTail", result.blocking.length, comments.length, list)}${stop}`);
  } else {
    p(`**${t("report.verdictPassed")}** — ${t("report.passedTail", list, comments.length)}${stop}`);
  }
  p();
  p(SEVERITIES.map((s) => `\`${s} ${result.counts[s]}\``).join(" · "));

  for (const [file, found] of files) {
    p();
    p(`### \`${file}\``);
    for (const finding of found.sort((a, b) => rank(a) - rank(b) || (anchorLine(a) || 0) - (anchorLine(b) || 0))) {
      const { title, rest } = splitFinding(finding.content);
      const at = anchorLine(finding);
      // `path:line` unadorned — hosts linkify that shape, and a markdown link
      // to a relative path does not resolve in most of them.
      const where = `${finding.path}${at ? `:${at}` : ""}`;
      p();
      // Blocking is judged against the gate that actually ran, not the severity
      // in the abstract — under `--block-on P0` a P1 is reported, not blocking.
      p(`**${blocking.has(finding) ? "❌" : "💬"} ${severityOf(finding)} · \`${where}\` — ${title}**`);
      if (rest) {
        p();
        p(rest);
      }
    }
  }
  return L.join("\n");
}
