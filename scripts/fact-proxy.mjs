#!/usr/bin/env node
// In-job fact-injecting proxy for the OrcaCode Review cascade.
//
// OCR can only send the auth header (x-api-key / authorization) — it has no way
// to attach custom headers. But the routing DSL routes on `headers[...]`. This
// tiny loopback proxy bridges the gap: OCR talks to it (OCR_LLM_URL points
// here), it stamps the cascade's raw-fact headers, and forwards everything —
// including SSE streams — to the real OrcaRouter endpoint.
//
// It is ephemeral: bound to 127.0.0.1 on an OS-assigned port, lives only for
// the duration of one Actions job, and dies with it. Nothing is deployed.
//
// The facts are re-read from CR_FACTS_FILE on EVERY request, so the driver can
// flip them between the cheap pass and the in-run strong escalation without
// restarting the proxy. The file is a flat JSON object of header->value; an
// absent/empty/unparseable file stamps nothing (the DSL falls through to its
// default, i.e. the cheap tier).
//
// Retry: transient upstream failures are retried up to 3 more attempts with
// 1s/2s/4s backoff; a numeric Retry-After header (seconds) wins, capped at
// 30s. WHAT is retryable is deliberately narrow, because a replayed chat
// completion is not idempotent — a duplicate can double-bill:
//   - HTTP 429/502/503/504: a response was received, so the gateway owned the
//     request and answered "not processed" — safe to replay. No other status
//     is ever retried (every other 4xx included).
//   - Connection errors ONLY when they prove the upstream never began
//     processing: ECONNREFUSED / ENOTFOUND / EAI_AGAIN (the connection or name
//     lookup never came up), or any error raised BEFORE the request body
//     finished flushing. An ECONNRESET after the body was fully sent (and
//     before any response) is ambiguous — the gateway may already have
//     consumed and billed the request — so it is surfaced as 502, NOT replayed.
//   - Once a response has started relaying to the client, NOTHING is retried:
//     the response headers are already out, so a mid-stream failure destroys
//     the client connection (fail fast) instead of re-attempting.
// To make replays safe the request body is buffered BEFORE the first attempt,
// capped at 8 MiB: a larger body streams straight through with ALL retries
// disabled for that request (nothing is kept to replay; memory stays bounded).
// A final failure relays the upstream status/body unchanged (502 for a
// connection error). Every response carries x-cr-retry-count (retries actually
// performed) for observability.
//
// Timeout: each upstream attempt is capped (default 120s, CR_UPSTREAM_TIMEOUT_MS
// / the upstreamTimeoutMs opt override it) so a black-hole gateway (accepts the
// TCP connection, never answers) fails fast into the SAME error handler instead
// of hanging until OCR's own timeout. A pre-response timeout is classified like
// any pre-send connection error (retried only if the body hadn't finished
// flushing — replay stays idempotency-safe); a timeout after the relay started
// tears the client stream down and never retries.
//
// Resilience: the client (OCR) can vanish at any time. A 'close' before the
// response finished cancels the in-flight upstream request (an OCR disconnect
// must not leak a still-billing completion) and blocks any pending retry from
// dialing again; a client-side 'error' is caught (a write to a dead socket must
// not throw an unhandled EPIPE); and the CLI installs a process-level
// uncaughtException backstop that logs and keeps serving — one bad client can
// never take the proxy down mid-job.
//
// Metering (CR_USAGE_FILE): every relayed response gets its `usage` block
// appended as one JSONL record — per-call prompt/completion/cached tokens and
// the model the gateway actually resolved. This is what makes a model's REAL
// per-review cost measurable (unit price alone is misleading: a weaker model
// loops more tool calls, and the prefix-cache hit rate moves the bill more than
// the base rate does). The tap is deliberately non-invasive: it never buffers a
// whole response — it keeps only a bounded TAIL (usage sits at the end of an
// OpenAI-shaped body), so SSE still streams through unbuffered and memory stays
// flat on a multi-MB completion. Extraction and the append are fully soft-fail:
// metering must never alter, delay, or break a review.
//
// Env:
//   ORCAROUTER_URL          full upstream chat-completions URL (origin + path forwarded)
//   CR_FACTS_FILE           path to the JSON facts file the driver rewrites per pass
//   CR_UPSTREAM_TIMEOUT_MS  optional per-attempt upstream timeout (ms; default 120000)
//   CR_USAGE_FILE           optional JSONL path for per-call token accounting (off when unset)
//   CR_MAX_RPM              optional client-side request ceiling (requests/min; unset = no limit)
// On listen it prints `PROXY_URL=http://127.0.0.1:<port><upstream-path>` to
// stdout; the driver sets OCR_LLM_URL to that. Auth is forwarded untouched and
// never logged.
//
// Exported for tests: createProxyServer({ upstreamUrl, factsFile,
// policyBlockFile, sleep, maxRetries, maxBufferBytes, usageFile }) returns an
// unlistened http.Server — `sleep` is the injectable backoff seam and
// `maxBufferBytes` the retry-buffer cap. The CLI entry below keeps the original
// env-var + PROXY_URL contract; action.yml usage is unchanged.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { URL, pathToFileURL } from "node:url";

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
// Connection-error codes that PROVE the request never reached processing:
// name resolution or the TCP connect itself failed, so no bytes of the
// request were ever consumed upstream. Everything else is judged by whether
// the request body had finished flushing when the error fired.
const PRE_PROCESSING_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const BACKOFF_MS = [1000, 2000, 4000];
const RETRY_AFTER_CAP_MS = 30_000;
// Bodies above this stream straight through (single attempt, no retries):
// buffering arbitrarily large bodies for replay would unbound the proxy's
// memory on a shared runner.
const MAX_RETRY_BUFFER_BYTES = 8 * 1024 * 1024;
// A gateway that accepts the connection but never responds (a black hole) must
// not hang the whole job — cap each upstream attempt and let the error handler
// classify the timeout like any other pre/post-response failure.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Metering keeps only this much of the END of each response. `usage` is the
// last field of an OpenAI-shaped body (and rides the final SSE frame), so a
// tail is sufficient — and it keeps the proxy's memory flat regardless of how
// large the completion is.
const USAGE_TAIL_BYTES = 64 * 1024;

