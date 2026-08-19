// Contract tests for usage-summary.mjs — turns fact-proxy's per-call metering
// (CR_USAGE_FILE, one JSON object per line) into a token + cost picture.
//
// What these pin, in order of how much a silent break would cost:
//   1. The billing math. ratio 1 == $2.00/1M input tokens. Output is
//      ratio * completion_ratio; cached input is ratio * cache_ratio, and a
//      price entry with NO cache_ratio bills cached tokens at the FULL input
//      rate (that is what the gateway does) and says so in the output.
//   2. Price-list resolution. A metering record carries the name the UPSTREAM
//      provider echoed; the price list is keyed by the gateway's own
//      vendor-prefixed alias. Exact-match-only lookup would silently price
//      nothing, so there are three fallbacks — and an AMBIGUOUS basename must
//      stay unpriced rather than be guessed.
//   3. Best-effort I/O. Metering is observability, never a gate: a malformed
//      line or an unreadable price list degrades the report but still exits 0.
//      Only a missing file argument is a usage error (exit 2).

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const USAGE_SUMMARY = join(SCRIPTS, "usage-summary.mjs");

let dir;
let seq = 0;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-summary-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTmp(name, body) {
  const file = join(dir, `${(seq += 1)}-${name}`);
  writeFileSync(file, body);
  return file;
}

// Rows may be objects (serialized here) or raw strings, so a test can inject a
// malformed line deliberately.
const writeUsage = (rows) =>
  writeTmp(
    "usage.jsonl",
    `${rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`,
  );

const writePricing = (entries) => writeTmp("pricing.json", JSON.stringify({ data: entries }));

