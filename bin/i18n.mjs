// Simplified Chinese / English strings for the installer, matching the
// zh|en pair orcadub's Skill installer ships.
//
// Two rules hold this together:
//
//   1. English is the fallback for any key a translation misses, so a gap
//      shows up as an English line rather than a blank or a raw key.
//   2. Only prose is translated. Flag names, platform IDs, workflow inputs,
//      severity codes, file paths, and shell commands stay verbatim in both
//      languages — a user who reads the Chinese output still has to type
//      `--platform codex` and grep for `block-on`, and translating those would
//      make the output impossible to act on.

export const LANGUAGES = Object.freeze(["en", "zh", "ja", "ko"]);

// The locale prefixes that map onto each table. Traditional Chinese is
// deliberately absent — zh-TW/zh-HK differ enough in vocabulary that serving
// them Simplified reads worse than serving them English.
const LOCALE_PREFIX = Object.freeze({
  zh: ["zh", "zh-cn", "zh-sg", "zh-hans", "zh-hans-cn"],
  ja: ["ja", "ja-jp"],
  ko: ["ko", "ko-kr"],
});

export function parseLanguage(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (LANGUAGES.includes(value)) return value;
  throw new Error(`unknown language "${raw}" (use zh or en)`);
}

/** Picks a default from the POSIX locale variables, in the usual precedence. */
export function detectLanguage(env = process.env) {
  if (env.ORCACODE_LANG) {
    try { return parseLanguage(env.ORCACODE_LANG); } catch { /* fall through to the locale */ }
  }
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  const locale = raw.split(".")[0].replaceAll("_", "-").toLowerCase();
  for (const [lang, prefixes] of Object.entries(LOCALE_PREFIX)) {
    if (prefixes.includes(locale)) return lang;
  }
  return "en";
}

