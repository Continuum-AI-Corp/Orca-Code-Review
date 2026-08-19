#!/usr/bin/env node
// Turn fact-proxy's per-call metering (CR_USAGE_FILE) into a cost picture.
//
//   node usage-summary.mjs <usage.jsonl> [--pricing pricing.json] [--json]
//
// Why this exists: a reviewer model's LIST price predicts its review cost
// badly. Three effects dominate and only metering exposes them:
//   1. Call amplification — a weaker model burns more tool-call round trips
//      per file, so it re-sends the same context more times. Input tokens, not
//      price, are the bill.
//   2. Prefix-cache hit rate — the engine re-sends a near-identical prompt per
//      file. A model whose gateway entry has NO cache_ratio pays full rate on
//      every repeat and can lose to a nominally pricier model that caches.
//   3. Output is a rounding error — a review is overwhelmingly input tokens,
//      so a scary-looking completion multiplier barely moves the total.
//
// With --pricing (a dump of the gateway's `GET /api/pricing`) each model's
// ratios are applied to the measured tokens to produce a real per-run cost.
// The gateway bills `QuotaPerUnit = 500 * 1000` quota per USD at ratio 1, i.e.
// ratio 1 == $0.002/1K == $2.00/1M input tokens; output is
// ratio * completion_ratio and cached input is ratio * cache_ratio.
//
// A model with no cache_ratio in the price list gets its cached tokens billed
// at FULL input rate and is flagged, because that is what the gateway does.
//
// Exits 0 even on a malformed line (metering is observability, never a gate).

import fs from "node:fs";

const USD_PER_1M_AT_RATIO_1 = 2.0;

// One pass, because a flag's VALUE is not a positional argument. --pricing
// takes a path, and a path does not start with "--", so scanning separately
// for "the first argv entry that isn't a flag" picks up the price list as the
// usage file whenever --pricing comes first. That failure is silent rather
// than loud: a price list is itself valid JSON, so it parses as a single
// metering row with no token fields and reports a run that cost nothing.
// Advancing the index past a flag's value keeps both argument orders working.
const argv = process.argv.slice(2);
let file = null;
let pricingPath = null;
let asJson = false;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--pricing") {
    // Only consume the next entry when it is actually a value. A trailing
    // --pricing, or one followed by another flag, must not swallow that flag.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      pricingPath = next;
      i += 1;
    }
  } else if (argv[i] === "--json") asJson = true;
  else if (!argv[i].startsWith("--") && file === null) file = argv[i];
}
if (!file) {
  console.error("usage: node usage-summary.mjs <usage.jsonl> [--pricing pricing.json] [--json]");
  process.exit(2);
}

const rows = [];
let skipped = 0;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    rows.push(JSON.parse(line));
  } catch {
    skipped += 1;
  }
}

// Price lookup. The name in a metering record is whatever the UPSTREAM provider
// echoed (e.g. "gpt-4o-mini-2024-07-18"), while the price list is keyed by the
// gateway's own vendor-prefixed alias ("openai/gpt-4o-mini-2024-07-18"), so an
// exact-match-only lookup silently prices nothing. Resolution order:
//   1. exact key
//   2. unique match on the part after "/" (vendor prefix dropped)
//   3. unique match after stripping a trailing -YYYY-MM-DD snapshot suffix
// A basename that maps to SEVERAL vendors is left unpriced rather than guessed
// — a wrong ratio is worse than an honest gap in a cost comparison.
let prices = null;
if (pricingPath) {
  try {
    const data = JSON.parse(fs.readFileSync(pricingPath, "utf8")).data || [];
    const exact = new Map(data.map((d) => [d.model_name, d]));
    // Basenames are indexed case-INSENSITIVELY: providers echo back their own
    // casing, which often differs from the price list's, so a case-sensitive
    // index silently prices nothing.
    const byBase = new Map();
    for (const d of data) {
      const full = String(d.model_name);
      const base = full.includes("/") ? full.slice(full.indexOf("/") + 1) : full;
      const k = base.toLowerCase();
      if (!byBase.has(k)) byBase.set(k, []);
      byBase.get(k).push(d);
    }
    const unique = (name) => {
      const hits = byBase.get(String(name).toLowerCase());
      return hits && hits.length === 1 ? hits[0] : null;
    };
    // Suffixes providers append to the echoed name that are not part of the
    // price-list key: a dated snapshot, or a release-channel marker such as
    // "-preview", which is billed against the unsuffixed entry.
    const strip = [
      (s) => s.replace(/-\d{4}-\d{2}-\d{2}$/, ""),
      (s) => s.replace(/-(preview|latest|stable)$/i, ""),
    ];
    prices = {
      get(name) {
        if (exact.has(name)) return exact.get(name);
        const direct = unique(name);
        if (direct) return direct;
        for (const f of strip) {
          const s = f(String(name));
          if (s === name) continue;
          const hit = exact.get(s) || unique(s);
          if (hit) return hit;
        }
        return null;
      },
    };
  } catch (e) {
    console.error(`usage-summary: could not read pricing (${e.message}) — reporting tokens only`);
  }
}