// Client-side request-rate ceiling (CR_MAX_RPM). Some models enforce a hard
// per-minute request quota that cannot be raised. The engine fans out per-file
// requests concurrently and has no rate knob, so on a large enough diff it can
// overshoot the quota, the gateway answers 429, and the retry path above turns
// that into backoff sleeps — dead time that counts against the job's
// wall-clock budget. Throttling HERE is the only correct place: the proxy is
// the single choke point every engine request passes through, so it is the
// only spot that can observe the true aggregate rate.
//
// Retries count against the window too — a replayed request consumes quota
// exactly like a fresh one.
export function createRateLimiter({ maxRpm = 0, sleep = defaultSleep, now = () => Date.now() } = {}) {
  if (!maxRpm || maxRpm <= 0) return { acquire: () => Promise.resolve() };
  const window = [];
  // Serialize admission: concurrent callers must not all observe the same
  // pre-admission window and collectively blow through the ceiling.
  let queue = Promise.resolve();
  const admit = async () => {
    for (;;) {
      const t = now();
      while (window.length && t - window[0] >= 60_000) window.shift();
      if (window.length < maxRpm) {
        window.push(t);
        return;
      }
      // Wait just past the moment the oldest slot leaves the window.
      await sleep(60_000 - (t - window[0]) + 5);
    }
  };
  return {
    acquire() {
      // Chain even on rejection so one failure cannot wedge the queue.
      queue = queue.then(admit, admit);
      return queue;
    },
  };
}

