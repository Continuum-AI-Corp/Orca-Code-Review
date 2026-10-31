// CR-12: a maintainer's /orcacode-review reviewed whatever head the PR had when
// the run started. On a fork PR the fork's owner can push between the
// maintainer reading the change and the review running — the maintainer
// approves spend on code they never saw, and the verdict lands on it.
//
// Now, when the PR's head lives in another repository (a fork, or a fork that
// was deleted), the command must name the commit: `/orcacode-review <sha>`
// with at least 7 hex characters. The action reviews exactly that commit, and
// only if it is still the PR's head; otherwise it refuses with a comment that
// says what the head is now and how to re-run. A same-repository PR keeps the
// bare command (only people with push access can move its head); a commit it
// names is held to the same check.

import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { step, runGithubScript, fakeCore, ROOT } from "./test-helpers/action-yaml.mjs";

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OLD = "ffffeeee11112222333344445555666677778888";

async function command(body, { head = "outsider/widgets", sha = HEAD, assoc = "MEMBER" } = {}) {
  const posted = [];
  const github = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            number: 7,
            user: { login: "outsider" },
            author_association: "NONE",
            draft: false,
            base: { ref: "main", repo: { full_name: "acme/widgets" } },
            head: { sha, repo: head ? { full_name: head } : null },
          },
        }),
      },
      users: { getAuthenticated: async () => { throw Object.assign(new Error("no"), { status: 403 }); } },
      issues: { createComment: async (a) => (posted.push(a), { data: { user: { login: "github-actions[bot]" } } }) },
    },
  };
  const { core, rec } = fakeCore();
  await runGithubScript(step("pr").with.script, {
    github,
    core,
    context: {
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 7, pull_request: { url: "x" } },
        comment: { id: 1, body, author_association: assoc },
        repository: { default_branch: "main", private: false },
      },
      repo: { owner: "acme", repo: "widgets" },
      issue: { number: 7 },
    },
    env: {
      IDENTITY: path.join(ROOT, "scripts", "identity.mjs"),
      PUBLISH_GUARD: path.join(ROOT, "scripts", "publish-guard.mjs"),
      TOKEN_IS_JOB_TOKEN: "true",
      BOT_LOGIN_INPUT: "",
      BRAND: "OrcaCode Review",
    },
  });
  return { rec, posted };
}

describe("a same-repository PR keeps the bare command", () => {
  test("bare -> reviews the head", async () => {
    const { rec, posted } = await command("/orcacode-review", { head: "acme/widgets" });
    assert.equal(rec.outputs.run, "true");
    assert.equal(rec.outputs.head_sha, HEAD);
    assert.equal(posted.length, 0);
  });

  test("words after the command are not a commit", async () => {
    assert.equal((await command("@orcacode review please", { head: "acme/widgets" })).rec.outputs.run, "true");
  });

  test("a commit it names must still be the head", async () => {
    assert.equal((await command(`/orcacode-review ${HEAD.slice(0, 7)}`, { head: "acme/widgets" })).rec.outputs.run, "true");
    const stale = await command(`/orcacode-review ${OLD.slice(0, 9)}`, { head: "acme/widgets" });
    assert.equal(stale.rec.outputs.run, "false");
    assert.equal(stale.posted.length, 1);
  });
});

describe("a fork PR's command must name the commit, and it must still be the head", () => {
  for (const given of [HEAD.slice(0, 7), HEAD.slice(0, 12).toUpperCase(), HEAD]) {
    test(`/orcacode-review ${given} -> reviews exactly ${HEAD.slice(0, 7)}…`, async () => {
      const { rec, posted } = await command(`/orcacode-review ${given}`);
      assert.equal(rec.outputs.run, "true");
      assert.equal(rec.outputs.head_sha, HEAD, "the full SHA the checkout pins");
      assert.equal(posted.length, 0);
    });
  }

  test("every spelling of the command takes the commit", async () => {
    for (const cmd of ["/orcacode review", "@orcacode-review", "@orcacode review"]) {
      assert.equal((await command(`${cmd} ${HEAD.slice(0, 8)}`)).rec.outputs.run, "true", cmd);
    }
  });

  test("the bare command -> refused, with a comment naming the head and the command to use", async () => {
    const { rec, posted } = await command("/orcacode-review");
    assert.equal(rec.outputs.run, "false");
    assert.equal(rec.failed, null, "a refusal is not a failed job");
    assert.match(rec.outputs.stop_reason, /fork/);
    assert.equal(posted.length, 1);
    assert.match(posted[0].body, new RegExp(`/orcacode-review ${HEAD.slice(0, 7)}`));
    assert.match(posted[0].body, /fork/i);
  });

  test("a commit that is no longer the head -> refused, saying what the head is now", async () => {
    const { rec, posted } = await command(`/orcacode-review ${OLD.slice(0, 7)}`);
    assert.equal(rec.outputs.run, "false");
    assert.match(posted[0].body, /no longer/i);
    assert.match(posted[0].body, new RegExp(OLD.slice(0, 7)));
    assert.match(posted[0].body, new RegExp(`/orcacode-review ${HEAD.slice(0, 7)}`));
  });

  for (const arg of [HEAD.slice(0, 6), "please", "a1b2c3d!", `${HEAD}0`]) {
    test(`"${arg}" is not a commit -> refused`, async () => {
      assert.equal((await command(`/orcacode-review ${arg}`)).rec.outputs.run, "false");
    });
  }

  test("a deleted fork counts as a fork", async () => {
    assert.equal((await command("/orcacode-review", { head: null })).rec.outputs.run, "false");
    assert.equal((await command(`/orcacode-review ${HEAD.slice(0, 7)}`, { head: null })).rec.outputs.run, "true");
  });

  test("an outsider's command is still refused before any of this (and nothing is posted)", async () => {
    const { rec, posted } = await command(`/orcacode-review ${HEAD.slice(0, 7)}`, { assoc: "NONE" });
    assert.equal(rec.outputs.run, "false");
    assert.equal(posted.length, 0);
  });

  test("the refusal is posted through the publish funnel", () => {
    const env = step("pr").env;
    assert.equal(env.PUBLISH_GUARD, "${{ github.action_path }}/scripts/publish-guard.mjs");
    assert.equal(env.CR_REDACT_API_KEY, "${{ inputs.orcarouter-api-key }}");
    assert.equal(env.CR_REDACT_GITHUB_TOKEN, "${{ inputs.github-token }}");
    assert.match(step("pr").with.script, /guard\.guardGithub\(github\)/);
  });
});
