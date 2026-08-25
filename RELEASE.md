# Releasing

## The `@v1` tag must track the endpoints it depends on

The setup-generated workflow and the README quickstart pin
`uses: Continuum-AI-Corp/orca-code-review@v1`. The `settings`, `report`,
`on-oversized-diff`, `auto-review-authors`, and diff-guard features depend on
gateway control-plane endpoints (`/api/code_review/settings`,
`/api/code_review/report`) **and** on the `scripts/settings.mjs` /
`scripts/report.mjs` this action ships.

**Release order matters.** If `@v1` points at a commit that predates these
scripts, a user who follows the quickstart gets working reviews but a
silently inert Settings tab (settings never fetched) and empty Analytics
(runs never reported) — no error, just two dead console tabs.

When cutting a release from a merged feature branch:

1. Merge the feature branch to `main` (the branch that includes
   `scripts/settings.mjs`, `scripts/report.mjs`, and the current
   `action.yml`).
2. Deploy the gateway (OrcaRouter-O2) so the control-plane endpoints are live.
3. Tag the merged commit and **move the floating `v1` tag to it**:
   ```
   git tag -f v1.<n> <merged-sha>     # immutable release
   git tag -f v1     <merged-sha>     # floating major that the workflow pins
   git push --force origin v1 v1.<n>
   ```
4. Verify: `git ls-tree v1 scripts/` lists `settings.mjs` and `report.mjs`,
   and `git show v1:action.yml` contains the "Fetch review settings" and
   "Report run" steps.

Until the tag is moved, do not advertise the new inputs under `@v1`. For
pre-release dogfooding, pin an immutable commit SHA (as OrcaRouter-O2's own
`.github/workflows/orca-code-review.yml` does) rather than `@v1`.

## Marketplace

Publish/refresh the GitHub Marketplace listing from the same merged commit as
a verified publisher; the listing's default install snippet must match the
README quickstart (including `@v1` once moved).

## Installers

Two one-command installers ship from this repo, and both generate a workflow
that pins `@v1`. **Release them only after the `v1` tag has been moved** — an
installer that writes `@v1` against a stale tag hands every new user the dead
Settings/Analytics tabs described above, on their very first run.

### npm — `npx @orcarouter/code-review`

Package name is **`@orcarouter/code-review`**, under the `orcarouter`
organization scope. The **bin** it installs is still `orcacode-review` (one
word, matching the product name and the `/orcacode-review` PR command), so a
global install gives a short command while the package name carries the org:

```
npx @orcarouter/code-review          # the package name
orcacode-review --version            # the command, after `npm i -g`
```

The repo and the action stay `orca-code-review`.

`publishConfig.access` is `public` in `package.json`. Scoped packages default to
**restricted**, so without it a hand-run `npm publish` that forgets
`--access public` ships it private and the documented install command 404s for
everyone outside the org.

#### The unscoped `orcacode-review` name is retired

1.0.0 and 1.0.1 were published unscoped under a personal account, before the
move to the org. Neither is maintained, and 1.0.0 additionally does not run at
all (see gate 5). Leave both on the registry — unpublishing burns those version
numbers permanently — but mark the name dead:

```
npm deprecate orcacode-review "Moved to @orcarouter/code-review"
```

Never publish to the old name again.

**Publishing is automatic.** To cut a release, bump `version` in `package.json`
(and the two `.claude-plugin` files — see below) and merge to `main`. That is
the whole procedure; do not run `npm publish` by hand.

`.github/workflows/publish.yml` runs on every push to `main` and asks the
registry whether that exact version exists. If it does, the job no-ops green.
If it does not, it publishes. The check is deliberately *not* a diff of
`package.json` against the previous commit: a squash merge, a force push, or a
revert each make "the previous commit" the wrong thing to compare against, and
that failure is silent in both directions — a missed release, or a publish that
dies on E409.

Five gates run before the point of no return, and each one fails the job:

1. `package.json`, `.claude-plugin/plugin.json`, and
   `.claude-plugin/marketplace.json` all carry the same version.