// Group by resolved model: one run can legitimately span models (the L2 judge
// is a different model from the reviewer, and a router alias can re-resolve).
const byModel = new Map();
const blank = () => ({ calls: 0, prompt: 0, completion: 0, cached: 0, blocked: 0, retries: 0 });
for (const r of rows) {
  const key = r.model || "(unknown)";
  if (!byModel.has(key)) byModel.set(key, blank());
  const m = byModel.get(key);
  m.calls += 1;
  m.prompt += r.prompt || 0;
  m.completion += r.completion || 0;
  m.cached += r.cached || 0;
  m.retries += r.retries || 0;
  if (r.status && r.status >= 400) m.blocked += 1;
}

const cost = (model, m) => {
  const p = prices ? prices.get(model) : null;
  if (!p) return null;
  const ratio = p.model_ratio;
  if (typeof ratio !== "number") return null;
  const inRate = ratio * USD_PER_1M_AT_RATIO_1;
  const outRate = ratio * (p.completion_ratio ?? 1) * USD_PER_1M_AT_RATIO_1;
  // No cache_ratio on the price entry == no cache discount at this gateway.
  const hasCache = typeof p.cache_ratio === "number";
  const cachedRate = hasCache ? inRate * p.cache_ratio : inRate;
  const fresh = Math.max(0, m.prompt - m.cached);
  const usd =
    (fresh / 1e6) * inRate + (m.cached / 1e6) * cachedRate + (m.completion / 1e6) * outRate;
  return { usd, inRate, outRate, cachedRate, hasCache };
};

const total = blank();
for (const m of byModel.values()) {
  total.calls += m.calls;
  total.prompt += m.prompt;
  total.completion += m.completion;
  total.cached += m.cached;
  total.blocked += m.blocked;
  total.retries += m.retries;
}
let totalUsd = 0;
let priced = true;
for (const [model, m] of byModel) {
  const c = cost(model, m);
  if (c) totalUsd += c.usd;
  else priced = false;
}

const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "—");
const M = (n) => (n / 1e6).toFixed(3);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        calls: total.calls,
        prompt_tokens: total.prompt,
        completion_tokens: total.completion,
        cached_tokens: total.cached,
        cache_hit_rate: total.prompt > 0 ? total.cached / total.prompt : null,
        blocked_calls: total.blocked,
        retries: total.retries,
        usd: priced ? Number(totalUsd.toFixed(4)) : null,
        by_model: [...byModel].map(([model, m]) => ({
          model,
          ...m,
          usd: cost(model, m)?.usd ?? null,
        })),
        malformed_lines: skipped,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(
  `calls=${total.calls}  prompt=${M(total.prompt)}M  completion=${M(total.completion)}M  ` +
    `cached=${M(total.cached)}M (${pct(total.cached, total.prompt)} hit)` +
    (total.retries ? `  retries=${total.retries}` : "") +
    (total.blocked ? `  blocked=${total.blocked}` : ""),
);

for (const [model, m] of byModel) {
  const c = cost(model, m);
  const money = c
    ? `  $${c.usd.toFixed(4)}` +
      (c.hasCache ? "" : "  [no cache discount at this gateway — repeats billed at full rate]")
    : prices
      ? "  (not in price list)"
      : "";
  console.log(
    `  ${model}: calls=${m.calls} prompt=${M(m.prompt)}M completion=${M(m.completion)}M ` +
      `cached=${pct(m.cached, m.prompt)}${money}`,
  );
}

if (priced && byModel.size > 0) {
  console.log(`TOTAL $${totalUsd.toFixed(4)} for this run`);
  // Per-call input is the amplification signal: compare it across models on
  // the SAME commit to see which one re-reads context more.
  if (total.calls > 0) {
    console.log(
      `  (${(total.prompt / total.calls).toFixed(0)} input tokens per call — ` +
        `compare across models on the same commit to see call amplification)`,
    );
  }
}
if (skipped) console.log(`note: ${skipped} malformed line(s) skipped`);
