// .orcacode-review.json — the local review's one settings file.
//
// The contract worth guarding is that the file can never be HALF-read: every
// malformed shape is refused by name, and a valid file changes exactly what it
// says and nothing else.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CONFIG_FILE, CONFIG_KEYS, loadLocalConfig, configTemplate } from "../bin/localconfig.mjs";
import { buildPlan, renderPlan } from "../bin/harness.mjs";

const CLI = fileURLToPath(new URL("../bin/orcacode-review.mjs", import.meta.url));

function scratch(t, config) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ocr-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, CONFIG_FILE), typeof config === "string" ? config : JSON.stringify(config));
  }
  return dir;
}

function repo(t, config) {
  const dir = scratch(t, config);
  const run = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  // A base commit, so `main~1..HEAD` is a real range in every test below.
  run("commit", "-q", "--allow-empty", "-m", "init");
  return { dir, run };
}

// ---------------------------------------------------------------- loading ---

test("no file means defaults, not an error", (t) => {
  const r = loadLocalConfig(scratch(t));
  assert.deepEqual(r, { ok: true, file: null, config: {} });
});

test("a valid file is normalised: block_on to a string, rules with their text read in", (t) => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs/api.md"), "Check tenant scoping.\n");
  fs.writeFileSync(
    path.join(dir, CONFIG_FILE),
    JSON.stringify({
      $comment: "ignored",
      block_on: ["p0"],
      language: "zh",
      exclude: [" docs/** "],
      rules: [
        { path: "src/api/**/*.ts", rule_file: "docs/api.md" },
        { path: "**/*.sql", rule: "Reversible?", replace: true },
      ],
    }),
  );
  const r = loadLocalConfig(dir);
  assert.equal(r.ok, true);
  assert.equal(r.file, CONFIG_FILE);
  assert.equal(r.config.block_on, "P0");
  assert.equal(r.config.language, "zh");
  assert.deepEqual(r.config.exclude, ["docs/**"]);
  assert.deepEqual(r.config.rules, [
    { path: "src/api/**/*.ts", text: "Check tenant scoping.", replace: false, source: "docs/api.md" },
    { path: "**/*.sql", text: "Reversible?", replace: true, source: "inline" },
  ]);
});

test('block_on "" is a valid "never block", and is kept distinct from absent', (t) => {
  assert.equal(loadLocalConfig(scratch(t, { block_on: "" })).config.block_on, "");
  assert.equal("block_on" in loadLocalConfig(scratch(t, {})).config, false);
});

// Each of these would, if tolerated, make the file lie about what the review
// does. So each is refused, and the message names the key.
for (const [label, body, expect] of [
  ["not JSON", "{ block_on: P0 }", /not valid JSON/],
  ["an array", "[]", /must be a JSON object/],
  ["a typo'd key", { blockOn: "P0" }, /unknown key "blockOn" — allowed: block_on, language, exclude, rules/],
  ["a bad severity", { block_on: "P0,P9" }, /"block_on" has "P9"/],
  ["block_on as a number", { block_on: 1 }, /"block_on" must be a string/],
  ["an unknown language", { language: "de" }, /"language" must be one of en, zh, ja, ko/],
  ["exclude as a string", { exclude: "docs/**" }, /"exclude" must be an array/],
  ["an empty exclude glob", { exclude: [""] }, /"exclude" must be an array/],
  ["rules as an object", { rules: {} }, /"rules" must be an array/],
  ["a rule without a path", { rules: [{ rule: "x" }] }, /"rules"\[0\] needs a "path"/],
  ["a rule with neither text nor file", { rules: [{ path: "*.ts" }] }, /exactly one of "rule"/],
  ["a rule with both text and file", { rules: [{ path: "*.ts", rule: "x", rule_file: "y" }] }, /exactly one of "rule"/],
  ["a rule with a stray key", { rules: [{ path: "*.ts", rule: "x", when: "always" }] }, /"rules"\[0\] has unknown key "when"/],
  ["a non-boolean replace", { rules: [{ path: "*.ts", rule: "x", replace: "yes" }] }, /"replace" must be true or false/],
  ["an empty rule", { rules: [{ path: "*.ts", rule: "   " }] }, /rule text is empty/],
  ["a missing rule_file", { rules: [{ path: "*.ts", rule_file: "nope.md" }] }, /could not be read/],
  ["a rule_file outside the repo", { rules: [{ path: "*.ts", rule_file: "../../etc/hostname" }] }, /must stay inside the repository/],
]) {
  test(`refuses ${label}, naming the problem`, (t) => {
    const r = loadLocalConfig(scratch(t, body));
    assert.equal(r.ok, false);
    assert.equal(r.file, CONFIG_FILE);
    assert.match(r.error, expect);
  });
}

