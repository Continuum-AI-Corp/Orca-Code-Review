// `review plan` and `review submit` — the two command entry points of the
// harness surface. The reviewing logic lives in harness.mjs; this file is the
// part that touches the filesystem, the terminal, and the exit code.
//
// STDOUT vs STDERR MATTERS HERE. `review plan` writes the review request — a
// prompt — to stdout and nothing else, so piping it straight into an agent
// works and the captured text is not laced with progress lines. Everything
// meant for a human reading along goes to stderr. `review submit` is the
// reverse: its report is for the human, so that goes to stdout.
//
// Exit codes:
//   0  reviewed — the report carries the verdict, blocked or not
//   1  reviewed and blocked, ONLY under --fail-on-block (hooks, CI steps)
//   2  no usable result (unparseable, malformed, or partial) — never a pass

import fs from "node:fs";
import path from "node:path";

import {
  WORK_DIR,
  buildPlan,
  renderPlan,
  groundTruthRef,
  validateResult,
  positionCheck,
  gate,
  renderReport,
  renderReportMarkdown,
  parsePrNumber,
  repoRoot,
  resolvePr,
  gitCommonDir,
} from "./harness.mjs";
import { CONFIG_FILE, loadLocalConfig, configTemplate } from "./localconfig.mjs";

const DEFAULT_BLOCK_ON = "P0,P1";
const FORMATS = ["text", "md", "json"];

