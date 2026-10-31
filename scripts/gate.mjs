#!/usr/bin/env node
// Severity gate for the OrcaCode Review action.
//
// Reads an `ocr review --format json` result file, extracts the [P0]/[P1]/[P2]/[P3]
// tag the model prefixes onto each comment, and answers one yes/no question:
// "does any finding carry a severity in the given set?"
//
//   node gate.mjs <result.json> --has P0,P1
//     exit 0  -> at least one finding matches (escalate / block)
//     exit 10 -> none match (converged / pass)
//     exit 2  -> usage error
//     exit 3  -> the result could not be read as a review result
//
// "No match" is deliberately NOT 1: node exits 1 on any uncaught exception, so
// a caller that read 1 as "pass" let a crashed gate clear the merge. Callers
// take 0 and 10 as the only answers and fail closed on everything else.
//
// The model is instructed to tag every comment; if one is still untagged we
// default it to P1 (fail-safe) so a missing tag escalates for a second look
// rather than being silently treated as advisory. A summary line is printed to
// stderr for the CI log.

import fs from "node:fs";
import { SEVERITIES, severityOf } from "./severity.mjs";

const EXIT = Object.freeze({ MATCH: 0, NO_MATCH: 10, USAGE: 2, UNREADABLE: 3 });

const [file, flag, listRaw] = process.argv.slice(2);

if (!file || flag !== "--has") {
  console.error("usage: node gate.mjs <result.json> --has P0,P1");
  process.exit(EXIT.USAGE);
}

const wanted = new Set(
  (listRaw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

let comments;
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed?.comments)) throw new Error("no `comments` array");
  comments = parsed.comments;
} catch (e) {
  // No readable review result. That is NOT a clean review: the caller decides
  // what an undecidable gate means, and the merge gate fails closed on it.
  console.error(`gate: could not read findings from ${file} (${e.message})`);
  process.exit(EXIT.UNREADABLE);
}

// Severity comes from the shared severity.mjs (leading-tag-only parsing plus
// the untagged->P1 fail-safe) so the gate, the control-plane run report
// (report.mjs), and the PR summary comment can never drift apart.

const counts = {};
let matched = false;
for (const c of comments) {
  const sev = severityOf(c);
  counts[sev] = (counts[sev] || 0) + 1;
  if (wanted.has(sev)) matched = true;
}

const breakdown =
  SEVERITIES
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(", ") || "none";

console.error(
  `gate: ${comments.length} finding(s) [${breakdown}] · match(${[...wanted].join(",") || "-"}) = ${matched}`,
);

process.exit(matched ? EXIT.MATCH : EXIT.NO_MATCH);
