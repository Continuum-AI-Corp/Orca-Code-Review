// Shared severity parsing for the OrcaCode Review scripts.
//
// One module owns the rule "which severity is this finding?" so the merge gate
// (gate.mjs), the control-plane run report (report.mjs), and the PR summary
// comment (summary-comment.mjs) can never drift apart:
//
//   - Only a LEADING [P0]/[P1]/[P2]/[P3] tag counts (case-insensitive). A tag
//     mentioned later in prose or a code example must not override the
//     fail-safe below, otherwise an untagged finding could promote a PR and
//     slip past P0/P1 gating.
//   - An untagged finding defaults to P1 (fail-safe): the model is instructed
//     to tag every comment, and a missing tag must escalate for another look
//     rather than pass as advisory.
//
// P2 vs P3: P2 is a real-but-conditional bug (fires only under a precondition
// the code doesn't normally meet); P3 is a pure style/maintainability nit. Both
// are non-blocking, but the split keeps the summary honest and mirrors Codex.

export const SEVERITIES = ["P0", "P1", "P2", "P3"];

// Severity of one `ocr review --format json` comment.
export function severityOf(comment) {
  const m = String(comment?.content || "").match(/^\s*\[(P[0-3])\]/i);
  return m ? m[1].toUpperCase() : "P1";
}

// {P0: n, P1: n, P2: n, P3: n} for a result's comments array — always all keys,
// zeroed, so consumers can render/report counts without existence checks.
export function countSeverities(comments) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const c of Array.isArray(comments) ? comments : []) counts[severityOf(c)] += 1;
  return counts;
}

// Rank for "which is more severe": lower is worse. Folding findings together
// (dedupe, exhaustive merge, judge clusters) keeps the most severe tag among
// what it folds — a stage that merges must never be the one that lowers a P0.
export const RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

export const moreSevere = (a, b) => (RANK[a] <= RANK[b] ? a : b);

// `comment` with its leading tag set to `sev` (added when it had none). The
// rest of the comment is untouched.
export function withSeverity(comment, sev) {
  const content = String(comment?.content || "");
  const m = content.match(/^\s*\[(P[0-3])\]\s*/i);
  const body = m ? content.slice(m[0].length) : content.replace(/^\s+/, "");
  return { ...comment, content: `[${sev}] ${body}` };
}

// A finding about security: what the judge must never drop, whatever it
// scores it. Deliberately broad — a false positive only keeps a finding the
// reader then dismisses; a false negative lets a model talk a real one away.
const SECURITY_RE =
  /\b(?:security|vulnerab\w*|exploit\w*|inject\w*|xss|csrf|ssrf|rce|remote code execution|authenticat\w*|authori[sz]\w*|authn|authz|access[- ]control|privilege\w*|credential\w*|secrets?|api[- ]?keys?|passwords?|deseriali[sz]\w*|path traversal|directory traversal|sandbox\w*|exfiltrat\w*|cve-\d{4}-\d+)\b/i;

export function isSecurityFinding(comment) {
  return SECURITY_RE.test(String(comment?.content || ""));
}
