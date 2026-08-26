# Troubleshooting

Collect evidence first. A guess costs more than a command.

```bash
gh run list --workflow orca-code-review.yml --limit 5
gh run view <run-id> --log-failed
gh secret list | grep ORCAROUTER_API_KEY
```

## No workflow run appears at all

The job never started, so there are no logs. Work down this list:

| Check | How | Fix |
| --- | --- | --- |
| Workflow exists **on the base branch** | `git show origin/<default>:.github/workflows/orca-code-review.yml` | `pull_request_target` reads the workflow from the base branch, not the PR head. A workflow added only in the PR branch will not run until it merges. |
| App is enabled | OrcaRouter → Apps → OrcaCode Review | Turn it on. |
| `auto_review` is on | Dashboard | Off means no automatic reviews. `/orcacode-review` still works. |
| PR is not a draft | `gh pr view --json isDraft` | With `trigger: ready_for_review`, drafts are skipped by design. Mark it ready. |
| Author is allowed | `gh pr view --json authorAssociation` | If it is outside `auto-review-authors`, a maintainer can run `/orcacode-review`. |
| Actions are enabled | Repo Settings → Actions | Forked repos ship with Actions disabled. |

## `/orcacode-review` does nothing

The comment gate requires **both**: the comment starts with one of
`/orcacode-review`, `/orcacode review`, `@orcacode-review`, `@orcacode review`
(a leading space or quote breaks `startsWith`), **and** the commenter's
`author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`.

An outside contributor commenting the command is silently ignored. That is
deliberate — the command runs a privileged workflow holding the paid key.

## Run fails immediately with an auth error

| Cause | Tell |
| --- | --- |
| Secret missing or misnamed | `gh secret list` shows no `ORCAROUTER_API_KEY`. The name is exact and case-sensitive. |
| Secret set on an environment or another repo | Repository secrets and environment secrets are different scopes. The job reads repository (or org) secrets. |
| Key revoked or out of budget | Check <https://www.orcarouter.ai/console/token>. A wallet at its limit returns an auth-shaped failure. |
| Fork PR | Secrets are unavailable to `pull_request` from forks — which is exactly why the shipped workflow uses `pull_request_target`. If someone replaced the trigger, that is the bug. |

## "Diff too large" notice, check is red

Working as configured. The guard runs before the engine, so nothing was spent.

- Split the PR — the real fix, and it reviews better.
- Or raise `max-diff-kb` / `max-diff-files`.
- Or set `on-oversized-diff: "pass"` to make the skip advisory. Understand the
  trade first: with a required check, `pass` means a big enough PR can walk
  straight through the gate unreviewed.

## Review runs, but no comments appear

| Cause | Fix |
| --- | --- |
| Nothing was found | A clean run posts a summary, not inline comments. Check the job log's severity counts. |
| Quiet mode | P2 findings are muted at posting time. The gate and report still counted them — the log will show a nonzero P2. |
| Precision filter dropped them | L1 drops findings whose `existing_code` snippet does not match the reviewed commit; L2 drops low-confidence clusters. Lower `judge-threshold`, or set `precision-filter: "false"` to see raw output. |
| Missing permissions | The job needs `pull-requests: write` and `issues: write`. |

## Reviews work, but the console's Settings and Analytics tabs are empty

`@v1` points at a commit that predates `scripts/settings.mjs` and
`scripts/report.mjs`. Settings are never fetched and runs are never reported —
**with no error message**. Two dead tabs and working reviews is the signature.

Verify against the action repo:

```bash
git ls-tree v1 scripts/ | grep -E 'settings|report'
```

Fix by pinning a newer tag or an immutable commit SHA instead of `@v1`.

## Findings look wrong or noisy

- Tighten the rubric at **OrcaRouter → Apps → OrcaCode Review**.
- Raise `judge-threshold` above `0.5` to drop more low-confidence findings.
- Set `judge-model` to something other than the reviewer model — a judge that is
  the same model is not an independent second opinion.
- Turn on quiet mode to keep P2 out of the PR while still counting it.

## Every PR gets two sets of comments

The Action and the GitHub App are both installed. They review the same pull
requests independently, so the repo pays twice and the author reads everything
twice.

| Check | How |
| --- | --- |
| Action present | `git show origin/<default>:.github/workflows/orca-code-review.yml` |
| App present | A bot review, or a check on a recent PR that no workflow in the repo produces |

Keep one. Removing the Action is the reversible half — delete the workflow (drop
the required check first). Removing the App means revoking its installation on
GitHub, which is a permission change someone with admin rights has to make.

## Merges are not actually blocked

A red check blocks nothing until it is required. Add **`review`** under
**Settings → Branches / Rulesets → Require status checks to pass**.

Also confirm `block-on` is not `""`, and that the reviewed severities are the ones
you expect — with the dashboard authoritative, `block_on` may have been changed in
the console rather than in the file.

## The run times out

`timeout-minutes` (default 20) is a ceiling on **one** engine pass. Exceeding it
fails closed with a distinct "wall-clock timeout" error, separate from
"no usable result" — the log says which. Raise it for very large diffs or
slow-per-call models, or lower `concurrency` if the model is rate-limiting and the
retries are what is eating the clock.
