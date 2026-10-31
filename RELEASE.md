# Releasing

## Release tags are never moved

Whatever commit a tag points at runs, with the customer's OrcaRouter key, in
every repository that references the tag. A tag that can be re-pointed — with
`git tag -f` and a force push — is therefore a way to run new code in every
customer's CI without a single customer-side change. So:

- **A release is a new tag on a merged commit of `main`: `v1.<minor>.<patch>`.**
  It is created once and never moved, re-created or deleted. A bad release is
  fixed by the next one, never by re-pointing the old tag.
- **What we hand out pins the commit, not a tag.** The installer
  (`ACTION_SHA` / `ACTION_VERSION` in `bin/orcacode-review.mjs`), the example
  workflow (`workflows/orca-code-review.yml`), the skill's asset
  (`skills/orca-review-action/assets/workflow.yml`) and the README quickstart
  all read `uses: Continuum-AI-Corp/orca-code-review@<full sha> # v1.<n>.<p>`.
  `scripts/release-pin.test.mjs` holds all four to the installer's constants,
  so a release that bumps one bumps all of them. Customers' Dependabot
  (`package-ecosystem: github-actions`) reads the `# v1.x.y` comment and offers
  each new release as a pull request that changes the SHA and the comment
  together.
- **The `v1` major tag is legacy.** Workflows written before commit pinning
  reference `@v1`, and only for them is it still advanced: only ever to a
  descendant of its current commit that already carries an immutable
  `v1.<n>.<p>` release tag, by an administrator through the ruleset bypass
  below. It is the one tag update left that needs force, and it exists only so
  those workflows still receive fixes. Nothing this repository generates or
  documents references `@v1` any more; tell anyone still on it to pin a SHA.

### Cutting a release

1. Merge to `main`. The gateway control-plane endpoints the action calls
   (`/api/code_review/settings`, `/api/code_review/report`) must already be live
   for the version you are releasing — deploy OrcaRouter-O2 first.
2. Create the release tag on the merged commit and push **only that new tag**:
   ```
   git tag -a v1.<n>.<p> -m "v1.<n>.<p>" <merged-sha>
   git push origin refs/tags/v1.<n>.<p>
   ```
   Publish a GitHub Release for it; with immutable releases enabled (below) the
   tag and its assets are locked from then on.
3. In a follow-up PR, bump `ACTION_SHA` and `ACTION_VERSION` in
   `bin/orcacode-review.mjs` to that commit and tag, and the same `uses:` line in
   `workflows/orca-code-review.yml`, `skills/orca-review-action/assets/workflow.yml`
   and the README quickstart. The test suite fails until all four agree. Bump
   `package.json` in the same PR when the installer should ship it (see
   Installers below).
4. Only if legacy `@v1` users should get this release: an administrator advances
   `v1` to the same commit (a descendant of its current one, through the ruleset
   bypass).
5. Verify: `git ls-tree <sha> scripts/` lists `settings.mjs` and `report.mjs`, and
   `git show <sha>:action.yml` contains the "Fetch review settings" and
   "Report run" steps.

### Repository settings (administrator, one-time)

These are settings, not code, so no commit can turn them on. Until an
administrator does, the rules above are a convention only:

- **Tag ruleset** (Settings → Rules → Rulesets → New tag ruleset), targeting
  `v*`: restrict updates, restrict deletions, block force pushes; no bypass for
  `v*.*.*`, and an administrator-only bypass on `v1` for the legacy fast-forward
  in step 4.
