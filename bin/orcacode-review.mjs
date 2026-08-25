#!/usr/bin/env node
// OrcaCode Review installer — `npx orcacode-review`.
//
//   npx orcacode-review                interactive menu
//   npx orcacode-review init           write .github/workflows/orca-code-review.yml
//   npx orcacode-review reconfigure    change the inputs in an existing workflow
//   npx orcacode-review doctor         diagnose an install that is not working
//   npx orcacode-review uninstall      remove the workflow (gate first, file second)
//   npx orcacode-review skill install  install the agent skill (36 platforms)
//   npx orcacode-review skill list     list the platforms and what is detected here
//
// Zero dependencies on purpose: `npx` downloads the whole tree before it runs
// anything, so every dependency is latency the user pays at install time and a
// supply-chain edge on a tool whose whole job is touching CI config.
//
// The API key is never read, echoed, or passed as an argv value — argv is
// visible in `ps`. `gh secret set` is spawned with inherited stdio so the user
// types it into gh, not into this process.
//
// All prose comes from i18n.mjs (zh/en). Flag names, platform IDs, workflow
// inputs, and shell commands are never translated — the reader still has to
// type them.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { SKILL_PLATFORMS, POPULAR_PLATFORM_IDS, findPlatform, detectPlatforms, resolveTargets } from "./platforms.mjs";
import { installTree, STATUS } from "./skill-tree.mjs";
import { makeT, detectLanguage, parseLanguage } from "./i18n.mjs";
import { renderBanner } from "./banner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const WORKFLOW_REL = ".github/workflows/orca-code-review.yml";
const SECRET = "ORCAROUTER_API_KEY";
const ACTION_REF = "Continuum-AI-Corp/orca-code-review@v1";
const CONSOLE_TOKENS = "https://www.orcarouter.ai/console/token";
const CONSOLE_APPS = "https://www.orcarouter.ai/";
const SKILL_NAME = "setup-orca-code-review";

// Resolved from the locale up front so every path — including an early `die()`
// during argument parsing — has a working translator.
let LANG = detectLanguage();
let t = makeT(LANG);

const setLanguage = (lang) => { LANG = lang; t = makeT(lang); };

// ---------------------------------------------------------------- output ---

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1);
const dim = c(2);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);

const say = (s = "") => console.log(s);
const ok = (s) => say(`${green("✔")} ${s}`);
const warn = (s) => say(`${yellow("!")} ${s}`);
const info = (s) => say(`${cyan("›")} ${s}`);
const fail = (s) => {
  console.error(`${red("✖")} ${s}`);
  process.exitCode = 1;
};

function die(msg, hint) {
  console.error(`${red("✖")} ${msg}`);
  if (hint) console.error(`  ${dim(hint)}`);
  process.exit(1);
}

function showBanner(argv) {
  if (argv?.noBanner || argv?.json || !process.stdout.isTTY) return;
  say();
  renderBanner((s) => process.stdout.write(s), { color: tty });
}

// ------------------------------------------------------------------ shell ---

// Never throws: a missing binary and a nonzero exit are both just "not ok", and
// every caller here treats them the same way.
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    ok: r.status === 0,
    out: (r.stdout || "").trim(),
    err: (r.error?.message || r.stderr || "").trim(),
  };
}

const hasGh = () => sh("gh", ["--version"]).ok;
const ghAuthed = () => sh("gh", ["auth", "status"]).ok;

// ----------------------------------------------------------------- prompts ---

let rl = null;
const ui = () => (rl ??= readline.createInterface({ input: process.stdin, output: process.stdout }));
const closeUi = () => { rl?.close(); rl = null; };

let ASSUME_YES = false;

function requireInteractive(what) {
  if (ASSUME_YES) return false;
  if (process.stdin.isTTY) return true;
  die(t("common.nonTTY", what), t("common.nonTTYHint"));
}

// A numbered single-choice prompt. `options` is [{label, value, detail, recommended}].
async function select(question, options, { defaultIndex = 0 } = {}) {
  if (!requireInteractive(question)) return options[defaultIndex].value;

  say();
  say(bold(question));
  options.forEach((o, i) => {
    const tag = o.recommended ? dim(` ${t("common.recommended")}`) : "";
    say(`  ${cyan(String(i + 1))}. ${o.label}${tag}`);
    if (o.detail) say(`     ${dim(o.detail)}`);
  });

  for (;;) {
    const raw = (await ui().question(dim(t("common.chooseRange", options.length, defaultIndex + 1)))).trim();
    if (raw === "") return options[defaultIndex].value;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    warn(t("common.enterNumber", options.length));
  }
}

