// The workflows this repository ships for customers (the example, the skill's
// asset, and the one the installer renders), read through the YAML parser.
//
//   CR-5   Retargeting a PR's base did not re-run the review, and a reopened PR
//          was not reviewed: add `reopened` and `edited` (the job's `if:` lets
//          `edited` through only when the base changed). `statuses: write` lets
//          the action put its verdict on the PR head for comment runs too.
//   CR-6   A workflow-level concurrency group with cancel-in-progress let ANY
//          comment cancel an in-flight review (each comment starts a run in the
//          same group, which then skips). Concurrency is per job now, and
//          comment runs have a group of their own that never cancels a running
//          job (GitHub still replaces a PENDING one with a newer comment's —
//          doc-drift.test.mjs holds the docs to saying so).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { shippedWorkflows } from "./test-helpers/action-yaml.mjs";

describe("the shipped workflows", () => {
  test("there are three, and the parser read each", async () => {
    const wfs = await shippedWorkflows();
    assert.equal(wfs.length, 3);
    for (const w of wfs) assert.ok(w.doc?.jobs?.review, `${w.name}: no review job`);
  });

  test("re-run on reopened and on a retargeted base (edited), not only opened/synchronize", async () => {
    for (const w of await shippedWorkflows()) {
      const types = w.doc.on.pull_request_target.types;
      for (const t of ["opened", "synchronize", "reopened", "ready_for_review", "edited"]) {
        assert.ok(types.includes(t), `${w.name}: pull_request_target.types lacks ${t}`);
      }
      const cond = w.doc.jobs.review.if;
      assert.match(cond, /github\.event\.action != 'edited'/, `${w.name}: edited must be filtered`);
      assert.match(cond, /github\.event\.changes\.base/, `${w.name}: edited runs only on a base change`);
    }
  });

  test("no workflow-level concurrency; the job's group separates comment runs, which never cancel", async () => {
    for (const w of await shippedWorkflows()) {
      assert.equal(w.doc.concurrency, undefined, `${w.name}: workflow-level concurrency lets any comment cancel a review`);
      const c = w.doc.jobs.review.concurrency;
      assert.ok(c && c.group, `${w.name}: the review job needs its own concurrency group`);
      assert.match(c.group, /github\.event_name == 'issue_comment'/, `${w.name}: comment runs need their own group`);
      assert.match(String(c["cancel-in-progress"]), /github\.event_name != 'issue_comment'/, `${w.name}: a comment run must never cancel`);
    }
  });

  test("they grant statuses: write, so the verdict lands on the PR head for comment runs too", async () => {
    for (const w of await shippedWorkflows()) {
      assert.equal(w.doc.permissions.statuses, "write", w.name);
    }
  });

  test("the comment gate is still there (defence in depth with the action's own check)", async () => {
    for (const w of await shippedWorkflows()) {
      assert.match(w.doc.jobs.review.if, /\["OWNER", "MEMBER", "COLLABORATOR"\]/, w.name);
    }
  });
});