// Pull the LAST `"usage": { ... }` object out of a response tail. Hand-scanned
// rather than regexed because the object nests (prompt_tokens_details), which a
// non-greedy regex would truncate. Returns null on anything unparseable — a
// missing meter record is always preferable to disturbing the review.
function extractUsage(text) {
  const key = text.lastIndexOf('"usage"');
  if (key === -1) return null;
  const open = text.indexOf("{", key);
  if (open === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(open, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null; // truncated by the tail cap — treat as absent
}

// The resolved model name, so a router-alias run records what the DSL actually
// picked (the request only ever names the alias).
function extractModel(text) {
  const m = text.match(/"model"\s*:\s*"([^"]{1,200})"/);
  return m ? m[1] : null;
}

// Append one metering record. Never throws: a full disk or a bad path must not
// fail a review that otherwise succeeded.
function recordUsage(tailText, { usageFile, status, retries, seq, error = null }) {
  if (!usageFile) return;
  try {
    const usage = extractUsage(tailText);
    const cached =
      usage?.prompt_tokens_details?.cached_tokens ??
      usage?.cached_tokens ??
      usage?.prompt_cache_hit_tokens ??
      0;
    fs.appendFileSync(
      usageFile,
      JSON.stringify({
        ts: new Date().toISOString(),
        seq,
        status,
        retries,
        model: extractModel(tailText),
        prompt: usage?.prompt_tokens ?? null,
        completion: usage?.completion_tokens ?? null,
        total: usage?.total_tokens ?? null,
        cached,
        ...(error ? { error } : {}),
      }) + "\n",
    );
  } catch {
    /* best-effort: metering is observability, never a failure mode */
  }
}

// A guardrail (content policy) or firewall (tool-call policy) block arrives as
// HTTP 400 with `error.code = guardrail_blocked|firewall_blocked`. Persist the
// layer, policy name, and a regex-stripped reason; ignore any other 400.
function recordPolicyBlock(buf, policyBlockFile) {
  if (!policyBlockFile) return;
  let code, message;
  try {
    const j = JSON.parse(buf.toString("utf8"));
    code = j?.error?.code;
    message = j?.error?.message || "";
  } catch {
    return;
  }
  if (code !== "guardrail_blocked" && code !== "firewall_blocked") return;
  const kind = code === "guardrail_blocked" ? "guardrail" : "firewall";
  const nameMatch = message.match(
    /blocked by (?:guardrail|firewall(?: policy)?)\s+"([^"]+)"/i,
  );
  const idMatch = message.match(/\(request id:\s*([^)]+)\)/i);
  // Strip the parts the comment renders separately (policy name, request id),
  // collapse the verbose regex fragments, then dedupe identical reasons so a
  // two-rule match doesn't read as "a configured rule; a configured rule".
  let detail = message
    .replace(/^.*?blocked by (?:guardrail|firewall(?: policy)?)\s+"[^"]+":\s*/i, "")
    .replace(/\s*\(request id:[^)]*\)/i, "")
    .replace(/regex\(matched pattern "[\s\S]*?"\)/gi, "a configured rule")
    .trim();
  detail = [...new Set(detail.split(/;\s*/).map((s) => s.trim()).filter(Boolean))].join("; ");
  try {
    fs.writeFileSync(
      policyBlockFile,
      JSON.stringify({
        kind,
        policyName: nameMatch ? nameMatch[1] : null,
        requestId: idMatch ? idMatch[1].trim() : null,
        detail: detail || null,
      }),
    );
  } catch {
    /* best-effort: a missing block comment is acceptable; the job still fails closed */
  }
}

