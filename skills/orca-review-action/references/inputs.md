# Action inputs

Every input of `Continuum-AI-Corp/orca-code-review` (pinned to a release commit
in the shipped workflow). Read the row before
answering a question about behavior — do not guess a default.

**These rows describe this action.** The hosted OrcaCode Review GitHub App runs a
different review engine, so a setting of the same name can behave differently
there — `fix-first` and `exhaustive` in particular. For the App, the console at
**OrcaRouter → Apps → OrcaCode Review** is the authority; do not answer a question
about the App from this file.

## Required

| Input | Default | What it does |
| --- | --- | --- |
| `orcarouter-api-key` | — | OrcaRouter API key. Always pass it as `${{ secrets.ORCAROUTER_API_KEY }}`, never a literal. |

## Routing and identity

| Input | Default | What it does |
| --- | --- | --- |
| `orcarouter-url` | `https://api.orcarouter.ai/v1/chat/completions` | Chat-completions endpoint. Change only for a self-hosted gateway. From v1.7.0 (unreleased) it must be https; plain http is accepted only to this machine (`localhost`, `127.0.0.0/8`, `[::1]`), and anything else fails the run naming this input. |
| `github-token` | `${{ github.token }}` | Fetches the PR head, posts review comments, and reacts to a `/orcacode-review` command. From v1.7.0 (unreleased) it also writes the commit status on the PR head, which needs `statuses: write`. |
| `bot-login` | `""` | From v1.7.0 (unreleased). The login the action posts as when `github-token` is a GitHub App's installation token other than the job's own (e.g. `my-app[bot]`); it recognises its earlier notices by it. Not needed for the default `github.token` or a personal token. |
| `brand` | `OrcaCode Review` | Name shown on PR comments. |
| `router` | `orcarouter/orcacode-review` | Router alias that owns model selection. The action names no models: it injects raw facts (`x-cr-prev-tier`, `x-cr-prev-p0p1`) and this router's DSL recipe maps them to a concrete model. |
| `engine-version` | `1.3.13` | Pinned `@alibaba-group/open-code-review` version. From v1.7.0 (unreleased), only versions whose checksums the action pins (`scripts/engine-pins.json`) install — any other value fails the run. |

## Severity and merge gate

| Input | Default | What it does |
| --- | --- | --- |
| `fix-first` | `P0,P1` | Severities that stop an exhaustive review early — that finding is what to fix first. No effect unless `exhaustive` is on, and it never changes what the reviewer is asked to look for. |
| `block-on` | `P0,P1` | Severities that fail the check and block the merge. `""` means never block. |

Values are `P0`, `P1`, `P2`, comma-separated, case-insensitive. An explicit
empty string is valid and means "none".

## Who gets reviewed

| Input | Default | What it does |
| --- | --- | --- |
| `auto-review-authors` | unset: everyone (v1.6.0) | Author-association allowlist for **automatic** reviews. Others can still be reviewed on demand via `/orcacode-review`. Values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `NONE`. Write the list out: it means the same to every release. |
| | | From v1.7.0 (unreleased): unset means `OWNER,MEMBER,COLLABORATOR` on a public repo (everyone on a private one), and `"*"` means everyone — v1.6.0 reads `"*"` as nobody. |
| `on-skipped-review` | `pass` | From v1.7.0 (unreleased). What a settings skip (auto-review off, on-demand mode, a draft, an author outside the allowlist) does to the **job**: `pass` keeps it green, as every release did; `fail` fails it. The `status-context` status reports a skip as "Not reviewed" either way. |
| `status-context` | `OrcaCode Review` | From v1.7.0 (unreleased). Commit status written on the PR head after every run (on-demand runs included): success only when a review ran on that head and the gate passed; a settings skip is "Not reviewed". Make it the required check; needs `statuses: write`. `""` turns it off. |

On a **public** repo this is a spend control, not a preference. The workflow runs on
`pull_request_target`, which bypasses GitHub's fork-approval gate, and the key is
wallet-metered. Put a budget + alert on the key either way. The shipped workflow's
`if:` honours the `/orcacode-review` command only from `OWNER`, `MEMBER` or
`COLLABORATOR`; from v1.7.0 (unreleased) the action itself refuses anyone else's
command too, and an unset allowlist means maintainers only on a public repo.

## Oversized-diff guard

