// Contract tests for authority.mjs — the single settlement decision behind
// reactions and the clean-verdict post.
//
// Three findings shared one root: nothing in the composite action established
// which invocation was authoritative, so every publication and every reaction
// was decided from one run's local view. The mechanism lives here so it can
// be exercised without adding another condition at each call site.
//
// Pins:
//   1. Custom App identity is resolved (create-response, /user, installation
//      slug), not guessed as github-actions[bot].
//   2. Latest-run-authoritative: a stale sibling cannot settle, even on the
//      same head.
//   3. A superseded head cannot publish a clean verdict — unknown current
//      head counts as moved.
//
// The driver (action.yml) is pinned to consult this script rather than
// re-implement the fallback, so the two cannot drift apart silently again.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  GITHUB_ACTIONS_BOT,
  resolveActorLogin,
  tokenIsUser,
  isAuthoritative,
  notAuthoritativeReason,
  relevantSiblings,
  settle,
} from "./authority.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const AUTHORITY = join(SCRIPTS, "authority.mjs");
const ACTION = join(SCRIPTS, "..", "action.yml");

function cli(args) {
  return JSON.parse(execFileSync("node", [AUTHORITY, "--settle", ...args], { encoding: "utf8" }));
}

describe("resolveActorLogin", () => {
  test("the login a reaction-create returned wins — that is who we must delete", () => {
    assert.equal(
      resolveActorLogin({
        createdByLogin: "custom-app[bot]",
        userLogin: "someone",
        appSlug: "other-app",
      }),
      "custom-app[bot]",
    );
  });

  test("/user login is used when nothing was carried from create", () => {
    assert.equal(resolveActorLogin({ userLogin: "my-bot[bot]" }), "my-bot[bot]");
  });

  test("installation app_slug becomes {slug}[bot]", () => {
    assert.equal(resolveActorLogin({ appSlug: "orcacode-review" }), "orcacode-review[bot]");
  });

  test("an app_slug that already carries [bot] is not doubled", () => {
    assert.equal(resolveActorLogin({ appSlug: "orcacode-review[bot]" }), "orcacode-review[bot]");
  });

  test("empty /user (installation token) does not beat a carried identity", () => {
    assert.equal(
      resolveActorLogin({ userLogin: "", createdByLogin: "custom-app[bot]" }),
      "custom-app[bot]",
    );
  });

  test("jq's literal null is not a login — that was the #43 trap one layer up", () => {
    assert.equal(
      resolveActorLogin({ userLogin: "null", createdByLogin: "null", appSlug: "null" }),
      GITHUB_ACTIONS_BOT,
    );
  });

  test("only when every source is empty do we fall back to github-actions[bot]", () => {
    assert.equal(resolveActorLogin({}), GITHUB_ACTIONS_BOT);
    assert.equal(resolveActorLogin({ userLogin: "", createdByLogin: "  ", appSlug: undefined }), GITHUB_ACTIONS_BOT);
  });
});

describe("tokenIsUser", () => {
  test("only an explicit User declines — empty/Bot/403-shaped values react", () => {
    assert.equal(tokenIsUser("User"), true);
    assert.equal(tokenIsUser("Bot"), false);
    assert.equal(tokenIsUser(""), false);
    assert.equal(tokenIsUser(undefined), false);
    assert.equal(tokenIsUser("null"), false);
  });
});

