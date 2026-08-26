// Tests for the `npx @orcarouter/code-review` workflow renderer.
//
// The renderer decides what a consumer's CI actually does, so the two
// properties worth pinning are: (1) it only writes inputs that differ from
// their documented default — a file that echoes defaults implies control it
// does not have when the dashboard is authoritative; and (2) what it writes is
// readable back by `reconfigure`, so the round trip cannot silently drift.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULTS,
  renderWorkflow,
  parseOverrides,
} from "../bin/orcacode-review.mjs";

const CLI = fileURLToPath(new URL("../bin/orcacode-review.mjs", import.meta.url));

// --------------------------------------------------------------- entry point ---

test("the CLI runs when executed through a symlink", () => {
  // npm installs a `bin` as a SYMLINK at node_modules/.bin/<name>, so argv[1]
  // is the link and import.meta.url is its target. An entry-point guard that
  // compares them without realpath is false for every npx and every global
  // install: the process exits 0 having printed nothing. Shipped as 1.0.0 and
  // only caught by installing the published tarball, because running
  // `node bin/orcacode-review.mjs` directly never takes that path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-bin-"));
  const link = path.join(dir, "orcacode-review");
  try {
    fs.symlinkSync(CLI, link);
  } catch (e) {
    if (e.code === "EPERM" || e.code === "ENOSYS") return; // unprivileged Windows
    throw e;
  }

  const r = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/, "no version printed — the guard rejected the symlink");
});