test("the template is valid, carries the caller's language, and round-trips", (t) => {
  const text = configTemplate({ language: "ja", comment: "note" });
  const dir = scratch(t, text);
  const r = loadLocalConfig(dir);
  assert.equal(r.ok, true);
  assert.equal(r.config.language, "ja");
  assert.equal(r.config.block_on, "P0,P1");
  assert.deepEqual(Object.keys(JSON.parse(text)), ["$comment", ...CONFIG_KEYS]);
});

// ----------------------------------------------------------------- effect ---

test("exclude and rules from the file reach the plan, with the reason and the merged checklist", (t) => {
  const { dir, run } = repo(t);
  fs.mkdirSync(path.join(dir, "docs"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "docs/x.ts"), "1\n");
  fs.writeFileSync(path.join(dir, "src/a.ts"), "1\n");
  fs.writeFileSync(path.join(dir, "src/b.sql"), "select 1;\n");
  fs.writeFileSync(
    path.join(dir, CONFIG_FILE),
    JSON.stringify({
      exclude: ["docs/**"],
      rules: [
        { path: "src/**/*.ts", rule: "PROJECT-TS-RULE" },
        { path: "**/*.sql", rule: "PROJECT-SQL-RULE", replace: true },
      ],
    }),
  );
  run("add", "-A");
  run("commit", "-q", "-m", "x");
  const plan = buildPlan({ from: "main~1", to: "HEAD" }, dir);

  assert.deepEqual(plan.excluded.map((f) => [f.path, f.code]), [["docs/x.ts", "project_exclude"]]);
  assert.equal(plan.config.file, CONFIG_FILE);

  const ts = plan.rule_groups.find((g) => g.files.includes("src/a.ts"));
  assert.equal(ts.source, "project");
  assert.equal(ts.pattern, "src/**/*.ts");
  assert.match(ts.rule, /^PROJECT-TS-RULE\n\n/, "project text first");
  assert.match(ts.rule, /Dead Code/, "the bundled TS checklist is kept underneath");

  const sql = plan.rule_groups.find((g) => g.files.includes("src/b.sql"));
  assert.equal(sql.rule, "PROJECT-SQL-RULE", "replace drops the bundled checklist");

  assert.match(renderPlan(plan), /project settings: `\.orcacode-review\.json` \(1 extra exclude\) \(2 project rules\)/);
});

test("without a file, plan.config is null and the plan carries the first-run offer", (t) => {
  const { dir, run } = repo(t);
  fs.writeFileSync(path.join(dir, "a.ts"), "1\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");
  const plan = buildPlan({ from: "main~1", to: "HEAD", language: "zh" }, dir);
  assert.equal(plan.config, null);
  const text = renderPlan(plan);
  assert.ok(!/project settings/.test(text));
  // The onboarding is in the plan — the one document the agent reads every
  // time — and it is explicit about when and how often.
  assert.match(text, /## First review in this repository/);
  assert.match(text, /After you have shown the report — not before — offer ONCE/);
  assert.match(text, /review config init --lang zh/);
  assert.match(text, /Do not create the file unasked/);
  assert.match(text, /findings in 简体中文/, "it names the language this run used, so 'save these' is concrete");
});

test("with a file, the first-run offer is gone", (t) => {
  const { dir, run } = repo(t, { block_on: "P0" });
  fs.writeFileSync(path.join(dir, "a.ts"), "1\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");
  const text = renderPlan(buildPlan({ from: "main~1", to: "HEAD" }, dir));
  assert.ok(!/First review in this repository/.test(text));
});

test("init pre-fills block_on from --block-on, so 'save what we used' is one command", (t) => {
  const { dir } = repo(t);
  const r = cli(dir, "review", "config", "init", "--lang", "zh", "--block-on", "p0");
  assert.equal(r.status, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), "utf8"));
  assert.equal(written.block_on, "P0");
  assert.equal(written.language, "zh");
  assert.equal(loadLocalConfig(dir).ok, true, "and what it wrote is valid by its own rules");
});

// -------------------------------------------------------------------- CLI ---

