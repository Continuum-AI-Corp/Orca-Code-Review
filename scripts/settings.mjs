#!/usr/bin/env node
// Dashboard settings fetch for the OrcaCode Review action.
//
//   node settings.mjs --url <orcarouter-url> --repo owner/name --out <path.json>
//   (the API key comes from ORCAROUTER_API_KEY in the env, never a flag)
//
// GETs <origin of --url>/api/code_review/settings?repo=<owner/name> (the
// /v1/… path of the chat-completions URL is stripped, same as report.mjs)
// with `Authorization: Bearer <key>`. The gateway answers
// {"success":true,"message":"","data":{auto_review, trigger, exhaustive,
// quiet, fix_first, block_on, rubric}} — always 200 with the EFFECTIVE
// settings for the repo.
//
// The validated settings object is written to --out AND printed to stdout,
// and the script ALWAYS exits 0:
//
//   - Envelope failure -> the built-in DEFAULTS below, with the fallback noted
//     on stderr, and CLASSIFIED in the file so the action can say which it was:
//       status "no_settings": the gateway ANSWERED that this key has none — a
//         4xx (an ordinary, non-CI key gets 403 here on every run) or
//         success:false. No retry: asking again changes nothing.
//       status "unavailable": an outage — a 5xx, 408/429, a timeout, a network
//         error, a body that is not the envelope — after one retry.
//     with `cause` naming it ("HTTP 403", "timed out after 5000ms", …). The
//     action then uses the WORKFLOW's inputs for the run either way (see the
//     "Fetch review settings" step); FAIL-OPEN: a settings outage must never
//     kill reviews.
//   - Field failure (unknown trigger, bad severity list, non-bool, non-string
//     rubric) -> that FIELD falls back to its default while valid fields are
//     kept; no retry (re-asking won't change a value the server meant).
//
// EVERY STAND-IN IS NAMED. Whenever a value in the file is a default standing
// in for one the server did not give us — every field on an envelope failure,
// the one field on a field failure — that field is listed in `unresolved`
// (absent when the server answered every field validly), so the action never
// mistakes a stand-in for a dashboard value: an unresolved block_on is
// replaced by the workflow's own block-on, never by this default.
//
// Severity lists are normalized (trim + uppercase); an explicit empty string
// is VALID and means "none" (e.g. block_on:"" = never block). A whitespace-
// only rubric is treated as empty (no override). 5s timeout per attempt.
//
// The precedence rule between these settings and explicit `with:` inputs
// (an input differing from its documented default wins) lives in action.yml's
// "Fetch review settings" step, not here — this script only reports what the
// server says.

import fs from "node:fs";
import { SEVERITIES } from "./severity.mjs";
import { controlPlaneBase } from "./control-plane.mjs";
import { gatewayUrlProblem } from "./gateway-url.mjs";

// Per attempt. CR_SETTINGS_TIMEOUT_MS overrides it (the tests use a short one).
const TIMEOUT_MS = Number(process.env.CR_SETTINGS_TIMEOUT_MS) > 0 ? Number(process.env.CR_SETTINGS_TIMEOUT_MS) : 5000;
const RETRY_PAUSE_MS = 500;
const ATTEMPTS = 2; // initial + one retry

// Keep in sync with the README table and settings.test.mjs.
const DEFAULTS = Object.freeze({
  auto_review: true,
  trigger: "every_push",
  exhaustive: false,
  quiet: false,
  fix_first: "P0,P1",
  block_on: "P0,P1",
  // THE VALUE THE GATEWAY WOULD HAVE GIVEN, which is the whole job of a failure
  // default: reproduce the answer we could not fetch.
  //
  // This used to be every severity, on the reasoning that a workspace predating
  // report_on resolved to all four, so no single value could match "what this
  // workspace normally sees" — and losing P2/P3 to a timeout was judged worse
  // than showing them once. That premise expired. The gateway's own default is
  // now P0,P1 for every workspace that has not set the field, so all-severities
  // matches nothing any more: on a settings outage it published P2/P3 to
  // installs that would never have been shown them.
  //
  // Which is not a cosmetic mistake here. These severities are the ones the
  // judge exists to filter, so an outage that opens this up is also the outage
  // most likely to have degraded the filtering.
  report_on: "P0,P1",
  rubric: "",
});