| Input | Default | What it does |
| --- | --- | --- |
| `max-diff-kb` | `5000` | Skip the review when the merge-base diff exceeds this size. Raised from 512 so large PRs are reviewed rather than refused; the real ceiling is the model context window, which this cannot see. From v1.7.0 (unreleased), files named like a standard lockfile (`package-lock.json`, `yarn.lock`, `go.sum`, `Cargo.lock`, …) are not counted here or in `max-diff-files`; the summary lists them. |
| `max-diff-files` | `2000` | Skip when the diff touches more files than this. Raised from 300. |
| `on-oversized-diff` | `fail` | What a skip does to the check. `fail` means a diff padded past the limits cannot bypass a required gate. `pass` restores advisory behavior. |

The guard runs **before** the engine, so an oversized PR costs nothing.

## Precision filter

Post-processing between the engine and the merge gate. Both layers are soft-fail:
an error keeps the prior stage's findings and never aborts the review.

| Input | Default | What it does |
| --- | --- | --- |
| `precision-filter` | `true` | L1 verifies each finding's `existing_code` snippet against the reviewed commit and re-homes or drops mismatches; L2 is an LLM judge that clusters by root cause and drops low-confidence findings. `false` posts the engine's raw findings. |
| `judge-model` | `""` | Model for the L2 judge. Empty sends the `router` alias, and the router's recipe picks the judge model (its judge rule). Set a model id to pin one; it should differ from the reviewer model so it acts as an independent second opinion. Ignored when `precision-filter` is `false`. |
| `judge-threshold` | `0.5` | Keep-threshold (0–1) for the judge's per-cluster confidence. Lower keeps more findings; raise to be stricter. |

## Throughput

| Input | Default | What it does |
| --- | --- | --- |
| `concurrency` | `24` | Max concurrent file reviews. Raise to shorten wall clock; lower it under a tight per-minute request quota. |
| `max-tools` | `""` (engine default) | Max tool-call rounds per file. Lowering cuts cost and time but can cost review depth. |
| `timeout-minutes` | `60` | Wall-clock ceiling for **one** engine pass — `exhaustive` makes up to three, so the worst case is 3x this. Exceeding it fails closed with a distinct "wall-clock timeout" error. Accepts decimals. Raised from 20 alongside the diff limits: a larger diff needs the time to actually be read. |

## Control plane

| Input | Default | What it does |
| --- | --- | --- |
| `settings` | `true` | Fetch per-repo settings from the OrcaRouter dashboard at the start of each run. `false` skips the fetch and makes the workflow file authoritative. |
| `report` | `true` | Send a per-run summary — repo, PR number, head SHA, tier, P0/P1/P2 counts, gate result, engine version. `tier` is always `standard` since the cascade was retired; the field is kept so the payload shape does not churn. **Never code or finding text.** |
| `meter` | `true` | Record per-call token accounting and print a totals table in the job log. Local only; nothing is uploaded. |

### Precedence between the dashboard and this file

With `settings: "true"` (the default), the dashboard supplies `auto_review`,
`trigger`, `exhaustive`, `quiet`, `fix_first`, `block_on`, and `rubric`. A `with:`
input wins **only when it differs from its documented default** — writing
`block-on: "P0,P1"` explicitly changes nothing, because that *is* the default.

To make the file unambiguously authoritative, set `settings: "false"`. The fetch is
skipped entirely and no server value can apply.

The settings fetch fails **open**. When it gets no settings — a 4xx (an ordinary,
non-CI key gets one on every run) or an outage (5xx, timeout, network) — the run
uses this file's inputs rather than killing the review, and **`block-on` in the
workflow is the outage floor**: if an outage must not loosen a stricter dashboard
policy, write that policy here. From v1.7.0 (unreleased) the log names which
failure it was, and the run is exactly a `settings: "false"` run (every severity
displayed).

## Dashboard-only settings

These have no workflow input. They live at **OrcaRouter → Apps → OrcaCode Review**
and only apply when `settings` is `true`.

| Setting | Values | What it does |
| --- | --- | --- |
| `auto_review` | on / off | Master switch for automatic reviews. |
| `trigger` | `every_push`, `ready_for_review`, `on_demand` | When an automatic review fires. `ready_for_review` skips drafts. |
| `exhaustive` | on / off | Extra engine passes over the same diff, deduped. Costs more. |
| `quiet` | on / off | Mutes P2 at posting time. The gate and the run report still see true counts. |
| `rubric` | free text | Server-side rubric override for the review prompt. |
| Model | one | Which model runs the review. The action never names a model — the router resolves it. |
