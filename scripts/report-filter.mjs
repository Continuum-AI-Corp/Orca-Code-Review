#!/usr/bin/env node
// report_on severity filter.
//
//   node report-filter.mjs <result.json> --show P0,P1 --block-on P0,P1 --out <filtered.json>
//
// WHY THIS EXISTS. `report_on` is a per-workspace/per-repo setting ("Report
// severities" in the dashboard) that decides which severities are PUBLISHED. The
// Action did not apply it — it did not even parse the field — so a workspace
// that narrowed the setting had it silently ignored here. A knob that is offered
// and then not honoured is worse than one that does not exist.
//
// SHOW = report_on UNION block_on, and the union is the load-bearing part. A
// severity the workspace configured as merge-blocking must never be hidden by a
// display preference: "show me less" would otherwise quietly disable the gate
// the same workspace asked for. The gate itself keeps reading the UNfiltered
// result, so this cannot change what is enforced — only what is shown — but a
// blocked merge with no visible reason is its own defect.
//
// AND NOTHING ELSE MOVES. Not the severity tally, not the gate, not the clean
// marker, not the control-plane run report: those describe what the review
// FOUND. action.yml feeds the filtered file to the posting step only, exactly
// as it does for quiet mode.
//
// NO --show FLAG AT ALL means no filtering, which is not the same as an empty
// value. An empty --show is a legitimate configuration meaning "only what
// blocks" (the union leaves block_on behind); an absent flag means the driver
// had no setting to apply — a failed settings fetch, say — and display must
// fail OPEN in that case. Hiding findings because a fetch timed out would be
// the wrong direction on both counts.
//
// Severity comes from the shared severity.mjs (leading-tag-only parsing plus
// the untagged->P1 fail-safe), the same reader the gate, the quiet filter and
// the run report use. A third notion of severity in this repository is how the
// gate and the display would come to disagree about the same finding.
//
// Failure behavior mirrors quiet-filter.mjs: a missing or unparseable input
// writes an empty engine-shaped result and exits 0, because that is what the
// posting step's own try/catch would do with the raw file. Bad USAGE exits 2 —
// that is a wiring bug in action.yml and has to be loud.

import fs from "node:fs";
import { SEVERITIES, severityOf } from "./severity.mjs";

const usage = () => {
  console.error(
    "usage: node report-filter.mjs <result.json> [--show P0,P1] [--block-on P0,P1] --out <filtered.json>",
  );
  process.exit(2);
};

const [file, ...rest] = process.argv.slice(2);
if (!file) usage();

const opts = { show: null, blockOn: "P0,P1", out: null };
for (let i = 0; i < rest.length; i += 1) {
  const flag = rest[i];
  // A flag's VALUE is not another flag: catching that here turns a mangled
  // action.yml expansion (an empty `${{ ... }}` swallowing the next argument)
  // into a usage error instead of a silently wrong severity set.
  const value = rest[i + 1];
  if (flag === "--out") {
    if (value === undefined || value.startsWith("--")) usage();
    opts.out = value;
    i += 1;
  } else if (flag === "--show") {
    if (value === undefined || value.startsWith("--")) usage();
    opts.show = value;
    i += 1;
  } else if (flag === "--block-on") {
    if (value === undefined || value.startsWith("--")) usage();
    opts.blockOn = value;
    i += 1;
  } else {
    usage();
  }
}
if (!opts.out) usage();

const parseSet = (raw) => {
  const set = new Set();
  for (const piece of String(raw).split(",")) {
    const sev = piece.trim().toUpperCase();
    if (!sev) continue;
    // An unknown severity is a wiring bug, not a finding to drop. Loud, because
    // the alternative is a keep-set quietly missing a level nobody notices
    // until findings stop appearing.
    if (!SEVERITIES.includes(sev)) {
      console.error(`report-filter: unknown severity ${JSON.stringify(sev)}`);
      process.exit(2);
    }
    set.add(sev);
  }
  return set;
};

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  fs.writeFileSync(opts.out, JSON.stringify({ comments: [] }));
  process.stdout.write(`${JSON.stringify({ shown: 0, withheld: 0 })}\n`);
  process.exit(0);
}

const comments = Array.isArray(parsed?.comments) ? parsed.comments : [];

if (opts.show === null) {
  // Pass-through, byte-for-byte in shape: no setting was supplied, so there is
  // nothing to apply and nothing to report as withheld.
  fs.writeFileSync(opts.out, JSON.stringify({ ...parsed, comments }));
  process.stdout.write(`${JSON.stringify({ shown: comments.length, withheld: 0 })}\n`);
  process.exit(0);
}

const keep = parseSet(opts.show);
for (const sev of parseSet(opts.blockOn)) keep.add(sev);

const shown = comments.filter((c) => keep.has(severityOf(c)));
const withheld = comments.length - shown.length;

fs.writeFileSync(opts.out, JSON.stringify({ ...parsed, comments: shown }));
if (withheld > 0) {
  console.error(
    `report-filter: withheld ${withheld} of ${comments.length} finding(s) — shown ${[...keep].sort().join(",")}`,
  );
}
process.stdout.write(`${JSON.stringify({ shown: shown.length, withheld })}\n`);
