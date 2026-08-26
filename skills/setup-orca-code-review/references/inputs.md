# Action inputs

Every input of `Continuum-AI-Corp/orca-code-review@v1`. Read the row before
answering a question about behavior — do not guess a default.

## Required

| Input | Default | What it does |
| --- | --- | --- |
| `orcarouter-api-key` | — | OrcaRouter API key. Always pass it as `${{ secrets.ORCAROUTER_API_KEY }}`, never a literal. |

## Routing and identity

| Input | Default | What it does |
| --- | --- | --- |
| `orcarouter-url` | `https://api.orcarouter.ai/v1/chat/completions` | Chat-completions endpoint. Change only for a self-hosted gateway. |
| `github-token` | `${{ github.token }}` | Fetches the PR head, posts review comments, and reacts to a `/orcacode-review` command. |
| `brand` | `OrcaCode Review` | Name shown on PR comments. |
| `router` | `orcarouter/orcacode-review` | Router alias that owns model selection. The action names no models: it injects raw facts (`x-cr-prev-tier`, `x-cr-prev-p0p1`) and this router's DSL recipe maps them to a concrete model. |
| `engine-version` | `1.3.13` | Pinned `@alibaba-group/open-code-review` version. Bump deliberately — later steps parse its JSON output shape. |

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
| `auto-review-authors` | `""` (everyone) | Author-association allowlist for **automatic** reviews. Others can still be reviewed on demand via `/orcacode-review`. Values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `NONE`. |

On a **public** repo this is a spend control, not a preference. The workflow runs on
`pull_request_target`, which bypasses GitHub's fork-approval gate, and the key is
wallet-metered — so any stranger opening a PR can trigger paid reviews. Set the
allowlist and put a budget + alert on the key.

## Oversized-diff guard

| Input | Default | What it does |
| --- | --- | --- |
| `max-diff-kb` | `512` | Skip the review when the merge-base diff exceeds this size. |
| `max-diff-files` | `300` | Skip when the diff touches more files than this. |
| `on-oversized-diff` | `fail` | What a skip does to the check. `fail` means a diff padded past the limits cannot bypass a required gate. `pass` restores advisory behavior. |

The guard runs **before** the engine, so an oversized PR costs nothing.

## Precision filter

Post-processing between the engine and the merge gate. Both layers are soft-fail:
an error keeps the prior stage's findings and never aborts the review.

| Input | Default | What it does |
| --- | --- | --- |
| `precision-filter` | `true` | L1 verifies each finding's `existing_code` snippet against the reviewed commit and re-homes or drops mismatches; L2 is an LLM judge that clusters by root cause and drops low-confidence findings. `false` posts the engine's raw findings. |
| `judge-model` | `deepseek/deepseek-v4-pro` | Model for the L2 judge. Should differ from the reviewer model so it acts as an independent second opinion. Ignored when `precision-filter` is `false`. |
| `judge-threshold` | `0.5` | Keep-threshold (0–1) for the judge's per-cluster confidence. Lower keeps more findings; raise to be stricter. |

## Throughput

| Input | Default | What it does |
| --- | --- | --- |
| `concurrency` | `24` | Max concurrent file reviews. Raise to shorten wall clock; lower it under a tight per-minute request quota. |
| `max-tools` | `""` (engine default) | Max tool-call rounds per file. Lowering cuts cost and time but can cost review depth. |
| `timeout-minutes` | `20` | Wall-clock ceiling for **one** engine pass. Exceeding it fails closed with a distinct "wall-clock timeout" error. Accepts decimals. Bump for very large diffs or slow models. |

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

The settings fetch fails **open**: a control-plane outage falls back to built-in
defaults rather than killing the review.

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
