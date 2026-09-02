---
name: orca-review
description: Review code changes yourself, locally, with OrcaCode Review's severity contract and merge gate — no GitHub Action, no OrcaRouter account, no API key. You are the reviewer; the CLI supplies file selection, the P0-P3 rubric, position verification, and the gate. Use whenever the user asks you to review their changes, review a diff, branch, commit, or a pull request by number ("review PR 556"), check work before committing or pushing, run OrcaCode Review here, or asks "is this safe to merge?" — and whenever they want a local review that agrees with what CI will say.
---

# OrcaCode Review — local review

You are the reviewer. Your own model does the thinking; the CLI does everything
that must not be left to a model — which files are in scope, which rules apply,
whether a finding is filed on the right line, and what blocks a merge.

This is the same severity contract the GitHub Action enforces, so a P1 you find
here is a P1 that would block there. That parity is the point: "it passed
locally" has to mean something.

**Severity contract:** `P0` critical / `P1` high → ❌ block. `P2` conditional bug
/ `P3` nit → 💬 report, never block.

## When this skill applies

| The user says something like… | You do |
| --- | --- |
| "review my changes", "看一下我这次的改动", "check this before I push" | The [workflow](#workflow) below |
| "review this branch / this commit / these staged files" | Same, with the matching [range flags](#choosing-the-range) |
| "review PR 556", "帮我审一下 #556" | Same, with `--pr 556` — do **not** check the branch out first |
| "is this safe to merge?" | Same — the gate answers it |
| "set up OrcaCode Review on this repo", "why didn't CI review my PR?" | **Not this skill.** That is `orca-review-action`, which wires up the Action |

Nothing here talks to OrcaRouter. If the user wants automatic review on every
PR, that is the other skill.

## Workflow

### 1. Plan

```bash
npx @orcarouter/code-review review plan --lang en   # en | zh | ja | ko
```

`--lang` is the language the user is speaking to you in — `en`, `zh`, `ja`, or
`ko`. **Do not copy the example's value; read the conversation.** An English
request gets `en`, a Chinese one `zh`. Pass it on every command. The plan will tell you to write your findings in
that language, and `submit` will render its report in it. Without the flag the
CLI falls back to the machine's locale, which is usually right and sometimes is
not; you know which language the conversation is in, so say so.

**Everything you say to the user is in that language too** — the one-line
acknowledgement before you start, the report you relay, the next step you offer,
the settings question. A Chinese request answered with "I'll review PR 92" and
then a Chinese report reads as two different people.

It prints a complete review request to stdout: the files in scope, the files it
excluded and why, the git command that shows each change, per-language review
checklists, the full P0-P3 rubric, the project's own conventions, and the exact
result shape. Progress notes go to stderr, so the stdout text is the whole
prompt and nothing else.

Read all of it. Everything you need is in there — do not go looking for a rubric
elsewhere, and do not substitute a severity scheme you know from somewhere else.

The file list has already been filtered: binaries, deleted files, unsupported
types, tests and fixtures and generated code, and anything under `.gitignore`
are listed under **Excluded** with the reason. Do not review those, and do not
second-guess the list — it is the same selection CI applies.

### 2. Review

Work file by file through the list in the request:

1. Get the diff with the command the request gives you.
2. **Read the actual file**, not just the diff. A finding you cannot confirm by
   reading the surrounding code is a finding to drop.
3. Apply that file's rule group, then the severity rubric.

Comment only on changed lines. The rubric's precision section is binding, in
particular: one comment per distinct issue, never the same root cause restated
per file, and never a finding pinned to a file you did not open.

### 3. Hand back

Write `.orcacode-review/result.json` in exactly the shape the request specifies.
**Four fields per finding, and nothing else** — the file is an internal handoff,
not a report, and every extra byte is a line of raw JSON scrolling past the
person watching you work:

```json
{"comments": [
  {"path": "src/auth.ts", "line": 41,
   "existing_code": "  if (token === expected) {",
   "content": "[P0] **Title**\n\nBody."}
]}
```

- `path` — repo-relative, and it must be the file that actually contains the code.
- `line` — in the post-change file. Only for a finding that genuinely spans
  several lines, write `start_line`/`end_line` instead.
- `existing_code` — the source you are quoting, **copied verbatim**. This gets
  grepped against the tree to check you filed the finding on the right file. A
  paraphrase here reads as a wrong location and the finding may be dropped. One
  line is enough; do not paste a whole function.
- `content` — `[P0]`/`[P1]`/`[P2]`/`[P3]`, then a bold title, then the body,
  **written in the user's language**. The tag, the bold, and the separate
  **Fix:** paragraph are structure and never change; the words inside them do.
  Identifiers, paths, and code stay verbatim.

Found nothing? Write `{"comments": []}`. That is a clean review, not a failure.

`warnings` is optional and you will almost never want it: it lists files you
could **not** review, and a non-empty `warnings` makes the review partial, which
`submit` rejects rather than passes. Omit the key unless something genuinely
failed.

### 4. Submit

```bash
npx @orcarouter/code-review review submit --format md --lang en   # same --lang as the plan
```

Same `--lang` as the plan, so the report's verdict line and headings come out in
the user's language alongside the findings you wrote in it.

This verifies every finding's position against the tree, drops duplicates,
tags what would block a merge, and prints the report as markdown.

Use `--format md` rather than the default. The default is an ANSI terminal
report hard-wrapped at 78 columns, which arrives in a conversation as a wall of
pre-formatted text.

**Relay that markdown to the user verbatim.** It is written to be read in a
chat: grouped by file, blocking file first, ❌ on what stops the merge and 💬
on what does not. Do not re-summarise it, do not re-order it, and do not
substitute your own severity call — the gate decides what blocks, not you, and
it will have re-homed or dropped findings you were about to report.

**The exit code is not the verdict.** `submit` exits `0` whenever the review
ran, blocked or not — your job is to tell the user what the bugs are, and that
is the report. The line under its heading says which it was: ❌ (`Blocked`,
`已拦截`, …) means something at P0/P1 would stop a merge, ✅ means nothing
would. Relay whichever you got.

| Exit | Means | You say |
| --- | --- | --- |
| `0` | The review ran. The report has the findings and the verdict | Relay the report as-is |
| `2` | The result was unusable | Fix the JSON and submit again. **Never** a pass |

Exit `2` is the only failure, and it is never a pass. (A `1` only exists under
`--fail-on-block`, which is for hooks and CI scripts — you have no reason to
pass it.)

The same markdown is always saved to `.orcacode-review/report.md`.

Then say, in one line, what you would do next. Offer to fix; do not start
fixing unless the user asked for it in the first place.

## The first review in a repository

If the plan ends with a section titled **First review in this repository**,
there is no `.orcacode-review.json` yet. Do the review exactly as normal. Then,
after the report is on screen, offer once — one sentence — to save the settings
this run used, and say what saving buys them: the next review here needs no
flags, for them or for anyone else who clones the repo. Something like:

> 这个仓库还没有本地评审配置。要我把这次的设置（中文、P0/P1 阻塞）存成
> `.orcacode-review.json` 吗？以后在这里评审就不用再指定了。

Yes → run the `review config init` command the plan gives you, apply anything
they asked for on top, show them the file. No → drop it for the rest of the
conversation. Never create the file without being asked, and never ask before
the report: they should decide with the output in front of them, not in the
abstract.

## Changing how the local review behaves

The repo's local review settings live in one committed file,
`.orcacode-review.json`. When the user asks for a lasting change — not "this
once" but "from now on" — **edit that file**; do not reach for a flag, and do
not put it in `CLAUDE.md`.

| The user says something like… | You change |
| --- | --- |
| "本地只挡 P0", "only block on critical locally" | `"block_on": "P0"` |
| "别挡了，都只提醒", "never block, just report" | `"block_on": ""` |
| "以后用中文报", "report in Japanese from now on" | `"language": "zh"` / `"ja"` |
| "不要审 docs/", "skip generated files" | append to `"exclude"`: `"docs/**"`, `"**/*.generated.ts"` |
| "API 文件多查一下鉴权", "add a checklist for migrations" | append to `"rules"`: `{ "path": "src/api/**/*.ts", "rule": "…" }` |

Before editing, run this to see what applies now and where each value came from:

```bash
npx @orcarouter/code-review review config --lang en   # the user's language
```

If the file does not exist yet, create it with the template rather than by hand:

```bash
npx @orcarouter/code-review review config init --lang en   # the user's language
```

Then edit only the key the user asked about. Show them the resulting file. Keys
you do not write keep their defaults; unknown keys are an error, not a typo the
tool overlooks — if `plan` or `submit` refuses with "`.orcacode-review.json` is
invalid", read the message, it names the key and the allowed values.

The four keys, and nothing else:

- `block_on` — `"P0,P1"` (default), `"P0"`, or `""`. What the report marks ❌.
- `language` — `en` | `zh` | `ja` | `ko`. Outranks the machine locale; `--lang`
  still outranks it.
- `exclude` — extra globs never to review, on top of the bundled rules.
  `docs/**`, `**/*.snap`, `legacy/**`.
- `rules` — extra checklists. Each `{ "path": glob, "rule": "text" }` or
  `{ "path": glob, "rule_file": "docs/review/api.md" }`. By default the text is
  **added** to the bundled checklist for those files; `"replace": true` swaps it
  in instead.

For a one-off ("just this time only block on P0") use the flag on that one
command instead, and change nothing on disk.

## Choosing the range

With no flags it picks for you and says which it picked: uncommitted work if the
tree is dirty, otherwise this branch against its base — the range CI would use.
Override when the user was specific:

| The user means | Flags |
| --- | --- |
| "what I'm working on right now" | `--worktree` |
| "this branch" / "the PR I'm on" | `--from main --to HEAD` |
| "PR 556" — a number, not the current branch | `--pr 556` |
| "that commit" | `--commit <sha>` |
| "only block on critical" — this once | `--block-on P0` on `submit` |
| "only block on critical" — from now on | `"block_on": "P0"` in `.orcacode-review.json` (see [above](#changing-how-the-local-review-behaves)) |

Pass `--background "…"` when the user has told you what the change is *for*.
It goes to the reviewer — you — as business context, and it is what lets you
judge whether the change does what it was supposed to. With `--pr` the PR's
title and description become the background automatically; only pass
`--background` on top of it if the user told you something the PR does not say.

### Reviewing a pull request by number

`--pr` needs the GitHub CLI (`gh`) and **does not check the branch out**. It
fetches the PR into a private ref and leaves the work tree exactly as it was —
so it is safe to run mid-change, and you must not `git checkout` or `git stash`
around it. Fork PRs work; the head is fetched from the base repository.

If it reports that `gh` is missing or not signed in, do not try to install or
authenticate it. Say so, and offer the fallback the CLI prints:

```bash
gh pr checkout 556     # the user runs this, then you review with no --pr
```

## Getting it wrong

- **Do not invent severities.** High/Medium/Low is a different tool's
  vocabulary. Untagged findings default to P1, which blocks — so tag everything.
- **Do not drop P2 and P3 to look decisive.** The rubric is explicit that they
  are still emitted. They do not block; hiding them is not calibration.
- **Do not skip `submit` because you already know what you found.** Position
  verification and deduplication happen there, and they change the answer.
- **Do not report a clean review when `submit` exited 2.** That is an unusable
  result, not a pass. Fix the JSON and submit again.
- **Do not switch branches to review a PR.** `--pr` exists so you never have to.
  Checking out loses the user's uncommitted work or fails outright, and leaves
  them somewhere they did not ask to be.

## If something fails

| Symptom | Cause |
| --- | --- |
| "Not a git repository" | Run from inside the repo |
| "Nothing to review" | Clean tree with no commits past the base — use `--worktree` or name a range |
| "Unusable result" | The JSON is malformed, or `warnings` is non-empty. Read the message, fix, resubmit |
| "Position check skipped" | Expected on uncommitted work — nothing to grep. Findings are all kept |
| "No result at …" | You did not write the file, or wrote it somewhere else |
| "`--pr` needs the GitHub CLI" | No `gh`. Tell the user; offer `gh pr checkout <n>` as the fallback |
| "gh is installed but not signed in" | Theirs to fix: `gh auth login`. Do not run it for them |

`references/contract.md` has the full command reference, the JSON schema, and
the exit codes — read it before guessing at a flag.