// A numbered checkbox list. Accepts "1,3,5", ranges ("1-4"), "a" for all, and
// bare Enter for the preselected set.
async function multiSelect(question, options, { preselected = [] } = {}) {
  const chosen = new Set(preselected);
  if (!requireInteractive(question)) return options.filter((o) => chosen.has(o.value)).map((o) => o.value);

  say();
  say(bold(question));
  options.forEach((o, i) => {
    const mark = chosen.has(o.value) ? green("[x]") : dim("[ ]");
    const tag = o.detected ? green(`  ← ${t("common.detected")}`) : "";
    say(`  ${mark} ${cyan(String(i + 1).padStart(2))}. ${o.label}${tag}`);
  });
  say(dim(`     ${t("common.multiHint")}`));

  for (;;) {
    const raw = (await ui().question(dim(t("common.selectPrompt")))).trim().toLowerCase();
    if (raw === "") {
      if (chosen.size > 0) break;
      warn(t("common.nothingSelected"));
      continue;
    }
    if (raw === "a" || raw === "all") return options.map((o) => o.value);

    const picked = new Set();
    let bad = false;
    for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const range = part.match(/^(\d+)-(\d+)$/);
      const nums = range
        ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, k) => Number(range[1]) + k)
        : [Number(part)];
      for (const n of nums) {
        if (!Number.isInteger(n) || n < 1 || n > options.length) { bad = true; break; }
        picked.add(options[n - 1].value);
      }
      if (bad) break;
    }
    if (bad || picked.size === 0) { warn(t("common.enterNumber", options.length)); continue; }
    return [...picked];
  }
  return [...chosen];
}

async function confirm(question, defaultYes = true) {
  if (!requireInteractive(question)) return defaultYes;
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const raw = (await ui().question(`${bold(question)} ${dim(suffix)} `)).trim().toLowerCase();
  if (raw === "") return defaultYes;
  return raw === "y" || raw === "yes";
}

// The language screen, shown once at the top of a guided flow when --lang was
// not given. Its own label is bilingual, so it reads correctly before a
// language has been chosen.
async function askLanguage(argv) {
  if (argv.lang || ASSUME_YES || !process.stdin.isTTY) return;
  const picked = await select(
    t("lang.question"),
    [
      { label: t("lang.en"), value: "en" },
      { label: t("lang.zh"), value: "zh" },
    ],
    { defaultIndex: LANG === "zh" ? 1 : 0 },
  );
  setLanguage(picked);
}

// -------------------------------------------------------------- repo state ---

function repoState() {
  const top = sh("git", ["rev-parse", "--show-toplevel"]);
  if (!top.ok) die(t("common.notGitRepo"), t("common.notGitRepoHint"));
  const root = top.out;

  const state = {
    root,
    workflowPath: path.join(root, WORKFLOW_REL),
    installed: fs.existsSync(path.join(root, WORKFLOW_REL)),
    nameWithOwner: null,
    visibility: null,
    defaultBranch: null,
    gh: hasGh() && ghAuthed(),
  };

  if (state.gh) {
    const v = sh("gh", ["repo", "view", "--json", "nameWithOwner,visibility,defaultBranchRef"], { cwd: root });
    if (v.ok) {
      try {
        const j = JSON.parse(v.out);
        state.nameWithOwner = j.nameWithOwner ?? null;
        state.visibility = j.visibility ?? null;
        state.defaultBranch = j.defaultBranchRef?.name ?? null;
      } catch {
        /* leave the fields null — everything downstream degrades to URLs */
      }
    }
  }

  // Fall back to the remote URL so we can still print correct links without gh.
  if (!state.nameWithOwner) {
    const u = sh("git", ["remote", "get-url", "origin"], { cwd: root });
    const m = u.ok && u.out.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) state.nameWithOwner = m[1];
  }

  return state;
}

// ---------------------------------------------------------------- template ---