const cli = (dir, ...args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

test("plan and submit refuse an invalid file with exit 2 — never defaults", (t) => {
  const { dir, run } = repo(t, { block_on: "P7" });
  fs.writeFileSync(path.join(dir, "a.ts"), "1\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");
  const plan = cli(dir, "review", "plan", "--lang", "en", "--from", "main~1", "--to", "HEAD");
  assert.equal(plan.status, 2);
  assert.match(plan.stderr, /\.orcacode-review\.json is invalid: "block_on" has "P7"/);
  const submit = cli(dir, "review", "submit", "--lang", "en");
  assert.equal(submit.status, 2);
  assert.match(submit.stderr, /is invalid/);
});

test("block_on: flag beats file beats default, and the file's win is announced", (t) => {
  const { dir, run } = repo(t, { block_on: "P0" });
  fs.writeFileSync(path.join(dir, "x.js"), "export const f = (a) => a.b;\n");
  run("add", "-A");
  run("commit", "-q", "-m", "x");
  fs.mkdirSync(path.join(dir, ".orcacode-review"));
  fs.writeFileSync(
    path.join(dir, ".orcacode-review/result.json"),
    JSON.stringify({ comments: [{ path: "x.js", line: 1, existing_code: "export const f", content: "[P1] **T**\n\nb" }] }),
  );
  fs.writeFileSync(path.join(dir, ".orcacode-review/plan.json"), JSON.stringify({ ground_truth_ref: run("rev-parse", "HEAD").trim() }));

  const fromFile = cli(dir, "review", "submit", "--format", "json", "--lang", "en");
  assert.equal(JSON.parse(fromFile.stdout).blocked, false, "the file says P0 only, so a P1 does not block");
  assert.match(fromFile.stderr, /Blocking on P0 — from \.orcacode-review\.json/);

  const fromFlag = cli(dir, "review", "submit", "--format", "json", "--lang", "en", "--block-on", "P0,P1");
  assert.equal(JSON.parse(fromFlag.stdout).blocked, true, "the flag outranks the file");
  assert.ok(!/from \.orcacode-review\.json/.test(fromFlag.stderr), "and the file's setting is not announced when it lost");
});

test("language: the file outranks the locale and yields to --lang", (t) => {
  const { dir, run } = repo(t, { language: "zh" });
  fs.writeFileSync(path.join(dir, "a.ts"), "1\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");
  const env = { ...process.env, NO_COLOR: "1", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", ORCACODE_LANG: "" };
  const byFile = spawnSync(process.execPath, [CLI, "review", "plan", "--from", "main~1", "--to", "HEAD"], { cwd: dir, encoding: "utf8", env });
  assert.match(byFile.stdout, /in 简体中文/, "the plan asks for Chinese findings because the file said so");
  assert.match(byFile.stderr, /已读取/, "and the CLI speaks Chinese too");
  const byFlag = spawnSync(process.execPath, [CLI, "review", "plan", "--from", "main~1", "--to", "HEAD", "--lang", "ja"], { cwd: dir, encoding: "utf8", env });
  assert.match(byFlag.stdout, /in 日本語/);
});

test("review config shows each value and its source; init writes the template once", (t) => {
  const { dir } = repo(t);
  const none = cli(dir, "review", "config", "--lang", "en");
  assert.equal(none.status, 0);
  assert.match(none.stdout, /block_on\s+P0,P1\s+← the default/);
  assert.match(none.stdout, /language\s+en\s+← the command line/);
  assert.match(none.stdout, /review config init/, "tells the user how to create one");

  const init = cli(dir, "review", "config", "init", "--lang", "zh");
  assert.equal(init.status, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), "utf8"));
  assert.equal(written.language, "zh", "the template is pre-filled with the language the user was using");
  assert.match(written.$comment, /block_on/);

  const again = cli(dir, "review", "config", "init", "--lang", "en");
  assert.equal(again.status, 1, "refuses to overwrite");
  assert.match(again.stdout + again.stderr, /already exists; pass --force/);

  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ block_on: "P0", exclude: ["docs/**"] }));
  const show = cli(dir, "review", "config", "--lang", "en");
  assert.match(show.stdout, /block_on\s+P0\s+← \.orcacode-review\.json/);
  assert.match(show.stdout, /exclude\s+1 extra exclude\s+docs\/\*\*/);
  assert.match(show.stdout, /edit \.orcacode-review\.json directly/);

  const json = cli(dir, "review", "config", "--json", "--lang", "en");
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.block_on, { value: "P0", source: "file" });
  assert.deepEqual(parsed.exclude, ["docs/**"]);
});