// Keep the scratch directory out of `git status` without editing .gitignore —
// that file belongs to the project, and a review must not leave a diff behind.
// .git/info/exclude is the per-clone equivalent and is never committed.
function excludeFromGit(root) {
  const gitDir = gitCommonDir(root);
  if (!gitDir) return;
  const file = path.join(gitDir, "info", "exclude");
  try {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (current.split("\n").some((l) => l.trim() === `/${WORK_DIR}/`)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}/${WORK_DIR}/\n`);
  } catch {
    // A read-only or otherwise unwritable git store — the review still works,
    // the directory just shows up as untracked. Not worth failing over.
  }
}

// `--pr` is the one part of the harness that talks to a forge. It stays here,
// at the edge, behind a soft dependency on `gh` — the review itself never
// learns what a pull request is, so a host without `gh` (or without GitHub)
// loses this shortcut and nothing else.
function applyPr(argv, root, ui) {
  if (argv.pr === undefined) return {};
  if (argv.from || argv.to || argv.commit || argv.worktree) ui.die(ui.t("review.prConflict"));

  // Validate before announcing. "Resolving pull request #abc…" followed by
  // "that is not a number" reads as though we tried.
  const n = parsePrNumber(argv.pr);
  if (!n) ui.die(ui.t("review.prBadNumber", String(argv.pr ?? "")), ui.t("review.prHint"));

  ui.note(ui.t("review.prFetching", n));
  const r = resolvePr(n, root);
  if (!r.ok) {
    const message = {
      "no-gh": () => ui.t("review.prNoGh"),
      "no-auth": () => ui.t("review.prNoAuth"),
      "bad-number": () => ui.t("review.prBadNumber", r.detail),
      "fetch-failed": () => ui.t("review.prFetchFailed", r.detail),
      "no-base-ref": () => ui.t("review.prNoBaseRef", r.detail),
    }[r.code];
    ui.die(message ? message() : ui.t("review.prFailed", r.detail), ui.t("review.prHint"));
  }

  ui.note(ui.t("review.prResolved", r.pr.number, r.pr.base));
  // A merged or closed PR still reviews fine, but reviewing one by accident —
  // because the number was a typo — should not be silent.
  if (r.pr.state && r.pr.state !== "OPEN") ui.note(ui.t("review.prState", r.pr.state));
  if (r.pr.fork) ui.note(ui.t("review.prFork"));

  // An explicit --background is the user speaking; the PR body is a default.
  const background = argv.background || r.background;
  if (!argv.background && r.background) ui.note(ui.t("review.prBackground"));

  return { from: r.from, to: r.to, pr: r.pr.number, prMeta: r.pr, background };
}

// The repo's settings file, or a loud refusal. Both commands call this first:
// a config that fails to parse must stop the review, not be shrugged off into
// defaults — the file says P0 and the run would block on P1.
function requireConfig(root, ui) {
  const loaded = loadLocalConfig(root);
  if (!loaded.ok) {
    ui.fail(ui.t("review.cfgInvalid", loaded.file, loaded.error));
    process.exit(2);
  }
  return loaded;
}

export async function cmdReviewPlan(argv, ui) {
  const root = repoRoot(process.cwd());
  if (!root) ui.die(ui.t("review.notRepo"));

  const config = requireConfig(root, ui);
  const pr = applyPr(argv, root, ui);

  const plan = buildPlan(
    {
      from: argv.from,
      to: argv.to,
      commit: argv.commit,
      worktree: argv.worktree,
      background: argv.background,
      language: ui.language,
      config,
      ...pr,
    },
    root,
  );

  if (plan.range.mode === "error") ui.die(ui.t("review.cannotResolve"), ui.t("review.noBaseHint"));
  if (plan.range.mode === "empty") {
    ui.warn(ui.t("review.nothingToReview", plan.range.base || ""));
    return;
  }
  if (plan.files.length === 0) {
    ui.warn(ui.t("review.noFiles", plan.range.mode));
    return;
  }

  const workDir = path.join(root, WORK_DIR);
  fs.mkdirSync(workDir, { recursive: true });
  excludeFromGit(root);

  const request = renderPlan(plan);
  // plan.json is what `review submit` reads back for the range — submit must
  // grep the same commit the review was planned against, and re-deriving it
  // later could pick a different one if the user committed in between.
  fs.writeFileSync(
    path.join(workDir, "plan.json"),
    `${JSON.stringify({ ...plan, ground_truth_ref: groundTruthRef(plan.range, root) }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(workDir, "request.md"), `${request}\n`);

  if (argv.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    process.stdout.write(`${request}\n`);
  }

  // Human notes on stderr so they never contaminate a piped prompt.
  ui.note(ui.t("review.planned", plan.files.length, plan.range.mode));
  if (config.file) ui.note(ui.t("review.cfgLoaded", config.file));
  // Only explain a mode nobody asked for. When the user typed the flag, saying
  // it back to them is noise.
  if (plan.range.code === "auto-dirty") ui.note(ui.t("review.autoWorktree"));
  if (plan.range.code === "auto-ahead") ui.note(ui.t("review.autoRange", plan.range.base));
  if (plan.rubric.conventions.file) ui.note(ui.t("review.conventions", plan.rubric.conventions.file));
}

export async function cmdReviewSubmit(argv, ui) {
  // Before anything else: a mistyped flag is a usage error, and reporting it as
  // "no result file" sends the caller looking in the wrong place.
  const format = argv.json ? "json" : argv.format || "text";
  if (!FORMATS.includes(format)) ui.die(ui.t("review.badFormat", format, FORMATS.join(", ")));

  const root = repoRoot(process.cwd());
  if (!root) ui.die(ui.t("review.notRepo"));

  const config = requireConfig(root, ui);

  const resultFile = path.resolve(root, argv._[2] || path.join(WORK_DIR, "result.json"));
  if (!fs.existsSync(resultFile)) {
    ui.fail(ui.t("review.missingResult", path.relative(root, resultFile)));
    process.exitCode = 2;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  } catch (e) {
    ui.fail(ui.t("review.unusable", e.message));
    process.exitCode = 2;
    return;
  }

  const check = validateResult(parsed);
  if (!check.ok) {
    ui.fail(ui.t("review.unusable", check.error));
    process.exitCode = 2;
    return;
  }

  // The commit the position check greps, recorded when the plan was built.
  let ref = "";
  try {
    ref = JSON.parse(fs.readFileSync(path.join(root, WORK_DIR, "plan.json"), "utf8")).ground_truth_ref || "";
  } catch {
    // Submitting a result nobody planned is allowed — a harness may have built
    // the request itself. We just cannot verify positions without a commit.
  }

  let comments = check.comments;
  if (comments.length > 0 && argv.postfilter !== false) {
    // postfilter.mjs reads a FILE, not our parsed copy, so it must be handed the
    // widened shape — it is written against `start_line`/`end_line`, and pointing
    // it at a result that used a bare `line` silently returns every finding with
    // no anchor at all. Normalising here is also what keeps this caller and the
    // Action's caller feeding that script byte-identical input.
    const normalized = path.join(root, WORK_DIR, "result.normalized.json");
    fs.mkdirSync(path.dirname(normalized), { recursive: true });
    fs.writeFileSync(normalized, `${JSON.stringify({ comments, warnings: [] })}\n`);

    const l1 = positionCheck(normalized, root, ref);
    fs.rmSync(normalized, { force: true });
    if (l1.ran) {
      const filtered = JSON.parse(fs.readFileSync(l1.out, "utf8"));
      ui.note(ui.t("review.positionsChecked", comments.length, filtered.comments.length));
      comments = filtered.comments;
      fs.rmSync(l1.out, { force: true });
    } else if (l1.code === "no-commit") {
      ui.note(ui.t("review.positionsNoCommit"));
    } else {
      ui.note(ui.t("review.positionsFailed", l1.detail));
    }
  }

  // Flag beats file beats default. Said out loud only when the file decided —
  // a flag is the user's own typing, and the default needs no announcement.
  const blockOn = argv.blockOn ?? config.config.block_on ?? DEFAULT_BLOCK_ON;
  if (argv.blockOn === undefined && config.config.block_on !== undefined) {
    ui.note(ui.t("review.cfgBlockOnFrom", blockOn, ui.t("review.cfgSrcFile")));
  }
  const result = gate(comments, blockOn);

  // Always written, whatever the chosen format. An agent that ran the default
  // terminal report still has somewhere to read a pasteable version from, and a
  // human has something to attach to a ticket.
  const markdown = renderReportMarkdown(comments, result, { t: ui.t });
  const reportPath = path.join(WORK_DIR, "report.md");
  try {
    const workDir = path.join(root, WORK_DIR);
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(root, reportPath), `${markdown}\n`);
    // Only worth saying when the report was NOT what we just printed.
    if (format === "text" && comments.length > 0) ui.note(ui.t("review.reportSaved", reportPath));
  } catch {
    // A report we could not save is not a reason to fail a review.
  }

  // The process status carries the verdict only when asked. The local harness
  // is there to tell an agent what the bugs are; the agent reads the report,
  // and its shell tool would stamp a 1 with "Error" and bury that report under
  // a crash banner. A hook or CI step that wants `&&` to mean something passes
  // --fail-on-block. A `2` upstream is different — the result was unusable —
  // and nothing here touches it: a review that did not happen must never come
  // back looking like one that passed.
  const verdictExit = () => {
    if (result.blocked && argv.failOnBlock) process.exitCode = 1;
  };

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({ comments, counts: result.counts, block_on: result.wanted, blocked: result.blocked }, null, 2)}\n`,
    );
    verdictExit();
    return;
  }

  if (format === "md") {
    // Markdown is the whole output — the verdict is already its second line, so
    // repeating it through ui.ok/ui.fail would render as a stray ANSI line in
    // the middle of a chat message.
    process.stdout.write(`${markdown}\n`);
    verdictExit();
    return;
  }

  ui.say();
  if (comments.length === 0) {
    ui.ok(ui.t("review.clean"));
    return;
  }

  ui.say(renderReport(comments, result, { color: ui.color, t: ui.t }));
  ui.say();
  if (result.blocked) {
    // ui.fail() sets exitCode 1 as a side effect, so it is only the right
    // channel when that IS the request. Otherwise the same line goes out as a
    // note: the verdict is information here, not a failure.
    if (argv.failOnBlock) ui.fail(ui.t("review.blocked", result.blocking.length, result.wanted.join(",")));
    else ui.note(ui.t("review.blocked", result.blocking.length, result.wanted.join(",")));
    verdictExit();
  } else {
    ui.ok(ui.t("review.passed", result.wanted.join(",") || "—"));
  }
}

// `review config` — show the settings that will apply and where each came
// from, or `review config init` to write the file. The show form exists so a
// user never has to reason about precedence in their head: three sources
// (flag, file, default) collapse to one column that says which won.
export async function cmdReviewConfig(argv, ui) {
  const root = repoRoot(process.cwd());
  if (!root) ui.die(ui.t("review.notRepo"));

  if (argv._[2] === "init") {
    const file = path.join(root, CONFIG_FILE);
    if (fs.existsSync(file) && !argv.force) {
      ui.warn(ui.t("review.cfgExists", CONFIG_FILE));
      process.exitCode = 1;
      return;
    }
    // Pre-filled with what this user was already using — the language they
    // spoke, the gate they asked for — so the template is a record of the
    // present, not a form to fill in.
    fs.writeFileSync(
      file,
      configTemplate({ language: ui.language, blockOn: argv.blockOn, comment: ui.t("review.cfgComment") }),
    );
    ui.ok(ui.t("review.cfgWritten", CONFIG_FILE));
    ui.say(`  ${ui.t("review.cfgEditHint", CONFIG_FILE)}`);
    return;
  }

  const loaded = requireConfig(root, ui);
  const c = loaded.config;
  const src = {
    flag: ui.t("review.cfgSrcFlag"),
    file: ui.t("review.cfgSrcFile"),
    dflt: ui.t("review.cfgSrcDefault"),
    locale: ui.t("review.cfgSrcLocale"),
  };
  const effective = {
    file: loaded.file,
    block_on: { value: argv.blockOn ?? c.block_on ?? DEFAULT_BLOCK_ON, source: argv.blockOn !== undefined ? "flag" : c.block_on !== undefined ? "file" : "default" },
    language: { value: ui.language, source: argv.lang ? "flag" : c.language ? "file" : "locale" },
    exclude: c.exclude || [],
    rules: (c.rules || []).map((r) => ({ path: r.path, replace: r.replace, source: r.source })),
  };

  if (argv.json) {
    process.stdout.write(`${JSON.stringify(effective, null, 2)}\n`);
    return;
  }

  const name = (k) => ({ flag: src.flag, file: src.file, default: src.dflt, locale: src.locale })[k];
  if (loaded.file) ui.note(ui.t("review.cfgLoaded", loaded.file));
  else ui.note(ui.t("review.cfgNone", CONFIG_FILE));
  ui.say();
  ui.say(`  ${ui.color.bold("block_on".padEnd(10))} ${String(effective.block_on.value || '""').padEnd(10)} ${ui.color.dim(`← ${name(effective.block_on.source)}`)}`);
  ui.say(`  ${ui.color.bold("language".padEnd(10))} ${effective.language.value.padEnd(10)} ${ui.color.dim(`← ${name(effective.language.source)}`)}`);
  ui.say(`  ${ui.color.bold("exclude".padEnd(10))} ${ui.t("review.cfgRowExclude", effective.exclude.length)}${effective.exclude.length ? ui.color.dim(`   ${effective.exclude.join(", ")}`) : ""}`);
  ui.say(`  ${ui.color.bold("rules".padEnd(10))} ${ui.t("review.cfgRowRules", effective.rules.length)}${effective.rules.length ? ui.color.dim(`   ${effective.rules.map((r) => `${r.path} → ${r.source}${r.replace ? " (replace)" : ""}`).join(", ")}`) : ""}`);
  ui.say();
  ui.say(`  ${ui.color.dim(loaded.file ? ui.t("review.cfgEditHint", loaded.file) : ui.t("review.cfgCreateHint"))}`);
}
