// CR-5: a merge gate that passes without a review.
//
// Every settings skip (author allowlist, on-demand mode, auto_review off, a
// draft) used to end the job green — the opposite of the oversized-diff rule,
// where a skip fails the check so an unreviewed diff cannot satisfy a required
// gate. And an on-demand review (an issue_comment run) reported its verdict on
// the DEFAULT BRANCH's check, so a red verdict never blocked the PR.
//
// Now:
//   - every run that resolves a PR writes a commit status (context
//     `status-context`, default "OrcaCode Review") on the PR's HEAD SHA — the
//     comment-triggered runs included — and it is `success` only when a review
//     actually ran on that head and the gate passed (or an oversized diff was
//     made advisory with `on-oversized-diff: "pass"`). A settings skip is never
//     success there: it says "Not reviewed: <reason>".
//   - the JOB is another matter. Failing it on a skip by default (the first cut
//     of this fix) turned on-demand mode, auto-review-off, drafts and outsiders'
//     PRs red for every customer, and broke merges for those who require the
//     `review` job. So a skip passes the job by default, as it always did, and
//     `on-skipped-review: "fail"` fails it too. A customer who makes the
//     status required is protected either way; nobody else regresses.

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

  for (const onSkipped of ["pass", "fail", "", "PASS!"]) {
    test(`a settings skip is "Not reviewed: <reason>", never success (on-skipped-review: ${JSON.stringify(onSkipped)})`, () => {
      const s = decideStatus({ ...base, decision: "skip", reason: "on-demand mode", onSkipped });
      assert.equal(s.state, "failure");
      assert.match(s.description, /^Not reviewed: on-demand mode/);
    });
  }

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

  test("a skip passes the job by default (as before); the status is on by default", () => {
    const inputs = loadAction().inputs;
    assert.equal(inputs["on-skipped-review"].default, "pass");
    assert.equal(inputs["status-context"].default, "OrcaCode Review");
  });

  test("a settings skip's status lands on the head as failure even when the job passes", async () => {
    const { calls } = await publish({ DECISION: "skip", REASON: "draft PR", ON_SKIPPED: "pass", REVIEW_OUTCOME: "", ENFORCE_OUTCOME: "", VERDICT: "" });
    assert.equal(calls[0].state, "failure");
    assert.match(calls[0].description, /^Not reviewed: draft PR/);
  });
});

describe("action.yml: a settings skip follows on-skipped-review", () => {
  async function skip(onSkipped, extra = {}) {
    const { core, rec } = fakeCore();
    const posted = [];
    const github = {
      paginate: async () => [],
      rest: {
        issues: {
          listComments: () => {},
          createComment: async (a) => posted.push(a.body),
          updateComment: async (a) => posted.push(a.body),
        },
      },
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
        STATUS_CONTEXT: "OrcaCode Review",
        PUBLISH_GUARD: path.join(ROOT, "scripts", "publish-guard.mjs"),
        ...extra,
      },
    });
    return { rec, posted };
  }

  test('the default ("pass"): the job stays green, as it did before this branch', async () => {
    const { rec } = await skip(loadAction().inputs["on-skipped-review"].default);
    assert.equal(rec.failed, null);
  });

  test('"fail": the job fails too', async () => {
    assert.ok((await skip("fail")).rec.failed);
    assert.ok((await skip(" FAIL ")).rec.failed, "case and spaces do not matter");
  });

  test("an unrecognised value passes the job, and says so", async () => {
    const { rec } = await skip("fial");
    assert.equal(rec.failed, null);
    assert.ok(rec.warnings.some((w) => /on-skipped-review/.test(w) && /fial/.test(w)), rec.warnings.join("\n"));
  });

  test("the notice says the status reports the PR as not reviewed (so a required status still holds it)", async () => {
    const { posted } = await skip("pass");
    assert.equal(posted.length, 1);
    assert.match(posted[0], /OrcaCode Review/);
    assert.match(posted[0], /not reviewed/i);
  });

  test("with the status turned off (status-context: \"\") the notice does not promise one", async () => {
    const { posted } = await skip("pass", { STATUS_CONTEXT: "" });
    assert.doesNotMatch(posted[0], /commit status/i);
  });
});
