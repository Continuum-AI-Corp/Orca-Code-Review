// WHO THE ACTION POSTS AS — the one funnel that decides which comments are the
// action's own.
//
// The action finds its earlier comments by an HTML marker (<!-- orca-code-
// review-* -->) to edit a notice in place or delete a stale one. A marker
// counts only in a comment its own identity wrote; otherwise anyone could plant
// one and have the action edit or delete THEIR comment. So the identity must be
// right, and must never be a guess:
//
//   1. the `bot-login` input, when the workflow sets it (a custom GitHub App:
//      "my-app[bot]");
//   2. else the token's user (users.getAuthenticated — a personal token);
//   3. else github-actions[bot], but ONLY when github-token is the job's own
//      GITHUB_TOKEN — the one installation token whose author we know;
//   4. else unknown, until the action's first comment or review in this run:
//      GitHub reports its author back, and that login is recorded in
//      $RUNNER_TEMP/cr-identity for the rest of the run.
// Unknown matches nothing — post anew, edit and delete nothing.
//
// Steps 1-3 run once ("Resolve PR refs", resolveIdentity) and reach every later
// step as BOT_LOGIN; step 4 is recorded by guardGithub (publish-guard.mjs) on
// the way back from every comment or review it creates.

import fs from "node:fs";
import path from "node:path";

export const JOB_TOKEN_LOGIN = "github-actions[bot]";
const FILE = "cr-identity";

// A GitHub login (alphanumerics and single hyphens, up to 39) or an App's bot
// login (the same with "[bot]").
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;
const valid = (l) => typeof l === "string" && LOGIN.test(l);

const recordPath = () => (process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, FILE) : null);

/** Steps 1-3. `{ login: "" }` when only step 4 can tell. */
export async function resolveIdentity({ github, botLogin = "", tokenIsJobToken = false } = {}) {
  const explicit = String(botLogin || "").trim();
  if (explicit) {
    if (!valid(explicit)) throw new Error(`bot-login ${JSON.stringify(explicit)} is not a GitHub login`);
    return { login: explicit, source: "the bot-login input" };
  }
  try {
    const { data } = await github.rest.users.getAuthenticated();
    if (valid(data?.login)) return { login: data.login, source: "the token's user" };
  } catch {
    // An installation token has no user: fall through.
  }
  if (tokenIsJobToken) return { login: JOB_TOKEN_LOGIN, source: "the job's GITHUB_TOKEN" };
  return { login: "", source: "unknown until the action posts in this run (set bot-login)" };
}

/** The identity for this step: the resolved one, else the one recorded this run. */
export function ownLogin() {
  const resolved = String(process.env.BOT_LOGIN || "").trim();
  if (resolved) return resolved;
  const p = recordPath();
  if (!p) return "";
  try {
    const l = fs.readFileSync(p, "utf8").trim();
    return valid(l) ? l : "";
  } catch {
    return "";
  }
}

/** Step 4: learn the identity from what GitHub says the action just created. */
export function recordIdentity(response) {
  if (ownLogin()) return;
  const login = response?.data?.user?.login;
  const p = recordPath();
  if (!p || !valid(login)) return;
  try {
    fs.writeFileSync(p, login, { flag: "wx", mode: 0o600 }); // the first one wins
  } catch {
    // Already recorded (or RUNNER_TEMP is not writable): nothing to learn.
  }
}

/** Is this comment the action's own? False whenever the identity is unknown. */
export function isOwn(comment) {
  const login = ownLogin();
  return Boolean(login) && Boolean(comment?.body) && comment?.user?.login === login;
}
