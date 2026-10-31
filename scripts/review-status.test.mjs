// CR-5: a merge gate that passes without a review.
//
// Every settings skip (author allowlist, on-demand mode, auto_review off, a
// draft) used to end the job green — the opposite of the oversized-diff rule,
// where a skip fails the check so an unreviewed diff cannot satisfy a required
// gate. And an on-demand review (an issue_comment run) reported its verdict on
// the DEFAULT BRANCH's check, so a red verdict never blocked the PR.
//
// Now:
//   - `on-skipped-review` ("fail" by default, "pass" to make skips advisory)
//     decides what a settings skip does to the job, exactly as
//     `on-oversized-diff` does for an oversized one;
//   - every run that resolves a PR writes a commit status (context
//     `status-context`, default "OrcaCode Review") on the PR's HEAD SHA — the
//     comment-triggered runs included — and it is `success` only when a review
//     actually ran on that head and the gate passed, or when a skip was made
//     advisory on purpose.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { decideStatus } from "./review-status.mjs";
import { step, loadAction, runGithubScript, fakeCore, ROOT } from "./test-helpers/action-yaml.mjs";

const base = {
  decision: "review",
  reason: "",
  guardDecision: "review",
  guardReason: "",
  onSkipped: "fail",
  onOversized: "fail",
  reviewOutcome: "success",
  enforceOutcome: "success",
  verdict: "pass",
  blockOn: "P0,P1",
};

describe("decideStatus", () => {
  test("a review that ran and passed the gate -> success", () => {
    assert.equal(decideStatus(base).state, "success");
  });

  test("a gate that blocked -> failure", () => {
    const s = decideStatus({ ...base, enforceOutcome: "failure", verdict: "blocked" });
    assert.equal(s.state, "failure");
    assert.match(s.description, /P0,P1/);
  });

  test("a gate that could not decide -> failure, never success", () => {
    assert.notEqual(decideStatus({ ...base, enforceOutcome: "failure", verdict: "error" }).state, "success");
  });

  for (const outcome of ["failure", "cancelled", "skipped", ""]) {
    test(`the review step ${outcome || "never ran"} -> not success`, () => {
      const s = decideStatus({ ...base, reviewOutcome: outcome, enforceOutcome: "skipped", verdict: "" });
      assert.ok(["error", "failure"].includes(s.state), s.state);
    });
  }

  test("enforce succeeded but its verdict is missing -> not success", () => {
    assert.notEqual(decideStatus({ ...base, verdict: "" }).state, "success");
  });

  test("a settings skip fails by default, naming the reason", () => {
    const s = decideStatus({ ...base, decision: "skip", reason: "on-demand mode" });
    assert.equal(s.state, "failure");
    assert.match(s.description, /on-demand mode/);
  });

  test('a settings skip with on-skipped-review: "pass" is advisory success', () => {
    assert.equal(decideStatus({ ...base, decision: "skip", reason: "draft PR", onSkipped: "pass" }).state, "success");
  });

  test("anything but an explicit pass fails a skip (fail-safe)", () => {
    assert.equal(decideStatus({ ...base, decision: "skip", reason: "x", onSkipped: "PASS!" }).state, "failure");
  });

  test("an oversized skip follows on-oversized-diff", () => {
    assert.equal(decideStatus({ ...base, guardDecision: "skip", guardReason: "too big" }).state, "failure");
    assert.equal(decideStatus({ ...base, guardDecision: "skip", guardReason: "too big", onOversized: "pass" }).state, "success");
  });

  test("no decision at all (the settings step never ran) -> error", () => {
    assert.equal(decideStatus({ ...base, decision: "" }).state, "error");
  });

  test("descriptions fit GitHub's 140-character limit", () => {
    const s = decideStatus({ ...base, decision: "skip", reason: "x".repeat(500) });
    assert.ok(s.description.length <= 140);
  });
});

describe("action.yml: the status is published on the head SHA", () => {
  const ENV = {
    PUBLISH_GUARD: path.join(ROOT, "scripts", "publish-guard.mjs"),
    STATUS_SCRIPT: path.join(ROOT, "scripts", "review-status.mjs"),
    STATUS_CONTEXT: "OrcaCode Review",
    HEAD_SHA: "headsha123",
    DECISION: "review",
    REASON: "",
    GUARD_DECISION: "review",
    GUARD_REASON: "",
    ON_SKIPPED: "fail",
    ON_OVERSIZED: "fail",
    REVIEW_OUTCOME: "success",
    ENFORCE_OUTCOME: "failure",
    VERDICT: "blocked",
    BLOCK_ON: "P0,P1",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "99",
  };

  async function publish(env, { fail = null, eventName = "issue_comment" } = {}) {
    const calls = [];
    const github = {
      rest: {
        repos: {
          createCommitStatus: async (args) => {
            calls.push(args);
            if (fail) {
              const e = new Error("Resource not accessible by integration");
              e.status = fail;
              throw e;
            }
            return { data: {} };
          },
        },
      },
    };
    const { core, rec } = fakeCore();
    await runGithubScript(step("status").with.script, {
      github,
      core,
      context: { eventName, repo: { owner: "acme", repo: "widgets" }, payload: {} },
      env: { ...ENV, ...env },
    });
    return { calls, rec };
  }

  test("an on-demand (comment) run's blocked verdict lands on the PR head as failure", async () => {
    const { calls } = await publish({});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sha, "headsha123");
    assert.equal(calls[0].state, "failure");
    assert.equal(calls[0].context, "OrcaCode Review");
    assert.match(calls[0].target_url, /\/acme\/widgets\/actions\/runs\/99$/);
  });

  test("a missing statuses permission is a warning, not a failed run", async () => {
    const { rec } = await publish({}, { fail: 403 });
    assert.equal(rec.failed, null);
    assert.ok(rec.warnings.some((w) => /statuses: write/.test(w)), rec.warnings.join("\n"));
  });

  test("an empty status-context turns the status off", async () => {
    const { calls } = await publish({ STATUS_CONTEXT: "" });
    assert.equal(calls.length, 0);
  });

  test("the step runs on every ending (always()) once the PR was resolved", () => {
    const s = step("status");
    assert.match(s.if, /always\(\)/);
    assert.match(s.if, /steps\.pr\.outputs\.run == 'true'/);
  });

  test("the inputs exist with fail-safe defaults", () => {
    const inputs = loadAction().inputs;
    assert.equal(inputs["on-skipped-review"].default, "fail");
    assert.equal(inputs["status-context"].default, "OrcaCode Review");
  });
});

describe("action.yml: a settings skip follows on-skipped-review", () => {
  async function skip(onSkipped) {
    const { core, rec } = fakeCore();
    const github = {
      paginate: async () => [],
      rest: { issues: { listComments: () => {}, createComment: async () => ({}), updateComment: async () => ({}) } },
    };
    await runGithubScript(step("Skip review (settings)").with.script, {
      github,
      core,
      context: { repo: { owner: "acme", repo: "widgets" }, payload: {} },
      env: {
        BRAND: "OrcaCode Review",
        PR_NUMBER: "7",
        REASON: "on-demand mode",
        ON_SKIPPED: onSkipped,
        PUBLISH_GUARD: path.join(ROOT, "scripts", "publish-guard.mjs"),
      },
    });
    return rec;
  }

  test('default "fail": the job fails, so a required check cannot pass unreviewed', async () => {
    assert.ok((await skip("fail")).failed);
  });

  test('"pass": advisory, the job stays green', async () => {
    assert.equal((await skip("pass")).failed, null);
  });

  test("anything else fails (fail-safe)", async () => {
    assert.ok((await skip("")).failed);
  });
});
