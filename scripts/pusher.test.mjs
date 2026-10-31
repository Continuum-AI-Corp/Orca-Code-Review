// CR-11: the author is not the pusher.
//
// author_association is the PR AUTHOR's. On a maintainer-opened PR whose head
// lives in an outsider's fork, every push the outsider makes is a
// `synchronize` the author gate waves through — the outsider spends the
// workspace's wallet on a public repository while the gate looks at the
// maintainer.
//
// Now, on `synchronize`, when the head repository is not the base repository
// and the push was made by someone other than the PR's author, "Resolve PR
// refs" asks GitHub that person's permission on this repository
// (repos.getCollaboratorPermissionLevel). The settings gate then auto-reviews
// only if they can write (write, maintain, admin) — unless auto-review-authors
// lets everyone through anyway, in which case nobody is spending more than
// they could by opening a PR of their own. A refusal is a skip, which the
// commit status reports as "Not reviewed". A maintainer's /orcacode-review
// still reviews the head (see comment-sha.test.mjs for how that is pinned).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { step, runBashStep, runGithubScript, fakeCore, ROOT } from "./test-helpers/action-yaml.mjs";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pusher-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const pr = ({ head = "outsider/widgets", author = "maint", assoc = "MEMBER" } = {}) => ({
  number: 7,
  user: { login: author },
  author_association: assoc,
  draft: false,
  base: { ref: "main", repo: { full_name: "acme/widgets" } },
  head: { sha: "headsha", repo: head ? { full_name: head } : null },
});

async function resolve({ action = "synchronize", sender = "outsider", prOpts, permission = "read", fail = false, event = "pull_request_target" } = {}) {
  const asked = [];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pr(prOpts) }) },
      users: { getAuthenticated: async () => { throw Object.assign(new Error("no"), { status: 403 }); } },
      repos: {
        getCollaboratorPermissionLevel: async (args) => {
          asked.push(args);
          if (fail) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { permission, role_name: permission } };
        },
      },
    },
  };
  const { core, rec } = fakeCore();
  await runGithubScript(step("pr").with.script, {
    github,
    core,
    context: {
      eventName: event,
      payload: { action, sender: sender ? { login: sender } : undefined, pull_request: pr(prOpts), repository: { default_branch: "main", private: false } },
      repo: { owner: "acme", repo: "widgets" },
      issue: { number: 7 },
    },
    env: { IDENTITY: path.join(ROOT, "scripts", "identity.mjs"), TOKEN_IS_JOB_TOKEN: "true", BOT_LOGIN_INPUT: "" },
  });
  return { rec, asked };
}

describe("Resolve PR refs: who pushed, and can they write here", () => {
  test("an outsider's push to a maintainer's PR from the outsider's fork -> not trusted", async () => {
    const { rec, asked } = await resolve({ sender: "outsider", permission: "read" });
    assert.equal(rec.outputs.run, "true");
    assert.equal(rec.outputs.pusher, "outsider");
    assert.equal(rec.outputs.pusher_trusted, "false");
    assert.deepEqual(asked, [{ owner: "acme", repo: "widgets", username: "outsider" }]);
  });

  for (const permission of ["write", "maintain", "admin"]) {
    test(`a pusher with ${permission} -> trusted`, async () => {
      assert.equal((await resolve({ sender: "maint2", permission })).rec.outputs.pusher_trusted, "true");
    });
  }

  for (const permission of ["read", "triage", "none"]) {
    test(`a pusher with ${permission} -> not trusted`, async () => {
      assert.equal((await resolve({ sender: "someone", permission })).rec.outputs.pusher_trusted, "false");
    });
  }

  test("GitHub cannot say -> not trusted (fail closed)", async () => {
    assert.equal((await resolve({ sender: "someone", fail: true })).rec.outputs.pusher_trusted, "false");
  });

  test("the author pushing to their own fork is the author's gate's business -> not asked", async () => {
    const { rec, asked } = await resolve({ sender: "maint", prOpts: { author: "maint" } });
    assert.equal(rec.outputs.pusher_trusted, "n/a");
    assert.deepEqual(asked, []);
  });

  test("a same-repository head -> not asked (only people with push access can push there)", async () => {
    const { rec, asked } = await resolve({ sender: "outsider", prOpts: { head: "acme/widgets" } });
    assert.equal(rec.outputs.pusher_trusted, "n/a");
    assert.deepEqual(asked, []);
  });

  test("a deleted head repository counts as a fork", async () => {
    assert.equal((await resolve({ sender: "outsider", prOpts: { head: null } })).rec.outputs.pusher_trusted, "false");
  });

  for (const action of ["opened", "reopened", "ready_for_review"]) {
    test(`${action} moves no code -> not asked`, async () => {
      const { rec, asked } = await resolve({ action, sender: "outsider" });
      assert.equal(rec.outputs.pusher_trusted, "n/a");
      assert.deepEqual(asked, []);
    });
  }

  test("plain pull_request is judged the same", async () => {
    assert.equal((await resolve({ event: "pull_request", sender: "outsider" })).rec.outputs.pusher_trusted, "false");
  });
});

function gate({ trusted, pusher = "outsider", authors = "", isPrivate = "false", assoc = "MEMBER", event = "pull_request_target" }) {
  const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(out, "");
  const r = runBashStep(step("settings").run, {
    env: {
      GATEWAY_URL_CHECK: path.join(ROOT, "scripts", "gateway-url.mjs"),
      ORCAROUTER_URL: "https://api.orcarouter.ai/v1/chat/completions",
      SETTINGS_ENABLED: "false",
      INPUT_FIX_FIRST: "P0,P1",
      INPUT_BLOCK_ON: "P0,P1",
      EVENT_NAME: event,
      IS_DRAFT: "false",
      AUTHOR_ASSOC: assoc,
      AUTO_REVIEW_AUTHORS: authors,
      REPO_PRIVATE: isPrivate,
      PUSHER: pusher,
      PUSHER_TRUSTED: trusted,
      BRAND: "OrcaCode Review",
      GITHUB_OUTPUT: out,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(
    fs.readFileSync(out, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

describe("the settings gate holds the pusher to the allowlist too", () => {
  test("an untrusted pusher on a public repo -> skip, naming them", () => {
    const o = gate({ trusted: "false" });
    assert.equal(o.decision, "skip");
    assert.match(o.reason, /outsider/);
    assert.match(o.reason, /write/);
  });

  test("a trusted pusher, or no question asked -> review", () => {
    assert.equal(gate({ trusted: "true" }).decision, "review");
    assert.equal(gate({ trusted: "n/a" }).decision, "review");
    assert.equal(gate({ trusted: "" }).decision, "review", "a step that never ran says nothing either way");
  });

  test('auto-review-authors that lets everyone through ("*", or unset on a private repo) does not ask', () => {
    assert.equal(gate({ trusted: "false", authors: "*" }).decision, "review");
    assert.equal(gate({ trusted: "false", isPrivate: "true" }).decision, "review");
  });

  test("an explicit narrower list asks", () => {
    assert.equal(gate({ trusted: "false", authors: "OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR" }).decision, "skip");
  });

  test("the comment command is not an automatic review: never asked here", () => {
    assert.equal(gate({ trusted: "false", event: "issue_comment" }).decision, "review");
  });

  test("the step is handed the pusher's verdict", () => {
    const env = step("settings").env;
    assert.equal(env.PUSHER, "${{ steps.pr.outputs.pusher }}");
    assert.equal(env.PUSHER_TRUSTED, "${{ steps.pr.outputs.pusher_trusted }}");
  });
});
