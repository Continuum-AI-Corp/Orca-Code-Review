---
name: setup-orca-code-review
description: Set up, reconfigure, troubleshoot, or remove OrcaCode Review — AI pull-request review powered by OrcaRouter — in a GitHub repository. Handles the whole lifecycle end to end without asking the user to run a CLI. Use whenever the user mentions OrcaCode Review, OrcaRouter code review, "@orcarouter code review", or /orcacode-review, and whenever they ask to set up AI code review on a repo, add the orca-code-review action, change which severities block merges, find out why a review did not run or did not post findings, take the review workflow back out, or install the OrcaCode Review GitHub App instead of the Action.
---

# OrcaCode Review

OrcaCode Review reviews every pull request with an LLM, posts findings as inline
comments, and fails a status check when serious issues are found. Model selection
lives in OrcaRouter, not in the repo.

It runs one of two ways, and a repo should use exactly one:

- **GitHub Action** — a workflow file plus one secret. Needs write access.
  The default, and the only one an agent can complete end to end.
- **GitHub App** — a bot, nothing in the repo. Needs repo admin or org owner,
  and a human to approve the install in a browser.

**Severity contract:** `P0` critical / `P1` high → ❌ block. `P2` advisory → 💬 comment.

## What you can do with this skill

You carry out all of these yourself — writing files, running `gh`, and asking the
user only for the decisions that are genuinely theirs. Never tell the user to go
run an installer; that is what this skill replaces.

| The user says something like… | You do |
| --- | --- |
| "set up OrcaCode Review here", "@orcarouter code review 帮我配置这个仓库" | [Install](#install) — offer Action vs App first |
| "install the GitHub App instead", "用 App 模式" | [App mode](#install--github-app-mode) |
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

There are two ways to run OrcaCode Review on a repo. Pick one — **never both**,
see [Do not install both](#do-not-install-both).

### 0. Pick the mode

Check what the user is even able to do *before* offering the choice, so you do
not walk them into an approval they cannot give:

```bash
gh api /repos/<owner>/<name> --jq '{admin: .permissions.admin, ownerType: .owner.type, owner: .owner.login}'
# for an Organization owner, also:
gh api /orgs/<owner>/memberships/$(gh api /user --jq .login) --jq .role   # "admin" | "member"
```

Then ask with `AskUserQuestion`:

**"How should OrcaCode Review run on this repo?"**

- *GitHub Action (recommended)* — a workflow file in the repo plus one secret.
  Anyone with **write access** can set it up, it works on personal repos, and
  the config is visible in the diff like any other CI. This is the path the
  rest of this section describes.
- *GitHub App* — no file in the repo; a bot reviews PRs. Needs **repo admin, or
  organization owner** on an org repo. One approval can cover many repos.

**If the probe above said `admin: false` and the org role is `member`, say so
before they choose.** They cannot complete App mode themselves — they would
click through to the approval page and be stopped there. Offer Action mode, or
offer to draft the request they send to an owner.

Chose App mode? → [Install — GitHub App mode](#install--github-app-mode).
Otherwise carry on.

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

### 5. Switch it on in the OrcaRouter console

Point the user at **OrcaRouter → Apps → OrcaCode Review** (<https://www.orcarouter.ai/>)
to turn it on and choose review models. Reviews will not run until it is enabled.

This is the OrcaRouter console, not the GitHub App — Action mode still needs it.
There is no API for this step today, so it is the user's to do.

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

## Install — GitHub App mode

No file lands in the repo. OrcaRouter reviews pull requests as a bot, and the
repo's own config is the App's installation rather than a workflow.

### 1. Confirm they can actually approve it

Installing a GitHub App is a **permission grant**, so GitHub requires a human to
approve it on an authorization page. There is no REST endpoint that installs an
App on someone's behalf — this is deliberate, not a gap you can route around.

The approver must be **repo admin**, or an **organization owner** for an org
repo. If the step-0 probe showed otherwise, stop here and offer:

- Action mode instead, which only needs write access, or
- a message they can forward to an owner, containing the install link below and
  one line on what it does.

### 2. Hand over the link

Print the URL. Offer to open it, but **never open it without printing it** —
SSH sessions, containers and CI have no browser, and a tool that silently
launches nothing leaves the user waiting on something that will not happen.

```
https://github.com/apps/orcacode-review/installations/new
```

To open it as well:

```bash
open <url>        # macOS
xdg-open <url>    # Linux
```

Tell them what to expect on that page: choose the account or organization, then
**select only this repository** unless they mean to cover more. "All
repositories" is a much larger grant, and on a paid plan a much larger bill.

### 3. Wait, then verify

Ask them to say when the approval is done — do not poll silently and do not
assume.

Verification depends on what their token can see:

```bash
# Works only with the admin:org scope, which they may not want to grant:
gh api /orgs/<owner>/installations --jq '.installations[].app_slug'
```

`GET /repos/{owner}/{repo}/installation` does **not** work here — it needs the
App's own JWT, which no user token can produce.

If neither is available, verify the honest way: open a pull request and look for
the bot's review. That is the same thing the user cares about anyway.

```bash
gh pr create --fill
```

### 4. Configure

Everything else lives at **OrcaRouter → Apps → OrcaCode Review**
(<https://www.orcarouter.ai/>): models, review mode, severity rules, merge
policy, rubric.

**No `ORCAROUTER_API_KEY` secret is needed in the repo** — the App carries its
own credentials. Do not add one; it would sit there unused and look load-bearing
to the next person who reads the settings page.

### 5. Make the gate real

The App posts its own status check. Read the exact check name off the test PR
rather than guessing it:

```bash
gh pr checks <number>
```

Then require that check under **Settings → Branches / Rulesets → Require status
checks to pass**. Until it is required, a red check blocks nothing.

### 6. Report

Same rules as Action mode: what is in place, what is not, and any outstanding
action as a copy-pasteable command. If the approval never happened, say the
install is **not** complete — an unapproved App reviews nothing and reports no
error.

## Do not install both

The Action and the App both review the same pull requests. Running them together
gives every PR two sets of comments and bills two reviews.

Before installing either, check for the other:

- Action present → `.github/workflows/orca-code-review.yml` exists on the base branch.
- App present → a bot review or an extra check on a recent PR.

If the user has one and wants the other, remove the first — [Uninstall](#uninstall)
for the Action, or the App's own page on GitHub for the App. Removing the Action
is the reversible one, so prefer that direction when they are unsure.

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

- Merge policy (`block-on`), exhaustive early-stop (`fix-first`), and which severities post
  inline (Report severities, dashboard-only).
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
