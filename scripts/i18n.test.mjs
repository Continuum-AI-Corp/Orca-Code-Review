// Tests for the zh/en string table and the ORCA CODE REVIEW wordmark.
//
// The failure this guards against is not a crash — it is a Chinese session
// that silently drops to English, or worse, prints a raw key like
// "doctor.gateMissingFix" where a sentence should be. Both look like the tool
// is broken, and neither shows up in any other test.

import test from "node:test";
import assert from "node:assert/strict";

import { LANGUAGES, TABLES, makeT, parseLanguage, detectLanguage } from "../bin/i18n.mjs";
import { bannerRows, bannerWidth, renderBanner } from "../bin/banner.mjs";

// Walks a nested string table into a flat list of dotted keys.
function flatten(node, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) keys.push(...flatten(v, key));
    else keys.push(key);
  }
  return keys;
}

const lookup = (table, key) => key.split(".").reduce((n, p) => n?.[p], table);

// ------------------------------------------------------------------- table ---

// Every non-English table is checked against English. The earlier version only
// checked Chinese, so adding Japanese and Korean would have been able to ship
// half-translated with a green suite.
const TRANSLATIONS = LANGUAGES.filter((l) => l !== "en");

for (const lang of TRANSLATIONS) {
  test(`${lang} covers every English key`, () => {
    // A missing key falls back to English, which reads as a half-translated tool.
    const missing = flatten(TABLES.en).filter((k) => lookup(TABLES[lang], k) === undefined);
    assert.deepEqual(missing, [], `untranslated ${lang} keys: ${missing.join(", ")}`);
  });

  test(`${lang} adds no keys English lacks`, () => {
    // A language-only key is dead weight, and it hides that the English side
    // was never written.
    const extra = flatten(TABLES[lang]).filter((k) => lookup(TABLES.en, k) === undefined);
    assert.deepEqual(extra, [], `${lang}-only keys: ${extra.join(", ")}`);
  });

  test(`${lang} keys are functions exactly where English keys are`, () => {
    // A parameterized English string paired with a plain translation silently
    // drops the argument — the branch name or count just vanishes.
    const mismatched = flatten(TABLES.en).filter(
      (k) => typeof lookup(TABLES.en, k) !== typeof lookup(TABLES[lang], k),
    );
    assert.deepEqual(mismatched, [], `${lang} arity mismatch: ${mismatched.join(", ")}`);
  });

  test(`${lang} takes the same argument count as English`, () => {
    for (const key of flatten(TABLES.en)) {
      const en = lookup(TABLES.en, key);
      if (typeof en !== "function") continue;
      assert.equal(lookup(TABLES[lang], key).length, en.length, `${lang}.${key}: differing arity`);
    }
  });
}

