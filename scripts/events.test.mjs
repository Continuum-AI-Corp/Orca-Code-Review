// Which events the action acts on, who may spend the key, and what the shipped
// workflows trigger on — run through the YAML parser, with the action's own
// code executed against GitHub doubles.
//
//   CR-12  The action used to trust the workflow's `if:` to keep outsiders'
//          comments out; the README quickstart showed a bare `uses:` with no
//          such `if:`. "Resolve PR refs" now refuses an issue_comment run
//          unless it is on a pull request, its body is the review command, and
//          the commenter is OWNER/MEMBER/COLLABORATOR — whatever the workflow.
//   CR-2   auto-review-authors defaulted to everyone, so on a PUBLIC repo any
//          fork PR spent the workspace's wallet. Unset now means
//          OWNER,MEMBER,COLLABORATOR on a public repo (and when visibility is
//          unknown); private repos keep "everyone"; "*" opts back in to everyone.
//   CR-5   An `edited` PR event runs only when the base changed (a retarget
//          re-reviews; a title edit does not) — see workflows.test.mjs for the
//          triggers the shipped workflows add.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { step, actionSteps, runBashStep, runGithubScript, fakeCore } from "./test-helpers/action-yaml.mjs";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "events-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------ Resolve PR refs

async function resolve(eventName, payload) {
  const { core, rec } = fakeCore();
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { base: { ref: "main" }, head: { sha: "headsha" }, draft: false, author_association: "NONE" } }),
      },
    },
  };
  const context = {
    eventName,
    payload: { repository: { default_branch: "main", private: false }, ...payload },
    repo: { owner: "acme", repo: "widgets" },
    issue: { number: payload.issue?.number ?? payload.pull_request?.number ?? 0 },
  };
  await runGithubScript(step("pr").with.script, { github, context, core });
  return rec;
}

const prEvent = (action, extra = {}) => ({
  action,
  pull_request: {
    number: 7,
    base: { ref: "main" },
    head: { sha: "headsha" },
    draft: false,
    author_association: "CONTRIBUTOR",
  },
  ...extra,
});
const commentEvent = (body, association, onPr = true) => ({
  action: "created",
  issue: { number: 7, ...(onPr ? { pull_request: { url: "x" } } : {}) },
  comment: { id: 1, body, author_association: association },
});

describe("Resolve PR refs: only a maintainer's review command on a PR runs a comment-triggered review", () => {
  for (const cmd of ["/orcacode-review", "/orcacode review", "@orcacode-review", "@orcacode review please"]) {
    test(`MEMBER "${cmd}" -> runs`, async () => {
      const rec = await resolve("issue_comment", commentEvent(cmd, "MEMBER"));
      assert.equal(rec.outputs.run, "true");
      assert.equal(rec.outputs.head_sha, "headsha");
    });
  }

  for (const assoc of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", ""]) {
    test(`${assoc || "(missing)"} "/orcacode-review" -> refused`, async () => {
      const rec = await resolve("issue_comment", commentEvent("/orcacode-review", assoc));
      assert.equal(rec.outputs.run, "false");
      assert.equal(rec.failed, null, "a refusal is a no-op, not a failed job");
    });
  }

  test("a maintainer's ordinary comment -> no run", async () => {
    assert.equal((await resolve("issue_comment", commentEvent("LGTM, merging", "OWNER"))).outputs.run, "false");
  });

  test("a near-miss command (/orcacode-reviewer) -> no run", async () => {
    assert.equal((await resolve("issue_comment", commentEvent("/orcacode-reviewer", "OWNER"))).outputs.run, "false");
  });

  test("the command on a plain issue (not a PR) -> no run", async () => {
    assert.equal((await resolve("issue_comment", commentEvent("/orcacode-review", "OWNER", false))).outputs.run, "false");
  });
});

