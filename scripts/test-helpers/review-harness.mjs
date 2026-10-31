// Test harness: run action.yml's Review step for real against a scratch git
// repository, with a stand-in `ocr` that behaves like a hostile engine — it
// reports everything it can see from inside the PR checkout. Shared by the
// suites that pin what the engine may see (keys, symlinks, attributes).

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

import { step, inputDefaults, resolveEnv, runBashStep, runBashStepAsync, stub, ROOT } from "./action-yaml.mjs";

export const REAL_KEY = "orca-REAL-key-7f3a9c1e5b";

let root = null;
const scratch = () => {
  if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "review-step-"));
  return root;
};
export const cleanupReviewHarness = () => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
};

export const git = (cwd, ...args) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// A repository with a base commit on origin/main and a head commit on top.
// `head(repo)` makes the PR's changes.
export function makeRepo(name, head = () => {}) {
  const repo = path.join(scratch(), name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "app.js"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  head(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", "head");
  return { repo, sha: git(repo, "rev-parse", "HEAD") };
}

async function upstreamDouble() {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"choices":[{"message":{"content":"ok"}}]}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

// The hostile engine. Writes what it saw to $OCR_SPY (a path the test picks):
// its own env, every /proc/<pid>/environ and cmdline it can read, the symlinks
// left in the checkout, and the status of one call through OCR_LLM_URL with
// the token it was given. Then prints `result` as its JSON review.
function hostileEngine(stubDir, spy, result = { comments: [], warnings: [] }) {
  const js = path.join(stubDir, "ocr-impl.mjs");
  fs.writeFileSync(
    js,
    `import fs from "node:fs";
import path from "node:path";
const seen = { env: { ...process.env }, proc: [], symlinks: [], call: null, cwd: process.cwd() };
try {
  for (const pid of fs.readdirSync("/proc").filter((p) => /^\\d+$/.test(p))) {
    for (const f of ["environ", "cmdline"]) {
      try { seen.proc.push(fs.readFileSync(\`/proc/\${pid}/\${f}\`, "latin1")); } catch {}
    }
  }
} catch {}
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) seen.symlinks.push(path.relative(process.cwd(), p));
    else if (e.isDirectory()) walk(p);
  }
};
walk(process.cwd());
try {
  const r = await fetch(process.env.OCR_LLM_URL, {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.OCR_LLM_TOKEN, "content-type": "application/json" },
    body: "{}",
  });
  seen.call = r.status;
} catch (e) { seen.call = String(e); }
fs.writeFileSync(process.env.OCR_SPY, JSON.stringify(seen));
process.stdout.write(${JSON.stringify(JSON.stringify(result))});
`,
  );
  stub(stubDir, "ocr", `exec node "${js}" "$@"`);
  return spy;
}

let seq = 0;
// Stage the key, then run the Review step against a repo. Returns the spy
// record, the upstream double's log and the step's result.
export async function runReview({ repo, sha, inputs = {}, result } = {}) {
  seq += 1;
  const temp = path.join(scratch(), `temp-${seq}`);
  const stubDir = path.join(scratch(), `stubs-${seq}`);
  fs.mkdirSync(temp);
  fs.mkdirSync(stubDir);
  const spy = path.join(scratch(), `spy-${seq}.json`);
  hostileEngine(stubDir, spy, result);
  const upstream = await upstreamDouble();
  try {
    const ctx = {
      inputs: {
        ...inputDefaults(),
        "orcarouter-api-key": REAL_KEY,
        "orcarouter-url": `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
        "precision-filter": "false",
        meter: "false",
        "timeout-minutes": "1",
        ...inputs,
      },
      steps: {
        pr: { outputs: { base: "main", head_sha: sha, base_is_default: "false", number: "7" } },
        settings: { outputs: { fix_first: "P0,P1", rubric_file: "", exhaustive: "false" } },
      },
      github: { action_path: ROOT, workspace: repo },
      runner: { temp },
    };
    const base = { RUNNER_TEMP: temp, GITHUB_WORKSPACE: repo, GITHUB_OUTPUT: path.join(temp, "out") };
    fs.writeFileSync(base.GITHUB_OUTPUT, "");

    const stage = step("stage-key");
    const staged = runBashStep(stage.run, { env: { ...resolveEnv(stage.env, ctx), ...base }, cwd: repo });
    assert.equal(staged.status, 0, staged.stdout + staged.stderr);

    const review = step("review");
    const r = await runBashStepAsync(review.run, {
      env: { ...resolveEnv(review.env, ctx), ...base, OCR_SPY: spy },
      stubDir,
      cwd: repo,
    });
    const seen = fs.existsSync(spy) ? JSON.parse(fs.readFileSync(spy, "utf8")) : null;
    return { r, seen, upstream: upstream.seen, temp };
  } finally {
    await upstream.close();
  }
}

