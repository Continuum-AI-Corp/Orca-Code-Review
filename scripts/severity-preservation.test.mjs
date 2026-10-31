// No stage between the engine and the merge gate may LOWER a finding's
// severity or lose a P0 / security finding.
//
// Three stages fold findings together, and each used to keep whichever copy it
// met first, whatever its tag:
//   - postfilter.mjs dedupes by normalised content (the tag stripped), so a
//     "[P3] Null deref" seen first swallowed the "[P0] Null deref" after it;
//   - exhaustive-merge.mjs keyed on file+line+content (tag stripped), so an
//     extra pass's P0 for a finding the first pass rated P3 was discarded;
//   - judge.mjs keeps one representative per cluster — possibly the P3 of a
//     cluster holding a P0 — and could drop ANY cluster, P0s included, on a
//     model's say-so (a model the PR's own text may be steering).
// Now: a fold keeps the HIGHEST severity among what it folds, and the judge may
// re-rank and annotate but never drop a P0 or a security finding.

import http from "node:http";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { severityOf, isSecurityFinding } from "./severity.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
let dir;
let seq = 0;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sev-keep-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const file = (obj) => {
  const f = join(dir, `${(seq += 1)}.json`);
  writeFileSync(f, JSON.stringify(obj));
  return f;
};

describe("postfilter: a duplicate never lowers the severity", () => {
  let repo;
  let commit;
  before(() => {
    repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "a.js"), "const x = 1;\n");
    const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g("add", "-A");
    g("commit", "-q", "-m", "x");
    commit = g("rev-parse", "HEAD").trim();
  });

  const run = (comments) => {
    const out = join(dir, `${(seq += 1)}-pf.json`);
    const r = spawnSync("node", [join(SCRIPTS, "postfilter.mjs"), file({ comments }), repo, commit, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(out, "utf8")).comments;
  };

  test("[P3] then [P0] of the same finding -> one finding, at P0", () => {
    const got = run([
      { path: "a.js", start_line: 1, end_line: 1, content: "[P3] Null deref on the login path" },
      { path: "b.js", start_line: 2, end_line: 2, content: "[P0] null deref on the login path" },
    ]);
    assert.equal(got.length, 1);
    assert.equal(severityOf(got[0]), "P0");
    assert.equal(got[0].path, "a.js", "the first copy's location is kept");
  });

  test("an untagged duplicate (P1 fail-safe) raises a P3", () => {
    const got = run([
      { path: "a.js", content: "[P3] same thing" },
      { path: "a.js", content: "same thing" },
    ]);
    assert.equal(got.length, 1);
    assert.equal(severityOf(got[0]), "P1");
  });
});

describe("exhaustive-merge: a later pass's higher severity wins", () => {
  test("base [P3] + fresh [P0] on the same line -> merged at P0, still counted as no new finding", () => {
    const out = join(dir, `${(seq += 1)}-merged.json`);
    const stdout = execFileSync(
      "node",
      [
        join(SCRIPTS, "exhaustive-merge.mjs"),
        "--base", file({ comments: [{ path: "a.js", start_line: 4, end_line: 4, content: "[P3] Token compared with ==" }] }),
        "--new", file({ comments: [{ path: "a.js", start_line: 4, end_line: 4, content: "[P0] token compared with ==" }] }),
        "--out", out,
      ],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(stdout), { new_findings: 0 });
    const merged = JSON.parse(readFileSync(out, "utf8")).comments;
    assert.equal(merged.length, 1);
    assert.equal(severityOf(merged[0]), "P0");
  });
});

describe("isSecurityFinding", () => {
  for (const t of [
    "[P2] **SQL injection** via the sort parameter",
    "[P3] Authorization check missing on /admin",
    "[P2] The API key is written to the log",
    "[P3] XSS in the preview pane",
    "[P2] Path traversal in the upload handler",
  ]) {
    test(`security: ${t}`, () => assert.equal(isSecurityFinding({ content: t }), true));
  }
  for (const t of ["[P3] Prefer const over let", "[P2] Author name is misspelled", "[P2] Off-by-one in pagination"]) {
    test(`not security: ${t}`, () => assert.equal(isSecurityFinding({ content: t }), false));
  }
});

describe("judge: may re-rank and annotate, never drop a P0 or a security finding", () => {
  async function judge(comments, groups, threshold = 0.5) {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ groups }) } }] }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const out = join(dir, `${(seq += 1)}-judged.json`);
    try {
      const r = await new Promise((resolve) => {
        const child = spawn("node", [join(SCRIPTS, "judge.mjs"), file({ comments }), "--out", out, "--model", "m", "--threshold", String(threshold)], {
          env: {
            ...process.env,
            HOME: dir,
            OCR_LLM_URL: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
            OCR_LLM_TOKEN: "t",
          },
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (status) => resolve({ status, stderr }));
      });
      assert.equal(r.status, 0, r.stderr);
      return { comments: JSON.parse(readFileSync(out, "utf8")).comments, stderr: r.stderr };
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  const f = (content, path = "a.js") => ({ content, path, start_line: 1, end_line: 1, existing_code: "x" });

  test("a P0 the judge marks keep=false survives", async () => {
    const { comments, stderr } = await judge(
      [f("[P0] Remote code execution via eval")],
      [{ member_ids: [0], representative_id: 0, confidence: 0.1, keep: false, root_cause: "speculative", reason: "r" }],
    );
    assert.equal(comments.length, 1);
    assert.equal(severityOf(comments[0]), "P0");
    assert.match(stderr, /P0|security/i);
  });

  test("a security P2 below the threshold survives", async () => {
    const { comments } = await judge(
      [f("[P2] **SQL injection** in the report filter")],
      [{ member_ids: [0], representative_id: 0, confidence: 0.2, keep: true, root_cause: "x", reason: "r" }],
      0.7,
    );
    assert.equal(comments.length, 1);
  });

  test("a non-security P2 can still be dropped (the judge keeps its job)", async () => {
    const { comments } = await judge(
      [f("[P2] Prefer early return here")],
      [{ member_ids: [0], representative_id: 0, confidence: 0.2, keep: false, root_cause: "x", reason: "r" }],
    );
    assert.equal(comments.length, 0);
  });

  test("a cluster represented by its P3 keeps the P0 of a member", async () => {
    const { comments } = await judge(
      [f("[P3] Style: comparison reads oddly"), f("[P0] Token compared with == (timing)", "b.js")],
      [{ member_ids: [0, 1], representative_id: 0, confidence: 0.9, keep: true, root_cause: "same", reason: "r" }],
    );
    assert.equal(comments.length, 1);
    assert.equal(severityOf(comments[0]), "P0");
  });

  test("a dropped cluster keeps its protected member, not its P3 representative", async () => {
    const { comments } = await judge(
      [f("[P3] nit"), f("[P0] Secret logged in plaintext", "b.js")],
      [{ member_ids: [0, 1], representative_id: 0, confidence: 0.1, keep: false, root_cause: "same", reason: "r" }],
    );
    assert.equal(comments.length, 1);
    assert.equal(severityOf(comments[0]), "P0");
    assert.equal(comments[0].path, "b.js");
  });
});
