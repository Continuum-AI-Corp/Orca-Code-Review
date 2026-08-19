// Contract tests for judge.mjs — the L2 precision gate. It sends the L1
// findings to an INDEPENDENT model in one batched call and keeps one
// representative per surviving cluster above --threshold. It runs on every
// review (`precision-filter` defaults to "true").
//
// What is worth testing here is NOT the prompt or the judge's taste — that is
// a model-quality question, not a contract. What IS worth testing is every
// place this script decides to DROP a real finding, because each one is a
// silent way to lose a genuine defect:
//
//   1. Threshold parsing. `--threshold` gates every keep/drop, so a value that
//      is silently coerced sets the gate to the wrong place. parseFloat would
//      turn "0.8oops" into 0.8 and "0x1" into 0; the strict parser must reject
//      both loudly instead.
//   2. Schema-drift coercion of the judge's own response. The LLM sometimes
//      stringifies its JSON values, and plain JS truthiness is actively
//      dangerous here: the STRING "false" is truthy, and Number(true) is 1 —
//      which would sail past ANY threshold and neutralize the entire gate.
//   3. Fail-open for findings the judge never classified. A blind spot in the
//      judge must not become a silent drop, at any threshold.
//
// The LLM is a local mock: these assert our handling of a response, never the
// model's judgment. Async spawn (not spawnSync) because that mock runs in THIS
// process, so the test event loop has to stay live to answer the child.

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const JUDGE = join(SCRIPTS, "judge.mjs");

let dir;
let home;
let seq = 0;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "judge-test-"));
  // An empty HOME so the ~/.opencodereview/config.json fallback can never pick
  // up the developer's real local harness config and make these tests lie.
  home = join(dir, "home");
  writeFileSync(join(dir, ".keep"), "");
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// LLM double. `reply` is the judge's message content (a string). Pass
// `envelope` to control the whole completion body instead.
async function startLlm({ reply, envelope, status = 200 }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(status, { "content-type": "application/json" });
      if (envelope !== undefined) {
        res.end(typeof envelope === "string" ? envelope : JSON.stringify(envelope));
      } else {
        res.end(
          JSON.stringify({
            choices: [{ message: { content: reply } }],
            usage: { total_tokens: 42 },
          }),
        );
      }
    });
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((r) => server.close(r)) };
}

function writeInput(comments, extra = {}) {
  const file = join(dir, `${(seq += 1)}-in.json`);
  writeFileSync(file, JSON.stringify({ ...extra, comments }));
  return file;
}

