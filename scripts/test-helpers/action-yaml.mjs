// Test helper: read action.yml and the shipped workflows through a real YAML
// parser, and run the code they carry the way GitHub runs it.
//
// The older suites read action.yml as text and cut pieces out of it with
// regexes. That works until an indentation or a quoting style changes, and then
// it silently tests nothing. Anything new that asserts the SHAPE of a step — its
// `if:`, its `env:`, its trigger list — goes through this parser instead.
//
// Not a *.test.mjs file, so `node --test scripts/*.test.mjs` does not run it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
export const parseYamlFile = (rel) => YAML.parse(readText(rel));

export function loadAction() {
  return parseYamlFile("action.yml");
}

export function actionSteps() {
  return loadAction().runs.steps;
}

// A step by `id:` or, failing that, by its exact `name:`. Throws when absent so
// a renamed step turns a test red rather than hollow.
export function step(key) {
  const s = actionSteps().find((x) => x.id === key || x.name === key);
  if (!s) throw new Error(`action.yml has no step with id or name ${JSON.stringify(key)}`);
  return s;
}

// Every workflow file this repository ships for customers to copy, plus the one
// the installer renders. The installer's is rendered with its defaults.
export const SHIPPED_WORKFLOW_FILES = [
  "workflows/orca-code-review.yml",
  "skills/orca-review-action/assets/workflow.yml",
];

export async function shippedWorkflows() {
  const { renderWorkflow, DEFAULTS } = await import(path.join(ROOT, "bin", "orcacode-review.mjs"));
  return [
    ...SHIPPED_WORKFLOW_FILES.map((rel) => ({ name: rel, text: readText(rel), doc: parseYamlFile(rel) })),
    (() => {
      const text = renderWorkflow({ ...DEFAULTS });
      return { name: "bin/orcacode-review.mjs renderWorkflow()", text, doc: YAML.parse(text) };
    })(),
  ];
}

// Shell comment lines of a `run:` script (a line whose first non-blank
// character is `#`). Used to prove nothing GitHub expands lands in one.
export function shellCommentLines(script) {
  return String(script || "")
    .split("\n")
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => /^\s*#/.test(line));
}

// The environment a step under test starts from: this process's, minus every
// variable the RUNNER owns. On a CI runner the test job's own GITHUB_OUTPUT,
// GITHUB_ENV, GITHUB_PATH, GITHUB_STEP_SUMMARY, RUNNER_TEMP and
// GITHUB_EVENT_NAME are set; a step started from `...process.env` would write
// its outputs into the TEST job's files and read the test workflow's event.
// A test passes the ones it means explicitly (scripts/test-isolation.test.mjs).
const RUNNER_OWNED = /^(GITHUB_|RUNNER_|ACTIONS_)/;
export function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !RUNNER_OWNED.test(k)));
}

// Run a step's bash `run:` the way the runner does (`bash -e {0}`), with the
// given env and a PATH that puts `stubDir` first, so tests can stand in for
// git/gh/node. Returns spawnSync's result.
export function runBashStep(script, { env = {}, stubDir = null, cwd = undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-step-"));
  const file = path.join(dir, "step.sh");
  fs.writeFileSync(file, script);
  const PATH = stubDir ? `${stubDir}${path.delimiter}${process.env.PATH}` : process.env.PATH;
  try {
    return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
      cwd,
      encoding: "utf8",
      env: { ...cleanEnv(), PATH, ...env },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Write an executable stub script into `dir`.
export function stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// actions/github-script runs `script:` as the body of an AsyncFunction whose
// parameters are its context objects. Do the same, with doubles.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// The script runs in THIS process, so the runner-owned variables are taken out
// of process.env for its duration (see cleanEnv) and everything is put back.
export async function runGithubScript(script, { github, context, core, env = {} } = {}) {
  const saved = {};
  const set = (k, v) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  };
  for (const k of Object.keys(process.env)) if (RUNNER_OWNED.test(k)) set(k, undefined);
  for (const [k, v] of Object.entries(env)) set(k, v);
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(path.join(ROOT, "action.yml"));
    const fn = new AsyncFunction("github", "context", "core", "require", script);
    return await fn(github, context, core, require);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A `core` double that records what the script reported.
export function fakeCore() {
  const rec = { outputs: {}, failed: null, notices: [], warnings: [], errors: [], summary: [] };
  const core = {
    setOutput: (k, v) => {
      rec.outputs[k] = String(v);
    },
    setFailed: (m) => {
      rec.failed = String(m);
    },
    notice: (m) => rec.notices.push(String(m)),
    warning: (m) => rec.warnings.push(String(m)),
    error: (m) => rec.errors.push(String(m)),
    info: () => {},
    debug: () => {},
    summary: {
      addRaw(t) {
        rec.summary.push(String(t));
        return this;
      },
      async write() {
        return this;
      },
    },
  };
  return { core, rec };
}

// ------------------------------------------------------------ env resolution

// The `inputs:` defaults declared in action.yml, as GitHub would hand them to
// a step when the workflow sets nothing.
export function inputDefaults() {
  const out = {};
  for (const [k, v] of Object.entries(loadAction().inputs || {})) {
    out[k] = v.default === undefined ? "" : String(v.default);
  }
  return out;
}

// Resolve a step's `env:` block the way the runner would for the simple
// references this action uses: `${{ a.b.c }}` (optionally inside other text).
// `ctx` is a nested object ({ inputs, steps, github, runner }). An expression
// that is not a plain dotted reference, or a reference `ctx` cannot answer,
// throws — a test that silently got "" would be testing nothing.
export function resolveEnv(env, ctx) {
  const out = {};
  for (const [k, raw] of Object.entries(env || {})) {
    out[k] = String(raw).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr) => {
      if (!/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(expr)) {
        throw new Error(`env ${k}: not a plain reference: ${expr}`);
      }
      let v = ctx;
      for (const part of expr.split(".")) {
        if (v === undefined || v === null || !(part in Object(v))) {
          throw new Error(`env ${k}: ${expr} is not provided by the test context`);
        }
        v = v[part];
      }
      return v === undefined || v === null ? "" : String(v);
    });
  }
  return out;
}

// Async twin of runBashStep, for steps that talk to a server living in the
// test process (spawnSync would block the event loop that has to answer).
export async function runBashStepAsync(script, { env = {}, stubDir = null, cwd = undefined } = {}) {
  const { spawn } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-step-"));
  const file = path.join(dir, "step.sh");
  fs.writeFileSync(file, script);
  const PATH = stubDir ? `${stubDir}${path.delimiter}${process.env.PATH}` : process.env.PATH;
  try {
    return await new Promise((resolve) => {
      const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
        cwd,
        env: { ...cleanEnv(), PATH, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
