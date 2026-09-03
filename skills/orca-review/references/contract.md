# Harness contract

The machine-readable surface behind the local review. Two commands, split at the
point where judgement enters: `plan` is everything before the model, `submit` is
everything after it.

Nothing here contacts OrcaRouter, and no API key exists in this flow.

## `review plan`

```
npx @orcarouter/code-review review plan [range] [--background <text>] [--lang en|zh|ja|ko] [--json]
```

Writes the review request to **stdout** and progress notes to **stderr**, so
`review plan > request.md` captures the prompt clean. Also writes both
`.orcacode-review/request.md` and `.orcacode-review/plan.json`, and adds
`/.orcacode-review/` to `.git/info/exclude` so reviewing never dirties the repo.

### Range flags

| Flag | Meaning |
| --- | --- |
| *(none)* | Auto: uncommitted work if the tree is dirty, else this branch vs its base |
| `--worktree` | Uncommitted work (staged + unstaged + untracked) |
| `--from <ref> --to <ref>` | A range. `--to` defaults to `HEAD` |
| `--commit <sha>`, `-c` | One commit |
| `--pr <number>` | A GitHub pull request. Mutually exclusive with the four above |
| `--background <text>`, `-b` | Business context passed to the reviewer |

Named to match Open Code Review's `ocr delegate` flags, so anyone who knows one
already knows the other.

### `--pr`

The only flag that talks to a forge, and the only one with a dependency:
`gh`, resolved at call time. Without it the command fails with `no-gh` and
tells the caller to `gh pr checkout` instead. Nothing else in the harness knows
what a pull request is.

It does **not** check the branch out. Two fetches put the PR into a private ref
namespace and the range is built from those:

```
refs/orcacode/pr/<n>/head   <- +refs/pull/<n>/head   (exists for fork PRs too)
refs/orcacode/pr/<n>/base   <- +refs/heads/<baseRefName>
```

The work tree is never touched, so `--pr` is safe to run mid-change. Re-running
moves the same two refs; nothing accumulates and no branch is created. If the
base branch has been deleted (a merged PR), it falls back to
`<remote>/<baseRefName>` and then the bare name, and fails with `no-base-ref`
if neither resolves.

The remote is whichever one points at the repository `gh` resolved — not
blindly `origin` — so a fork checkout fetches from upstream.

The PR title and body become `background` unless `--background` was given
explicitly, capped at 4000 characters. `plan.pr` carries the metadata:

```json
{ "number": 556, "title": "…", "url": "…", "state": "OPEN",
  "base": "main", "head": "feat/x", "fork": false }
```

It is `null` for every other mode. `range.code` is `"pr"`.

### `--json`

Emits the plan as structured data instead of the prompt. `schema_version` is
`"1"`; it changes only when a field changes incompatibly.

```json
{
  "schema_version": "1",
  "mode": "range | commit | workspace",
  "repository": "/abs/path",
  "from": "main", "to": "HEAD", "commit": "", "merge_base": "<sha>",
  "pr": null,
  "background": "",
  "language": "en",
  "config": null,
  "selector": "builtin",
  "files":    [{ "path": "src/a.ts", "status": "M", "insertions": 12, "deletions": 3 }],
  "excluded": [{ "path": "pnpm-lock.yaml", "reason": "lockfile" }],
  "rule_groups": [{ "group_id": 1, "source": "…", "pattern": "*.ts", "files": ["src/a.ts"], "rule": "…" }],
  "diff_recipe": "git diff <merge_base>..HEAD -- <path>",
  "rubric": { "severity": "…", "output_shape": "…", "conventions": { "file": "AGENTS.md", "text": "…" } },
  "result_path": "/abs/path/.orcacode-review/result.json"
}
```

### `language`

The language the reviewer is told to write findings in: `--lang` if given, else
the CLI's locale detection, else `en`. The plan carries a `## Language` section
naming it. Only the findings' prose and the report's own strings follow it; the
severity rubric, the output-shape rule, and the tags are English tokens shared
with the Action and do not translate.

### `selector`

Always `builtin`. Changed files come from git; which of them are reviewable,
and which checklist applies to each, comes from Open Code Review's rule corpus
vendored under `vendor/open-code-review/` and a JavaScript port of its matcher
(`bin/selection.mjs`). Nothing is installed and nothing is spawned. The plan's
`excluded` list carries a reason per file:

