---
name: setup-orca-code-review
description: Set up, reconfigure, troubleshoot, or remove OrcaCode Review — AI pull-request review powered by OrcaRouter — in a GitHub repository. Handles the whole lifecycle end to end without asking the user to run a CLI. Use whenever the user mentions OrcaCode Review, OrcaRouter code review, "@orcarouter code review", or /orcacode-review, and whenever they ask to set up AI code review on a repo, add the orca-code-review action, change which severities block merges, find out why a review did not run or did not post findings, or take the review workflow back out.
---

# OrcaCode Review

OrcaCode Review is a GitHub composite action that reviews every pull request with
an LLM, posts findings as inline comments, and fails a status check when serious
issues are found. Model selection lives in OrcaRouter, not in the workflow file.

**Severity contract:** `P0` critical / `P1` high → ❌ block. `P2` advisory → 💬 comment.

## What you can do with this skill

You carry out all of these yourself — writing files, running `gh`, and asking the
user only for the decisions that are genuinely theirs. Never tell the user to go
run an installer; that is what this skill replaces.

| The user says something like… | You do |
| --- | --- |
| "set up OrcaCode Review here", "@orcarouter code review 帮我配置这个仓库" | [Install](#install) |
| "only block P0", "move the config to the dashboard", "raise the diff limit" | [Reconfigure](#reconfigure) |
| "why didn't the review run?", "no comments appeared", "the check is stuck red" | [Troubleshoot](#troubleshoot) |
| "remove OrcaCode Review", "turn the review off" | [Uninstall](#uninstall) |
| "what can OrcaCode Review do?" | Summarize this table and the severity contract. Do not dump the file. |

## Pick the route

Jump straight to the section the table above points at. Do not run the install
flow on a repo that already has the workflow — go to **Reconfigure** instead.

Run this first in every route — it tells you which one applies:

```bash
git rev-parse --show-toplevel && \
  gh repo view --json nameWithOwner,visibility,defaultBranchRef 2>/dev/null; \
  ls .github/workflows/ 2>/dev/null | grep -i 'orca\|code-review'
```

If `gh` is missing or unauthenticated, everything still works — you just hand the
user web URLs instead of running commands. Say so once and move on.

## Install

### 1. Preflight

Confirm all three, and stop with a specific message if any fails:

- Inside a git work tree with a GitHub `origin` remote.
- No existing OrcaCode workflow (if there is one → **Reconfigure**).
- Record the repo's `nameWithOwner`, `visibility`, and default branch — later steps need them.

### 2. Ask for the key decisions

Ask these with **one** `AskUserQuestion` call. Include the fourth question **only when
`visibility` is `PUBLIC`** — it is a spend-control decision that does not exist on a
private repo, and asking it there is noise.

**Q1 — "Where should review settings live?"** (`settings` input)
- *OrcaRouter dashboard (recommended)* → `settings: "true"`. Models, review mode,
  severity rules, and rubric change from the console with no workflow edit. Dashboard
  values win unless a `with:` input differs from its documented default.
- *This workflow file* → `settings: "false"`. Skips the dashboard fetch entirely; the
  YAML is authoritative and nothing server-side can override it. Pick this for repos
  under change control.

**Q2 — "Which findings should block the merge?"** (`block-on` input)
- *P0 and P1 (recommended)* → `"P0,P1"`. The default contract.
- *P0 only* → `"P0"`. Blocks only critical issues; P1 still posts inline.
- *Nothing — comment only* → `""`. The check always passes. Good for a trial period.

**Q3 — "What happens when a PR's diff is too large to review?"** (`on-oversized-diff`)
- *Fail the check (recommended)* → `"fail"`. A diff padded past `max-diff-kb` /
  `max-diff-files` cannot be used to slip past a required merge gate.
- *Pass with a notice* → `"pass"`. The skip notice posts and the check stays green.

**Q4 — public repos only — "Who gets an automatic review?"** (`auto-review-authors`)
- *Known contributors only (recommended)* → `"OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR"`.
- *Everyone* → `""`.

Say plainly why Q4 exists: the workflow runs on `pull_request_target` with your
OrcaRouter secret, so on a public repo a stranger's PR can spend from your wallet.
Also tell them to set a budget + alert on the key at <https://www.orcarouter.ai/console/token>.

Everything else keeps its default. Do not ask about `judge-model`, `concurrency`,
`engine-version`, or `precision-filter` during install — see `references/inputs.md`
if the user brings them up unprompted.

### 3. Write the workflow

Copy `assets/workflow.yml` to `.github/workflows/orca-code-review.yml`, then set the
four values from step 2 under `with:`. Omit any input the user left at its default —
a workflow that only lists what it overrides stays readable and lets the dashboard own
the rest.

Keep the `if:` condition and the `on:` block exactly as shipped. They encode two things
that are easy to break: `pull_request_target` is what lets a fork PR be reviewed at all,
and the author-association check on `issue_comment` is what stops any drive-by commenter
from spending your quota with `/orcacode-review`.

Show the user the final file before committing.

### 4. Have the user add the API key — with `gh`, themselves

The secret must be named exactly `ORCAROUTER_API_KEY`.

This is the one step you do **not** perform. Stop, hand the user this command,
and wait for them to confirm they have run it:

```
! gh secret set ORCAROUTER_API_KEY --repo <owner/name>
```

`gh` prompts for the value on their terminal, so the key goes from their
keyboard straight to GitHub. It never passes through you.

**Never** ask them to paste the key into the chat, read it out of a file or an
env var, or pass it on a command line. A pasted key is in the transcript
forever; a key in `argv` is visible to every process on the machine via `ps`.
There is no version of this you can do "carefully" — the only safe handling is
not handling it.

They can create or copy a key at <https://www.orcarouter.ai/console/token>.

Without `gh`, send them to
`https://github.com/<owner>/<name>/settings/secrets/actions/new` and have them
add it in the browser.

Then confirm it exists without ever seeing its value:

```bash
gh secret list --repo <owner/name> | grep ORCAROUTER_API_KEY
```

If it is not there yet, do not continue to the test PR — the run will fail on
auth and the failure will look like a configuration bug rather than a missing
key. Wait, or skip to step 8 and list it as outstanding.

### 5. Enable the app

Point the user at **OrcaRouter → Apps → OrcaCode Review** (<https://www.orcarouter.ai/>)
to turn the app on and choose review models. Reviews will not run until it is enabled.

### 6. Commit and open a test PR

Commit on a branch, push, and open a PR — do not commit straight to the default branch.
The PR is also the test: the workflow must run against a real pull request to prove out.

```bash
gh pr create --fill && gh run watch
```

### 7. Make the gate real

A passing check blocks nothing until it is required. Walk the user through
**Settings → Branches / Rulesets → Require status checks to pass** and adding the
**`review`** check, or offer to do it:

```bash
gh api -X PATCH repos/<owner>/<name>/branches/<default>/protection/required_status_checks \
  -f 'checks[][context]=review'
```

Confirm before running — branch protection changes affect everyone on the repo.

### 8. Report, and close on what they still owe

Tell the user, concretely: the workflow path, the settings you chose, whether the
secret and required check are in place, and the result of the test run. If any step
was skipped (no `gh`, protection not applied), say which.

**End the message with their outstanding actions as copy-pasteable commands** —
not prose describing them. Anything you could not do yourself belongs here, and
the API key is almost always on the list because you are not allowed to do it:

```
! gh secret set ORCAROUTER_API_KEY --repo <owner/name>
```

Re-check with `gh secret list` before claiming it is done. Do not report the
install as complete while the secret is missing: the workflow is in place but
every run will fail on auth, and "installed" would be a lie the user only finds
out about on their next PR.

## Reconfigure

Read the existing `.github/workflows/orca-code-review.yml` first, then check whether
`settings: "false"` is set.

**If the dashboard owns settings (`settings` absent or `"true"`)** — most knobs are not
in the file. Review mode, models, exhaustive mode, quiet mode, rubric, and the
fix-first/block-on tuning all live at **OrcaRouter → Apps → OrcaCode Review**. Send the
user there rather than editing YAML, and explain the precedence rule: an input written
in the file only wins if it differs from its documented default.

**If the file is authoritative (`settings: "false"`)** — edit it. Ask with
`AskUserQuestion` which knobs to change, offering only what is relevant:

- Merge policy (`block-on`) and fix-first escalation (`fix-first`).
- Diff limits (`max-diff-kb`, `max-diff-files`) and `on-oversized-diff`.
- Precision filter (`precision-filter`, `judge-model`, `judge-threshold`).
- Run reporting (`report`) and token metering (`meter`).

`references/inputs.md` has every input, its default, and what it actually controls.
Read it before answering a question about behavior — do not guess a default.

State the before → after for each value you change, and note that the new settings take
effect on the next push to any open PR.

## Troubleshoot

Gather evidence before theorizing:

```bash
gh run list --workflow orca-code-review.yml --limit 5
gh run view <run-id> --log-failed
```

`references/troubleshooting.md` maps each symptom to its cause and fix. The four that
account for most reports:

- **No run at all** — the PR is a draft and `trigger` is `ready_for_review`, the author
  is outside `auto-review-authors`, or the app is off in the dashboard.
- **Run fails immediately, auth error** — `ORCAROUTER_API_KEY` is missing, misnamed, or
  scoped to an environment the job cannot read.
- **"Diff too large" notice and a red check** — expected behavior with
  `on-oversized-diff: "fail"`. Split the PR, or raise `max-diff-kb` / `max-diff-files`.
- **Reviews work but the console's Settings/Analytics tabs are empty** — `@v1` points at
  a commit older than `scripts/settings.mjs` / `scripts/report.mjs`. There is no error
  for this; verify with `git ls-tree v1 scripts/` against the action repo.

Report the actual failing output, not a paraphrase of it.

## Uninstall

Confirm with the user first, then in this order:

1. **Drop the required check** — remove `review` from branch protection *before* deleting
   the workflow. A required check whose workflow no longer exists never reports, and every
   PR blocks forever with no way to clear it.
2. **Delete the workflow** — `rm .github/workflows/orca-code-review.yml`, commit, push.
3. **Leave the secret** — say that `ORCAROUTER_API_KEY` is harmless to keep and is worth
   keeping if they may reinstall. Delete it only if they ask.
4. **Mention the dashboard** — turning the app off at **OrcaRouter → Apps → OrcaCode
   Review** stops any remaining billing.

Do not delete old review comments. They are part of the PR history.
