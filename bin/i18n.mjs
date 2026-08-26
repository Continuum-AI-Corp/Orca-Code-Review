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

export const LANGUAGES = Object.freeze(["en", "zh"]);

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
  return ["zh", "zh-cn", "zh-sg", "zh-hans", "zh-hans-cn"].includes(locale) ? "zh" : "en";
}

const EN = {
  lang: { question: "Language / 语言", en: "English", zh: "简体中文" },

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
    unknownLanguageHint: "Use --lang zh or --lang en.",
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
    optLang: "Interface language: zh | en (default: from your locale)",
    optNoBanner: "Skip the wordmark",
    optScope: "For `skill`: project | global",
    optPlatform: "For `skill`: repeatable; omit to pick interactively",
    optHelp: "Show this",
    optVersion: "Show the version",
  },
};

const ZH = {
  lang: { question: "Language / 语言", en: "English", zh: "简体中文" },

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
    unknownLanguageHint: "请用 --lang zh 或 --lang en。",
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
    optLang: "界面语言：zh | en（默认跟随系统 locale）",
    optNoBanner: "不显示字符画标题",
    optScope: "用于 `skill`：project | global",
    optPlatform: "用于 `skill`：可重复；不指定则交互选择",
    optHelp: "显示本帮助",
    optVersion: "显示版本号",
  },
};

const STRINGS = { en: EN, zh: ZH };

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