- **Immutable releases** (Settings → General → Releases → "Enable release
  immutability"), so a published release's tag and assets cannot be changed.
- **Dependabot** for this repository's own pinned actions is configured in
  `.github/dependabot.yml`.

## Marketplace

Publish/refresh the GitHub Marketplace listing from a release tag's commit as a
verified publisher; the listing's install snippet must match the README
quickstart, pinned SHA included.

## Installers

Two one-command installers ship from this repo, and both generate a workflow
pinned to `ACTION_SHA`. **Release them only after that commit carries a release
tag** — the publish workflow refuses otherwise, and checks that the pinned
commit ships `scripts/settings.mjs` and `scripts/report.mjs` (an older commit
would hand every new user dead Settings/Analytics tabs on their first run).

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

#### The `1.x` line is retired; `2.0.0` is the supported floor

1.0.2 through 1.5.0 were published on 25–26 Aug 2026 and are all **deprecated**:
still installable, and every install of one prints

```
npm warn deprecated @orcarouter/code-review@1.x.y: No longer supported —
install @orcarouter/code-review@latest
```

Deprecated rather than unpublished, and not by preference — see "Unpublishing
cannot be automated" below. Two things left with that line:

- **App mode.** Up to 1.4.0 the skill offered a GitHub App install as an
  alternative to the Action. Installing an App is a permission grant only a
  human can approve on a web page, so the agent could only hand over a link and
  wait; 1.5.0 dropped it. 2.0.0 is the first version published without it, and
  the major is where that break belongs.
- **The self-dependency.** 1.1.0 through 1.5.0 declared
  `@orcarouter/code-review: ^1.0.2` as a dependency *of itself*, so every `npx`
  fetched a second, older copy of the CLI before running the one it was asked
  for. Removed in 2.0.0 and pinned by a test — see "the CLI ships with no
  dependencies" in `scripts/installer.test.mjs`.

Deprecation is the right instrument for this anyway. It reaches exactly the
people who need telling — anyone who installs one — without breaking anyone
pinned, which an unpublish does with an E404 and no explanation. Run it with the
**Deprecate** workflow (`workflow_dispatch`: versions, plus a message; an empty
message clears the flag).

#### The unscoped `orcacode-review` name is retired

1.0.0 and 1.0.1 were published unscoped under a personal account, before the
move to the org. Neither is maintained, and 1.0.0 additionally does not run at
all (see gate 5). Leave both on the registry — unpublishing burns those version
numbers permanently — but mark the name dead:

```
npm deprecate orcacode-review "Moved to @orcarouter/code-review"
```

**Still outstanding** as of 2.0.0 — both versions are live and unmarked. The
**Deprecate** workflow cannot do it: `NPM_TOKEN` is scoped to
`@orcarouter/code-review` alone, which is the property that makes a leak
survivable. This one runs from the personal account that owns the name.

Never publish to the old name again, and do not unpublish these two: emptying
the package frees `orcacode-review` for anyone to claim 24 hours later, and the
docs used to tell people to `npx` it. A dead name we still hold beats a live one
someone else fills.

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
2. The commit the installer pins (`ACTION_SHA`) exists, is tagged
   `ACTION_VERSION`, and ships `scripts/settings.mjs` + `scripts/report.mjs`.
3. The full test suite passes.
4. The tarball actually contains `bin/` and the skill — a tarball missing them
   publishes cleanly and only fails on the user's first `npx`.
5. The packed tarball is installed into a scratch project and run through npm's
   own `node_modules/.bin` shim, asserting it prints the expected version and
   that `skill list` produces the catalog.

And one gate *after* publishing, because that is the only place it can be
checked:

6. The new version must appear in the **public packument**, fetched
   anonymously and retried for five minutes. `npm publish` exiting 0 does not
   mean anyone can install what it shipped.

   It polls `registry.npmjs.org/<name>` — the document `npm install` actually
   reads to pick a version — rather than the `/<name>/<version>` route. That
   distinction is not cosmetic: the per-version route stayed 404 for over three
   minutes after two correct publishes and failed both builds. Checking a
   document nobody installs from was the bug; the timeout was a symptom.

   Anonymous on purpose — an authenticated read succeeds against a restricted
   package and proves nothing. A restricted package and an unpropagated one
   look alike, so a red gate 6 still means *check the URL by hand* before
   concluding the package is private.

Gate 6 exists because `@orcarouter/code-review@1.0.2` published green and was
unreachable. Scoped packages default to **restricted**, and it landed that way
despite both `--access public` and `publishConfig.access` — the log read
`+ @orcarouter/code-review@1.0.2` while the registry 404'd and the package page
403'd for everyone outside the org. The job now runs `npm access set
status=public` (idempotent, soft-fail) and then proves the result with an
unauthenticated fetch. The fetch is what decides: an authenticated read would
succeed against a private package and prove nothing.

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

**Unpublishing cannot be automated, and the `NPM_TOKEN` secret cannot do it.**
Tried, on the 1.x withdrawal: every version came back

```
npm error code E403
Granular access tokens that bypass two-factor authentication may not
perform this action.
```

CI can publish and cannot withdraw, by registry policy rather than by
configuration — so no token, scope, or workflow fixes it, and a workflow that
offers the button is a guard rail around something that never runs. Withdrawing
a version takes an interactive `npm login` (web or OTP) from a maintainer's own
machine, inside the 72 hours. Plan on that when a release needs pulling: the
person, not the pipeline.

Auth is the `NPM_TOKEN` repository secret. Use a **granular access token scoped
to this one package**, not a classic automation token — a leaked classic token
can publish anything in the account. Rotate with `gh secret set NPM_TOKEN`.

The workflow creates **no git tags**. The npm version and the action's `v1.x`
tags are separate version lines (the action is on v1.6.x while the CLI is on
2.x); tagging from a publish would collide with the action's series. Action
tags stay manual and immutable, per the section above.

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

`bin/i18n.mjs` holds every language. `scripts/i18n.test.mjs` checks each
translation against English and fails the build on a missing key, a
translation-only key, or a parameterized string whose versions take different
argument counts (which would silently drop a branch name or a count).

Adding a language is three edits: append the code to `LANGUAGES`, add its
locale prefixes to `LOCALE_PREFIX`, add the table. The language picker is
generated from `LANGUAGES`, and a `lang.<code>` label is required in *every*
table so each language can name the others — a test enforces that. Nothing else
needs touching.

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
step. Treat `skills/orca-review-action/` as shipped surface on merge.

Three versions have to move together on a feature release: `package.json`,
`.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`
(`metadata.version`). Nothing enforces this — a mismatch shows up as a plugin
that reports the wrong version in `/plugin`.
