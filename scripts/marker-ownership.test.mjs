// CR-15: the action finds its own earlier comments by an HTML marker
// (<!-- orca-code-review-* -->) — to edit a notice in place, or to delete a
// stale one once a review posts. It used to match the marker in ANY comment, so
// anyone who could comment on the PR could plant the marker and have the action
// edit or DELETE that comment (or leave the real notice stale). Now a marker
// counts only in a comment authored by the token's own identity.
//
// That identity was resolved with a guess: when users.getAuthenticated failed
// it ASSUMED github-actions[bot]. It fails for every installation token, so a
// custom GitHub App never matched its own markers (a new notice every push)
// and would have treated github-actions[bot]'s as its own. Now ONE funnel
// (scripts/identity.mjs, used through scripts/publish-guard.mjs) decides:
//   1. the `bot-login` input, when set;
//   2. else the token's user (users.getAuthenticated: a personal token);
//   3. else github-actions[bot] only when github-token IS the job's own token;
//   4. else unknown — until the action's first comment or review in this run,
//      whose author GitHub reports back; that login is recorded for the run.
// Unknown matches nothing: post anew, edit and delete nothing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { step, actionSteps, loadAction, runBashStep, stub, runGithubScript, fakeCore, ROOT } from "./test-helpers/action-yaml.mjs";

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
  async function resolveWith(getAuthenticated, env = { TOKEN_IS_JOB_TOKEN: "true", BOT_LOGIN_INPUT: "" }) {
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
    await runGithubScript(step("pr").with.script, {
      github,
      core,
      context,
      env: { IDENTITY: path.join(ROOT, "scripts", "identity.mjs"), ...env },
    });
    return rec.outputs.bot_login;
  }
  const refused = async () => {
    const e = new Error("Resource not accessible by integration");
    e.status = 403;
    throw e;
  };

  test("the job's own GITHUB_TOKEN (no user behind it) is github-actions[bot]", async () => {
    assert.equal(await resolveWith(refused, { TOKEN_IS_JOB_TOKEN: "true" }), BOT);
  });

  test("a personal token is its user's login", async () => {
    assert.equal(await resolveWith(async () => ({ data: { login: "octo-maintainer" } })), "octo-maintainer");
  });

  test("another App's installation token is NOT assumed to be github-actions[bot]: unknown", async () => {
    assert.equal(await resolveWith(refused, { TOKEN_IS_JOB_TOKEN: "false", BOT_LOGIN_INPUT: "" }), "");
  });

  test("the bot-login input names it, ahead of everything else", async () => {
    assert.equal(await resolveWith(refused, { TOKEN_IS_JOB_TOKEN: "false", BOT_LOGIN_INPUT: "my-app[bot]" }), "my-app[bot]");
    assert.equal(
      await resolveWith(async () => ({ data: { login: "someone" } }), { TOKEN_IS_JOB_TOKEN: "false", BOT_LOGIN_INPUT: " my-app[bot] " }),
      "my-app[bot]",
    );
  });

  test("the bot-login input exists, empty by default, and the step is handed it and the job-token test", () => {
    assert.equal(loadAction().inputs["bot-login"].default, "");
    const env = step("pr").env;
    assert.equal(env.BOT_LOGIN_INPUT, "${{ inputs.bot-login }}");
    assert.equal(env.TOKEN_IS_JOB_TOKEN, "${{ inputs.github-token == github.token }}");
  });
});

// ------------------------------------------------------------------- the funnel

