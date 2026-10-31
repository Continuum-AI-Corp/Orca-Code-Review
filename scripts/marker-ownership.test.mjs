// CR-15: the action finds its own earlier comments by an HTML marker
// (<!-- orca-code-review-* -->) — to edit a notice in place, or to delete a
// stale one once a review posts. It used to match the marker in ANY comment, so
// anyone who could comment on the PR could plant the marker and have the action
// edit or DELETE that comment (or leave the real notice stale). Now a marker
// counts only in a comment authored by the token's own identity, resolved once
// by "Resolve PR refs" (github-actions[bot] for the default GITHUB_TOKEN).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { step, runGithubScript, fakeCore, ROOT } from "./test-helpers/action-yaml.mjs";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "markers-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const BOT = "github-actions[bot]";
const comment = (id, login, body) => ({ id, user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" }, body });

function fakeGithub(comments) {
  const calls = [];
  const rec = (name) => async (args) => {
    calls.push({ name, args });
    return { data: {} };
  };
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        listComments: () => {},
        createComment: rec("createComment"),
        updateComment: rec("updateComment"),
        deleteComment: rec("deleteComment"),
      },
      pulls: { get: async () => ({ data: { body: "" } }), update: rec("pullsUpdate") },
    },
  };
  return { github, calls };
}

const BASE_ENV = {
  BRAND: "OrcaCode Review",
  PR_NUMBER: "7",
  BOT_LOGIN: BOT,
  PUBLISH_GUARD: path.join(ROOT, "scripts", "publish-guard.mjs"),
};
const CONTEXT = { repo: { owner: "acme", repo: "widgets" }, payload: { repository: { private: true } } };

async function run(name, comments, env) {
  const { github, calls } = fakeGithub(comments);
  await runGithubScript(step(name).with.script, { github, core: fakeCore().core, context: CONTEXT, env: { ...BASE_ENV, ...env } });
  return calls;
}

const NOTICES = [
  ["Skip review (settings)", "<!-- orca-code-review-disabled -->", { REASON: "on-demand mode", ON_SKIPPED: "pass" }],
  [
    "Skip review (diff too large)",
    "<!-- orca-code-review-skip -->",
    { REASON: "too big", SIZE_KB: "1", FILES: "1", MAX_KB: "1", MAX_FILES: "1", ON_OVERSIZED: "pass" },
  ],
];

describe("notice upserts only edit the action's own comment", () => {
  for (const [name, marker, env] of NOTICES) {
    test(`${name}: a marker planted by another user is never edited`, async () => {
      const calls = await run(name, [comment(11, "mallory", `${marker}\nplanted`)], env);
      assert.ok(!calls.some((c) => c.name === "updateComment"), "the action edited someone else's comment");
      assert.ok(calls.some((c) => c.name === "createComment"), "the action must post its own notice instead");
    });

    test(`${name}: its own earlier notice is edited in place`, async () => {
      const calls = await run(name, [comment(12, BOT, `${marker}\nold`)], env);
      const upd = calls.find((c) => c.name === "updateComment");
      assert.ok(upd, "its own notice was not updated");
      assert.equal(upd.args.comment_id, 12);
    });
  }

  test("Surface guardrail / firewall block: a planted marker is never edited", async () => {
    const block = path.join(dir, "block.json");
    fs.writeFileSync(block, JSON.stringify({ kind: "guardrail", policyName: "p", detail: "d" }));
    const calls = await run("Surface guardrail / firewall block", [comment(13, "mallory", "<!-- orca-code-review-block -->")], {
      POLICY_BLOCK: block,
      REPO_PRIVATE: "true",
    });
    assert.ok(!calls.some((c) => c.name === "updateComment"));
    assert.ok(calls.some((c) => c.name === "createComment"));
  });

  test("no resolved identity matches nothing (fail safe: post anew, edit nothing)", async () => {
    const [name, marker, env] = NOTICES[0];
    const calls = await run(name, [comment(14, BOT, marker)], { ...env, BOT_LOGIN: "" });
    assert.ok(!calls.some((c) => c.name === "updateComment"));
  });
});

describe("the stale-notice sweep only deletes the action's own comments", () => {
  test("planted markers survive; the action's own stale notices go", async () => {
    const reported = path.join(dir, "reported.json");
    fs.writeFileSync(reported, JSON.stringify({ comments: [] }));
    const comments = [
      comment(21, "mallory", "<!-- orca-code-review-disabled --> mine"),
      comment(22, "mallory", "<!-- orca-code-review-block --> mine too"),
      comment(23, BOT, "<!-- orca-code-review-skip --> stale"),
    ];
    const calls = await run("Summary (PR description)", comments, {
      RESULT: reported,
      PREV_BODY: path.join(dir, "prev.md"),
      SUMMARY_SCRIPT: path.join(ROOT, "scripts", "summary-comment.mjs"),
      INJECT_SCRIPT: path.join(ROOT, "scripts", "inject-summary.mjs"),
      GATE: path.join(ROOT, "scripts", "gate.mjs"),
      BLOCK_ON: "P0,P1",
      QUIET: "false",
      PASSES: "1",
    });
    const deleted = calls.filter((c) => c.name === "deleteComment").map((c) => c.args.comment_id);
    assert.deepEqual(deleted, [23]);
  });
});

describe("Resolve PR refs resolves the token's identity once", () => {
  async function resolveWith(getAuthenticated) {
    const { core, rec } = fakeCore();
    const github = {
      rest: {
        users: { getAuthenticated },
        pulls: { get: async () => ({ data: {} }) },
      },
    };
    const context = {
      eventName: "pull_request_target",
      payload: {
        action: "opened",
        repository: { default_branch: "main", private: false },
        pull_request: { number: 1, base: { ref: "main" }, head: { sha: "s" }, author_association: "OWNER" },
      },
      repo: { owner: "acme", repo: "widgets" },
      issue: { number: 1 },
    };
    await runGithubScript(step("pr").with.script, { github, core, context });
    return rec.outputs.bot_login;
  }

  test("the default GITHUB_TOKEN (no user behind it) is github-actions[bot]", async () => {
    const login = await resolveWith(async () => {
      const e = new Error("Resource not accessible by integration");
      e.status = 403;
      throw e;
    });
    assert.equal(login, BOT);
  });

  test("a personal token is its user's login", async () => {
    assert.equal(await resolveWith(async () => ({ data: { login: "octo-maintainer" } })), "octo-maintainer");
  });
});