describe("isAuthoritative / latest-run", () => {
  const head = "abc123";

  test("unknown current head is not evidence this run still describes it", () => {
    assert.equal(isAuthoritative({ reviewedSha: head, currentSha: "" }), false);
    assert.equal(isAuthoritative({ reviewedSha: head, currentSha: "null" }), false);
    assert.match(notAuthoritativeReason({ reviewedSha: head, currentSha: "" }), /unknown/);
  });

  test("unknown reviewed head cannot publish", () => {
    assert.equal(isAuthoritative({ reviewedSha: "", currentSha: head }), false);
  });

  test("a superseded head is not authoritative", () => {
    assert.equal(isAuthoritative({ reviewedSha: head, currentSha: "def456" }), false);
    assert.match(
      notAuthoritativeReason({ reviewedSha: head, currentSha: "def456" }),
      /abc123 vs def456/,
    );
  });

  test("matching heads with no sibling evidence -> authoritative", () => {
    assert.equal(isAuthoritative({ reviewedSha: head, currentSha: head, thisRunId: "10" }), true);
    assert.equal(isAuthoritative({ reviewedSha: head, currentSha: head, siblingRuns: [] }), true);
  });

  test("an older sibling on the same head does not steal authority", () => {
    assert.equal(
      isAuthoritative({
        reviewedSha: head,
        currentSha: head,
        thisRunId: "20",
        siblingRuns: [{ id: 10 }, { id: 20 }],
      }),
      true,
    );
  });

  test("a newer sibling on the same head is the authority — this run stands down", () => {
    assert.equal(
      isAuthoritative({
        reviewedSha: head,
        currentSha: head,
        thisRunId: "10",
        siblingRuns: [{ id: 10 }, { id: 11 }],
      }),
      false,
    );
    assert.match(
      notAuthoritativeReason({
        reviewedSha: head,
        currentSha: head,
        thisRunId: "10",
        siblingRuns: [{ id: 11 }],
      }),
      /newer run \(11\)/,
    );
  });

  test("a sibling from another workflow is ignored when --workflow is set", () => {
    assert.equal(
      isAuthoritative({
        reviewedSha: head,
        currentSha: head,
        thisRunId: "10",
        workflow: "OrcaCode Review",
        siblingRuns: [
          { id: 99, name: "CI" },
          { id: 10, name: "OrcaCode Review" },
        ],
      }),
      true,
    );
  });

  test("same-workflow newer sibling still wins after the name filter", () => {
    assert.equal(
      isAuthoritative({
        reviewedSha: head,
        currentSha: head,
        thisRunId: "10",
        workflow: "OrcaCode Review",
        siblingRuns: [
          { id: 12, name: "OrcaCode Review" },
          { id: 10, name: "OrcaCode Review" },
        ],
      }),
      false,
    );
  });

  test("relevantSiblings drops nameless-id-less rows and keeps pre-scoped {id} rows", () => {
    assert.deepEqual(relevantSiblings([{ id: 1 }, { name: "x" }, null], { workflow: "x" }), [{ id: 1 }]);
  });
});

describe("settle — one plan for publication and reactions", () => {
  const current = {
    reviewedSha: "abc",
    currentSha: "abc",
    thisRunId: "5",
    createdByLogin: "custom-app[bot]",
  };

  test("authoritative clean run: clear 👀, add 👍, allowed to publish clean", () => {
    const plan = settle({ ...current, clean: true });
    assert.equal(plan.actor, "custom-app[bot]");
    assert.equal(plan.authoritative, true);
    assert.equal(plan.manageReactions, true);
    assert.equal(plan.publishClean, true);
    assert.equal(plan.clearEyes, true);
    assert.equal(plan.addThumb, true);
    assert.equal(plan.reason, "this run is authoritative");
  });

  test("authoritative findings run: clear 👀, do not add 👍, still may publish clean if it had one", () => {
    const plan = settle({ ...current, clean: false });
    assert.equal(plan.clearEyes, true);
    assert.equal(plan.addThumb, false);
    assert.equal(plan.publishClean, true);
  });

  test("stale run on a superseded head: no clean verdict, no reaction writes", () => {
    const plan = settle({
      ...current,
      currentSha: "newer",
      clean: true,
    });
    assert.equal(plan.authoritative, false);
    assert.equal(plan.publishClean, false);
    assert.equal(plan.clearEyes, false);
    assert.equal(plan.addThumb, false);
    assert.match(plan.reason, /abc vs newer/);
    // Identity is still resolved so a log can name who we would have acted as.
    assert.equal(plan.actor, "custom-app[bot]");
  });

  test("stale run finishing after a newer sibling does not add or clear", () => {
    const plan = settle({
      ...current,
      thisRunId: "5",
      siblingRuns: [{ id: 9 }],
      clean: true,
    });
    assert.equal(plan.authoritative, false);
    assert.equal(plan.publishClean, false);
    assert.equal(plan.clearEyes, false);
    assert.equal(plan.addThumb, false);
    assert.match(plan.reason, /newer run \(9\)/);
  });

  test("a User token never manages reactions, but an authoritative one may still publish", () => {
    const plan = settle({ ...current, tokenType: "User", clean: true });
    assert.equal(plan.manageReactions, false);
    assert.equal(plan.clearEyes, false);
    assert.equal(plan.addThumb, false);
    assert.equal(plan.publishClean, true);
    assert.equal(plan.actor, "");
    assert.match(plan.reason, /belongs to a user/);
  });

  test("a User token on a superseded head publishes nothing", () => {
    const plan = settle({ ...current, tokenType: "User", currentSha: "moved", clean: true });
    assert.equal(plan.publishClean, false);
    assert.equal(plan.manageReactions, false);
  });

  test("installation-token identity (no /user) uses the create-response login", () => {
    const plan = settle({
      ...current,
      tokenType: "",
      userLogin: "",
      createdByLogin: "acme-review[bot]",
      clean: true,
    });
    assert.equal(plan.actor, "acme-review[bot]");
    assert.equal(plan.clearEyes, true);
  });

  test("installation-token identity with only an app slug, no create-response", () => {
    const plan = settle({
      reviewedSha: "abc",
      currentSha: "abc",
      userLogin: "",
      createdByLogin: "",
      appSlug: "acme-review",
      clean: true,
    });
    assert.equal(plan.actor, "acme-review[bot]");
  });
});

