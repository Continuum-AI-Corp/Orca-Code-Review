// The commit status the action writes on the PR's head SHA at the end of every
// run — the merge-gate verdict that also reaches the PR from a comment-
// triggered (on-demand) run, whose own job check lands on the default branch.
//
// One pure function, so every ending is decided in one place and tested as a
// table. `success` means exactly one of two things: a review ran on this head
// and the severity gate passed it, or the diff was oversized and the workflow
// made that skip advisory on purpose (`on-oversized-diff: "pass"`). Everything
// else — a settings skip, a blocked gate, a gate that could not decide, an
// engine failure, a cancelled run, a run that never reached a decision — is not
// success.
//
// A SETTINGS SKIP IS NEVER SUCCESS HERE, whatever `on-skipped-review` says.
// That input decides the JOB, and it passes by default: failing the job on
// every on-demand, auto-review-off, draft or outsider PR broke every customer
// who requires the `review` job. This status is what a customer who wants
// "unreviewed cannot merge" makes required, and it says "Not reviewed".
//
// Inputs are the raw strings the step reads from step outputs/outcomes, so an
// absent value (a step that never ran) is "" and lands on a failing branch.

const MAX = 140; // GitHub's limit for a status description

const clip = (s) => (s.length <= MAX ? s : `${s.slice(0, MAX - 1)}…`);

export function decideStatus({
  decision = "",
  reason = "",
  guardDecision = "",
  guardReason = "",
  onSkipped = "", // the job's business only (see above); kept so callers pass one shape
  onOversized = "",
  reviewOutcome = "",
  enforceOutcome = "",
  verdict = "",
  blockOn = "",
} = {}) {
  const out = (state, description) => ({ state, description: clip(description) });

  if (decision === "skip") {
    return out("failure", `Not reviewed: ${reason} — a maintainer can comment /orcacode-review`);
  }
  if (decision !== "review") return out("error", "Review did not start");

  if (guardDecision === "skip") {
    return onOversized === "pass"
      ? out("success", `Review skipped (${guardReason}) — advisory`)
      : out("failure", `Review skipped (${guardReason}) — diff too large to review`);
  }
  if (guardDecision !== "review") return out("error", "Review did not start (size guard)");

  if (reviewOutcome !== "success") return out("error", "Review did not complete — see the run");
  if (enforceOutcome === "success" && verdict === "pass") {
    return out("success", `Reviewed — no ${blockOn || "blocking"} findings`);
  }
  if (verdict === "blocked") return out("failure", `Blocked — ${blockOn} finding(s)`);
  return out("error", "Review did not complete — see the run");
}