// Only inputs that differ from their documented default are written. A workflow
// that lists what it overrides and nothing else stays readable, and — with
// `settings: "true"` — an input equal to its default would not change behavior
// anyway, so writing it would only imply a control the file does not have.
export const DEFAULTS = Object.freeze({
  settings: "true",
  "block-on": "P0,P1",
  "on-oversized-diff": "fail",
  "auto-review-authors": "",
});

// Generated workflow comments stay English: the file is committed and read by
// everyone on the repo, and CI config in a language half the team cannot read
// is worse than none.
const INPUT_NOTES = {
  settings: '"false" makes this file authoritative — no dashboard override',
  "block-on": "severities that fail the check (block the merge)",
  "on-oversized-diff": '"pass" makes an oversized-diff skip advisory',
  "auto-review-authors": "author allowlist for AUTOMATIC reviews",
};

export function renderWorkflow(overrides) {
  const lines = Object.entries(overrides)
    .filter(([k, v]) => v !== undefined && v !== DEFAULTS[k])
    .map(([k, v]) => `          ${k}: ${JSON.stringify(v)}${INPUT_NOTES[k] ? `  # ${INPUT_NOTES[k]}` : ""}`);

  const withBlock = [
    `          orcarouter-api-key: \${{ secrets.${SECRET} }}`,
    ...lines,
  ].join("\n");

  return `# OrcaCode Review — https://github.com/Continuum-AI-Corp/orca-code-review
#
# Generated by \`npx orcacode-review\`. The review logic lives in the published
# action, so this file never copies scripts or config — bump the version tag to
# update. Add one repository secret, ${SECRET}, and enable the app at
# OrcaRouter -> Apps -> OrcaCode Review.

name: OrcaCode Review

concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.event.issue.number || github.ref }}
  cancel-in-progress: true

on:
  # \`synchronize\` re-reviews on every new push. \`ready_for_review\` makes the
  # dashboard's trigger=ready_for_review mode fire when a draft becomes ready.
  pull_request_target:
    types: [opened, synchronize, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write # tier state label + clean/fallback PR comments

jobs:
  review:
    runs-on: ubuntu-latest
    # Run on PR events, or when a trusted user comments the review command on a
    # PR. All four spellings are accepted — either prefix (\`/\` or \`@\`) with
    # either separator (hyphen or space). The command runs this privileged
    # \`pull_request_target\` workflow with the OrcaRouter secret, so only
    # maintainers may trigger it — otherwise any participant could burn paid
    # quota and spam reviews without pushing new commits.
    if: |
      github.event_name == 'pull_request_target' ||
      (github.event_name == 'issue_comment' &&
        github.event.issue.pull_request &&
        (startsWith(github.event.comment.body, '/orcacode-review') ||
          startsWith(github.event.comment.body, '/orcacode review') ||
          startsWith(github.event.comment.body, '@orcacode-review') ||
          startsWith(github.event.comment.body, '@orcacode review')) &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association))
    steps:
      - uses: ${ACTION_REF}
        with:
${withBlock}
`;
}

// Best-effort read-back of what the current file overrides, so `reconfigure`
// can show real before-values instead of pretending everything is default.
export function readOverrides(file) {
  return parseOverrides(fs.readFileSync(file, "utf8"));
}

export function parseOverrides(text) {
  const found = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const m = text.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'#\\n]*)["']?`, "m"));
    if (m) found[key] = m[1].trim();
  }
  return found;
}

// ------------------------------------------------------------------ config ---

async function askConfig(state, current = DEFAULTS) {
  const out = {};

  out.settings = await select(
    t("config.settingsQ"),
    [
      { label: t("config.settingsDashboard"), value: "true", recommended: true, detail: t("config.settingsDashboardDetail") },
      { label: t("config.settingsFile"), value: "false", detail: t("config.settingsFileDetail") },
    ],
    { defaultIndex: current.settings === "false" ? 1 : 0 },
  );

  const blockOptions = ["P0,P1", "P0", ""];
  out["block-on"] = await select(
    t("config.blockQ"),
    [
      { label: t("config.blockBoth"), value: "P0,P1", recommended: true, detail: t("config.blockBothDetail") },
      { label: t("config.blockP0"), value: "P0", detail: t("config.blockP0Detail") },
      { label: t("config.blockNone"), value: "", detail: t("config.blockNoneDetail") },
    ],
    { defaultIndex: Math.max(0, blockOptions.indexOf(current["block-on"])) },
  );

  out["on-oversized-diff"] = await select(
    t("config.oversizedQ"),
    [
      { label: t("config.oversizedFail"), value: "fail", recommended: true, detail: t("config.oversizedFailDetail") },
      { label: t("config.oversizedPass"), value: "pass", detail: t("config.oversizedPassDetail") },
    ],
    { defaultIndex: current["on-oversized-diff"] === "pass" ? 1 : 0 },
  );

  // Only a public repo has this problem, and only a public repo should be asked.
  if (state.visibility === "PUBLIC") {
    say();
    warn(t("config.publicWarning", CONSOLE_TOKENS));
    out["auto-review-authors"] = await select(
      t("config.authorsQ"),
      [
        {
          label: t("config.authorsKnown"),
          value: "OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR",
          recommended: true,
          detail: t("config.authorsKnownDetail"),
        },
        { label: t("config.authorsAll"), value: "", detail: t("config.authorsAllDetail") },
      ],
    );
  } else if (current["auto-review-authors"]) {
    out["auto-review-authors"] = current["auto-review-authors"];
  }

  return out;
}

// -------------------------------------------------------------- subcommands ---

async function cmdInit(argv) {
  const state = repoState();

  say();
  say(bold(t("init.title")));
  say(dim(t("init.repo", state.nameWithOwner ?? t("init.repoUnknown"))));
  say(dim(t("init.workflow", WORKFLOW_REL)));

  if (state.installed && !argv.force) {
    warn(t("init.exists"));
    const go = await confirm(t("init.reconfigureInstead"), true);
    closeUi();
    if (go) return cmdReconfigure(argv);
    info(t("init.unchangedHint"));
    return;
  }

  const cfg = await askConfig(state);
  const yaml = renderWorkflow(cfg);

  say();
  say(bold(t("init.preview")));
  say(dim(yaml.split("\n").map((l) => `  ${l}`).join("\n")));

  if (!(await confirm(t("init.writeConfirm", WORKFLOW_REL), true))) {
    closeUi();
    info(t("common.aborted"));
    return;
  }

  fs.mkdirSync(path.dirname(state.workflowPath), { recursive: true });
  fs.writeFileSync(state.workflowPath, yaml);
  ok(t("init.wrote", WORKFLOW_REL));

  await setupSecret(state);
  closeUi();

  say();
  say(bold(t("init.remaining")));
  say(t("init.step1", cyan(CONSOLE_APPS)));
  say(dim(t("init.step1Note")));
  say(t("init.step2"));
  say(dim(t("init.step2Note")));
  say(t("init.step3"));
  say(dim(t("init.step3Note", "review")));
  say();
  say(dim(t("init.diagnoseHint")));
}

async function cmdReconfigure(argv) {
  const state = repoState();
  if (!state.installed) die(t("reconfigure.missing", WORKFLOW_REL), t("reconfigure.missingHint"));

  const current = readOverrides(state.workflowPath);

  say();
  say(bold(t("reconfigure.title")));
  if (current.settings !== "false") {
    say();
    info(t("reconfigure.dashboardOwns"));
    say(dim(t("reconfigure.dashboardOwnsDetail", CONSOLE_APPS)));
  }

  const cfg = await askConfig(state, current);

  const changed = Object.entries(cfg).filter(([k, v]) => v !== current[k]);
  if (changed.length === 0) {
    closeUi();
    ok(t("reconfigure.noChanges"));
    return;
  }

  say();
  say(bold(t("reconfigure.changes")));
  for (const [k, v] of changed) {
    say(`  ${k}: ${dim(JSON.stringify(current[k]))} → ${bold(JSON.stringify(v))}`);
  }

  if (!(await confirm(t("reconfigure.applyConfirm", WORKFLOW_REL), true))) {
    closeUi();
    info(t("common.aborted"));
    return;
  }

  fs.writeFileSync(state.workflowPath, renderWorkflow(cfg));
  closeUi();
  ok(t("reconfigure.updated", WORKFLOW_REL));
  info(t("reconfigure.commitHint"));
}

async function cmdDoctor() {
  const state = repoState();

  say();
  say(bold(t("doctor.title")));
  say(dim(t("doctor.repo", state.nameWithOwner ?? t("doctor.repoUnknown"))));
  say();

  let problems = 0;
  const bad = (s, fix) => { problems++; fail(s); if (fix) say(`  ${dim(fix)}`); };

  // 1. Workflow present locally.
  if (state.installed) ok(t("doctor.workflowExists", WORKFLOW_REL));
  else bad(t("doctor.workflowMissing", WORKFLOW_REL), t("doctor.workflowMissingFix"));

  // 2. Workflow present on the base branch — the one that actually matters.
  //    pull_request_target reads the workflow from the base branch, so a file
  //    that exists only on a feature branch produces no runs and no error.
  if (state.installed && state.defaultBranch) {
    const onBase = sh("git", ["cat-file", "-e", `origin/${state.defaultBranch}:${WORKFLOW_REL}`], { cwd: state.root });
    if (onBase.ok) ok(t("doctor.onBase", state.defaultBranch));
    else bad(t("doctor.notOnBase", state.defaultBranch), t("doctor.notOnBaseFix"));
  }

  if (!state.gh) {
    say();
    warn(t("doctor.noGh"));
    say(dim(t("doctor.noGhHint")));
    return summarize(problems);
  }

  // 3. The secret. Existence only — the value is never fetched or printed.
  const secrets = sh("gh", ["secret", "list", "--json", "name"], { cwd: state.root });
  if (secrets.ok && /"name"\s*:\s*"ORCAROUTER_API_KEY"/.test(secrets.out)) {
    ok(t("doctor.secretSet", SECRET));
  } else {
    bad(t("doctor.secretMissing", SECRET), t("doctor.secretMissingFix", SECRET, CONSOLE_TOKENS));
  }

  // 4. Recent runs.
  const runs = sh(
    "gh",
    ["run", "list", "--workflow", "orca-code-review.yml", "--limit", "5", "--json", "conclusion,status,headBranch,createdAt"],
    { cwd: state.root },
  );
  if (!runs.ok) {
    warn(t("doctor.runsUnreadable"));
  } else {
    let list = [];
    try { list = JSON.parse(runs.out); } catch { /* fall through to the empty case */ }
    if (list.length === 0) {
      bad(t("doctor.noRuns"), t("doctor.noRunsFix"));
    } else {
      ok(t("doctor.recentRuns", list.length));
      for (const r of list) {
        const mark = r.conclusion === "success" ? green("pass") : r.conclusion ? red(r.conclusion) : yellow(r.status);
        say(`    ${mark}  ${r.headBranch}  ${dim(r.createdAt)}`);
      }
      if (list.some((r) => r.conclusion === "failure")) info(t("doctor.inspectFailure"));
    }
  }

  // 5. The gate. A red check blocks nothing until it is required.
  if (state.defaultBranch && state.nameWithOwner) {
    const prot = sh(
      "gh",
      ["api", `repos/${state.nameWithOwner}/branches/${state.defaultBranch}/protection/required_status_checks`],
      { cwd: state.root },
    );
    if (prot.ok && /"review"/.test(prot.out)) ok(t("doctor.gateRequired", state.defaultBranch));
    else if (prot.ok) bad(t("doctor.gateMissing", state.defaultBranch), t("doctor.gateMissingFix"));
    else warn(t("doctor.noProtection", state.defaultBranch));
  }

  return summarize(problems);
}

function summarize(problems) {
  say();
  if (problems === 0) ok(bold(t("doctor.clean")));
  else {
    fail(t("doctor.problems", problems));
    say(dim(t("doctor.problemsHint")));
  }
}

async function cmdUninstall() {
  const state = repoState();
  if (!state.installed) {
    info(t("uninstall.nothing", WORKFLOW_REL));
    return;
  }

  say();
  say(bold(t("uninstall.title")));
  say();
  warn(t("uninstall.gateFirst"));
  if (state.nameWithOwner && state.defaultBranch) {
    say(dim(t("uninstall.gateWhere", state.nameWithOwner, state.defaultBranch)));
  }

  if (!(await confirm(t("uninstall.deleteConfirm", WORKFLOW_REL), false))) {
    closeUi();
    info(t("common.abortedRemoval"));
    return;
  }

  fs.rmSync(state.workflowPath);
  closeUi();
  ok(t("uninstall.removed", WORKFLOW_REL));
  say();
  say(t("uninstall.keepSecret", SECRET));
  say(t("uninstall.disableApp", cyan(CONSOLE_APPS)));
  say(t("uninstall.keepComments"));
}

// ------------------------------------------------------------------- skill ---

const homeDir = () => process.env.HOME || process.env.USERPROFILE || "";
const lookPath = (exe) => sh(process.platform === "win32" ? "where" : "which", [exe]).ok;

async function cmdSkill(argv) {
  const source = path.join(PKG_ROOT, "skills", SKILL_NAME);
  if (!fs.existsSync(source)) die(t("skill.missingBundle"), t("skill.missingBundleHint"));

  const home = homeDir();
  // Detection always looks at the working directory, even for a global install:
  // "which agents does this person use" is answered by the project they are
  // standing in, not by where the files will land.
  const cwd = process.cwd();
  const detected = detectPlatforms(cwd, home, lookPath);

  const scope = argv.scope ?? (await select(
    t("skill.scopeQ"),
    [
      { label: t("skill.scopeProject"), value: "project", recommended: true, detail: t("skill.scopeProjectDetail") },
      { label: t("skill.scopeGlobal"), value: "global", detail: t("skill.scopeGlobalDetail") },
    ],
  ));
  if (scope !== "project" && scope !== "global") {
    die(t("skill.unknownScope", scope), t("skill.unknownScopeHint"));
  }

  let platformIds = argv.platforms ?? [];
  for (const id of platformIds) {
    if (!findPlatform(id)) die(t("skill.unknownPlatform", id), t("skill.unknownPlatformHint"));
  }

  if (platformIds.length === 0) {
    if (ASSUME_YES || !process.stdin.isTTY) {
      // Unattended: install to what is actually here. Falling back to "all 36"
      // would scatter directories across a machine nobody asked us to touch.
      platformIds = detected;
      if (platformIds.length === 0) die(t("skill.noneDetected"), t("skill.noneDetectedHint"));
    } else {
      // Detected first, then the popular names, then the long tail — so the
      // list opens on something recognizable instead of 36 rows of alphabet soup.
      const rank = (p) => (detected.includes(p.id) ? 0 : POPULAR_PLATFORM_IDS.includes(p.id) ? 1 : 2);
      const options = [...SKILL_PLATFORMS]
        .map((p, i) => ({ p, i }))
        .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
        .map(({ p }) => ({ label: p.name, value: p.id, detected: detected.includes(p.id) }));

      platformIds = await multiSelect(
        `${t("skill.platformQ")}${detected.length ? dim(t("skill.platformCount", detected.length)) : ""}`,
        options,
        { preselected: detected },
      );
    }
  }

  // Prefer the git root so a `skill install` from a subdirectory lands beside
  // the repo's other agent config, but do not require a repo — plenty of people
  // keep a scratch directory with an AGENTS setup and no git.
  const gitRoot = sh("git", ["rev-parse", "--show-toplevel"], { cwd });
  const projectDir = scope === "project" && gitRoot.ok ? gitRoot.out : cwd;
  const targets = resolveTargets({ platformIds, scope, projectDir, homeDir: home, skillName: SKILL_NAME });

  const results = targets.map((target) => {
    try {
      return { ...target, status: installTree(source, target.path, { force: argv.force }) };
    } catch (e) {
      return { ...target, status: STATUS.error, error: e.message };
    }
  });

  closeUi();

  if (argv.json) {
    say(JSON.stringify({ scope, source, results }, null, 2));
    if (results.some((r) => r.status === STATUS.error)) process.exitCode = 1;
    return;
  }

  say();
  for (const r of results) {
    const names = r.platformNames.join(", ");
    const where = dim(path.relative(scope === "project" ? projectDir : home, r.path) || r.path);
    switch (r.status) {
      case STATUS.installed: ok(`${names}  ${where}`); break;
      case STATUS.updated: ok(`${names}  ${where} ${dim(t("skill.statusUpdated"))}`); break;
      case STATUS.unchanged: say(`${dim("·")} ${names}  ${where} ${dim(t("skill.statusUnchanged"))}`); break;
      case STATUS.conflict: warn(`${names}  ${where} ${dim(t("skill.statusConflict"))}`); break;
      default: fail(`${names}  ${where} — ${r.error}`);
    }
  }

  if (results.some((r) => r.status === STATUS.conflict)) {
    say();
    info(t("skill.forceHint"));
  }
  if (results.some((r) => r.status === STATUS.error)) process.exitCode = 1;

  const installed = results.filter((r) => r.status === STATUS.installed || r.status === STATUS.updated);
  if (installed.length > 0) {
    say();
    info(t("skill.askAgent"));
    if (installed.some((r) => r.platformIds.includes("claude"))) {
      say(dim(t("skill.pluginHint")));
      say(dim("    /plugin marketplace add Continuum-AI-Corp/orca-code-review"));
      say(dim("    /plugin install orca-code-review"));
    }
  }
}

function cmdListPlatforms(argv) {
  const detected = detectPlatforms(process.cwd(), homeDir(), lookPath);
  if (argv.json) {
    return say(JSON.stringify(
      SKILL_PLATFORMS.map((p) => ({ ...p, detected: detected.includes(p.id) })),
      null,
      2,
    ));
  }
  say();
  say(bold(t("skill.listTitle", SKILL_PLATFORMS.length)) + dim(t("skill.listColumns")));
  for (const p of SKILL_PLATFORMS) {
    const mark = detected.includes(p.id) ? green("●") : dim("○");
    say(`  ${mark} ${p.id.padEnd(16)} ${p.name.padEnd(22)} ${dim(`${p.projectRoot}/skills/  ~/${p.globalRoot}/skills/`)}`);
  }
  say();
  say(dim(t("skill.listLegend")));
}

// ------------------------------------------------------------------ secret ---

async function setupSecret(state) {
  say();
  say(bold(t("secret.title", SECRET)));
  say(dim(t("secret.createHint", CONSOLE_TOKENS)));

  if (state.gh) {
    const list = sh("gh", ["secret", "list", "--json", "name"], { cwd: state.root });
    if (list.ok && /"name"\s*:\s*"ORCAROUTER_API_KEY"/.test(list.out)) {
      ok(t("secret.alreadySet", SECRET));
      return;
    }
    // `gh secret set` prompts for the value, so it needs a real terminal. Under
    // --yes or a piped stdin there is nobody to type the key — offering it would
    // just hand the user a confusing gh error instead of the manual URL.
    const canPrompt = process.stdin.isTTY && !ASSUME_YES;
    if (canPrompt && (await confirm(t("secret.setNow"), true))) {
      // Inherited stdio: gh prompts for the value directly. It never passes
      // through this process, so it cannot land in argv, a log, or scrollback.
      const r = spawnSync("gh", ["secret", "set", SECRET], { cwd: state.root, stdio: "inherit" });
      if (r.status === 0) { ok(t("secret.wasSet", SECRET)); return; }
      warn(t("secret.ghFailed"));
    }
  }

  const url = state.nameWithOwner
    ? `https://github.com/${state.nameWithOwner}/settings/secrets/actions/new`
    : t("secret.manualPath");
  say(t("secret.addManually", bold(SECRET)));
  say(`  ${cyan(url)}`);
}