const EN = {
  lang: { question: "Language / 语言 / 言語 / 언어", en: "English", zh: "简体中文", ja: "日本語", ko: "한국어" },

  common: {
    recommended: "(recommended)",
    detected: "detected",
    chooseRange: (n, d) => `  choose 1-${n} [${d}] `,
    enterNumber: (n) => `Enter a number between 1 and ${n}.`,
    multiHint: "e.g. 1,3 or 1-4 · a = all · Enter = keep the checked set",
    selectPrompt: "  select ",
    nothingSelected: "Nothing selected. Pick at least one, or press Ctrl-C to abort.",
    hintSelect: "↑↓ move · Enter select",
    hintMulti: "space toggle · a all · n none · / filter · Enter confirm",
    hintFiltering: "type to filter · ctrl-u clear · Enter apply",
    hintFilterLabel: "filter:",
    hintNoMatch: "no match",
    countSelected: (n) => `${n} selected`,
    nonTTY: (what) => `Cannot ask about ${what} — stdin is not a terminal.`,
    nonTTYHint: "Re-run with --yes to accept the recommended defaults, or pass the flags explicitly (--help).",
    notGitRepo: "Not inside a git repository.",
    notGitRepoHint: "cd into your repo and run this again.",
    unknownOption: (a) => `Unknown option: ${a}`,
    unknownOptionHint: "Run with --help for usage.",
    unknownCommand: (c) => `Unknown command: ${c}`,
    unknownLanguage: (l) => `Unknown language "${l}".`,
    unknownLanguageHint: "Use --lang en, zh, ja or ko.",
    missingPlatformValue: "--platform needs a value.",
    aborted: "Aborted. Nothing was written.",
    abortedRemoval: "Aborted. Nothing was removed.",
  },


  config: {
    settingsQ: "Where should review settings live?",
    settingsDashboard: "OrcaRouter dashboard",
    settingsDashboardDetail:
      "Change models, review mode, rubric, and severity rules from the console — no workflow edit.",
    settingsFile: "This workflow file",
    settingsFileDetail:
      "Skips the dashboard fetch. The YAML is authoritative; nothing server-side can override it.",

    blockQ: "Which findings should block the merge?",
    blockBoth: "P0 and P1",
    blockBothDetail: "The default contract: critical and high severity fail the check.",
    blockP0: "P0 only",
    blockP0Detail: "Only critical issues block. P1 still posts inline.",
    blockNone: "Nothing — comment only",
    blockNoneDetail: "The check always passes. Good for a trial period.",

    oversizedQ: "What should happen when a PR's diff is too large to review?",
    oversizedFail: "Fail the check",
    oversizedFailDetail: "A diff padded past the size limits cannot slip past a required merge gate.",
    oversizedPass: "Pass with a notice",
    oversizedPassDetail: "The skip notice posts and the check stays green.",

    publicWarning: (url) =>
      "This repo is public. The workflow runs on pull_request_target with your\n" +
      "  OrcaRouter secret, which bypasses GitHub's fork-approval gate — so a stranger\n" +
      `  opening a PR can spend from your wallet. Set a budget + alert at ${url}.`,
    authorsQ: "Who gets an automatic review?",
    authorsKnown: "Known contributors only",
    authorsKnownDetail: "Everyone else can still be reviewed on demand via /orcacode-review.",
    authorsAll: "Everyone",
    authorsAllDetail: "Any PR from anyone triggers a paid review.",
  },

  init: {
    title: "OrcaCode Review — install",
    repo: (name) => `  repo      ${name}`,
    repoUnknown: "(unknown — no GitHub remote detected)",
    workflow: (p) => `  workflow  ${p}`,
    exists: "A workflow already exists at that path.",
    reconfigureInstead: "Reconfigure it instead?",
    unchangedHint: "Nothing changed. Re-run with --force to overwrite.",
    preview: "Workflow to write:",
    writeConfirm: (p) => `Write ${p}?`,
    wrote: (p) => `Wrote ${p}`,
    remaining: "Remaining steps",
    step1: (url) => `  1. Enable the app: ${url} → Apps → OrcaCode Review`,
    step1Note: "     Reviews do not run until it is enabled.",
    step2: "  2. Commit on a branch and open a PR —",
    step2Note:
      "     pull_request_target reads the workflow from the base branch, so review\n" +
      "     only starts once this file is on your default branch.",
    step3: "  3. Make the gate real: Settings → Branches / Rulesets → Require status checks",
    step3Note: (check) => `     and add the ${check} check. A red check blocks nothing until it is required.`,
    diagnoseHint: "  Diagnose anytime with: npx @orcarouter/code-review doctor",
  },

  reconfigure: {
    title: "OrcaCode Review — reconfigure",
    missing: (p) => `No workflow at ${p}.`,
    missingHint: "Run `npx @orcarouter/code-review init` first.",
    dashboardOwns: "This install lets the OrcaRouter dashboard own most settings.",
    dashboardOwnsDetail: (url) =>
      "  Review mode, models, exhaustive mode, quiet mode, and the rubric are not in\n" +
      `  this file — change them at ${url} → Apps → OrcaCode Review.\n` +
      "  An input written here only wins when it differs from its documented default.",
    noChanges: "No changes — the workflow already matches those answers.",
    changes: "Changes",
    applyConfirm: (p) => `Apply to ${p}?`,
    updated: (p) => `Updated ${p}`,
    commitHint: "Commit and push. The new settings apply on the next push to any open PR.",
  },

  doctor: {
    title: "OrcaCode Review — doctor",
    repo: (name) => `  repo ${name}`,
    repoUnknown: "(unknown)",
    workflowExists: (p) => `${p} exists`,
    workflowMissing: (p) => `${p} is missing`,
    workflowMissingFix: "Run: npx @orcarouter/code-review init",
    onBase: (b) => `Present on origin/${b}`,
    notOnBase: (b) => `Not on origin/${b} yet`,
    notOnBaseFix:
      "pull_request_target reads the workflow from the BASE branch. Merge it before expecting runs.",
    noGh: "GitHub CLI unavailable or not authenticated — skipping secret, run, and gate checks.",
    noGhHint: "  Install from https://cli.github.com and run `gh auth login` for the full report.",
    secretSet: (s) => `Repository secret ${s} is set`,
    secretMissing: (s) => `Repository secret ${s} not found`,
    secretMissingFix: (s, url) => `Run: gh secret set ${s}   (key from ${url})`,
    runsUnreadable: "Could not list workflow runs (the workflow may never have run).",
    noRuns: "No runs recorded for this workflow",
    noRunsFix:
      "Common causes: the app is off in the dashboard, auto_review is off, the PR is a draft\n" +
      "  under trigger=ready_for_review, or the author is outside auto-review-authors.",
    recentRuns: (n) => `${n} recent run(s):`,
    inspectFailure: "Inspect a failure with: gh run view <run-id> --log-failed",
    gateRequired: (b) => `The "review" check is required on ${b}`,
    gateMissing: (b) => `The "review" check is NOT required on ${b}`,
    gateMissingFix:
      "Findings post, but nothing is blocked. Settings → Branches / Rulesets → Require status checks.",
    noProtection: (b) => `No branch protection readable on ${b} — merges are not gated.`,
    clean: "No problems found.",
    problems: (n) => `${n} problem(s) found — see the fixes above.`,
    problemsHint:
      "  Full symptom → cause → fix table: skills/setup-orca-code-review/references/troubleshooting.md",
  },

  uninstall: {
    title: "OrcaCode Review — uninstall",
    nothing: (p) => `Nothing to remove — no ${p}.`,
    gateFirst:
      'Drop the required "review" check FIRST.\n' +
      "  A required check whose workflow no longer exists never reports, and every PR\n" +
      "  blocks forever with no way to clear it.",
    gateWhere: (repo, branch) => `  Settings → Branches / Rulesets on ${repo} (${branch})`,
    deleteConfirm: (p) => `Delete ${p} now?`,
    removed: (p) => `Removed ${p}`,
    keepSecret: (s) => `  • The ${s} secret is harmless to keep, and worth keeping if you may reinstall.`,
    disableApp: (url) => `  • Turn the app off at ${url} → Apps → OrcaCode Review to stop any billing.`,
    keepComments: "  • Existing review comments are left in place — they are part of the PR history.",
  },

  skill: {
    missingBundle: "The bundled skill is missing from this package.",
    missingBundleHint: "Reinstall with: npx @orcarouter/code-review@latest skill",
    scopeQ: "Where should the skill be installed?",
    scopeProject: "This project",
    scopeProjectDetail: "Committed with the repo — everyone who clones it gets the skill.",
    scopeGlobal: "My user account",
    scopeGlobalDetail: "Available in every project on this machine.",
    unknownScope: (s) => `Unknown scope "${s}".`,
    unknownScopeHint: "Use --scope project or --scope global.",
    unknownPlatform: (id) => `Unknown platform "${id}".`,
    unknownPlatformHint: "List them with: npx @orcarouter/code-review skill list",
    noneDetected: "No agent platform detected here, and none was named.",
    noneDetectedHint:
      "Pass one explicitly, e.g. --platform claude --platform codex (`skill list` shows all 36).",
    platformQ: "Which agents should get the skill?",
    platformCount: (n) => ` (${n} detected)`,
    statusUpdated: "(updated)",
    statusUnchanged: "(already current)",
    statusConflict: "(left alone — a different version is already there)",
    forceHint: "Re-run with --force to overwrite the differing copies.",
    askAgent: 'Ask your agent: "set up OrcaCode Review in this repo".',
    pluginHint: "  For Claude Code, the plugin keeps itself updated instead:",
    handoffTitle: "Now just ask your agent",
    handoffPrimary: "set up OrcaCode Review in this repo",
    handoffMore: "It can also:",
    handoffDoctor: '"why isn\'t OrcaCode Review running?"',
    handoffDoctorWhat: "diagnose",
    handoffTune: '"make OrcaCode Review block P0 only"',
    handoffTuneWhat: "change the merge policy",
    handoffRemove: '"remove OrcaCode Review from this repo"',
    handoffRemoveWhat: "uninstall",
    handoffCli: "Prefer the terminal? Those work as subcommands too — see --help.",
    listTitle: (n) => `${n} supported platforms`,
    listColumns: "  (project root / global root)",
    listLegend: "  ● = detected here.  Install with: npx @orcarouter/code-review skill install --platform <id>",
  },

  secret: {
    title: (s) => `Repository secret: ${s}`,
    createHint: (url) => `  Create or copy a key at ${url}`,
    alreadySet: (s) => `${s} is already set.`,
    setNow: "Set it now with the GitHub CLI?",
    wasSet: (s) => `${s} set.`,
    ghFailed: "gh could not set the secret. Add it in the browser instead:",
    addManually: (s) => `  Add a secret named ${s} at:`,
    manualPath: "your repo → Settings → Secrets and variables → Actions → New repository secret",
  },

  usage: {
    tagline: "installer for OrcaCode Review (AI PR review by OrcaRouter)",
    usage: "Usage",
    bareCommand: "Run with no command to install the skill, then ask your agent to do the rest.",
    commands: "Commands",
    options: "Options",
    examples: "Examples",
    docs: "Docs",
    cmdInit: "Write .github/workflows/orca-code-review.yml yourself",
    cmdReconfigure: "Change the inputs in an existing workflow",
    cmdDoctor: "Diagnose an install that is not working",
    cmdUninstall: "Remove the workflow",
    cmdSkillInstall: (n) => `Install the agent skill (${n} platforms) — the default`,
    cmdSkillList: "List the supported platforms and which are detected here",
    optYes: "Accept the recommended defaults; never prompt",
    optForce: "Overwrite without asking",
    optJson: "Machine-readable output (skill install / skill list)",
    optLang: "Interface language: en | zh | ja | ko (default: from your locale)",
    optNoBanner: "Skip the wordmark",
    optScope: "For `skill`: project | global",
    optPlatform: "For `skill`: repeatable; omit to pick interactively",
    optHelp: "Show this",
    optVersion: "Show the version",
  },
};