test("the CLI runs when executed by its real path", () => {
  const r = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("importing the CLI runs nothing", () => {
  // The guard's other half: a bare import must not start the interactive flow.
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import(${JSON.stringify(CLI)}).then(m => console.log(Object.keys(m).sort().join(",")))`],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "DEFAULTS,parseOverrides,readOverrides,renderWorkflow");
});

test("the published version matches package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const r = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), pkg.version);
});

const withBlock = (yaml) =>
  yaml.slice(yaml.indexOf("        with:")).split("\n").slice(1).filter((l) => l.trim());

test("all-default config writes only the api key", () => {
  const yaml = renderWorkflow({ ...DEFAULTS });
  const lines = withBlock(yaml);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /orcarouter-api-key: \$\{\{ secrets\.ORCAROUTER_API_KEY \}\}/);
});

test("non-default inputs are written, defaults are not", () => {
  const yaml = renderWorkflow({
    settings: "false",
    "block-on": "P0",
    "on-oversized-diff": "fail", // default — must be omitted
    "auto-review-authors": "OWNER,MEMBER",
  });
  assert.match(yaml, /^\s+settings: "false"/m);
  assert.match(yaml, /^\s+block-on: "P0"/m);
  assert.match(yaml, /^\s+auto-review-authors: "OWNER,MEMBER"/m);
  assert.doesNotMatch(yaml, /^\s+on-oversized-diff:/m);
});

test('block-on "" (never block) is written, not dropped as falsy', () => {
  // An explicit empty string is a deliberate "none", not an absent value. If it
  // were dropped, a user who chose comment-only mode would silently get the
  // P0,P1 default and their merges would start failing.
  const yaml = renderWorkflow({ ...DEFAULTS, "block-on": "" });
  assert.match(yaml, /^\s+block-on: ""/m);
});

test("undefined inputs are skipped", () => {
  const yaml = renderWorkflow({ ...DEFAULTS, "auto-review-authors": undefined });
  assert.doesNotMatch(yaml, /auto-review-authors/);
});

test("the generated workflow keeps the security-critical scaffolding", () => {
  const yaml = renderWorkflow({ ...DEFAULTS });
  // pull_request_target is what lets a fork PR be reviewed at all.
  assert.match(yaml, /pull_request_target:/);
  // The author-association gate is what stops a drive-by commenter from
  // spending paid quota with /orcacode-review.
  assert.match(yaml, /\["OWNER", "MEMBER", "COLLABORATOR"\]/);
  // All four command spellings the GitHub App accepts.
  for (const cmd of ["/orcacode-review", "/orcacode review", "@orcacode-review", "@orcacode review"]) {
    assert.ok(yaml.includes(`'${cmd}'`), `missing command spelling: ${cmd}`);
  }
  assert.match(yaml, /pull-requests: write/);
  assert.match(yaml, /issues: write/);
});

test("render -> parse round-trips every input", () => {
  const cfg = {
    settings: "false",
    "block-on": "",
    "on-oversized-diff": "pass",
    "auto-review-authors": "OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR",
  };
  assert.deepEqual(parseOverrides(renderWorkflow(cfg)), cfg);
});

test("parsing a defaults-only workflow reports the defaults", () => {
  assert.deepEqual(parseOverrides(renderWorkflow({ ...DEFAULTS })), { ...DEFAULTS });
});

test("commented-out example inputs are not read as overrides", () => {
  // The shipped template documents optional inputs as comments. Treating one as
  // a real value would make `reconfigure` show a change the file never had.
  const text = [
    "        with:",
    "          orcarouter-api-key: ${{ secrets.ORCAROUTER_API_KEY }}",
    '          # settings: "false"',
    '          # block-on: "P0"',
  ].join("\n");
  assert.deepEqual(parseOverrides(text), { ...DEFAULTS });
});

test("a trailing comment on a real input does not leak into the value", () => {
  const text = '          block-on: "P0"  # severities that fail the check\n';
  assert.equal(parseOverrides(text)["block-on"], "P0");
});

// ------------------------------------------------------------ package identity ---

const PKG = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("a scoped package declares public access", () => {
  // Scoped packages default to RESTRICTED. Without publishConfig, a hand-run
  // publish that forgets `--access public` ships it private, and the install
  // command in the README 404s for everyone outside the org.
  if (!PKG.name.startsWith("@")) return;
  assert.equal(PKG.publishConfig?.access, "public");
});

test("the installed command is short even though the package name is scoped", () => {
  // `npm i -g` creates a command named by the bin KEY, not the package name.
  assert.deepEqual(Object.keys(PKG.bin), ["orcacode-review"]);
});

test("every npx invocation in the strings names the real package", () => {
  // The failure this catches: renaming the package and leaving `npx <old-name>`
  // in a hint, so the tool confidently tells people to run something that does
  // not exist. Moving to the org scope touched thirteen such strings across
  // two languages, and nothing but a grep would have caught a miss.
  const i18n = fs.readFileSync(new URL("../bin/i18n.mjs", import.meta.url), "utf8");
  const named = [...i18n.matchAll(/npx ([@\w./-]+)/g)].map((m) => m[1].replace(/@latest$/, ""));
  assert.ok(named.length > 0, "no npx invocations found — did the hints move?");
  for (const name of new Set(named)) {
    assert.equal(name, PKG.name, `stale package name in a hint: npx ${name}`);
  }
});

test("every npx invocation in the README names the real package", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const named = [...readme.matchAll(/npx ([@\w./-]+)/g)].map((m) => m[1].replace(/@latest$/, ""));
  assert.ok(named.length > 0);
  for (const name of new Set(named)) {
    assert.equal(name, PKG.name, `stale package name in README: npx ${name}`);
  }
});

// ------------------------------------------------------- skill safety rules ---

const SKILL = fs.readFileSync(
  new URL("../skills/setup-orca-code-review/SKILL.md", import.meta.url),
  "utf8",
);

test("the skill tells the agent to hand the API key to gh, not handle it", () => {
  // The one instruction that must never be softened. An agent that reads the
  // key to be helpful puts it in the transcript, permanently.
  assert.match(SKILL, /gh secret set ORCAROUTER_API_KEY/);
  assert.match(SKILL, /[Nn]ever.{0,80}paste the key into the chat/s);
  assert.match(SKILL, /\bps\b/, "the argv/ps rationale is missing — rules without reasons get edited away");
});

test("the skill closes by listing the key as an outstanding user action", () => {
  const report = SKILL.slice(SKILL.indexOf("### 8."), SKILL.indexOf("## Reconfigure"));
  assert.match(report, /gh secret set ORCAROUTER_API_KEY/, "the final step does not repeat the gh command");
  assert.match(report, /copy-pasteable/i);
});

test("the skill refuses to call an install complete without the secret", () => {
  assert.match(SKILL, /[Dd]o not report the\s+install as complete while the secret is missing/s);
});

// ------------------------------------------------------------ install modes ---

test("the skill offers both install modes and routes between them", () => {
  assert.match(SKILL, /## Install — GitHub App mode/);
  assert.match(SKILL, /GitHub Action \(recommended\)/);
  assert.match(SKILL, /https:\/\/github\.com\/apps\/orcacode-review\/installations\/new/);
});

test("App mode warns about the permission before offering the choice", () => {
  // Walking a plain org member to an approval page they will be stopped at is
  // the whole failure this ordering exists to avoid.
  const pick = SKILL.slice(SKILL.indexOf("### 0. Pick the mode"), SKILL.indexOf("### 1. Preflight"));
  assert.match(pick, /permissions\.admin/, "no repo-permission probe");
  assert.match(pick, /memberships/, "no org-role probe");
  assert.match(pick, /organization owner/i);
  assert.ok(
    pick.indexOf("admin: false") < pick.indexOf("Chose App mode?"),
    "the cannot-approve warning must come before the routing line",
  );
});

test("App mode never claims the install can be automated", () => {
  const app = SKILL.slice(SKILL.indexOf("## Install — GitHub App mode"), SKILL.indexOf("## Do not install both"));
  assert.match(app, /no REST endpoint that installs an\s+App/s);
  // Printing the URL matters more than opening it: SSH, containers and CI have
  // no browser, and a silent `open` leaves the user waiting on nothing.
  assert.match(app, /never open it without printing it/i);
  // The repo secret belongs to Action mode only.
  assert.match(app, /No `ORCAROUTER_API_KEY` secret is needed/);
});

test("the double-install conflict is documented in both places", () => {
  assert.match(SKILL, /## Do not install both/);
  const trouble = fs.readFileSync(
    new URL("../skills/setup-orca-code-review/references/troubleshooting.md", import.meta.url),
    "utf8",
  );
  assert.match(trouble, /two sets of comments/i);
});

// ------------------------------------------- the two workflow copies agree ---

// `workflows/orca-code-review.yml` (the repo's example) and the skill's
// `assets/workflow.yml` (the one written into a user's repo) are the same file
// with different prose. When #28 retired the review cascade it updated the
// example and missed the skill's copy, so every new install kept getting a
// `permissions:` comment describing a tier label that no longer exists.
//
// Comments drift silently. The machine-readable parts must not.

const readYaml = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const EXAMPLE = readYaml("../workflows/orca-code-review.yml");
const TEMPLATE = readYaml("../skills/setup-orca-code-review/assets/workflow.yml");

// Strips comments and blank lines, leaving only what GitHub actually reads.
const effective = (yaml) =>
  yaml
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trimEnd())
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .join("\n");

const section = (yaml, key) => {
  const lines = effective(yaml).split("\n");
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
};

for (const key of ["permissions", "on", "concurrency"]) {
  test(`the example workflow and the skill template agree on \`${key}:\``, () => {
    const a = section(EXAMPLE, key);
    const b = section(TEMPLATE, key);
    assert.ok(a, `example has no ${key}: block`);
    assert.equal(b, a, `the skill template's ${key}: block has drifted from the example`);
  });
}

test("neither workflow copy mentions a tier label that no longer exists", () => {
  // There is no add/remove-label step in action.yml. `issues: write` is still
  // required — for PR comments and the /orcacode-review reaction — so the
  // permission stays and only its justification was wrong.
  for (const [name, yaml] of [["example", EXAMPLE], ["skill template", TEMPLATE]]) {
    assert.doesNotMatch(yaml, /tier state label|tier label/, `${name} still documents the tier label`);
    assert.match(yaml, /issues: write/, `${name} dropped issues: write, which is still needed`);
  }
});

test("the action no longer claims its token manages a tier label", () => {
  const action = fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  assert.doesNotMatch(action, /manage the tier label/);
});