// spawnSync is fine here (unlike report.test.mjs): this script talks to no
// network, so the test's event loop does not need to stay live for the child.
function run(args) {
  const r = spawnSync("node", [USAGE_SUMMARY, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Most cases below use the documented order (usage file first); the
// "argument order" block pins that the reverse order works too.
function runJson(args) {
  const r = run([...args, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

describe("aggregation", () => {
  test("sums tokens and groups by model", () => {
    const usage = writeUsage([
      { model: "m1", prompt: 100, completion: 10, cached: 40 },
      { model: "m1", prompt: 200, completion: 20, cached: 60 },
      { model: "m2", prompt: 500, completion: 50, cached: 0 },
    ]);
    const out = runJson([usage]);

    assert.equal(out.calls, 3);
    assert.equal(out.prompt_tokens, 800);
    assert.equal(out.completion_tokens, 80);
    assert.equal(out.cached_tokens, 100);
    assert.equal(out.cache_hit_rate, 100 / 800);

    assert.equal(out.by_model.length, 2);
    const m1 = out.by_model.find((m) => m.model === "m1");
    assert.deepEqual(
      { calls: m1.calls, prompt: m1.prompt, completion: m1.completion, cached: m1.cached },
      { calls: 2, prompt: 300, completion: 30, cached: 100 },
    );
  });

  test("missing numeric fields count as 0, missing model is (unknown)", () => {
    const out = runJson([writeUsage([{}, { prompt: 5 }])]);
    assert.equal(out.calls, 2);
    assert.equal(out.prompt_tokens, 5);
    assert.equal(out.completion_tokens, 0);
    assert.equal(out.cached_tokens, 0);
    assert.equal(out.by_model.length, 1);
    assert.equal(out.by_model[0].model, "(unknown)");
  });

  test("only status >= 400 counts as blocked; retries are summed", () => {
    const out = runJson([
      writeUsage([
        { model: "m", status: 200, retries: 1 },
        { model: "m", status: 399 },
        { model: "m", status: 400 },
        { model: "m", status: 500, retries: 2 },
        { model: "m" }, // no status at all
      ]),
    ]);
    assert.equal(out.blocked_calls, 2);
    assert.equal(out.retries, 3);
  });

  test("cache_hit_rate is null when there are no prompt tokens", () => {
    const out = runJson([writeUsage([{ model: "m" }])]);
    assert.equal(out.cache_hit_rate, null);
  });
});

describe("best-effort input handling", () => {
  test("blank lines are skipped and are NOT counted as malformed", () => {
    const usage = writeTmp("usage.jsonl", '\n{"model":"m","prompt":10}\n\n   \n');
    const out = runJson([usage]);
    assert.equal(out.calls, 1);
    assert.equal(out.malformed_lines, 0);
  });

  test("a malformed line is counted and skipped, and the run still exits 0", () => {
    const usage = writeUsage([{ model: "m", prompt: 10 }, "{not json", { model: "m", prompt: 5 }]);
    const out = runJson([usage]);
    assert.equal(out.calls, 2);
    assert.equal(out.prompt_tokens, 15);
    assert.equal(out.malformed_lines, 1);
  });

  test("text mode notes skipped lines", () => {
    const r = run([writeUsage([{ model: "m", prompt: 10 }, "nope"])]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 malformed line\(s\) skipped/);
  });

  test("a missing file argument is a usage error (exit 2)", () => {
    const r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: node usage-summary\.mjs/);
  });

  test("an unreadable price list degrades to tokens-only, still exit 0", () => {
    const usage = writeUsage([{ model: "m", prompt: 1000 }]);
    const r = run([usage, "--pricing", join(dir, "does-not-exist.json"), "--json"]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /could not read pricing/);
    const out = JSON.parse(r.stdout);
    assert.equal(out.prompt_tokens, 1000, "tokens are still reported");
    assert.equal(out.usd, null, "but nothing is priced");
  });
});

describe("argument order", () => {
  // A flag's value is not a positional argument. --pricing takes a path, and a
  // path does not start with "--", so a "first non-flag argv entry" scan used
  // to pick the price list as the usage file when the flag came first. It
  // failed silently: a price list is valid JSON, so it parsed as one metering
  // row with no token fields and reported a run that cost nothing.
  test("--pricing before the usage file does not steal it", () => {
    const usage = writeUsage([{ model: "m", prompt: 1_000_000 }]);
    const pricing = writePricing([{ model_name: "m", model_ratio: 1 }]);
    const r = run(["--pricing", pricing, usage, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.prompt_tokens, 1_000_000, "the usage file must be read, not the price list");
    assert.equal(out.usd, 2, "and the price list must still be applied");
  });

  test("both orders produce the same result", () => {
    const usage = writeUsage([{ model: "m", prompt: 500_000, completion: 1000 }]);
    const pricing = writePricing([{ model_name: "m", model_ratio: 1 }]);
    const flagFirst = JSON.parse(run(["--pricing", pricing, usage, "--json"]).stdout);
    const fileFirst = JSON.parse(run([usage, "--pricing", pricing, "--json"]).stdout);
    assert.deepEqual(flagFirst, fileFirst);
  });

  test("the first positional wins; a stray extra one does not override it", () => {
    const usage = writeUsage([{ model: "m", prompt: 10 }]);
    const other = writeUsage([{ model: "m", prompt: 999 }]);
    const out = JSON.parse(run([usage, other, "--json"]).stdout);
    assert.equal(out.prompt_tokens, 10);
  });

  test("--json is recognized wherever it appears", () => {
    const usage = writeUsage([{ model: "m", prompt: 7 }]);
    const out = JSON.parse(run(["--json", usage]).stdout);
    assert.equal(out.prompt_tokens, 7);
  });

  test("a valueless --pricing does not swallow the flag after it", () => {
    const usage = writeUsage([{ model: "m", prompt: 7 }]);
    const r = run([usage, "--pricing", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.prompt_tokens, 7, "--json must still be honored");
    assert.equal(out.usd, null, "no price list was supplied");
  });

  test("a trailing --pricing with nothing after it is harmless", () => {
    const usage = writeUsage([{ model: "m", prompt: 7 }]);
    const r = run([usage, "--pricing"]);
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("price-list resolution", () => {
  const MILLION = { model: "TARGET", prompt: 1_000_000 };
  // ratio 1 => $2.00/1M input, so a priced 1M-prompt run is exactly $2.0000.
  const priceOf = (entries, model = "TARGET") => {
    const usage = writeUsage([{ ...MILLION, model }]);
    return runJson([usage, "--pricing", writePricing(entries)]).usd;
  };

  test("exact key", () => {
    assert.equal(priceOf([{ model_name: "TARGET", model_ratio: 1 }]), 2);
  });

  test("vendor prefix is dropped", () => {
    assert.equal(priceOf([{ model_name: "openai/TARGET", model_ratio: 1 }]), 2);
  });

  test("basename match is case-insensitive", () => {
    assert.equal(priceOf([{ model_name: "openai/target", model_ratio: 1 }]), 2);
  });

  test("a trailing -YYYY-MM-DD snapshot suffix is stripped", () => {
    const usage = writeUsage([{ model: "TARGET-2024-07-18", prompt: 1_000_000 }]);
    const pricing = writePricing([{ model_name: "openai/TARGET", model_ratio: 1 }]);
    assert.equal(runJson([usage, "--pricing", pricing]).usd, 2);
  });

  test("a release-channel suffix is stripped", () => {
    for (const suffix of ["preview", "latest", "stable"]) {
      const usage = writeUsage([{ model: `TARGET-${suffix}`, prompt: 1_000_000 }]);
      const pricing = writePricing([{ model_name: "openai/TARGET", model_ratio: 1 }]);
      assert.equal(runJson([usage, "--pricing", pricing]).usd, 2, suffix);
    }
  });

  test("an AMBIGUOUS basename is left unpriced rather than guessed", () => {
    const usd = priceOf([
      { model_name: "openai/TARGET", model_ratio: 1 },
      { model_name: "azure/TARGET", model_ratio: 99 },
    ]);
    assert.equal(usd, null, "two vendors share the basename, so neither ratio may be assumed");
  });

  test("a model absent from the price list is reported as such", () => {
    const usage = writeUsage([{ model: "TARGET", prompt: 1000 }]);
    const r = run([usage, "--pricing", writePricing([{ model_name: "other", model_ratio: 1 }])]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /not in price list/);
    assert.doesNotMatch(r.stdout, /TOTAL/, "an unpriced model suppresses the run total");
  });

  test("a non-numeric model_ratio is treated as unpriced", () => {
    assert.equal(priceOf([{ model_name: "TARGET", model_ratio: "1" }]), null);
  });
});

describe("cost math", () => {
  const usdFor = (row, priceEntry) => {
    const usage = writeUsage([{ model: "TARGET", ...row }]);
    const pricing = writePricing([{ model_name: "TARGET", ...priceEntry }]);
    return runJson([usage, "--pricing", pricing]).usd;
  };

  test("ratio 1 bills input at $2.00/1M", () => {
    assert.equal(usdFor({ prompt: 1_000_000 }, { model_ratio: 1 }), 2);
    assert.equal(usdFor({ prompt: 500_000 }, { model_ratio: 1 }), 1);
    assert.equal(usdFor({ prompt: 1_000_000 }, { model_ratio: 3 }), 6);
  });

  test("completion_ratio multiplies output only", () => {
    assert.equal(usdFor({ completion: 1_000_000 }, { model_ratio: 1, completion_ratio: 4 }), 8);
  });

  test("output defaults to the input rate when completion_ratio is absent", () => {
    assert.equal(usdFor({ completion: 1_000_000 }, { model_ratio: 1 }), 2);
  });

  test("cached tokens get the cache_ratio discount", () => {
    const usd = usdFor(
      { prompt: 1_000_000, cached: 1_000_000 },
      { model_ratio: 1, cache_ratio: 0.5 },
    );
    assert.equal(usd, 1, "fully cached at half rate");
  });

  test("NO cache_ratio means cached tokens are billed at the FULL input rate", () => {
    const usd = usdFor({ prompt: 1_000_000, cached: 1_000_000 }, { model_ratio: 1 });
    assert.equal(usd, 2, "same tokens cost double vs. a gateway entry that caches");
  });

  test("the missing-cache-discount case is flagged in the text report", () => {
    const usage = writeUsage([{ model: "TARGET", prompt: 1_000_000, cached: 1_000_000 }]);
    const pricing = writePricing([{ model_name: "TARGET", model_ratio: 1 }]);
    const r = run([usage, "--pricing", pricing]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no cache discount at this gateway/);
  });

  test("only the non-cached remainder is billed at the fresh rate", () => {
    // 600k fresh @ $2/1M + 400k cached @ $0.50/1M = 1.20 + 0.20
    const usd = usdFor(
      { prompt: 1_000_000, cached: 400_000 },
      { model_ratio: 1, cache_ratio: 0.25 },
    );
    assert.equal(usd, 1.4);
  });

  test("cached exceeding prompt never bills negative fresh tokens", () => {
    const usd = usdFor(
      { prompt: 100, cached: 5_000_000 },
      { model_ratio: 1, cache_ratio: 0 },
    );
    assert.equal(usd, 0, "fresh clamps at 0 and a zero cache_ratio is free");
  });

  test("per-model costs are summed into the run total", () => {
    const usage = writeUsage([
      { model: "a", prompt: 1_000_000 },
      { model: "b", prompt: 1_000_000 },
    ]);
    const pricing = writePricing([
      { model_name: "a", model_ratio: 1 },
      { model_name: "b", model_ratio: 2 },
    ]);
    const out = runJson([usage, "--pricing", pricing]);
    assert.equal(out.usd, 6);
    assert.deepEqual(
      out.by_model.map((m) => [m.model, m.usd]),
      [
        ["a", 2],
        ["b", 4],
      ],
    );
  });

  test("text mode prints the total and the per-call amplification signal", () => {
    const usage = writeUsage([
      { model: "TARGET", prompt: 400 },
      { model: "TARGET", prompt: 600 },
    ]);
    const pricing = writePricing([{ model_name: "TARGET", model_ratio: 1 }]);
    const r = run([usage, "--pricing", pricing]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /TOTAL \$0\.0020 for this run/);
    assert.match(r.stdout, /500 input tokens per call/);
  });
});