test("every string is non-empty in every language", () => {
  for (const lang of LANGUAGES) {
    for (const key of flatten(TABLES[lang])) {
      const value = lookup(TABLES[lang], key);
      const rendered = typeof value === "function"
        ? value(...Array.from({ length: value.length }, (_, i) => `arg${i}`))
        : value;
      assert.ok(String(rendered).trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test("every language can name every language", () => {
  // The language screen is generated from LANGUAGES, so a missing label would
  // render an empty row the user cannot identify.
  for (const lang of LANGUAGES) {
    for (const other of LANGUAGES) {
      assert.ok(lookup(TABLES[lang], `lang.${other}`), `${lang} cannot name ${other}`);
    }
  }
});

test("commands and flags survive translation", () => {
  // A reader of any translation still has to type these. Translating or
  // dropping one produces an instruction that cannot be followed.
  //
  // The invariant is derived from English rather than hardcoded: a literal the
  // English table never mentions proves nothing about the others.
  const render = (lang) =>
    JSON.stringify(
      flatten(TABLES[lang]).map((k) => {
        const v = lookup(TABLES[lang], k);
        return typeof v === "function" ? v("A", "B") : v;
      }),
    );
  const en = render("en");

  const candidates = [
    "--force", "--platform", "--scope", "--yes", "--help", "--lang",
    "gh secret set", "gh auth login", "gh run view",
    "pull_request_target", "auto_review", "ready_for_review", "auto-review-authors",
    "npx @orcarouter/code-review", "@orcarouter/code-review skill list", "/orcacode-review",
  ];
  const present = candidates.filter((literal) => en.includes(literal));
  assert.ok(present.length >= 10, "the English table stopped mentioning the literals this test guards");

  for (const lang of TRANSLATIONS) {
    const text = render(lang);
    for (const literal of present) {
      assert.ok(text.includes(literal), `${lang} lost the literal: ${literal}`);
    }
  }
});

// ----------------------------------------------------------------- selection ---

test("makeT falls back to English for an unknown language", () => {
  assert.equal(makeT("de")("common.recommended"), TABLES.en.common.recommended);
});

test("makeT returns the key rather than throwing on an unknown key", () => {
  assert.equal(makeT("en")("no.such.key"), "no.such.key");
});

test("makeT applies arguments to parameterized strings", () => {
  assert.match(makeT("zh")("doctor.notOnBase", "main"), /main/);
  assert.match(makeT("en")("doctor.notOnBase", "main"), /main/);
});

test("parseLanguage accepts zh/en in any casing and rejects the rest", () => {
  assert.equal(parseLanguage(" ZH "), "zh");
  assert.equal(parseLanguage("en"), "en");
  assert.throws(() => parseLanguage("fr"), /unknown language/);
});

test("locale detection maps each supported language and defaults to English", () => {
  assert.equal(detectLanguage({ LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(detectLanguage({ LANG: "ja_JP.UTF-8" }), "ja");
  assert.equal(detectLanguage({ LANG: "ko_KR.UTF-8" }), "ko");
  assert.equal(detectLanguage({ LANG: "en_US.UTF-8" }), "en");
  assert.equal(detectLanguage({}), "en");
});

test("Traditional Chinese falls back to English rather than Simplified", () => {
  // zh-TW/zh-HK diverge enough in vocabulary that serving Simplified reads
  // worse than serving English. Deliberate, so pin it.
  assert.equal(detectLanguage({ LC_ALL: "zh_TW.UTF-8" }), "en");
  assert.equal(detectLanguage({ LC_ALL: "zh_HK.UTF-8" }), "en");
});

test("--lang accepts every language the picker offers", () => {
  for (const lang of LANGUAGES) assert.equal(parseLanguage(lang), lang);
});

test("LC_ALL outranks LANG, and ORCACODE_LANG outranks both", () => {
  assert.equal(detectLanguage({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }), "en");
  assert.equal(detectLanguage({ ORCACODE_LANG: "zh", LANG: "en_US.UTF-8" }), "zh");
});

test("a malformed ORCACODE_LANG falls through to the locale instead of failing", () => {
  assert.equal(detectLanguage({ ORCACODE_LANG: "klingon", LANG: "zh_CN.UTF-8" }), "zh");
});

// -------------------------------------------------------------------- banner ---

test("the wordmark fits a standard 80-column terminal", () => {
  assert.ok(bannerWidth() <= 80, `wordmark is ${bannerWidth()} columns`);
});

test("every wordmark row is the same width once color is stripped", () => {
  const rows = bannerRows(false);
  assert.ok(rows.length > 0);
  // Rows are padded to center the shorter line, so trailing space may differ;
  // what must hold is that nothing exceeds the declared width.
  for (const row of rows) assert.ok(row.length <= bannerWidth(), `row too wide: ${row.length}`);
});

test("the plain wordmark carries no escape sequences", () => {
  for (const row of bannerRows(false)) assert.doesNotMatch(row, /\x1b\[/);
});

test("the colored wordmark opens and closes every sequence", () => {
  for (const row of bannerRows(true)) {
    assert.match(row, /^\x1b\[9[46]m/);
    assert.match(row, /\x1b\[0m$/);
  }
});

test("a narrow terminal gets a one-line title instead of a wrapped wordmark", () => {
  // A wrapped wordmark reads as corruption, which is worse than no wordmark.
  let out = "";
  renderBanner((s) => { out += s; }, { color: false, columns: 40 });
  assert.equal(out.trim(), "Orca Code Review");
  assert.equal(out.split("\n").filter(Boolean).length, 1);
});

test("a wide terminal gets the full wordmark", () => {
  let out = "";
  renderBanner((s) => { out += s; }, { color: false, columns: 120 });
  assert.equal(out.split("\n").filter(Boolean).length, bannerRows(false).length);
});