// Only x-cr-* facts are injectable; never let the file smuggle auth or other
// headers in. Matches the gateway's own x-cr-* convention (not on any denylist).
function readFacts(factsFile) {
  if (!factsFile) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(factsFile, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const lk = String(k).toLowerCase();
      if (lk.startsWith("x-cr-") && v !== undefined && v !== "") out[lk] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

// Delay before the (retryIndex+1)-th retry: a numeric Retry-After (seconds,
// capped at 30s) wins; otherwise the fixed 1s/2s/4s schedule. An HTTP-date
// Retry-After is deliberately ignored — clock math is not worth it here.
function retryDelayMs(retryIndex, retryAfter) {
  if (retryAfter !== undefined) {
    const s = String(retryAfter).trim();
    if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, RETRY_AFTER_CAP_MS);
  }
  return BACKOFF_MS[Math.min(retryIndex, BACKOFF_MS.length - 1)];
}

export function createProxyServer({
  upstreamUrl,
  factsFile = "",
  policyBlockFile = "",
  sleep = defaultSleep,
  maxRetries = 3,
  maxBufferBytes = MAX_RETRY_BUFFER_BYTES,
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  usageFile = "",
  maxRpm = 0,
  now = () => Date.now(),
} = {}) {
  const upstream = new URL(upstreamUrl);
  const upstreamLib = upstream.protocol === "http:" ? http : https;
  // Shared across every in-flight request: the ceiling is per-proxy (i.e. per
  // job), not per-connection.
  const limiter = createRateLimiter({ maxRpm, sleep, now });
  // Per-proxy call counter, so a metering file reads as the ordered sequence of
  // engine calls in one job (how many calls a model needed is itself a cost
  // signal — see the header).
  let callSeq = 0;

  return http.createServer((req, res) => {
    const mySeq = usageFile ? ++callSeq : 0;
    const headers = { ...req.headers };
    delete headers.host; // must match upstream, not the loopback proxy
    Object.assign(headers, readFacts(factsFile));
    const target = new URL(req.url, upstream);

    // The upstream request currently in flight for THIS client request (the
    // buffered attempt or the streaming variant), so a client disconnect can
    // cancel it. `clientGone` latches that disconnect so no scheduled retry
    // dials upstream again once OCR has hung up.
    let activeUpReq = null;
    let clientGone = false;

    // The client (OCR) socket can die at any moment. Without an 'error' sink a
    // write to a half-open socket throws an unhandled EPIPE/ECONNRESET and
    // would crash the whole proxy — log and drop instead.
    res.on("error", (e) => {
      console.error(`fact-proxy: client connection error (${e.message}) — dropping`);
      res.destroy();
    });
    // OCR hung up before we finished answering: the upstream call is now
    // orphaned. Cancel it so a disconnect can't leak a still-billing
    // completion, and stop any pending retry from starting a fresh one. A
    // normal completion also fires 'close', but with writableEnded already set
    // (nothing left in flight), so it is a no-op.
    res.on("close", () => {
      if (res.writableEnded) return;
      clientGone = true;
      if (activeUpReq && !activeUpReq.destroyed) {
        activeUpReq.destroy(new Error("client disconnected"));
      }
    });

    // Terminal failure for one client request. Before the relay: answer 502.
    // After it: the headers are out, so destroy the connection — a truncated
    // stream must error out fast, not leave OCR waiting until the job timeout.
    const failResponse = (retries, reason) => {
      // Meter the failure. Without this, an attempt that never received a
      // response is INVISIBLE to the metering file: a run where the gateway
      // hung on every call would record zero rows and read as "the model did
      // nothing", when in fact the environment failed. Recording it keeps
      // those two cases distinguishable — with no token counts, since none
      // were reported.
      recordUsage("", { usageFile, status: 0, retries, seq: mySeq, error: reason || "no response" });
      if (clientGone || res.writableEnded) return; // client already gone — nobody to answer
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "x-cr-retry-count": String(retries) });
      res.end();
    };

    // Relay the (final) upstream response — the point of no return: the
    // status/headers go on the wire here, so from now on NOTHING may retry
    // (a second writeHead would throw ERR_HTTP_HEADERS_SENT and kill the
    // whole proxy). relay() only ever runs at a terminal settle, so no retry
    // can be scheduled after it. All relay paths stamp x-cr-retry-count so a
    // flaky gateway is visible in the job log.
    const relay = (upRes, status, retries) => {
      const outHeaders = { ...upRes.headers, "x-cr-retry-count": String(retries) };
      // Buffer a 400 so we can read the guardrail/firewall reason, then relay
      // the identical bytes to OCR (which still fails closed). Everything else
      // streams straight through so SSE stays unbuffered.
      if (status === 400 && policyBlockFile) {
        const parts = [];
        upRes.on("data", (c) => parts.push(c));
        upRes.on("end", () => {
          const buf = Buffer.concat(parts);
          recordPolicyBlock(buf, policyBlockFile);
          // A blocked call still consumed the gateway's attention (and shows up
          // as a failed pass in the log), so meter it too — an all-blocked run
          // must not read as a free run.
          recordUsage(buf.toString("utf8"), { usageFile, status, retries, seq: mySeq });
          if (clientGone || res.writableEnded) return; // client left during the 400 buffer — nobody to answer
          res.writeHead(status, outHeaders);
          res.end(buf);
        });
        upRes.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        return;
      }
      // Metering tap: observe a bounded TAIL of the body without buffering it.
      // A 'data' listener alongside pipe() sees the same chunks and does not
      // consume them, so the relay below is byte-for-byte unchanged.
      if (usageFile) {
        let tail = Buffer.alloc(0);
        upRes.on("data", (c) => {
          const joined = tail.length ? Buffer.concat([tail, c]) : c;
          tail =
            joined.length > USAGE_TAIL_BYTES
              ? Buffer.from(joined.subarray(-USAGE_TAIL_BYTES))
              : joined;
        });
        upRes.on("end", () => {
          recordUsage(tail.toString("utf8"), { usageFile, status, retries, seq: mySeq });
        });
      }
      res.writeHead(status, outHeaders);
      upRes.pipe(res); // stream SSE through unbuffered
      // pipe() forwards data, not errors — and http.IncomingMessage swallows
      // an unlistened 'error' entirely, so without this handler a mid-stream
      // upstream failure would leave `res` open forever (OCR would hang until
      // the job timeout). Fail fast instead.
      upRes.on("error", (e) => {
        console.error(`fact-proxy: upstream stream failed mid-relay (${e.message}) — dropping the client connection`);
        res.destroy();
      });
    };

    const scheduleRetry = (body, nextRetries, ms) => {
      // A broken sleep must not strand the request — retry immediately then.
      Promise.resolve(sleep(ms)).then(
        () => attempt(body, nextRetries),
        () => attempt(body, nextRetries),
      );
    };

    // One upstream attempt over the buffered body; `retries` = retries already
    // performed (0-based). The `settled` latch guarantees exactly ONE of
    // {relay, scheduleRetry, failResponse} runs per attempt: a socket reset
    // while draining a retryable-status body fires upReq 'error' AFTER the
    // status path already scheduled a retry, and without the latch that would
    // start a second parallel retry chain (two relays -> double writeHead).
    const attempt = (body, retries) => {
      if (clientGone || res.destroyed) return; // client gave up — nobody left to answer
      // Wait for a rate-limit slot before dialing. No-op when maxRpm is unset.
      // Re-check the client afterwards: a throttled request can sit here for
      // tens of seconds, and OCR may have hung up in the meantime — dialing
      // then would burn quota on a response nobody will read.
      limiter.acquire().then(() => {
        if (clientGone || res.destroyed) return;
        dial(body, retries);
      });
    };

    const dial = (body, retries) => {
      let settled = false;
      const settleThisAttempt = () => {
        if (settled) return false;
        settled = true;
        return true;
      };
      let bodySent = false; // request body fully flushed to the socket
      let relayedThisAttempt = false; // THIS attempt's response is the one relaying

      const upReq = upstreamLib.request(
        target,
        { method: req.method, headers, host: upstream.host },
        (upRes) => {
          const status = upRes.statusCode || 502;
          if (RETRYABLE_STATUS.has(status) && retries < maxRetries) {
            if (!settleThisAttempt()) return;
            // Drain and discard — this response is not relayed. The drain
            // needs its own 'error' sink so a reset mid-drain is just noise
            // (the retry below is already scheduled and owns the outcome).
            upRes.on("error", (e) => {
              console.error(`fact-proxy: discarded ${status} response errored while draining (${e.message})`);
            });
            upRes.resume();
            const ms = retryDelayMs(retries, upRes.headers["retry-after"]);
            console.error(
              `fact-proxy: upstream ${status} — retry ${retries + 1}/${maxRetries} in ${ms}ms`,
            );
            scheduleRetry(body, retries + 1, ms);
            return;
          }
          if (!settleThisAttempt()) return;
          relayedThisAttempt = true;
          relay(upRes, status, retries);
        },
      );
      activeUpReq = upReq;
      // Fail fast on a black-hole gateway: destroying the request routes the
      // timeout through the SAME upReq 'error' handler below, so a pre-response
      // timeout is classified exactly like a pre-send connection error (retried
      // only when the body hadn't finished flushing — replay stays idempotent-
      // safe) and a post-relay timeout tears the stream down without retrying.
      upReq.setTimeout(upstreamTimeoutMs, () => {
        upReq.destroy(new Error(`upstream timeout after ${upstreamTimeoutMs}ms`));
      });
      upReq.on("error", (e) => {
        if (!settleThisAttempt()) {
          // This attempt's outcome is already owned elsewhere. If it was owned
          // by THIS attempt's relay, the stream just died mid-relay — fail the
          // client fast rather than hanging. If it was owned by a scheduled
          // retry (a drain-phase reset on a discarded 429/5xx body), do
          // nothing: the fresh attempt must not be disturbed.
          if (relayedThisAttempt) res.destroy();
          return;
        }
        // Retry ONLY errors that prove the upstream never began processing
        // (see the header): a replayed completion is not idempotent, and a
        // reset after the body was fully sent may already have been billed.
        const preProcessing = PRE_PROCESSING_CODES.has(e.code) || !bodySent;
        if (retries < maxRetries && preProcessing) {
          const ms = retryDelayMs(retries, undefined);
          console.error(
            `fact-proxy: upstream error (${e.message}) — retry ${retries + 1}/${maxRetries} in ${ms}ms`,
          );
          scheduleRetry(body, retries + 1, ms);
          return;
        }
        console.error(
          `fact-proxy: upstream error: ${e.message}${
            retries < maxRetries ? " (after the request was sent — not retried)" : ""
          }`,
        );
        failResponse(retries, e.message);
      });
      upReq.end(body, () => {
        bodySent = true;
      });
    };

    // Buffer the request body BEFORE the first attempt: retries must replay
    // identical bytes, and a piped stream can only be consumed once. The
    // buffer is capped: a body over maxBufferBytes flips to a single
    // pass-through attempt with retries disabled (see startStreaming).
    const chunks = [];
    let buffered = 0;
    let streaming = false;
    let streamReq = null;

    // NOTE: the streamed path deliberately does NOT wait on the limiter. The
    // client body is already flowing into us and cannot be paused for a
    // minute-scale delay without stalling `req` and risking OCR's own timeout,
    // and it is a single unreplayable attempt. Oversized bodies are rare (>8
    // MiB) and the engine's per-file requests are far smaller, so this cannot
    // meaningfully erode the ceiling — but it is a known, bounded exception
    // rather than an oversight.
    const startStreaming = () => {
      streaming = true;
      console.error(
        `fact-proxy: request body exceeds ${maxBufferBytes} bytes — streaming through, retries disabled (nothing is kept to replay)`,
      );
      // The body streams through byte-identical, so the client's own
      // content-length (if any) is still correct; without one Node re-chunks.
      delete headers["transfer-encoding"];
      const upReq = upstreamLib.request(
        target,
        { method: req.method, headers, host: upstream.host },
        (upRes) => {
          relay(upRes, upRes.statusCode || 502, 0);
        },
      );
      // Same black-hole guard as the buffered path; a streamed body can't be
      // replayed, so any error (incl. this timeout) fails closed, never retries.
      upReq.setTimeout(upstreamTimeoutMs, () => {
        upReq.destroy(new Error(`upstream timeout after ${upstreamTimeoutMs}ms`));
      });
      upReq.on("error", (e) => {
        console.error(`fact-proxy: upstream error (streamed body is unreplayable — not retried): ${e.message}`);
        failResponse(0, e.message);
      });
      streamReq = upReq;
      activeUpReq = upReq;
      for (const c of chunks) upReq.write(c);
      chunks.length = 0;
      req.pipe(upReq); // pipe ends upReq when the client body ends
    };

    req.on("data", (c) => {
      if (streaming) return; // the pipe carries everything from here on
      chunks.push(c);
      buffered += c.length;
      if (buffered > maxBufferBytes) startStreaming();
    });
    req.on("error", (e) => {
      if (streamReq) streamReq.destroy(e); // stop the upstream copy of a broken client body
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
    req.on("end", () => {
      if (streaming) return; // completion is the pipe's job now
      const body = Buffer.concat(chunks);
      // The buffered body is replayed with its exact length; never forward the
      // client's transfer-encoding for a re-sent buffer.
      delete headers["transfer-encoding"];
      headers["content-length"] = String(body.length);
      attempt(body, 0);
    });
  });
}

// ---- CLI entry (contract unchanged): env-driven, prints PROXY_URL on listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Backstop: one misbehaving client (a mid-write EPIPE, a socket destroyed
  // under us) must NEVER take the whole proxy down mid-job — every request
  // already fails closed on its own path. Log and keep serving; do NOT exit.
  // Registered only for the real proxy process, so importing the factory into
  // tests never masks their uncaught errors.
  process.on("uncaughtException", (e) => {
    console.error(`fact-proxy: uncaught exception (kept alive): ${e && e.stack ? e.stack : e}`);
  });

  const upstream = new URL(
    process.env.ORCAROUTER_URL || "https://api.orcarouter.ai/v1/chat/completions",
  );
  const envTimeout = Number(process.env.CR_UPSTREAM_TIMEOUT_MS);
  const server = createProxyServer({
    upstreamUrl: upstream.href,
    factsFile: process.env.CR_FACTS_FILE || "",
    policyBlockFile: process.env.CR_POLICY_BLOCK_FILE || "",
    usageFile: process.env.CR_USAGE_FILE || "",
    ...(Number.isFinite(Number(process.env.CR_MAX_RPM)) && Number(process.env.CR_MAX_RPM) > 0
      ? { maxRpm: Number(process.env.CR_MAX_RPM) }
      : {}),
    ...(Number.isFinite(envTimeout) && envTimeout > 0 ? { upstreamTimeoutMs: envTimeout } : {}),
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    // OCR must POST to the upstream's path; only the origin is swapped for us.
    process.stdout.write(`PROXY_URL=http://127.0.0.1:${port}${upstream.pathname}\n`);
  });
}