| `code` | Meaning |
| --- | --- |
| `ignored` | Under an always-skipped directory (`node_modules/`, `vendor/`, `.git/`, …) or matched by the root `.gitignore` |
| `binary` | Git reports no line counts |
| `unsupported_ext` | Extension not in the reviewable allowlist. Extensionless files pass |
| `default_path` | Matches a default exclude glob: tests, fixtures, snapshots, generated code |
| `project_exclude` | Matches an `exclude` glob in `.orcacode-review.json` |
| `deleted` | Nothing left to review |

`rule_groups` is the same corpus's per-language checklists, one group per
distinct (pattern, checklist) pair, in the shape `ocr delegate rule` emits.

Not ported: Open Code Review's own project/global rule layers
(`.opencodereview/rule.json`). A repo that uses those has `ocr` set up already;
this path is for repos that do not.

## `review config`

```
npx @orcarouter/code-review review config [--json]
npx @orcarouter/code-review review config init [--force]
```

Shows the settings that will apply to the next `plan`/`submit` and the source
of each — `flag`, `file`, `default`, `locale` — or writes the template. `--json`
emits `{ file, block_on: {value, source}, language: {value, source}, exclude,
rules }`.

### `.orcacode-review.json`

The repository's local review settings. Committed. Read by `plan`, `submit`,
and `config`; an invalid file makes all three exit `2` with the offending key
named, because a setting that was silently ignored would let the file say one
thing and the review do another.

```json
{
  "$comment": "optional note; ignored",
  "block_on": "P0,P1",
  "language": "zh",
  "exclude": ["docs/**", "**/*.generated.ts"],
  "rules": [
    { "path": "src/api/**/*.ts", "rule": "Every handler checks the caller's tenant before touching a row." },
    { "path": "migrations/**/*.sql", "rule_file": "docs/review/migrations.md", "replace": false }
  ]
}
```

| Key | Type | Effect | Precedence |
| --- | --- | --- | --- |
| `block_on` | `"P0,P1"` string or array; `""` = none | Which findings the report marks ❌ | `--block-on` > file > `P0,P1` |
| `language` | `en` `zh` `ja` `ko` | Findings and report language | `--lang` > file > locale > `en` |
| `exclude` | array of globs (doublestar syntax, case-insensitive) | Files never reviewed; listed under Excluded with reason `project_exclude` | Adds to the bundled excludes |
| `rules` | array of `{ path, rule \| rule_file, replace? }` | Extra checklist for files matching `path`; first match wins | Added to the bundled checklist unless `replace: true` |

`rule_file` is repo-relative and must resolve inside the repository. Unknown
top-level keys, unknown keys inside a rule, a `rule` and `rule_file` on the same
entry, or an unreadable `rule_file` are all errors. `plan --json` reports the
loaded file under `config` (or `null`).

When the file is absent, the plan text ends with a **First review in this
repository** section instructing the agent to offer, once and after the report,
to create it via `review config init`. `init` pre-fills `language` from the
run's language and `block_on` from `--block-on` if given. Nothing is ever
written unasked.

Not the same thing as `.orcacode-review/` — that directory is per-run scratch
(`plan.json`, `result.json`, `report.md`) and is kept out of git.

## `review submit`

```
npx @orcarouter/code-review review submit [file] [--block-on P0,P1]
                                          [--format text|md|json] [--fail-on-block]
                                          [--no-postfilter]
```

`file` defaults to `.orcacode-review/result.json`.

### `--format`

| Value | Output on stdout | For |
| --- | --- | --- |
| `text` *(default)* | ANSI report, hard-wrapped at 78 columns | A human at a terminal |
| `md` | Markdown report | An agent relaying it into a conversation |
| `json` | The structured result below | A scripted harness |

`--json` is an alias for `--format json`; `--md`/`--markdown` for `--format md`.
An unknown value is an error, not a fallback to `text` — a caller expecting
machine output must never silently receive ANSI.

The markdown report is **always** written to `.orcacode-review/report.md`,
whatever format was requested, so it can be read back or attached to a ticket.
It groups findings by file, sorts the file holding the worst finding first, and
marks each finding ❌ or 💬 according to the gate that actually ran — under
`--block-on P0` a P1 is marked 💬, because that run does not block on it.

Pipeline, in order:

1. **Shape check** — `comments` must be an array; every finding needs `path` and
   `content`. A bare `line` is widened to `start_line`/`end_line` here. A
   non-empty `warnings` means a partial review and is rejected. This mirrors the
   Action's `check-result.mjs`: a partial review must never become a clean pass.