// -------------------------------------------------------------------- main ---

function usage() {
  const n = SKILL_PLATFORMS.length;
  say(`${bold("orcacode-review")} — ${t("usage.tagline")}

${bold(t("usage.usage"))}
  npx orcacode-review [command] [options]

${bold(t("usage.commands"))}
  init             ${t("usage.cmdInit")}
  reconfigure      ${t("usage.cmdReconfigure")}
  doctor           ${t("usage.cmdDoctor")}
  uninstall        ${t("usage.cmdUninstall")}
  skill install    ${t("usage.cmdSkillInstall", n)}
  skill list       ${t("usage.cmdSkillList")}

${bold(t("usage.options"))}
  --yes, -y        ${t("usage.optYes")}
  --force          ${t("usage.optForce")}
  --json           ${t("usage.optJson")}
  --lang <zh|en>   ${t("usage.optLang")}
  --no-banner      ${t("usage.optNoBanner")}
  --scope <s>      ${t("usage.optScope")}
  --platform <id>  ${t("usage.optPlatform")}
  --help, -h       ${t("usage.optHelp")}
  --version, -v    ${t("usage.optVersion")}

${bold(t("usage.examples"))}
  npx orcacode-review skill install --platform claude --platform codex --yes
  npx orcacode-review skill install --scope global --platform cursor --lang zh

${bold(t("usage.docs"))}  https://github.com/Continuum-AI-Corp/orca-code-review`);
}

