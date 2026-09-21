#!/usr/bin/env node
// Authoritative-run settlement for the OrcaCode Review action.
//
// One decision, not a guard per call site. The reaction logic used to live in
// bash inside action.yml, which is why five review rounds found what no test
// did: every publication and every reaction was decided from one run's local
// view, and each fix added a condition (an identity match, a recorded id, a
// status code, a head comparison) at the site that had just failed.
//
// This module is the mechanism those three findings wanted. The driver
// gathers facts — token type, the login a reaction-create already returned,
// /user, the installation's app slug, the head this run reviewed, the head
// the PR has now, this run's id, sibling runs — and `settle()` answers what
// that invocation may do. Both the clean-verdict post and the always()
// reaction step consult the same function.
//
//   node authority.mjs --settle [--token-type User|Bot] [--user-login …]
//     [--created-by …] [--app-slug …] --reviewed <sha> --current <sha>
//     [--run-id <n>] [--workflow <name>] [--siblings <json>] [--clean]
//
// Prints one JSON object and ALWAYS exits 0 on --settle — a settlement
// glitch must not fail the review:
//
//   { actor, authoritative, manageReactions, publishClean, clearEyes,
//     addThumb, reason }
//
// Identity: GET /user has no authenticated user for an installation token,
// so the old fallback guessed github-actions[bot]. A custom App creates
// reactions as custom-app[bot] and the delete filter never matched. Prefer
// the login the create already returned; then /user; then {app_slug}[bot]
// from the installation; then github-actions[bot] for the default Actions
// token.
//
// Authority: this run is authoritative only when it still describes the
// current head (an unknown current head is "no" — "could not tell" is not
// evidence that it did not move) AND no sibling run of the same workflow
// is newer. Only the authoritative run publishes a clean verdict or
// settles reactions. A stale run finishing after a newer one therefore
// cannot withdraw a current thumb, leave a leftover 👀, or post
// "✅ No findings" for a superseded head.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GITHUB_ACTIONS_BOT = "github-actions[bot]";

// Empty, whitespace, and the literal strings jq prints for a missing field
// are all "no value". Installation tokens make `gh api user --jq .login`
// exit 0 and print nothing — or `null` — and the last time that was treated
// as a login the delete filter matched nobody.
function live(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "null" || s === "undefined") return "";
  return s;
}

export function resolveActorLogin({ userLogin, createdByLogin, appSlug } = {}) {
  const created = live(createdByLogin);
  if (created) return created;
  const user = live(userLogin);
  if (user) return user;
  const slug = live(appSlug);
  if (slug) return slug.endsWith("[bot]") ? slug : `${slug}[bot]`;
  return GITHUB_ACTIONS_BOT;
}

export function tokenIsUser(tokenType) {
  return live(tokenType) === "User";
}

// Sibling runs already scoped by the driver (same workflow / same PR head),
// or carrying a `name` we can filter with --workflow. A CI run with a
// higher id on a different workflow must not steal authority.
export function relevantSiblings(siblingRuns, { workflow } = {}) {
  const runs = Array.isArray(siblingRuns) ? siblingRuns : [];
  const wf = live(workflow);
  return runs.filter((r) => {
    if (!r || r.id == null || r.id === "") return false;
    if (!wf || !r.name) return true;
    return r.name === wf;
  });
}

export function notAuthoritativeReason({
  reviewedSha,
  currentSha,
  thisRunId,
  siblingRuns,
  workflow,
} = {}) {
  const reviewed = live(reviewedSha);
  const current = live(currentSha);
  if (!reviewed || !current) {
    return `cannot confirm this run still describes the PR head (${reviewed || "unknown"} vs ${current || "unknown"})`;
  }
  if (reviewed !== current) {
    return `cannot confirm this run still describes the PR head (${reviewed} vs ${current})`;
  }
  const self = Number(thisRunId);
  const newer = relevantSiblings(siblingRuns, { workflow }).find((r) => {
    const id = Number(r.id);
    return Number.isFinite(id) && Number.isFinite(self) && id > self;
  });
  if (newer) {
    return `a newer run (${newer.id}) is authoritative; this run is ${live(thisRunId) || "unknown"}`;
  }
  return "";
}

export function isAuthoritative(input = {}) {
  return notAuthoritativeReason(input) === "";
}

export function settle({
  tokenType,
  userLogin,
  createdByLogin,
  appSlug,
  reviewedSha,
  currentSha,
  thisRunId,
  siblingRuns,
  workflow,
  clean,
} = {}) {
  const facts = { reviewedSha, currentSha, thisRunId, siblingRuns, workflow };
  const authoritative = isAuthoritative(facts);
  const staleReason = notAuthoritativeReason(facts);
  const actor = resolveActorLogin({ userLogin, createdByLogin, appSlug });
  // A PAT-backed run still publishes a review. The user-token decline is
  // only about reactions: GitHub cannot tell ours from the token owner's.
  if (tokenIsUser(tokenType)) {
    return {
      actor: "",
      authoritative,
      manageReactions: false,
      publishClean: authoritative,
      clearEyes: false,
      addThumb: false,
      reason: authoritative
        ? "github-token belongs to a user, not an app; leaving reactions alone"
        : staleReason,
    };
  }
  if (!authoritative) {
    return {
      actor,
      authoritative: false,
      manageReactions: true,
      publishClean: false,
      clearEyes: false,
      addThumb: false,
      reason: staleReason,
    };
  }
  return {
    actor,
    authoritative: true,
    manageReactions: true,
    publishClean: true,
    clearEyes: true,
    addThumb: !!clean,
    reason: "this run is authoritative",
  };
}

function parseArgs(argv) {
  const opts = { siblings: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--settle") opts.settle = true;
    else if (a === "--clean") opts.clean = true;
    else if (a === "--token-type") opts.tokenType = argv[++i];
    else if (a === "--user-login") opts.userLogin = argv[++i];
    else if (a === "--created-by") opts.createdByLogin = argv[++i];
    else if (a === "--app-slug") opts.appSlug = argv[++i];
    else if (a === "--reviewed") opts.reviewedSha = argv[++i];
    else if (a === "--current") opts.currentSha = argv[++i];
    else if (a === "--run-id") opts.thisRunId = argv[++i];
    else if (a === "--workflow") opts.workflow = argv[++i];
    else if (a === "--siblings") {
      const raw = argv[++i] ?? "";
      try {
        const parsed = JSON.parse(raw);
        opts.siblings = Array.isArray(parsed) ? parsed : [];
      } catch {
        opts.siblings = [];
      }
    }
  }
  return opts;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.settle) {
    console.error(
      "usage: node authority.mjs --settle [--token-type User|Bot] [--user-login L] " +
        "[--created-by L] [--app-slug S] --reviewed SHA --current SHA " +
        "[--run-id N] [--workflow NAME] [--siblings JSON] [--clean]",
    );
    process.exit(2);
  }
  const plan = settle({
    tokenType: opts.tokenType,
    userLogin: opts.userLogin,
    createdByLogin: opts.createdByLogin,
    appSlug: opts.appSlug,
    reviewedSha: opts.reviewedSha,
    currentSha: opts.currentSha,
    thisRunId: opts.thisRunId,
    siblingRuns: opts.siblings,
    workflow: opts.workflow,
    clean: opts.clean,
  });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