const ZH = {
  lang: { question: "Language / 语言 / 言語 / 언어", en: "English", zh: "简体中文", ja: "日本語", ko: "한국어" },

  common: {
    recommended: "（推荐）",
    detected: "已检测",
    chooseRange: (n, d) => `  请输入 1-${n} [${d}] `,
    enterNumber: (n) => `请输入 1 到 ${n} 之间的数字。`,
    multiHint: "例如 1,3 或 1-4 · a = 全选 · 直接回车 = 保持已勾选项",
    selectPrompt: "  选择 ",
    nothingSelected: "未选择任何平台。请至少选一个，或按 Ctrl-C 退出。",
    hintSelect: "↑↓ 移动 · Enter 选择",
    hintMulti: "空格 勾选 · a 全选 · n 清空 · / 搜索 · Enter 确认",
    hintFiltering: "输入即搜索 · ctrl-u 清除 · Enter 应用",
    hintFilterLabel: "搜索：",
    hintNoMatch: "无匹配项",
    countSelected: (n) => `已选 ${n} 个`,
    nonTTY: (what) => `无法询问「${what}」—— 标准输入不是终端。`,
    nonTTYHint: "加 --yes 使用推荐默认值，或直接用命令行参数指定（见 --help）。",
    notGitRepo: "当前目录不是 git 仓库。",
    notGitRepoHint: "先 cd 进你的仓库再运行。",
    unknownOption: (a) => `未知参数：${a}`,
    unknownOptionHint: "用 --help 查看用法。",
    unknownCommand: (c) => `未知命令：${c}`,
    unknownLanguage: (l) => `未知语言「${l}」。`,
    unknownLanguageHint: "请用 --lang en / zh / ja / ko。",
    missingPlatformValue: "--platform 需要一个值。",
    aborted: "已取消，未写入任何内容。",
    abortedRemoval: "已取消，未删除任何内容。",
  },


  config: {
    settingsQ: "评审配置放在哪里？",
    settingsDashboard: "OrcaRouter 控制台",
    settingsDashboardDetail: "模型、评审模式、评分规则、严重级别都在控制台改，不用动 workflow。",
    settingsFile: "当前 workflow 文件",
    settingsFileDetail: "跳过控制台拉取。以 YAML 为准，服务端任何配置都无法覆盖。",

    blockQ: "哪些问题要拦住合并？",
    blockBoth: "P0 和 P1",
    blockBothDetail: "默认约定：严重和高危问题会让检查失败。",
    blockP0: "只拦 P0",
    blockP0Detail: "只有严重问题拦截，P1 仍然会评论在代码行上。",
    blockNone: "都不拦 —— 只评论",
    blockNoneDetail: "检查永远通过。适合试用期。",

    oversizedQ: "PR 的 diff 大到无法评审时怎么办？",
    oversizedFail: "让检查失败",
    oversizedFailDetail: "把 diff 撑到超过体积上限，也没法绕过必需的合并门禁。",
    oversizedPass: "通过，只发提示",
    oversizedPassDetail: "发一条跳过说明，检查保持绿色。",

    publicWarning: (url) =>
      "这是公开仓库。workflow 跑在 pull_request_target 上并带着你的 OrcaRouter\n" +
      "  密钥，会绕过 GitHub 的 fork 审批门禁 —— 陌生人开个 PR 就能花你的钱。\n" +
      `  请在 ${url} 设置预算上限和告警。`,
    authorsQ: "谁的 PR 会被自动评审？",
    authorsKnown: "仅限已知贡献者",
    authorsKnownDetail: "其他人仍可由维护者用 /orcacode-review 手动触发评审。",
    authorsAll: "所有人",
    authorsAllDetail: "任何人开 PR 都会触发一次付费评审。",
  },

  init: {
    title: "OrcaCode Review —— 安装",
    repo: (name) => `  仓库      ${name}`,
    repoUnknown: "（未知 —— 没检测到 GitHub remote）",
    workflow: (p) => `  workflow  ${p}`,
    exists: "该路径下已存在 workflow。",
    reconfigureInstead: "改为修改现有配置？",
    unchangedHint: "未做任何改动。要覆盖请加 --force 重新运行。",
    preview: "将要写入的 workflow：",
    writeConfirm: (p) => `写入 ${p}？`,
    wrote: (p) => `已写入 ${p}`,
    remaining: "接下来还要做",
    step1: (url) => `  1. 启用应用：${url} → Apps → OrcaCode Review`,
    step1Note: "     不启用的话评审不会运行。",
    step2: "  2. 在分支上提交并开一个 PR ——",
    step2Note:
      "     pull_request_target 从目标分支读取 workflow，所以只有这个文件进了\n" +
      "     默认分支，评审才会开始跑。",
    step3: "  3. 让门禁真正生效：Settings → Branches / Rulesets → Require status checks",
    step3Note: (check) => `     把 ${check} 检查设为必需。检查变红本身拦不住任何东西。`,
    diagnoseHint: "  随时体检：npx @orcarouter/code-review doctor",
  },

  reconfigure: {
    title: "OrcaCode Review —— 修改配置",
    missing: (p) => `找不到 ${p}。`,
    missingHint: "先运行 `npx @orcarouter/code-review init`。",
    dashboardOwns: "这个安装把大部分配置交给了 OrcaRouter 控制台。",
    dashboardOwnsDetail: (url) =>
      "  评审模式、模型、穷尽模式、静默模式和评分规则都不在这个文件里 ——\n" +
      `  去 ${url} → Apps → OrcaCode Review 改。\n` +
      "  写在这里的 input 只有在与文档默认值不同时才会生效。",
    noChanges: "没有变化 —— workflow 和你的选择已经一致。",
    changes: "变更",
    applyConfirm: (p) => `应用到 ${p}？`,
    updated: (p) => `已更新 ${p}`,
    commitHint: "提交并推送。新配置会在下一次向任意开放 PR 推送时生效。",
  },

  doctor: {
    title: "OrcaCode Review —— 体检",
    repo: (name) => `  仓库 ${name}`,
    repoUnknown: "（未知）",
    workflowExists: (p) => `${p} 存在`,
    workflowMissing: (p) => `缺少 ${p}`,
    workflowMissingFix: "运行：npx @orcarouter/code-review init",
    onBase: (b) => `已在 origin/${b} 上`,
    notOnBase: (b) => `还没进 origin/${b}`,
    notOnBaseFix: "pull_request_target 从「目标分支」读取 workflow。合并进去之后才会有运行记录。",
    noGh: "GitHub CLI 不可用或未登录 —— 跳过密钥、运行记录和门禁检查。",
    noGhHint: "  从 https://cli.github.com 安装并运行 `gh auth login` 可获得完整报告。",
    secretSet: (s) => `仓库密钥 ${s} 已配置`,
    secretMissing: (s) => `找不到仓库密钥 ${s}`,
    secretMissingFix: (s, url) => `运行：gh secret set ${s}   （密钥来自 ${url}）`,
    runsUnreadable: "无法读取运行记录（这个 workflow 可能从没跑过）。",
    noRuns: "这个 workflow 没有任何运行记录",
    noRunsFix:
      "常见原因：控制台里应用没开、auto_review 关着、trigger=ready_for_review 时 PR\n" +
      "  还是草稿，或者作者不在 auto-review-authors 白名单里。",
    recentRuns: (n) => `最近 ${n} 次运行：`,
    inspectFailure: "查看失败详情：gh run view <run-id> --log-failed",
    gateRequired: (b) => `${b} 上「review」检查已设为必需`,
    gateMissing: (b) => `${b} 上「review」检查「不是」必需的`,
    gateMissingFix: "问题照样会评论出来，但拦不住合并。Settings → Branches / Rulesets → Require status checks。",
    noProtection: (b) => `读不到 ${b} 的分支保护 —— 合并没有门禁。`,
    clean: "没有发现问题。",
    problems: (n) => `发现 ${n} 个问题 —— 修复方式见上。`,
    problemsHint: "  完整的「现象 → 原因 → 修复」表：skills/setup-orca-code-review/references/troubleshooting.md",
  },

  uninstall: {
    title: "OrcaCode Review —— 卸载",
    nothing: (p) => `没什么可删的 —— 不存在 ${p}。`,
    gateFirst:
      "请「先」取消必需的「review」检查。\n" +
      "  workflow 都删了，必需检查就永远不会上报，所有 PR 会被永久卡住，没有任何\n" +
      "  办法解开。",
    gateWhere: (repo, branch) => `  ${repo} 的 Settings → Branches / Rulesets（${branch}）`,
    deleteConfirm: (p) => `现在删除 ${p}？`,
    removed: (p) => `已删除 ${p}`,
    keepSecret: (s) => `  • ${s} 密钥留着没有坏处，以后想重装还用得上。`,
    disableApp: (url) => `  • 去 ${url} → Apps → OrcaCode Review 关掉应用，停止计费。`,
    keepComments: "  • 已有的评审评论会保留 —— 它们是 PR 历史的一部分。",
  },

  skill: {
    missingBundle: "这个包里缺少内置的 skill。",
    missingBundleHint: "重新安装：npx @orcarouter/code-review@latest skill",
    scopeQ: "skill 装到哪里？",
    scopeProject: "当前项目",
    scopeProjectDetail: "随仓库提交 —— 每个 clone 的人都能用。",
    scopeGlobal: "当前用户",
    scopeGlobalDetail: "本机所有项目都能用。",
    unknownScope: (s) => `未知的安装范围「${s}」。`,
    unknownScopeHint: "用 --scope project 或 --scope global。",
    unknownPlatform: (id) => `未知平台「${id}」。`,
    unknownPlatformHint: "用 npx @orcarouter/code-review skill list 查看全部。",
    noneDetected: "这里没检测到任何 Agent 平台，也没有指定平台。",
    noneDetectedHint: "请显式指定，例如 --platform claude --platform codex（`skill list` 列出全部 36 个）。",
    platformQ: "要把 skill 装到哪些 Agent？",
    platformCount: (n) => `（检测到 ${n} 个）`,
    statusUpdated: "（已更新）",
    statusUnchanged: "（已是最新）",
    statusConflict: "（已跳过 —— 那里存在一份内容不同的副本）",
    forceHint: "加 --force 重新运行可覆盖内容不同的副本。",
    askAgent: "对你的 Agent 说：「帮我在这个仓库配置 OrcaCode Review」。",
    pluginHint: "  Claude Code 建议改用插件，它会自动保持更新：",
    handoffTitle: "接下来直接对你的 AI 说",
    handoffPrimary: "帮我把这个仓库配置上 OrcaCode Review",
    handoffMore: "它还能：",
    handoffDoctor: "「OrcaCode Review 怎么没跑？」",
    handoffDoctorWhat: "排查",
    handoffTune: "「把 OrcaCode Review 改成只拦 P0」",
    handoffTuneWhat: "改合并策略",
    handoffRemove: "「把 OrcaCode Review 从这个仓库移除」",
    handoffRemoveWhat: "卸载",
    handoffCli: "想用命令行？这些也都是子命令 —— 见 --help。",
    listTitle: (n) => `支持 ${n} 个平台`,
    listColumns: "  （项目路径 / 全局路径）",
    listLegend: "  ● = 本机已检测到。安装：npx @orcarouter/code-review skill install --platform <id>",
  },

  secret: {
    title: (s) => `仓库密钥：${s}`,
    createHint: (url) => `  在 ${url} 创建或复制一个 key`,
    alreadySet: (s) => `${s} 已经配置好了。`,
    setNow: "现在用 GitHub CLI 配置它？",
    wasSet: (s) => `${s} 已配置。`,
    ghFailed: "gh 没能设置密钥。改在浏览器里加：",
    addManually: (s) => `  添加一个名为 ${s} 的密钥：`,
    manualPath: "你的仓库 → Settings → Secrets and variables → Actions → New repository secret",
  },

  usage: {
    tagline: "OrcaCode Review 安装器（由 OrcaRouter 驱动的 AI PR 评审）",
    usage: "用法",
    bareCommand: "不带命令直接运行 = 安装 skill，之后的事交给你的 AI。",
    commands: "命令",
    options: "参数",
    examples: "示例",
    docs: "文档",
    cmdInit: "自己写入 .github/workflows/orca-code-review.yml",
    cmdReconfigure: "修改已有 workflow 的参数",
    cmdDoctor: "排查装好但不工作的问题",
    cmdUninstall: "移除 workflow",
    cmdSkillInstall: (n) => `安装 Agent Skill（${n} 个平台）—— 默认命令`,
    cmdSkillList: "列出支持的平台，并标出本机检测到的",
    optYes: "使用推荐默认值，不再询问",
    optForce: "直接覆盖，不询问",
    optJson: "机器可读输出（skill install / skill list）",
    optLang: "界面语言：en | zh | ja | ko（默认跟随系统 locale）",
    optNoBanner: "不显示字符画标题",
    optScope: "用于 `skill`：project | global",
    optPlatform: "用于 `skill`：可重复；不指定则交互选择",
    optHelp: "显示本帮助",
    optVersion: "显示版本号",
  },
};