describe("one identity funnel (scripts/identity.mjs)", () => {
  let temp;
  before(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-"));
  });
  const fresh = () => {
    const d = fs.mkdtempSync(path.join(temp, "run-"));
    return d;
  };

  test("unknown identity + the action's first comment -> that comment's author is recorded for the run", async () => {
    const runnerTemp = fresh();
    const { github, calls } = fakeGithub([]);
    github.rest.issues.createComment = async (args) => {
      calls.push({ name: "createComment", args });
      return { data: { id: 1, user: { login: "my-app[bot]" } } };
    };
    await runGithubScript(step("Skip review (settings)").with.script, {
      github,
      core: fakeCore().core,
      context: CONTEXT,
      env: { ...BASE_ENV, ...NOTICES[0][2], BOT_LOGIN: "", RUNNER_TEMP: runnerTemp },
    });
    assert.equal(fs.readFileSync(path.join(runnerTemp, "cr-identity"), "utf8"), "my-app[bot]");

    // A later step of the same run knows it, and retires only that login's notices.
    const reported = path.join(runnerTemp, "reported.json");
    fs.writeFileSync(reported, JSON.stringify({ comments: [] }));
    const { github: g2, calls: c2 } = fakeGithub([
      comment(31, "github-actions[bot]", "<!-- orca-code-review-skip --> someone else's"),
      comment(32, "my-app[bot]", "<!-- orca-code-review-skip --> ours, from an earlier run"),
      comment(33, "mallory", "<!-- orca-code-review-disabled --> planted"),
    ]);
    await runGithubScript(step("Summary (PR description)").with.script, {
      github: g2,
      core: fakeCore().core,
      context: CONTEXT,
      env: {
        ...BASE_ENV,
        BOT_LOGIN: "",
        RUNNER_TEMP: runnerTemp,
        RESULT: reported,
        PREV_BODY: path.join(runnerTemp, "prev.md"),
        SUMMARY_SCRIPT: path.join(ROOT, "scripts", "summary-comment.mjs"),
        INJECT_SCRIPT: path.join(ROOT, "scripts", "inject-summary.mjs"),
        GATE: path.join(ROOT, "scripts", "gate.mjs"),
        BLOCK_ON: "P0,P1",
        QUIET: "false",
        PASSES: "1",
      },
    });
    assert.deepEqual(c2.filter((c) => c.name === "deleteComment").map((c) => c.args.comment_id), [32]);
  });

  test("with bot-login set, a custom App's earlier notice is edited in place — no duplicate per push", async () => {
    const [name, marker, env] = NOTICES[0];
    const calls = await run(name, [comment(41, "my-app[bot]", `${marker}\nold`)], { ...env, BOT_LOGIN: "my-app[bot]" });
    assert.ok(calls.some((c) => c.name === "updateComment" && c.args.comment_id === 41));
    assert.ok(!calls.some((c) => c.name === "createComment"));
  });

  test("a recorded identity never overrides a resolved one", async () => {
    const runnerTemp = fresh();
    fs.writeFileSync(path.join(runnerTemp, "cr-identity"), "my-app[bot]");
    const { ownLogin } = await import(path.join(ROOT, "scripts", "identity.mjs"));
    const saved = { BOT_LOGIN: process.env.BOT_LOGIN, RUNNER_TEMP: process.env.RUNNER_TEMP };
    try {
      process.env.RUNNER_TEMP = runnerTemp;
      process.env.BOT_LOGIN = "github-actions[bot]";
      assert.equal(ownLogin(), "github-actions[bot]");
      process.env.BOT_LOGIN = "";
      assert.equal(ownLogin(), "my-app[bot]");
    } finally {
      for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    }
  });

  test("every step that looks for its own comments asks the funnel, and no other copy of the check exists", () => {
    const listing = actionSteps().filter((st) => /listComments/.test(String(st.with?.script || "")));
    assert.ok(listing.length >= 4, `only ${listing.length} steps list comments`);
    for (const st of listing) {
      const script = st.with.script;
      assert.match(script, /guard\.isOwn\b/, `${st.name}: does not use the identity funnel`);
      assert.doesNotMatch(script, /process\.env\.BOT_LOGIN/, `${st.name}: has its own copy of the ownership check`);
      assert.equal(st.env.BOT_LOGIN, "${{ steps.pr.outputs.bot_login }}", `${st.name}: is not handed the resolved login`);
    }
  });

  test("the recorded identity is cleared at the start and the end of every run", () => {
    for (const name of ["Clear stale run files", "Clean up engine output"]) {
      assert.match(step(name).run, /"\$RUNNER_TEMP\/cr-identity"/, `${name} leaves cr-identity behind`);
    }
  });

  test("the reactions step clears the 👀 of the identity the funnel resolved (a custom App's too)", () => {
    const runnerTemp = fresh();
    fs.writeFileSync(path.join(runnerTemp, "cr-identity"), "my-app[bot]");
    const stubDir = fresh();
    const log = path.join(stubDir, "gh.log");
    stub(stubDir, "gh", `printf '%s\n' "$*" >> "${log}"
case "$*" in
  "api user --jq .type") echo Bot ;;
  "api user --jq .login") exit 1 ;;
  *--jq*) echo 7 ;;
esac`);
    const r = runBashStep(step("Settle the review reactions").run, {
      stubDir,
      env: { BOT_LOGIN: "", RUNNER_TEMP: runnerTemp, REPO: "acme/widgets", PR_NUMBER: "7", HEAD_SHA: "s", EVENT_NAME: "pull_request_target", GH_TOKEN: "t" },
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /select\(\.user\.login=="my-app\[bot\]"\)/, calls);
    assert.doesNotMatch(calls, /select\(\.user\.login=="github-actions\[bot\]"\)/);
  });

  test("an unknown identity clears nobody's 👀", () => {
    const stubDir = fresh();
    const log = path.join(stubDir, "gh.log");
    stub(stubDir, "gh", `printf '%s\n' "$*" >> "${log}"
case "$*" in
  "api user --jq .type") echo Bot ;;
  *--jq*) echo 7 ;;
esac`);
    const r = runBashStep(step("Settle the review reactions").run, {
      stubDir,
      env: { BOT_LOGIN: "", RUNNER_TEMP: fresh(), REPO: "acme/widgets", PR_NUMBER: "7", HEAD_SHA: "s", EVENT_NAME: "pull_request_target", GH_TOKEN: "t" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /DELETE/);
  });
});