function parse(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--force") out.force = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--json") out.json = true;
    else if (a === "--list") out.list = true;
    else if (a === "--no-banner") out.noBanner = true;
    else if (a === "--lang") out.lang = args[++i];
    else if (a.startsWith("--lang=")) out.lang = a.slice(7);
    else if (a === "--scope") out.scope = args[++i];
    else if (a.startsWith("--scope=")) out.scope = a.slice(8);
    // Repeatable, matching orcadub: --platform claude --platform codex.
    // A comma-separated list is also accepted because people type it anyway.
    else if (a === "--platform" || a === "--platforms") pushPlatforms(out, args[++i]);
    else if (a.startsWith("--platform=")) pushPlatforms(out, a.slice(11));
    else if (a.startsWith("--platforms=")) pushPlatforms(out, a.slice(12));
    else if (a.startsWith("-")) die(t("common.unknownOption", a), t("common.unknownOptionHint"));
    else out._.push(a);
  }
  return out;
}

function pushPlatforms(out, raw) {
  if (!raw) die(t("common.missingPlatformValue"), t("skill.unknownPlatformHint"));
  out.platforms ??= [];
  for (const id of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!out.platforms.includes(id)) out.platforms.push(id);
  }
}

async function main() {
  const argv = parse(process.argv.slice(2));

  if (argv.lang) {
    try {
      setLanguage(parseLanguage(argv.lang));
    } catch {
      // Reported in the locale-detected language — the flag was wrong, not the
      // user's locale, so their own language is still the right one to use.
      die(t("common.unknownLanguage", argv.lang), t("common.unknownLanguageHint"));
    }
  }

  if (argv.help) return usage();
  if (argv.version) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
    return say(pkg.version);
  }

  ASSUME_YES = Boolean(argv.yes);

  let cmd = argv._[0];
  const guided = !cmd || (cmd === "skill" && argv._[1] !== "list" && !argv.list);

  // The wordmark and the language screen belong to the guided flows only.
  // Putting them in front of `doctor` would just be noise on a diagnostic.
  if (guided) {
    showBanner(argv);
    await askLanguage(argv);
  }

  if (!cmd) {
    const state = repoState();
    cmd = await select(
      `${t("menu.question")}${state.installed ? dim(t("menu.alreadyInstalled")) : ""}`,
      [
        { label: t("menu.install"), value: "init", recommended: !state.installed },
        { label: t("menu.reconfigure"), value: "reconfigure", recommended: state.installed },
        { label: t("menu.doctor"), value: "doctor" },
        { label: t("menu.skill", SKILL_PLATFORMS.length), value: "skill" },
        { label: t("menu.uninstall"), value: "uninstall" },
      ],
      { defaultIndex: state.installed ? 1 : 0 },
    );
  }

  switch (cmd) {
    case "init":
    case "install": return cmdInit(argv);
    case "reconfigure":
    case "config": return cmdReconfigure(argv);
    case "doctor":
    case "check": return cmdDoctor();
    case "uninstall":
    case "remove": return cmdUninstall();
    case "skill": {
      // `skill`, `skill install`, `skill list` — the sub-verb is optional so the
      // bare form keeps working for anyone who learned it before `list` existed.
      const sub = argv._[1];
      if (sub === "list" || sub === "platforms" || argv.list) return cmdListPlatforms(argv);
      if (sub && sub !== "install") die(t("common.unknownCommand", `skill ${sub}`), "skill install | skill list");
      return cmdSkill(argv);
    }
    default:
      usage();
      die(t("common.unknownCommand", cmd));
  }
}

// Only run when invoked as a program. Importing this file (the test suite does)
// must not touch the filesystem or open a readline interface.
//
// Both sides are resolved through realpath before comparing. npm installs a
// `bin` as a SYMLINK at node_modules/.bin/<name>, so argv[1] is the link while
// import.meta.url is the link's target — comparing them raw is false for every
// npx and every global install, and the CLI exits 0 having done nothing at all.
// That failure is invisible when testing with `node bin/orcacode-review.mjs`,
// which is why installer.test.mjs now execs through a symlink.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved (deleted, permission-denied) is not a
    // direct invocation we can prove — stay quiet rather than run by accident.
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .catch((e) => die(e?.message || String(e)))
    .finally(closeUi);
}
