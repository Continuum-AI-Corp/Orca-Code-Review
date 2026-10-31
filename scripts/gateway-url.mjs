#!/usr/bin/env node
// Where the OrcaRouter key may go: the one judge.
//
// The key travels as a Bearer header to `orcarouter-url` (the review proxy) and
// to the control plane derived from it (settings.mjs, report.mjs). In clear it
// may go only to this machine — the rule OrcaRouter's own gateway keeps for
// every credential it hands out: https anywhere; plain http only to localhost,
// 127.0.0.0/8 or [::1]. Asked where the URL is first read (the action's
// settings step, which fails the run with the message below) and again
// wherever the key meets it.
//
//   node scripts/gateway-url.mjs      judges $ORCAROUTER_URL; on a refusal prints
//                                     a ::error:: naming the input and the fix
//                                     and exits 1.

import { pathToFileURL } from "node:url";

const FIX =
  "Use an https:// URL — put TLS in front of a self-hosted gateway — or plain http only to " +
  "this machine (localhost, 127.0.0.0/8 or [::1]): over any other network the key would travel in clear.";

const isLoopback = (hostname) => {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "[::1]") return true;
  // WHATWG URL has already normalised IPv4 forms (127.1, 2130706433, 0x7f.1).
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};

/** null when the key may be sent to `raw`; otherwise why not, and what to do. */
export function gatewayUrlProblem(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    return `orcarouter-url is not a URL (${JSON.stringify(String(raw ?? "").slice(0, 100))}). ${FIX}`;
  }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && isLoopback(u.hostname)) return null;
  return `orcarouter-url must be https: ${u.protocol}//${u.host} would carry your OrcaRouter key. ${FIX}`;
}

/** The URL, or a thrown Error carrying the judge's message. */
export function checkedGatewayUrl(raw) {
  const problem = gatewayUrlProblem(raw);
  if (problem) throw new Error(problem);
  return new URL(raw);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problem = gatewayUrlProblem(process.env.ORCAROUTER_URL);
  if (problem) {
    console.log(`::error::${problem.replace(/[\r\n]+/g, " ")}`);
    process.exit(1);
  }
}