2. **Position check** — each finding's `existing_code` is grepped against the
   reviewed commit. A snippet that matches a *different* file re-homes the
   finding to that file; one that matches nowhere and is pinned to a non-code
   file is dropped; then duplicates by normalized content are collapsed. This is
   the Action's `postfilter.mjs`, run unmodified.
   Skipped in workspace mode — uncommitted code is in no commit to grep — and
   fail-soft everywhere else: an error keeps every finding rather than losing any.
3. **Gate** — findings are tagged by leading `[P0]`…`[P3]`; an untagged finding
   counts as **P1** (fail-safe, so a missing tag escalates rather than passing).
   `--block-on` defaults to `P0,P1`; `--block-on ""` never blocks.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Reviewed. The report carries the verdict, blocked or not |
| `1` | Reviewed and blocked — **only under `--fail-on-block`** |
| `2` | No usable result — unparseable, malformed, or partial. Never a pass |

The default is `0` for a review that ran, whatever it found. The local harness
exists to tell an agent what the bugs are, and an agent reads the report — its
shell tool labels any non-zero exit `Error`, so a verdict carried in the status
arrives looking like a crashed command. The verdict is in the report instead:
`**❌ Blocked**` / `**✅ Passed**` in markdown, `❌ BLOCKED` / `✅ PASSED` in the
terminal report, `"blocked": true|false` under `--format json`.

### `--fail-on-block`

Makes a blocked review also exit `1`, for a caller that consumes the status
rather than the report: a pre-push hook, a CI step, a `review submit && git
push`. Nothing else changes.

`2` is unaffected by either setting. An unusable result must never come back as
`0` — that would turn a review that did not happen into a review that passed,
which is the one failure mode this whole pipeline exists to prevent.

### `--json`

```json
{
  "comments": [ … ],
  "counts": { "P0": 0, "P1": 2, "P2": 1, "P3": 4 },
  "block_on": ["P0", "P1"],
  "blocked": true
}
```

`comments` here is the post-verification set — re-homed and deduplicated — which
is why it can differ from what was submitted.

## Result shape

What an agent writes — the short form, four fields:

```json
{
  "comments": [
    {
      "path": "src/auth.ts",
      "line": 41,
      "existing_code": "  if (token === expected) {",
      "content": "[P0] **Token comparison is not constant-time**\n\n`===` on a secret leaks its prefix through timing. Use `crypto.timingSafeEqual`."
    }
  ]
}
```

What the pipeline speaks internally — the wide form, which is byte-for-byte what
the GitHub Action's engine emits, and what lets the same gate, the same filters,
and the same severity tally run over both:

```json
{ "path": "src/auth.ts", "start_line": 41, "end_line": 41, "…": "…" }
```

`validateResult` widens the short form into the wide one at the boundary, and
`submit` normalises the whole result to a scratch file before handing it to
`postfilter.mjs` — that script reads a *file*, not the parsed object, so it must
be given the wide form or every finding comes back with no anchor.

- `line` is the short form and is what you should write. `start_line`/`end_line`
  is for a finding that genuinely spans lines. Do not write both.
- The Action's poster collapses the pair to a single line as
  `end_line || start_line`, which is the same rule `anchorLine()` uses here.
- `warnings` is optional. Omit it; a non-empty one means a partial review and is
  rejected. An empty one is accepted and means the same as omitting it.
- The position check can **clear** the anchor when it re-homes a finding whose
  line it cannot resolve in the new file. That is deliberate — a stale line from
  the wrong file would post the comment on unrelated code.
- `existing_code` is the verification key. Copy it verbatim from the file; a
  paraphrase reads as a wrong location.
- `content` must open with the severity tag, then a bold title of about ten words
  naming what is **wrong** (not what to do, no full stop), then a blank line,
  then the body. The renderer splits on that bold.

## Relationship to the Action

| | Local (`review plan`/`submit`) | GitHub Action |
| --- | --- | --- |
| Who thinks | Your coding agent's model | The engine, via OrcaRouter |
| Credentials | None | `ORCAROUTER_API_KEY` |
| File selection | Vendored Open Code Review rules, ported matcher | The engine, same rules |
| Severity rubric | `rules/severity-instruction.md` | The same file |
| Position check | `postfilter.mjs` | The same script |
| L2 LLM judge | Not run — it needs a second, independent model | Optional |
| Result shape | Identical | Identical |
| Findings posted | Terminal | Inline PR comments |

The differences are about who pays for the thinking and where the output lands.
The severity judgement is the same on both sides on purpose.