describe("CLI", () => {
  test("--settle prints the plan and exits 0 (a planner glitch must not fail the job)", () => {
    const plan = cli([
      "--reviewed",
      "abc",
      "--current",
      "abc",
      "--run-id",
      "3",
      "--created-by",
      "custom-app[bot]",
      "--clean",
    ]);
    assert.equal(plan.addThumb, true);
    assert.equal(plan.actor, "custom-app[bot]");
  });

  test("garbage --siblings is no sibling evidence, not a crash", () => {
    const plan = cli(["--reviewed", "abc", "--current", "abc", "--siblings", "not-json"]);
    assert.equal(plan.authoritative, true);
  });

  test("missing --settle is usage (exit 2)", () => {
    const r = spawnSync("node", [AUTHORITY], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });

  test("a newer sibling via --siblings and --workflow stands this run down", () => {
    const plan = cli([
      "--reviewed",
      "abc",
      "--current",
      "abc",
      "--run-id",
      "1",
      "--workflow",
      "OrcaCode Review",
      "--siblings",
      JSON.stringify([
        { id: 2, name: "OrcaCode Review" },
        { id: 99, name: "CI" },
      ]),
      "--clean",
    ]);
    assert.equal(plan.authoritative, false);
    assert.equal(plan.addThumb, false);
    assert.equal(plan.publishClean, false);
  });
});

describe("action.yml wiring", () => {
  const yml = readFileSync(ACTION, "utf8").replace(/\r\n/g, "\n");

  test("both publication and settlement consult this script — no leftover bash guess", () => {
    assert.match(yml, /scripts\/authority\.mjs/, "the planner must be wired");
    assert.match(yml, /publishClean/, "the clean post must honour the planner");
    assert.match(yml, /clearEyes/, "the settle step must honour the planner");
    assert.match(yml, /addThumb/, "the thumb must come from the planner, not a local if");
    // THE BUG. The settle step used to do `[ -n "$ME" ] || ME="github-actions[bot]"`
    // after an empty /user, so a custom App's 👀 was never the login it filtered
    // on. The fallback lives in this module now, behind the other sources.
    assert.doesNotMatch(
      yml,
      /ME=.*github-actions\[bot\]/,
      "action.yml must not hard-code the Actions bot as the settle identity",
    );
  });

  test("the 👀 create carries the author login so settle does not have to guess", () => {
    assert.match(yml, /cr-actor/, "create must persist the observed login");
    assert.match(yml, /\.user\.login/, "create reads the identity the POST returned");
    const stale = yml.indexOf("- name: Clear stale run files");
    const cleanup = yml.indexOf("- name: Clean up engine output");
    const react = yml.indexOf("- name: React 👀 to acknowledge review request");
    assert.ok(stale > 0 && cleanup > stale && react > stale, "cleanup steps exist");
    const staleBlock = yml.slice(stale, react);
    const cleanupBlock = yml.slice(cleanup);
    assert.match(staleBlock, /cr-actor/, "stale-file wipe includes the carried identity");
    assert.match(cleanupBlock, /cr-actor/, "end-of-run wipe includes the carried identity");
  });

  test("the clean verdict is planned before it is posted, not after in reaction settlement", () => {
    const post = yml.indexOf("- name: Post review comments");
    const settleStep = yml.indexOf("- name: Settle the review reactions");
    const publishClean = yml.indexOf("publishClean");
    assert.ok(post > 0 && settleStep > post, "post then settle");
    assert.ok(publishClean > post && publishClean < settleStep, "authority is consulted inside the post step");
  });
});
