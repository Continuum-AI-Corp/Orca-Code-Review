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

### npm — `npx orcacode-review`

Package name is `orcacode-review` (one word, matching the product name and the
`/orcacode-review` PR command); the repo and action stay `orca-code-review`.

```
npm publish --access public          # from the merged commit, after `npm test`
npx orcacode-review@latest doctor    # smoke-test the published tarball
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