describe("Resolve PR refs: pull_request_target events", () => {
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
    test(`${action} -> runs`, async () => {
      assert.equal((await resolve("pull_request_target", prEvent(action))).outputs.run, "true");
    });
  }

  test("edited without a base change (title, body) -> no run", async () => {
    const rec = await resolve("pull_request_target", prEvent("edited", { changes: { title: { from: "x" } } }));
    assert.equal(rec.outputs.run, "false");
  });

  test("edited with a base change (retargeted) -> runs against the new base", async () => {
    const rec = await resolve("pull_request_target", prEvent("edited", { changes: { base: { ref: { from: "old" } } } }));
    assert.equal(rec.outputs.run, "true");
    assert.equal(rec.outputs.base, "main");
  });

  test("repository visibility is passed on ('true' only for a private repo)", async () => {
    assert.equal((await resolve("pull_request_target", prEvent("opened"))).outputs.repo_private, "false");
    const priv = await resolve("pull_request_target", { ...prEvent("opened"), repository: { default_branch: "main", private: true } });
    assert.equal(priv.outputs.repo_private, "true");
  });
});

describe("every step after the ref resolver is gated on its verdict", () => {
  test("nothing runs when Resolve PR refs says run=false (no reaction, no settings fetch, no spend)", () => {
    const steps = actionSteps();
    const after = steps.slice(steps.findIndex((s) => s.id === "pr") + 1);
    for (const s of after) {
      const cond = String(s.if || "");
      if (s.name === "Clean up engine output" || s.name === "Token accounting") continue;
      assert.ok(
        // The guard runs only after a settings `review`, so gating on its
        // decision is gating on the resolver's verdict transitively.
        /steps\.pr\.outputs\.run == 'true'/.test(cond) ||
          /steps\.(settings|guard)\.outputs\.decision == '(review|skip)'/.test(cond),
        `${s.name || s.uses}: if: ${cond || "(none)"}`,
      );
    }
  });

  test("no step is gated on `decision != 'skip'` (an absent decision must run nothing)", () => {
    for (const s of actionSteps()) {
      assert.doesNotMatch(String(s.if || ""), /!= 'skip'/, `${s.name}: ${s.if}`);
    }
  });
});

// ------------------------------------------------------- auto-review-authors

function settingsDecision({ authors = "", assoc = "NONE", isPrivate = "false", event = "pull_request_target" }) {
  const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(out, "");
  const r = runBashStep(step("settings").run, {
    env: {
      SETTINGS_ENABLED: "false",
      INPUT_FIX_FIRST: "P0,P1",
      INPUT_BLOCK_ON: "P0,P1",
      EVENT_NAME: event,
      IS_DRAFT: "false",
      AUTHOR_ASSOC: assoc,
      AUTO_REVIEW_AUTHORS: authors,
      REPO_PRIVATE: isPrivate,
      BRAND: "OrcaCode Review",
      GITHUB_OUTPUT: out,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(
    fs
      .readFileSync(out, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

describe("auto-review-authors: unset is safe on a public repository", () => {
  test("public + unset + an outsider (NONE) -> skip", () => {
    const o = settingsDecision({ assoc: "NONE" });
    assert.equal(o.decision, "skip");
    assert.match(o.reason, /auto-review-authors/);
  });

  for (const assoc of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    test(`public + unset + ${assoc} -> review`, () => {
      assert.equal(settingsDecision({ assoc }).decision, "review");
    });
  }

  test("public + unset + CONTRIBUTOR -> skip (a past contributor is still not a maintainer)", () => {
    assert.equal(settingsDecision({ assoc: "CONTRIBUTOR" }).decision, "skip");
  });

  test("unknown visibility is treated as public", () => {
    assert.equal(settingsDecision({ assoc: "NONE", isPrivate: "" }).decision, "skip");
  });

  test("private + unset + NONE -> review (private repos keep today's default)", () => {
    assert.equal(settingsDecision({ assoc: "NONE", isPrivate: "true" }).decision, "review");
  });

  test('"*" opts a public repo back in to reviewing everyone', () => {
    assert.equal(settingsDecision({ authors: "*", assoc: "NONE" }).decision, "review");
  });

  test("an explicit list still wins", () => {
    assert.equal(settingsDecision({ authors: "OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR", assoc: "CONTRIBUTOR" }).decision, "review");
  });

  test("a maintainer's comment command is never stopped by the allowlist", () => {
    assert.equal(settingsDecision({ assoc: "NONE", event: "issue_comment" }).decision, "review");
  });
});