const JA = {
  lang: { question: "Language / 语言 / 言語 / 언어", en: "English", zh: "简体中文", ja: "日本語", ko: "한국어" },

  common: {
    recommended: "（推奨）",
    detected: "検出済み",
    chooseRange: (n, d) => `  1-${n} を入力 [${d}] `,
    enterNumber: (n) => `1 から ${n} までの数字を入力してください。`,
    multiHint: "例: 1,3 または 1-4 · a = 全選択 · Enter = 選択中のまま確定",
    selectPrompt: "  選択 ",
    nothingSelected: "何も選択されていません。1 つ以上選ぶか、Ctrl-C で中止してください。",
    hintSelect: "↑↓ 移動 · Enter 選択",
    hintMulti: "space 切替 · a 全選択 · n 全解除 · / 絞り込み · Enter 確定",
    hintFiltering: "入力して絞り込み · ctrl-u クリア · Enter 適用",
    hintFilterLabel: "絞り込み:",
    hintNoMatch: "該当なし",
    countSelected: (n) => `${n} 件選択中`,
    nonTTY: (what) => `「${what}」を確認できません — 標準入力が端末ではありません。`,
    nonTTYHint: "--yes を付けて推奨値を使うか、フラグで明示してください（--help）。",
    notGitRepo: "git リポジトリの中ではありません。",
    notGitRepoHint: "リポジトリに cd してから実行してください。",
    unknownOption: (a) => `不明なオプション: ${a}`,
    unknownOptionHint: "使い方は --help を参照してください。",
    unknownCommand: (c) => `不明なコマンド: ${c}`,
    unknownLanguage: (l) => `不明な言語「${l}」。`,
    unknownLanguageHint: "--lang en / zh / ja / ko のいずれかを指定してください。",
    missingPlatformValue: "--platform には値が必要です。",
    aborted: "中止しました。何も書き込んでいません。",
    abortedRemoval: "中止しました。何も削除していません。",
  },

  config: {
    settingsQ: "レビュー設定はどこで管理しますか？",
    settingsDashboard: "OrcaRouter ダッシュボード",
    settingsDashboardDetail:
      "モデル・レビューモード・評価基準・重大度ルールをコンソールから変更。workflow の編集は不要です。",
    settingsFile: "この workflow ファイル",
    settingsFileDetail:
      "ダッシュボードの取得をスキップします。YAML が唯一の正解になり、サーバ側から上書きされません。",

    blockQ: "どの指摘でマージを止めますか？",
    blockBoth: "P0 と P1",
    blockBothDetail: "既定の取り決め。重大・高リスクの指摘でチェックが失敗します。",
    blockP0: "P0 のみ",
    blockP0Detail: "重大な問題だけを止めます。P1 は行コメントとして残ります。",
    blockNone: "止めない — コメントのみ",
    blockNoneDetail: "チェックは常に通ります。試用期間に向いています。",

    oversizedQ: "PR の差分が大きすぎてレビューできない場合は？",
    oversizedFail: "チェックを失敗させる",
    oversizedFailDetail: "差分を上限まで膨らませても、必須マージゲートを素通りできなくなります。",
    oversizedPass: "通知だけ出して通す",
    oversizedPassDetail: "スキップ通知を投稿し、チェックは緑のままです。",

    publicWarning: (url) =>
      "これは公開リポジトリです。workflow は pull_request_target で動き、あなたの\n" +
      "  OrcaRouter シークレットを使います。fork 承認ゲートを迂回するため、第三者が\n" +
      `  PR を開くだけであなたの残高を消費できます。${url} で予算と通知を設定してください。`,
    authorsQ: "誰の PR を自動レビューしますか？",
    authorsKnown: "既知のコントリビューターのみ",
    authorsKnownDetail: "それ以外も /orcacode-review で個別にレビューできます。",
    authorsAll: "全員",
    authorsAllDetail: "誰の PR でも有料レビューが走ります。",
  },

  init: {
    title: "OrcaCode Review — インストール",
    repo: (name) => `  リポジトリ  ${name}`,
    repoUnknown: "（不明 — GitHub リモートが見つかりません）",
    workflow: (p) => `  workflow    ${p}`,
    exists: "そのパスには既に workflow があります。",
    reconfigureInstead: "代わりに設定を変更しますか？",
    unchangedHint: "何も変更していません。上書きするには --force を付けて再実行してください。",
    preview: "書き込む workflow:",
    writeConfirm: (p) => `${p} を書き込みますか？`,
    wrote: (p) => `${p} を書き込みました`,
    remaining: "残りの手順",
    step1: (url) => `  1. アプリを有効化: ${url} → Apps → OrcaCode Review`,
    step1Note: "     有効化するまでレビューは動きません。",
    step2: "  2. ブランチにコミットして PR を作成 —",
    step2Note:
      "     pull_request_target はベースブランチから workflow を読むため、\n" +
      "     このファイルが既定ブランチに入って初めてレビューが始まります。",
    step3: "  3. ゲートを有効に: Settings → Branches / Rulesets → Require status checks",
    step3Note: (check) => `     ${check} チェックを必須に。赤いだけのチェックは何も止めません。`,
    diagnoseHint: "  いつでも診断: npx @orcarouter/code-review doctor",
  },

  reconfigure: {
    title: "OrcaCode Review — 設定変更",
    missing: (p) => `${p} が見つかりません。`,
    missingHint: "先に `npx @orcarouter/code-review init` を実行してください。",
    dashboardOwns: "このインストールでは、ほとんどの設定を OrcaRouter ダッシュボードが持っています。",
    dashboardOwnsDetail: (url) =>
      "  レビューモード・モデル・徹底モード・静音モード・評価基準はこのファイルには\n" +
      `  ありません。${url} → Apps → OrcaCode Review で変更してください。\n` +
      "  ここに書いた input は、文書化された既定値と異なる場合のみ有効になります。",
    noChanges: "変更なし — workflow は既にその内容です。",
    changes: "変更内容",
    applyConfirm: (p) => `${p} に適用しますか？`,
    updated: (p) => `${p} を更新しました`,
    commitHint: "コミットして push してください。次回どれかの PR に push した時点で反映されます。",
  },

  doctor: {
    title: "OrcaCode Review — 診断",
    repo: (name) => `  リポジトリ ${name}`,
    repoUnknown: "（不明）",
    workflowExists: (p) => `${p} があります`,
    workflowMissing: (p) => `${p} がありません`,
    workflowMissingFix: "実行: npx @orcarouter/code-review init",
    onBase: (b) => `origin/${b} に存在します`,
    notOnBase: (b) => `まだ origin/${b} に入っていません`,
    notOnBaseFix:
      "pull_request_target は「ベースブランチ」から workflow を読みます。マージしてから実行を待ってください。",
    noGh: "GitHub CLI が使えないか未認証です — シークレット・実行履歴・ゲートの確認をスキップします。",
    noGhHint: "  https://cli.github.com から導入し `gh auth login` を実行すると完全な結果が出ます。",
    secretSet: (s) => `リポジトリシークレット ${s} は設定済みです`,
    secretMissing: (s) => `リポジトリシークレット ${s} が見つかりません`,
    secretMissingFix: (s, url) => `実行: gh secret set ${s}   （キーは ${url}）`,
    runsUnreadable: "実行履歴を取得できません（一度も動いていない可能性があります）。",
    noRuns: "この workflow の実行履歴がありません",
    noRunsFix:
      "よくある原因: ダッシュボードでアプリが無効、auto_review が off、trigger=ready_for_review で\n" +
      "  PR が下書きのまま、作者が auto-review-authors の対象外。",
    recentRuns: (n) => `直近 ${n} 件の実行:`,
    inspectFailure: "失敗の詳細: gh run view <run-id> --log-failed",
    gateRequired: (b) => `${b} で「review」チェックが必須になっています`,
    gateMissing: (b) => `${b} で「review」チェックが必須になっていません`,
    gateMissingFix:
      "指摘は投稿されますが、何も止まりません。Settings → Branches / Rulesets → Require status checks。",
    noProtection: (b) => `${b} のブランチ保護を読めません — マージは制限されていません。`,
    clean: "問題は見つかりませんでした。",
    problems: (n) => `${n} 件の問題 — 上の修正方法を参照してください。`,
    problemsHint:
      "  症状 → 原因 → 対処の一覧: skills/setup-orca-code-review/references/troubleshooting.md",
  },

  uninstall: {
    title: "OrcaCode Review — アンインストール",
    nothing: (p) => `削除するものがありません — ${p} は存在しません。`,
    gateFirst:
      "先に必須の「review」チェックを外してください。\n" +
      "  workflow が消えた必須チェックは二度と報告されず、すべての PR が永久に\n" +
      "  ブロックされ、解除する手段がなくなります。",
    gateWhere: (repo, branch) => `  ${repo} の Settings → Branches / Rulesets（${branch}）`,
    deleteConfirm: (p) => `${p} を削除しますか？`,
    removed: (p) => `${p} を削除しました`,
    keepSecret: (s) => `  • ${s} シークレットは残しても無害で、再導入するなら残す価値があります。`,
    disableApp: (url) => `  • 課金を止めるには ${url} → Apps → OrcaCode Review でアプリを無効化してください。`,
    keepComments: "  • 既存のレビューコメントはそのまま残ります — PR の履歴の一部です。",
  },

  skill: {
    missingBundle: "このパッケージに同梱の skill が見つかりません。",
    missingBundleHint: "再インストール: npx @orcarouter/code-review@latest skill",
    scopeQ: "skill をどこにインストールしますか？",
    scopeProject: "このプロジェクト",
    scopeProjectDetail: "リポジトリと一緒にコミットされ、clone した全員が使えます。",
    scopeGlobal: "このユーザー",
    scopeGlobalDetail: "このマシンのすべてのプロジェクトで使えます。",
    unknownScope: (s) => `不明なスコープ「${s}」。`,
    unknownScopeHint: "--scope project または --scope global を指定してください。",
    unknownPlatform: (id) => `不明なプラットフォーム「${id}」。`,
    unknownPlatformHint: "一覧: npx @orcarouter/code-review skill list",
    noneDetected: "エージェントを検出できず、指定もありません。",
    noneDetectedHint:
      "明示してください。例: --platform claude --platform codex（`skill list` で 36 個すべて表示）。",
    platformQ: "どのエージェントに skill を入れますか？",
    platformCount: (n) => `（${n} 個検出）`,
    statusUpdated: "（更新しました）",
    statusUnchanged: "（既に最新）",
    statusConflict: "（スキップ — 内容の異なる版が既にあります）",
    forceHint: "内容が異なる版を上書きするには --force を付けて再実行してください。",
    askAgent: "エージェントにこう伝えてください:「このリポジトリに OrcaCode Review を設定して」。",
    pluginHint: "  Claude Code はプラグインの方が自動で更新されます:",
    handoffTitle: "あとはエージェントに頼むだけ",
    handoffPrimary: "このリポジトリに OrcaCode Review を設定して",
    handoffMore: "他にもできること:",
    handoffDoctor: "「OrcaCode Review が動かないのはなぜ？」",
    handoffDoctorWhat: "診断",
    handoffTune: "「OrcaCode Review を P0 だけ止めるように」",
    handoffTuneWhat: "マージ方針の変更",
    handoffRemove: "「このリポジトリから OrcaCode Review を外して」",
    handoffRemoveWhat: "アンインストール",
    handoffCli: "端末で使いたい場合は、これらもサブコマンドとして使えます — --help を参照。",
    listTitle: (n) => `対応プラットフォーム ${n} 個`,
    listColumns: "  （プロジェクト側 / グローバル側）",
    listLegend: "  ● = このマシンで検出。導入: npx @orcarouter/code-review skill install --platform <id>",
  },

  secret: {
    title: (s) => `リポジトリシークレット: ${s}`,
    createHint: (url) => `  ${url} でキーを作成またはコピーしてください`,
    alreadySet: (s) => `${s} は既に設定済みです。`,
    setNow: "GitHub CLI で今すぐ設定しますか？",
    wasSet: (s) => `${s} を設定しました。`,
    ghFailed: "gh でシークレットを設定できませんでした。ブラウザから追加してください:",
    addManually: (s) => `  ${s} という名前でシークレットを追加:`,
    manualPath: "リポジトリ → Settings → Secrets and variables → Actions → New repository secret",
  },

  usage: {
    tagline: "OrcaCode Review インストーラー（OrcaRouter による AI PR レビュー）",
    usage: "使い方",
    bareCommand: "コマンドなしで実行すると skill を入れます。あとはエージェントに頼んでください。",
    commands: "コマンド",
    options: "オプション",
    examples: "例",
    docs: "ドキュメント",
    cmdInit: ".github/workflows/orca-code-review.yml を自分で書き込む",
    cmdReconfigure: "既存 workflow の input を変更する",
    cmdDoctor: "動かないインストールを診断する",
    cmdUninstall: "workflow を削除する",
    cmdSkillInstall: (n) => `エージェント skill を導入（${n} プラットフォーム）— 既定`,
    cmdSkillList: "対応プラットフォームと検出状況を一覧表示",
    optYes: "推奨値を使い、一切確認しない",
    optForce: "確認せず上書きする",
    optJson: "機械可読な出力（skill install / skill list）",
    optLang: "表示言語: en | zh | ja | ko（既定: ロケールに従う）",
    optNoBanner: "ロゴを表示しない",
    optScope: "`skill` 用: project | global",
    optPlatform: "`skill` 用: 繰り返し可。省略すると対話選択",
    optHelp: "このヘルプを表示",
    optVersion: "バージョンを表示",
  },
};