const TRIGGERS = new Set(["every_push", "ready_for_review", "on_demand"]);

// "P0, p1" -> "P0,P1"; "" -> "" (a valid, deliberate "none"); anything with a
// non-severity token (or a non-string) -> null (invalid — caller defaults).
function normalizeSeverityList(v) {
  if (typeof v !== "string") return null;
  const tokens = v
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (tokens.some((t) => !SEVERITIES.includes(t))) return null;
  return tokens.join(",");
}

// Field-wise validation: every invalid field falls back to its default and is
// noted on stderr; valid fields are kept.
function validateSettings(data) {
  const out = { ...DEFAULTS };
  const unresolved = [];
  const fallback = (field, got) => {
    unresolved.push(field);
    console.error(
      `settings: field "${field}" invalid (${JSON.stringify(got)}) — using default ${JSON.stringify(DEFAULTS[field])}`,
    );
  };

  for (const field of ["auto_review", "exhaustive", "quiet"]) {
    if (typeof data[field] === "boolean") out[field] = data[field];
    else fallback(field, data[field]);
  }

  if (TRIGGERS.has(data.trigger)) out.trigger = data.trigger;
  else fallback("trigger", data.trigger);

  // report_on rides in this loop because it is the same shape as the other two —
  // a comma-joined severity subset where "" is a deliberate "none" — but it
  // answers a different question: fix_first and block_on decide what the review
  // ENFORCES, report_on only what it SHOWS.
  //
  // A RESPONSE THAT OMITS THE FIELD LANDS ON THE DEFAULT ABOVE, and that is no
  // longer the same thing as "behaves as before" — this comment used to say so
  // and was left standing when the default moved from all four severities to
  // P0,P1. An omitted field now resolves to P0,P1, and since the report filter
  // shows report_on UNION block_on (block_on also defaulting to P0,P1), P2/P3
  // are not recovered anywhere else.
  //
  // Which is deliberate, and rests on a fact rather than on compatibility: the
  // gateway sets P0,P1 itself for every workspace that has not chosen a value,
  // so an omitted field means "this workspace never set one", not "this server
  // is too old to have the field". Reproducing the answer we could not fetch is
  // the whole job of a failure default, and the answer is P0,P1.
  for (const field of ["fix_first", "block_on", "report_on"]) {
    const normalized = normalizeSeverityList(data[field]);
    if (normalized !== null) out[field] = normalized;
    else fallback(field, data[field]);
  }

  if (typeof data.rubric === "string") {
    // Whitespace-only means "no override"; keep real text verbatim.
    out.rubric = data.rubric.trim() === "" ? "" : data.rubric;
  } else {
    fallback("rubric", data.rubric);
  }

  return unresolved.length ? { ...out, unresolved } : out;
}

// The built-in defaults, marked as stand-ins for every field, and why: what
// an envelope failure (or no usable arguments at all) writes.
const fallbackSettings = (status = "unavailable", cause = "unknown") => ({
  ...DEFAULTS,
  unresolved: Object.keys(DEFAULTS),
  status,
  cause: String(cause).replace(/[\r\n]+/g, " ").slice(0, 400),
});

// A failed fetch, classified: status "no_settings" (the gateway said no — do
// not retry) or "unavailable" (an outage). `cause` is built here from a status
// code or an error code, never from the response body, and is one line: the
// action prints it inside a workflow command.
class FetchFailure extends Error {
  constructor(status, cause) {
    const line = String(cause).replace(/[\r\n]+/g, " ").slice(0, 200);
    super(line);
    this.status = status;
    this.cause = line;
  }
}

// 408 and 429 are 4xx but say "not now", not "not for you".
const TRANSIENT_4XX = new Set([408, 429]);