function spawnJudge(args, env) {
  return new Promise((resolve) => {
    const child = spawn("node", [JUDGE, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OCR_LLM_URL: "",
        OCR_LLM_TOKEN: "",
        JUDGE_MODEL: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const finding = (content, path = "src/a.js", existing_code = "const x = 1;") => ({
  content,
  path,
  existing_code,
  start_line: 3,
  end_line: 3,
});

// Runs judge against a mock LLM and returns the written output + stderr.
async function judge({ comments, reply, envelope, status, threshold, extra }) {
  const llm = await startLlm({ reply, envelope, status });
  try {
    const input = writeInput(comments, extra);
    const out = join(dir, `${(seq += 1)}-out.json`);
    const args = [input, "--out", out, "--model", "test/judge-model"];
    if (threshold !== undefined) args.push("--threshold", String(threshold));
    const r = await spawnJudge(args, {
      OCR_LLM_URL: `http://127.0.0.1:${llm.port}/v1/chat/completions`,
      OCR_LLM_TOKEN: "test-token",
    });
    return { ...r, out, seen: llm.seen, read: () => JSON.parse(readFileSync(out, "utf8")) };
  } finally {
    await llm.close();
  }
}

// One group covering finding 0, parameterized so each coercion case is a
// one-liner.
const oneGroup = (over) =>
  JSON.stringify({
    groups: [
      {
        member_ids: [0],
        representative_id: 0,
        confidence: 0.9,
        keep: true,
        root_cause: "rc",
        reason: "r",
        ...over,
      },
    ],
  });

describe("argument validation (no LLM call is made)", () => {
  test("a missing input file exits 2", async () => {
    const r = await spawnJudge([], {});
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: node judge\.mjs/);
  });

  test("a threshold with trailing garbage is REJECTED, not silently truncated", async () => {
    // parseFloat("0.8oops") === 0.8 — that silent success is the bug guarded here.
    for (const bad of ["0.8oops", "0x1", "abc", "", "1e-1", "  "]) {
      const r = await spawnJudge([writeInput([]), "--threshold", bad], {});
      assert.equal(r.status, 2, `threshold ${JSON.stringify(bad)} must be rejected`);
      assert.match(r.stderr, /--threshold must be a plain decimal/);
    }
  });

  test("a threshold outside [0,1] is rejected", async () => {
    for (const bad of ["1.5", "-0.1", "2"]) {
      const r = await spawnJudge([writeInput([]), "--threshold", bad], {});
      assert.equal(r.status, 2, bad);
      assert.match(r.stderr, /must be in \[0,1\]/);
    }
  });

  test("the range boundaries are accepted", async () => {
    for (const ok of ["0", "1", "0.0", "1.0", "0.75"]) {
      const r = await spawnJudge([writeInput([]), "--threshold", ok], {
        OCR_LLM_URL: "http://127.0.0.1:1/x",
        OCR_LLM_TOKEN: "t",
        JUDGE_MODEL: "m",
      });
      assert.equal(r.status, 0, `threshold ${ok} should be valid (${r.stderr})`);
    }
  });

  test("no LLM connection exits 2", async () => {
    const r = await spawnJudge([writeInput([finding("[P1] x")])], {});
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no LLM connection/);
  });

  test("no model exits 2", async () => {
    const r = await spawnJudge([writeInput([finding("[P1] x")])], {
      OCR_LLM_URL: "http://127.0.0.1:1/x",
      OCR_LLM_TOKEN: "t",
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no model/);
  });
});

describe("empty input short-circuits before the LLM call", () => {
  test("zero findings writes the input through and exits 0", async () => {
    const input = writeInput([], { warnings: ["w"] });
    const out = join(dir, `${(seq += 1)}-out.json`);
    const r = await spawnJudge([input, "--out", out], {
      OCR_LLM_URL: "http://127.0.0.1:1/unreachable",
      OCR_LLM_TOKEN: "t",
      JUDGE_MODEL: "m",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no findings/);
    // The unreachable URL proves no call was attempted.
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).warnings, ["w"]);
  });
});

describe("keep/drop decisions", () => {
  test("a kept group above threshold yields its representative", async () => {
    const r = await judge({
      comments: [finding("[P1] real bug")],
      reply: oneGroup({}),
      threshold: 0.7,
    });
    assert.equal(r.status, 0, r.stderr);
    const kept = r.read().comments;
    assert.equal(kept.length, 1);
    assert.equal(kept[0].content, "[P1] real bug");
  });

  test("confidence below threshold drops the group", async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: oneGroup({ confidence: 0.5 }),
      threshold: 0.7,
    });
    assert.equal(r.read().comments.length, 0);
  });

  test("confidence exactly at the threshold survives", async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: oneGroup({ confidence: 0.7 }),
      threshold: 0.7,
    });
    assert.equal(r.read().comments.length, 1);
  });

  test("keep=false drops the group", async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: oneGroup({ keep: false }),
      threshold: 0.7,
    });
    assert.equal(r.read().comments.length, 0);
  });

  test("the representative is chosen, and merged members are not posted", async () => {
    const r = await judge({
      comments: [finding("[P2] symptom a"), finding("[P1] root", "src/b.js")],
      reply: JSON.stringify({
        groups: [
          {
            member_ids: [0, 1],
            representative_id: 1,
            confidence: 0.9,
            keep: true,
            root_cause: "rc",
          },
        ],
      }),
      threshold: 0.7,
    });
    const kept = r.read().comments;
    assert.equal(kept.length, 1, "one representative per cluster");
    assert.equal(kept[0].content, "[P1] root");
    assert.match(r.stderr, /merged 1/);
  });
});

describe("schema drift in the judge response must not bypass the gate", () => {
  test('the STRING "false" drops the group (plain truthiness would keep it)', async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: oneGroup({ keep: "false" }),
      threshold: 0.7,
    });
    assert.equal(r.read().comments.length, 0, '"false" is a truthy string — must still drop');
  });

  test('the STRING "true" is accepted', async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: oneGroup({ keep: "TRUE " }),
      threshold: 0.7,
    });
    assert.equal(r.read().comments.length, 1);
  });

  test("a numeric-string confidence is accepted", async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: oneGroup({ confidence: "0.95" }),
      threshold: 0.7,
    });
    assert.equal(r.read().comments.length, 1);
  });

  test("a non-numeric confidence type drops the group rather than coercing", async () => {
    // Number(true) === 1 and Number([1]) === 1 would clear ANY threshold.
    for (const confidence of [true, [1], {}, null, "high", "0.9oops"]) {
      const r = await judge({
        comments: [finding("[P1] x")],
        reply: oneGroup({ confidence }),
        threshold: 0.7,
      });
      assert.equal(
        r.read().comments.length,
        0,
        `confidence ${JSON.stringify(confidence)} must not slip through`,
      );
    }
  });

  test("an out-of-range confidence is dropped, NOT clamped to 1", async () => {
    for (const confidence of [2, -1, 1.01]) {
      const r = await judge({
        comments: [finding("[P1] x")],
        reply: oneGroup({ confidence }),
        threshold: 0.7,
      });
      assert.equal(r.read().comments.length, 0, `confidence ${confidence}`);
    }
  });
});

