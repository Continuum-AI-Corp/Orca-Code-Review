# Demo recordings

Rendered with [vhs](https://github.com/charmbracelet/vhs) from the tapes in this
directory, against a small throwaway repository (`/tmp/orcacode-demo`, pushed to
a private GitHub repo so `--pr` and the Action setup have something real to talk
to). Every prompt is answered by its recommended (default) option.

| Tape | Output | What it shows |
| --- | --- | --- |
| `install.tape` | `docs/demo-install.{gif,mp4}` | `npx @orcarouter/code-review`: language → how you will use it (Both) → where → which agents → installed |
| `setup.tape` | `docs/demo-setup-raw.mp4` → `docs/demo-setup-3x.mp4`, `docs/demo-setup.gif` | Claude Code with `orca-review-action` wiring the GitHub Action: decisions, workflow file, API-key handoff |
| `review.tape` | `docs/demo-review-raw.mp4` → `docs/demo-review-3x.mp4`, `docs/demo-review.gif` | Claude Code with `orca-review` reviewing pull request #1 by number, no checkout |

The `-3x` files are the raw recordings at 3× speed; the GIFs are made from those.

## The demo repository

`/tmp/orcacode-demo` is built for each recording session and thrown away: a
four-file Node service (`src/auth.js`, `src/budget.js`, one test), pushed to a
private GitHub repo under the recording account, with one pull request that
plants three P1s — a non-constant-time token compare, a child key that copies
its parent's cap instead of sharing it, and a loop that re-parents sibling keys.
The private repo is deleted after the cut is made; recreate it the same way to
re-record.

## Re-render

```bash
# from the repository root; paths inside the tapes are relative to it
vhs docs/tapes/install.tape
vhs docs/tapes/setup.tape           # a few minutes: Claude runs at real time
vhs docs/tapes/review.tape          # same

# 3x and GIF
for n in setup review; do
  ffmpeg -i docs/demo-$n-raw.mp4 -filter:v "setpts=PTS/3" -an -r 30 -c:v libx264 -pix_fmt yuv420p -crf 22 -movflags +faststart docs/demo-$n-3x.mp4
  ffmpeg -i docs/demo-$n-3x.mp4 -vf "fps=10,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer" docs/demo-$n.gif
done
```

The review tape records the whole wait. `demo-review.mp4` is the same recording
with the thinking time sped up — see the ffmpeg line recorded in the commit
that produced it, or re-cut with:

```bash
# the shipped cut: 0–22s at 1x (launch, request), 22–276s at 12x (the review), 276–300s at 1x (the report)
ffmpeg -i docs/demo-review-raw.mp4 -filter_complex "
  [0:v]trim=0:22,setpts=PTS-STARTPTS[a];
  [0:v]trim=22:276,setpts=(PTS-STARTPTS)/12[b];
  [0:v]trim=276:300,setpts=PTS-STARTPTS[c];
  [a][b][c]concat=n=3:v=1:a=0[v]" -map "[v]" docs/demo-review.mp4
```

## Notes

- vhs rejects absolute paths in `Output`/`Screenshot`; run it from the repo root.
- The tapes use `Set Shell "bash"` because the recording user's zsh profile
  prints noise on startup.
- `review.tape` starts Claude Code with `--permission-mode bypassPermissions`: a
  recording cannot answer the per-command approval prompts, and the review only
  reads code and writes under `.orcacode-review/`. Do not copy that flag into
  real use.
- `review.tape` runs in a fresh clone at `/tmp/orcarouter-lite`, not the
  working checkout: Claude Code keys its project memory on the main repository,
  and the recording account's memory there says "reply in Chinese". A clone has
  its own, empty, memory, so the English request gets an English review.
- `review.tape` unsets the `CLAUDE*` environment variables first so Claude Code
  does not refuse to start as a nested session when the tape is run from inside
  another Claude Code.
- The install tape expects the old skill names (`run-orca-code-review`,
  `setup-orca-code-review`) to be present in the target repo so the
  "(replaced the old …)" lines appear. Without them the run still works; those
  lines are simply absent.