// One settings fetch. Throws a FetchFailure on any envelope problem.
async function fetchOnce(endpoint, key) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new FetchFailure("unavailable", `timed out after ${TIMEOUT_MS}ms`);
    }
    const code = e?.cause?.code || e?.code;
    throw new FetchFailure("unavailable", `network error (${code || e?.message || "unknown"})`);
  }
  if (res.status >= 400 && res.status < 500 && !TRANSIENT_4XX.has(res.status)) {
    throw new FetchFailure("no_settings", `HTTP ${res.status}`);
  }
  if (!res.ok) throw new FetchFailure("unavailable", `HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new FetchFailure("unavailable", `timed out after ${TIMEOUT_MS}ms`);
    }
    throw new FetchFailure("unavailable", "the body was not JSON");
  }
  if (body?.success !== true) throw new FetchFailure("no_settings", "the gateway answered without success:true");
  if (typeof body.data !== "object" || body.data === null) {
    throw new FetchFailure("unavailable", "the response had no data object");
  }
  return body.data;
}

async function resolveSettings(opts) {
  // The key goes out as a Bearer header: never in clear off this machine.
  const refused = gatewayUrlProblem(opts.url);
  if (refused) {
    console.error(`settings: not sending the key — ${refused}`);
    return fallbackSettings("unavailable", refused);
  }
  let endpoint;
  try {
    endpoint = `${controlPlaneBase(opts.url)}/api/code_review/settings?repo=${encodeURIComponent(opts.repo)}`;
  } catch (e) {
    console.error(`settings: bad --url (${e.message}) — using built-in defaults`);
    return fallbackSettings("unavailable", "the orcarouter-url input is not a URL");
  }

  let last = new FetchFailure("unavailable", "unknown");
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return validateSettings(await fetchOnce(endpoint, opts.key));
    } catch (e) {
      last = e instanceof FetchFailure ? e : new FetchFailure("unavailable", e?.message || String(e));
      console.error(`settings: attempt ${attempt}/${ATTEMPTS} failed (${last.cause})`);
      if (last.status === "no_settings") break; // an answer, not an outage
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
  }
  console.error(
    `settings: ${last.status === "no_settings" ? "no dashboard settings for this key" : "giving up"} (${last.cause}) — ` +
      "using built-in defaults (the action uses the workflow's inputs for this run)",
  );
  return fallbackSettings(last.status, last.cause);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") opts.url = argv[++i];
    else if (argv[i] === "--repo") opts.repo = argv[++i];
    else if (argv[i] === "--out") opts.out = argv[++i];
  }
  // The API key comes from the environment, NEVER argv: a --key flag would
  // land in /proc/<pid>/cmdline and `ps aux` (world-readable on Linux), a
  // real leak on shared/self-hosted runners.
  opts.key = process.env.ORCAROUTER_API_KEY;

  let settings;
  if (!opts.url || !opts.key || !opts.repo || !opts.out) {
    console.error(
      "settings: usage: ORCAROUTER_API_KEY=<key> node settings.mjs --url U --repo owner/name --out path.json " +
        "(fail-open — printing built-in defaults and exiting 0)",
    );
    settings = fallbackSettings("unavailable", "settings.mjs was called with missing arguments");
  } else {
    settings = await resolveSettings(opts);
  }

  const json = JSON.stringify(settings);
  if (opts.out) {
    try {
      fs.writeFileSync(opts.out, json);
    } catch (e) {
      console.error(`settings: could not write ${opts.out} (${e.message}) — stdout still carries the values`);
    }
  }
  process.stdout.write(`${json}\n`);
}

// Exit 0 unconditionally (and explicitly: fetch keep-alive sockets must not
// hold the process open) — a settings problem may never fail the review. Even
// an unexpected crash still emits the defaults so the driver has values.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(`settings: ${e.message} — using built-in defaults`);
    process.stdout.write(`${JSON.stringify(fallbackSettings("unavailable", "settings.mjs crashed"))}\n`);
    process.exit(0);
  },
);