describe("findings the judge did not classify fail OPEN", () => {
  test("an uncovered finding is kept even at threshold 1", async () => {
    const r = await judge({
      comments: [finding("[P1] classified"), finding("[P0] never mentioned", "src/b.js")],
      reply: JSON.stringify({
        groups: [
          { member_ids: [0], representative_id: 0, confidence: 1, keep: true, root_cause: "rc" },
        ],
      }),
      threshold: 1,
    });
    const kept = r.read().comments.map((c) => c.content);
    assert.ok(
      kept.includes("[P0] never mentioned"),
      "a judge blind spot must not become a silent drop at a high threshold",
    );
    assert.equal(kept.length, 2);
  });

  test("an empty groups array keeps everything", async () => {
    const r = await judge({
      comments: [finding("[P1] a"), finding("[P2] b", "src/b.js")],
      reply: JSON.stringify({ groups: [] }),
      threshold: 0.9,
    });
    assert.equal(r.read().comments.length, 2);
  });
});

describe("malformed groups still surface a valid finding", () => {
  test("an out-of-range representative_id falls back to a valid member", async () => {
    const r = await judge({
      comments: [finding("[P1] only one")],
      reply: oneGroup({ representative_id: 99, member_ids: [0] }),
      threshold: 0.7,
    });
    const kept = r.read().comments;
    assert.equal(kept.length, 1, "the coverage pass already marked member 0 as handled");
    assert.equal(kept[0].content, "[P1] only one");
  });

  test("a group with no resolvable representative is skipped loudly", async () => {
    const r = await judge({
      comments: [finding("[P1] a")],
      reply: JSON.stringify({
        groups: [
          { member_ids: [0], representative_id: 0, confidence: 1, keep: true, root_cause: "ok" },
          { member_ids: [77], representative_id: 88, confidence: 1, keep: true, root_cause: "bad" },
        ],
      }),
      threshold: 0.7,
    });
    assert.equal(r.read().comments.length, 1);
    assert.match(r.stderr, /skip malformed judge group/);
  });
});

describe("transport and envelope failures", () => {
  test("an HTTP error exits 1 without writing output", async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: "{}",
      status: 500,
      threshold: 0.7,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /HTTP 500/);
    assert.equal(existsSync(r.out), false, "a failed judge must not write a filtered result");
  });

  test("an unparseable completion envelope exits 1", async () => {
    const r = await judge({ comments: [finding("[P1] x")], envelope: "not json at all" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bad completion envelope/);
  });

  test("a judge reply that is not JSON exits 1", async () => {
    const r = await judge({ comments: [finding("[P1] x")], reply: "I think it looks fine!" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /judge did not return JSON/);
  });

  test("a fenced ```json reply is unwrapped", async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: `\`\`\`json\n${oneGroup({})}\n\`\`\``,
      threshold: 0.7,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.read().comments.length, 1);
  });
});

describe("request shape", () => {
  test("the model, a zero temperature and bearer auth are sent", async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: oneGroup({}),
      threshold: 0.7,
    });
    assert.equal(r.status, 0, r.stderr);
    const sent = JSON.parse(r.seen[0].body);
    assert.equal(sent.model, "test/judge-model");
    assert.equal(sent.temperature, 0, "a precision gate must be deterministic");
    assert.equal(r.seen[0].headers.authorization, "Bearer test-token");
    assert.equal(sent.messages.length, 2);
  });

  test("non-comment top-level keys survive into the output", async () => {
    const r = await judge({
      comments: [finding("[P1] x")],
      reply: oneGroup({}),
      threshold: 0.7,
      extra: { warnings: [], model: "engine-model" },
    });
    assert.equal(r.read().model, "engine-model");
  });
});