2. The `v1` tag exists and ships `scripts/settings.mjs` + `scripts/report.mjs`,
   because the installer generates a workflow pinned to `@v1`.
3. The full test suite passes.
4. The tarball actually contains `bin/` and the skill — a tarball missing them
   publishes cleanly and only fails on the user's first `npx`.
5. The packed tarball is installed into a scratch project and run through npm's
   own `node_modules/.bin` shim, asserting it prints the expected version and
   that `skill list` produces the catalog.

Gate 5 exists because 1.0.0 shipped a CLI that did nothing. npm installs a `bin`
as a **symlink**, so `argv[1]` is the link while `import.meta.url` is its
target; the entry-point guard compared the two without `realpath` and was false
for every `npx` and every global install. The process exited 0 having printed
nothing, and gates 1–4 all passed. Running `node bin/orcacode-review.mjs` never
takes that path, so nothing short of a real install can catch that class of bug.
`scripts/installer.test.mjs` now also execs the CLI through a symlink.

npm's unpublish window is 72 hours and a withdrawn version number can never be
reused, so anything checkable before publishing is checked there rather than
discovered afterward.

Auth is the `NPM_TOKEN` repository secret. Use a **granular access token scoped
to this one package**, not a classic automation token — a leaked classic token
can publish anything in the account. Rotate with `gh secret set NPM_TOKEN`.

The workflow creates **no git tags**. The npm version and the action's `v1.x`
tags are separate version lines (the action is on v1.4.x while the CLI starts at
1.0.0); tagging `v1.0.0` from a publish would collide with the action's series
and could move consumers' `uses: ...@v1` onto the wrong commit. Action tags stay
manual, per the section above.

Smoke-test after a release:

```
npx @orcarouter/code-review@latest skill list
```

`files` in `package.json` ships only `bin/` and `skills/` — the action itself is
consumed from GitHub, never from npm. The CLI has **no dependencies**; keep it
that way, since `npx` downloads the whole tree before running anything.

#### The platform catalog is shared with orcadub

`bin/platforms.mjs` is a port of `internal/skill_installer.go` in
[orcadub-mcp-server](https://github.com/Continuum-AI-Corp/orcadub-mcp-server).
The IDs, display names, roots, and detection rules must stay identical — a user
who runs both installers should not have to learn two names for the same
editor, and `--platform codex` must mean the same directory in both.

When either side adds a platform, add it to the other and bump the count in
three places: `scripts/platforms.test.mjs` (the count assertion is the tripwire),
the README platform list, and the orcadub README.

#### Adding a user-facing string

`bin/i18n.mjs` holds both languages. `scripts/i18n.test.mjs` fails the build if
the two tables diverge — a missing Chinese key, a key only Chinese has, or a
parameterized string whose two versions take different argument counts (which
would silently drop a branch name or a count from the Chinese output).

Translate prose only. Flags, platform IDs, workflow inputs, severity codes,
paths, and shell commands stay verbatim in both languages: a reader of the
Chinese output still has to type `--platform codex` and grep for `block-on`.
A test asserts that the literals present in the English table survive into the
Chinese one.

Detection rules carry the load here, and getting one wrong is silent. Two
standing rules, both already encoded as tests:

- Never detect on a root that most repos have anyway (`.github`, `.`) — it
  preselects a platform for everyone.
- Never detect on an executable whose name collides with a stock system binary
  (Command Code's `cmd` on Windows).

### Claude Code plugin

`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` make this repo
its own plugin marketplace:

```
/plugin marketplace add Continuum-AI-Corp/orca-code-review
/plugin install orca-code-review
```

The plugin is served from the repo's **default branch**, not from a tag — a
change to `skills/` reaches users as soon as it lands on `main`, with no release
step. Treat `skills/setup-orca-code-review/` as shipped surface on merge.

Three versions have to move together on a feature release: `package.json`,
`.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`
(`metadata.version`). Nothing enforces this — a mismatch shows up as a plugin
that reports the wrong version in `/plugin`.
