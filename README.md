# OrcaCode Review

**[AI code review](https://www.orcarouter.ai/code-review) that catches serious issues before they merge — powered by ****[OrcaRouter](https://www.orcarouter.ai/)****.**

Automatically review every pull request, post findings directly on the affected lines, and block serious issues from merging.

**P0/P1 → ❌ Block** · **P2 → 💬 Comment** · **Clean → ✅ Pass**

## How it works

```text
PR → Review → Merge Gate
        │
     P0/P1?
        ↓
      BLOCK
```

Every push gets one review. Findings post on the affected lines, and P0/P1 blocks the merge.

**You choose the model in OrcaRouter. OrcaCode handles the review.**

### What you get

* 🔍 Automatic review on every PR
* 💬 Inline P0 / P1 / P2 findings
* 🛑 Merge gate for serious issues
* 🧠 Choose your own review model
* 🎯 Precision filtering to reduce false positives
* 🔒 OrcaRouter guardrails + security policies
* 🔄 Re-run anytime with `/orcacode-review`

---

## Install

One command teaches your AI what OrcaCode Review is. Everything after that, you just ask for.

```bash
npx @orcarouter/code-review
```

It detects which coding agents you use, installs the skill, and stops. Then:

> **you:** set up OrcaCode Review in this repo

Your agent writes the workflow, walks you through the API key, and sets the merge gate — asking only the questions that are actually yours to answer.

The same goes for everything else:

| Say | It does |
| --- | --- |
| *"why didn't the review run?"* | Diagnoses the secret, the trigger, the base branch, the gate |
| *"make OrcaCode Review block P0 only"* | Retunes the merge policy |
| *"remove OrcaCode Review from this repo"* | Drops the required check first, then the workflow |
| *"what can OrcaCode Review do?"* | Explains itself |

**Claude Code** can install the skill as a plugin instead, which keeps it updated:

```text
/plugin marketplace add Continuum-AI-Corp/orca-code-review
/plugin install orca-code-review
```

### 36 agent platforms

The same catalog the [OrcaDub MCP server](https://github.com/Continuum-AI-Corp/orcadub-mcp-server) uses, so IDs and paths match across Orca products. Detected agents are pre-ticked; `/` filters the list.

```bash
npx @orcarouter/code-review skill list                    # all 36, detected ones marked
npx @orcarouter/code-review --platform claude,codex --yes # unattended
```

### Terminal, without an agent

The lifecycle is also available as plain subcommands — the skill is the front door, not the only door:

```bash
npx @orcarouter/code-review init          # write the workflow
npx @orcarouter/code-review reconfigure   # change blocking rules, diff limits, where config lives
npx @orcarouter/code-review doctor        # diagnose reviews that don't run or don't post
npx @orcarouter/code-review uninstall     # remove it (drops the merge gate first)
```

Prefer to wire it by hand? The manual steps are below.

Claude Code, Cursor, Codex, OpenCode, Windsurf, Cline, RooCode, Continue, GitHub Copilot, Gemini CLI, Amazon Q Developer, Qwen Code, Kilo Code, Auggie, Kimi Code, Kiro, Lingma, Junie, CodeBuddy Code, CoStrict, Crush, Factory Droid, iFlow, Pi, Qoder, Antigravity, Antigravity 2.0, Bob Shell, ForgeCode, Trae, Trae CN, ZCode, MimoCode, Hermes, OpenClaw, Command Code.

An existing identical skill is left unchanged; an existing **different** one is preserved unless you pass `--force`. Use `--json` for structured output and `NO_COLOR` for plain text.

### Language

The CLI speaks **English and Simplified Chinese**, picked from your locale (`LC_ALL` / `LC_MESSAGES` / `LANG`). Override it per run, or pin it for good:

```bash
npx @orcarouter/code-review --lang zh          # 中文界面
npx @orcarouter/code-review --lang en          # English
export ORCACODE_LANG=zh                # 固定下来
```

Guided flows open with a language screen when `--lang` is not given. Add `--no-banner` to skip the wordmark.

Menus are arrow-key driven — `↑↓` to move, `Enter` to pick. Multi-select adds `space` to toggle, `a`/`n` for all/none, and `/` to filter (`ctrl-u` clears it), which is how you find one agent among 36 without scrolling. Terminals without raw mode fall back to typing a number.

Only prose is translated — flags, platform IDs, workflow inputs, and shell commands stay verbatim, because you still have to type them.

---

## Quick Start

### 1. Enable OrcaCode Review

Go to [**OrcaRouter**](https://www.orcarouter.ai/) → **Apps → OrcaCode Review** and turn it on.

Configure your models, review mode, severity rules, merge policy, and other settings directly from the console.

### 2. Install the GitHub Action

[**Install OrcaCode Review from GitHub Marketplace →**](https://github.com/marketplace/actions/orca-code-review)

Add the Action to your repository:

```yaml
- uses: Continuum-AI-Corp/orca-code-review@v1
  with:
    orcarouter-api-key: ${{ secrets.ORCAROUTER_API_KEY }}
```

### 3. Add your API key

Create or copy a key from [**OrcaRouter → API Keys**](https://www.orcarouter.ai/console/token).

Add it to your GitHub repository as:

```text
ORCAROUTER_API_KEY
```

under **Settings → Secrets and variables → Actions**.

### 4. Open a PR

**That's it.**

OrcaCode automatically reviews new PRs and pushes, posts findings inline, and reports the merge gate.

---

## Severity

| Severity | Meaning            | Result     |
| -------- | ------------------ | ---------- |
| **P0**   | Critical / blocker | ❌ Block    |
| **P1**   | High severity      | ❌ Block    |
| **P2**   | Advisory           | 💬 Comment |

Customize the rubric and blocking policy from **OrcaRouter → Apps → OrcaCode Review**.

---

## Configure without touching YAML

Manage OrcaCode from **OrcaRouter → Apps → OrcaCode Review**:

* **Model** — choose your reviewer
* **Review mode** — every push, ready for review, or on demand
* **Merge policy** — choose which severities block
* **Exhaustive review** — run additional passes over the same diff
* **Quiet mode** — keep P2 findings in the summary
* **Custom rubric** — define your own review rules
* **Guardrails** — add security and policy checks

**Change your review strategy anytime. No GitHub workflow edits required.**

---

## Re-run a review

Comment on any PR:

```text
/orcacode-review
```

to request another review.

---

## Block merges

To make P0/P1 findings actually prevent merging:

**GitHub → Settings → Branches / Rulesets → Require status checks to pass**

Add the **`review`** check as required.

---

## Security & Privacy

OrcaCode reads the PR diff and repository files required for review. **It does not execute PR code.**

Optional run reporting sends only review metadata — repository, PR, commit SHA, tier, severity counts, gate result, and engine version.

**No source code, diff, or finding text is included in run reports.**

OrcaRouter guardrails can add secret detection, PII detection, prompt-injection protection, code-security rules, and external security scanners.

See [`SECURITY.md`](./SECURITY.md) for details.

---

## Under the hood

OrcaCode Review uses [Open Code Review](https://github.com/alibaba/open-code-review) as its review engine and **OrcaRouter for model routing, policy, and control**.

**OrcaCode decides how to review. OrcaRouter decides what model runs it.**

## License

[MIT](./LICENSE) © Continuum-AI-Corp.

Open Code Review is Apache-2.0. Attribution is preserved in [`NOTICE`](./NOTICE).