const KO = {
  lang: { question: "Language / 语言 / 言語 / 언어", en: "English", zh: "简体中文", ja: "日本語", ko: "한국어" },

  common: {
    recommended: "(권장)",
    detected: "감지됨",
    chooseRange: (n, d) => `  1-${n} 입력 [${d}] `,
    enterNumber: (n) => `1에서 ${n} 사이의 숫자를 입력하세요.`,
    multiHint: "예: 1,3 또는 1-4 · a = 전체 · Enter = 선택 상태로 확정",
    selectPrompt: "  선택 ",
    nothingSelected: "선택된 항목이 없습니다. 하나 이상 고르거나 Ctrl-C로 중단하세요.",
    hintSelect: "↑↓ 이동 · Enter 선택",
    hintMulti: "space 토글 · a 전체 · n 해제 · / 검색 · Enter 확정",
    hintFiltering: "입력해 검색 · ctrl-u 지우기 · Enter 적용",
    hintFilterLabel: "검색:",
    hintNoMatch: "일치 없음",
    countSelected: (n) => `${n}개 선택됨`,
    nonTTY: (what) => `「${what}」을(를) 물어볼 수 없습니다 — 표준 입력이 터미널이 아닙니다.`,
    nonTTYHint: "--yes로 권장값을 쓰거나 플래그로 직접 지정하세요(--help).",
    notGitRepo: "git 저장소 안이 아닙니다.",
    notGitRepoHint: "저장소로 cd한 뒤 다시 실행하세요.",
    unknownOption: (a) => `알 수 없는 옵션: ${a}`,
    unknownOptionHint: "사용법은 --help를 보세요.",
    unknownCommand: (c) => `알 수 없는 명령: ${c}`,
    unknownLanguage: (l) => `알 수 없는 언어 "${l}".`,
    unknownLanguageHint: "--lang en / zh / ja / ko 중 하나를 쓰세요.",
    missingPlatformValue: "--platform에는 값이 필요합니다.",
    aborted: "중단했습니다. 아무것도 쓰지 않았습니다.",
    abortedRemoval: "중단했습니다. 아무것도 삭제하지 않았습니다.",
  },

  config: {
    settingsQ: "리뷰 설정을 어디에 둘까요?",
    settingsDashboard: "OrcaRouter 콘솔",
    settingsDashboardDetail:
      "모델, 리뷰 모드, 평가 기준, 심각도 규칙을 콘솔에서 변경합니다. workflow는 건드리지 않습니다.",
    settingsFile: "이 workflow 파일",
    settingsFileDetail:
      "콘솔 조회를 건너뜁니다. YAML이 기준이 되고 서버 쪽 값이 덮어쓸 수 없습니다.",

    blockQ: "어떤 지적이 머지를 막아야 하나요?",
    blockBoth: "P0와 P1",
    blockBothDetail: "기본 규칙. 심각·높음 등급에서 체크가 실패합니다.",
    blockP0: "P0만",
    blockP0Detail: "심각한 문제만 막습니다. P1은 라인 코멘트로 남습니다.",
    blockNone: "막지 않음 — 코멘트만",
    blockNoneDetail: "체크는 항상 통과합니다. 시범 기간에 적합합니다.",

    oversizedQ: "PR diff가 너무 커서 리뷰할 수 없으면?",
    oversizedFail: "체크를 실패 처리",
    oversizedFailDetail: "diff를 상한 너머로 부풀려도 필수 머지 게이트를 통과할 수 없습니다.",
    oversizedPass: "안내만 남기고 통과",
    oversizedPassDetail: "건너뛰었다는 안내를 남기고 체크는 초록으로 유지됩니다.",

    publicWarning: (url) =>
      "공개 저장소입니다. workflow는 pull_request_target에서 당신의 OrcaRouter\n" +
      "  시크릿으로 실행되며 fork 승인 게이트를 우회합니다 — 즉 외부인이 PR을\n" +
      `  여는 것만으로 당신의 잔액을 씁니다. ${url}에서 예산과 알림을 설정하세요.`,
    authorsQ: "누구의 PR을 자동 리뷰할까요?",
    authorsKnown: "알려진 기여자만",
    authorsKnownDetail: "나머지도 /orcacode-review로 필요할 때 리뷰할 수 있습니다.",
    authorsAll: "모두",
    authorsAllDetail: "누구의 PR이든 유료 리뷰가 실행됩니다.",
  },

  init: {
    title: "OrcaCode Review — 설치",
    repo: (name) => `  저장소    ${name}`,
    repoUnknown: "(알 수 없음 — GitHub 리모트를 찾지 못함)",
    workflow: (p) => `  workflow  ${p}`,
    exists: "해당 경로에 이미 workflow가 있습니다.",
    reconfigureInstead: "대신 설정을 변경할까요?",
    unchangedHint: "아무것도 바꾸지 않았습니다. 덮어쓰려면 --force로 다시 실행하세요.",
    preview: "작성할 workflow:",
    writeConfirm: (p) => `${p}을(를) 작성할까요?`,
    wrote: (p) => `${p} 작성 완료`,
    remaining: "남은 단계",
    step1: (url) => `  1. 앱 켜기: ${url} → Apps → OrcaCode Review`,
    step1Note: "     켜기 전까지 리뷰는 실행되지 않습니다.",
    step2: "  2. 브랜치에 커밋하고 PR 열기 —",
    step2Note:
      "     pull_request_target은 베이스 브랜치에서 workflow를 읽습니다. 이 파일이\n" +
      "     기본 브랜치에 들어가야 리뷰가 시작됩니다.",
    step3: "  3. 게이트를 실제로: Settings → Branches / Rulesets → Require status checks",
    step3Note: (check) => `     ${check} 체크를 필수로 지정하세요. 빨간 체크만으로는 아무것도 막지 못합니다.`,
    diagnoseHint: "  언제든 진단: npx @orcarouter/code-review doctor",
  },

  reconfigure: {
    title: "OrcaCode Review — 설정 변경",
    missing: (p) => `${p}이(가) 없습니다.`,
    missingHint: "먼저 `npx @orcarouter/code-review init`을 실행하세요.",
    dashboardOwns: "이 설치는 대부분의 설정을 OrcaRouter 콘솔이 관리합니다.",
    dashboardOwnsDetail: (url) =>
      "  리뷰 모드, 모델, 철저 모드, 조용 모드, 평가 기준은 이 파일에 없습니다 —\n" +
      `  ${url} → Apps → OrcaCode Review에서 바꾸세요.\n` +
      "  여기 적은 input은 문서화된 기본값과 다를 때만 적용됩니다.",
    noChanges: "변경 없음 — workflow가 이미 그 내용입니다.",
    changes: "변경 사항",
    applyConfirm: (p) => `${p}에 적용할까요?`,
    updated: (p) => `${p} 업데이트 완료`,
    commitHint: "커밋 후 push하세요. 열려 있는 PR에 다음 push가 있을 때 적용됩니다.",
  },

  doctor: {
    title: "OrcaCode Review — 진단",
    repo: (name) => `  저장소 ${name}`,
    repoUnknown: "(알 수 없음)",
    workflowExists: (p) => `${p} 있음`,
    workflowMissing: (p) => `${p} 없음`,
    workflowMissingFix: "실행: npx @orcarouter/code-review init",
    onBase: (b) => `origin/${b}에 있습니다`,
    notOnBase: (b) => `아직 origin/${b}에 없습니다`,
    notOnBaseFix:
      "pull_request_target은 '베이스' 브랜치에서 workflow를 읽습니다. 머지한 뒤에 실행을 기대하세요.",
    noGh: "GitHub CLI를 쓸 수 없거나 로그인되지 않았습니다 — 시크릿·실행 기록·게이트 확인을 건너뜁니다.",
    noGhHint: "  https://cli.github.com 에서 설치하고 `gh auth login`을 실행하면 전체 결과가 나옵니다.",
    secretSet: (s) => `저장소 시크릿 ${s} 설정됨`,
    secretMissing: (s) => `저장소 시크릿 ${s}을(를) 찾을 수 없음`,
    secretMissingFix: (s, url) => `실행: gh secret set ${s}   (키는 ${url})`,
    runsUnreadable: "실행 기록을 읽을 수 없습니다(한 번도 실행되지 않았을 수 있습니다).",
    noRuns: "이 workflow의 실행 기록이 없습니다",
    noRunsFix:
      "흔한 원인: 콘솔에서 앱이 꺼짐, auto_review가 off, trigger=ready_for_review인데 PR이\n" +
      "  초안 상태, 또는 작성자가 auto-review-authors 대상이 아님.",
    recentRuns: (n) => `최근 실행 ${n}건:`,
    inspectFailure: "실패 내용 확인: gh run view <run-id> --log-failed",
    gateRequired: (b) => `${b}에서 "review" 체크가 필수입니다`,
    gateMissing: (b) => `${b}에서 "review" 체크가 필수가 아닙니다`,
    gateMissingFix:
      "지적은 올라오지만 아무것도 막지 못합니다. Settings → Branches / Rulesets → Require status checks.",
    noProtection: (b) => `${b}의 브랜치 보호를 읽을 수 없습니다 — 머지가 통제되지 않습니다.`,
    clean: "문제를 찾지 못했습니다.",
    problems: (n) => `문제 ${n}건 — 위의 해결 방법을 보세요.`,
    problemsHint:
      "  증상 → 원인 → 해결 표: skills/setup-orca-code-review/references/troubleshooting.md",
  },

  uninstall: {
    title: "OrcaCode Review — 제거",
    nothing: (p) => `제거할 것이 없습니다 — ${p}이(가) 없습니다.`,
    gateFirst:
      "필수 \"review\" 체크를 먼저 해제하세요.\n" +
      "  workflow가 사라진 필수 체크는 다시는 보고되지 않고, 모든 PR이 영원히\n" +
      "  막히며 풀 방법이 없습니다.",
    gateWhere: (repo, branch) => `  ${repo}의 Settings → Branches / Rulesets (${branch})`,
    deleteConfirm: (p) => `${p}을(를) 지금 삭제할까요?`,
    removed: (p) => `${p} 삭제 완료`,
    keepSecret: (s) => `  • ${s} 시크릿은 남겨도 무해하며, 다시 설치할 생각이면 남길 만합니다.`,
    disableApp: (url) => `  • 과금을 멈추려면 ${url} → Apps → OrcaCode Review에서 앱을 끄세요.`,
    keepComments: "  • 기존 리뷰 코멘트는 그대로 남습니다 — PR 기록의 일부입니다.",
  },

  skill: {
    missingBundle: "이 패키지에 포함된 skill을 찾을 수 없습니다.",
    missingBundleHint: "다시 설치: npx @orcarouter/code-review@latest skill",
    scopeQ: "skill을 어디에 설치할까요?",
    scopeProject: "이 프로젝트",
    scopeProjectDetail: "저장소와 함께 커밋되어, clone한 모두가 쓸 수 있습니다.",
    scopeGlobal: "내 사용자 계정",
    scopeGlobalDetail: "이 컴퓨터의 모든 프로젝트에서 쓸 수 있습니다.",
    unknownScope: (s) => `알 수 없는 범위 "${s}".`,
    unknownScopeHint: "--scope project 또는 --scope global을 쓰세요.",
    unknownPlatform: (id) => `알 수 없는 플랫폼 "${id}".`,
    unknownPlatformHint: "목록: npx @orcarouter/code-review skill list",
    noneDetected: "에이전트를 감지하지 못했고, 지정된 것도 없습니다.",
    noneDetectedHint:
      "직접 지정하세요. 예: --platform claude --platform codex (`skill list`로 36개 전체 확인).",
    platformQ: "어떤 에이전트에 skill을 설치할까요?",
    platformCount: (n) => ` (${n}개 감지)`,
    statusUpdated: "(업데이트됨)",
    statusUnchanged: "(이미 최신)",
    statusConflict: "(건너뜀 — 내용이 다른 버전이 이미 있음)",
    forceHint: "내용이 다른 복사본을 덮어쓰려면 --force로 다시 실행하세요.",
    askAgent: '에이전트에게 말하세요: "이 저장소에 OrcaCode Review를 설정해줘".',
    pluginHint: "  Claude Code는 플러그인 쪽이 자동으로 최신을 유지합니다:",
    handoffTitle: "이제 에이전트에게 말하기만 하면 됩니다",
    handoffPrimary: "이 저장소에 OrcaCode Review를 설정해줘",
    handoffMore: "이런 것도 됩니다:",
    handoffDoctor: '"OrcaCode Review가 왜 안 돌지?"',
    handoffDoctorWhat: "진단",
    handoffTune: '"OrcaCode Review가 P0만 막게 해줘"',
    handoffTuneWhat: "머지 정책 변경",
    handoffRemove: '"이 저장소에서 OrcaCode Review 제거해줘"',
    handoffRemoveWhat: "제거",
    handoffCli: "터미널이 편하다면 이것들도 서브커맨드로 있습니다 — --help 참고.",
    listTitle: (n) => `지원 플랫폼 ${n}개`,
    listColumns: "  (프로젝트 경로 / 전역 경로)",
    listLegend: "  ● = 이 컴퓨터에서 감지됨.  설치: npx @orcarouter/code-review skill install --platform <id>",
  },

  secret: {
    title: (s) => `저장소 시크릿: ${s}`,
    createHint: (url) => `  ${url} 에서 키를 만들거나 복사하세요`,
    alreadySet: (s) => `${s}은(는) 이미 설정되어 있습니다.`,
    setNow: "지금 GitHub CLI로 설정할까요?",
    wasSet: (s) => `${s} 설정 완료.`,
    ghFailed: "gh로 시크릿을 설정하지 못했습니다. 브라우저에서 추가하세요:",
    addManually: (s) => `  ${s} 이름으로 시크릿을 추가:`,
    manualPath: "저장소 → Settings → Secrets and variables → Actions → New repository secret",
  },

  usage: {
    tagline: "OrcaCode Review 설치 도구 (OrcaRouter 기반 AI PR 리뷰)",
    usage: "사용법",
    bareCommand: "명령 없이 실행하면 skill을 설치합니다. 나머지는 에이전트에게 맡기세요.",
    commands: "명령",
    options: "옵션",
    examples: "예시",
    docs: "문서",
    cmdInit: ".github/workflows/orca-code-review.yml을 직접 작성",
    cmdReconfigure: "기존 workflow의 input 변경",
    cmdDoctor: "설치했는데 동작하지 않을 때 진단",
    cmdUninstall: "workflow 제거",
    cmdSkillInstall: (n) => `에이전트 skill 설치 (${n}개 플랫폼) — 기본`,
    cmdSkillList: "지원 플랫폼과 감지 여부 목록",
    optYes: "권장값을 쓰고 묻지 않음",
    optForce: "묻지 않고 덮어쓰기",
    optJson: "기계 판독용 출력 (skill install / skill list)",
    optLang: "인터페이스 언어: en | zh | ja | ko (기본: 로케일 따름)",
    optNoBanner: "로고 표시 안 함",
    optScope: "`skill`용: project | global",
    optPlatform: "`skill`용: 반복 가능. 생략하면 대화형 선택",
    optHelp: "이 도움말 표시",
    optVersion: "버전 표시",
  },
};

const STRINGS = { en: EN, zh: ZH, ja: JA, ko: KO };

const lookup = (table, key) => key.split(".").reduce((node, part) => node?.[part], table);

/** Returns a `t(key, ...args)` bound to one language, falling back to English. */
export function makeT(language) {
  const primary = STRINGS[language] ?? STRINGS.en;
  return (key, ...args) => {
    const value = lookup(primary, key) ?? lookup(STRINGS.en, key);
    if (value === undefined) return key; // visible in output, never a crash
    return typeof value === "function" ? value(...args) : value;
  };
}

export const TABLES = STRINGS;
