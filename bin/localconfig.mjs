// `.orcacode-review.json` — the one place a repository configures the LOCAL
// review. Committed, tiny, four keys.
//
// WHY A FILE AT ALL. Flags are per run; a repo that wants "block on P0 only" or
// "never review docs/" wants it every run, for every person and every agent
// that reviews here. The Action has its workflow file for that; the local
// review had nothing.
//
// WHY NOT MORE KEYS. Each key answers one question a user actually asked:
// what blocks, what language, what to skip, what else to check. Anything the
// rubric itself decides (severity boundaries, output shape) is deliberately
// not configurable — those are the contract shared with CI.
//
// VALIDATION IS STRICT AND LOUD. A typo'd key that was silently ignored would
// make "block_on" quietly fall back to the default — the file would say P0 and
// the review would block on P1. So unknown keys and malformed values are
// errors, named precisely, and the commands refuse to run until fixed.

import fs from "node:fs";
import path from "node:path";

import { LANGUAGES } from "./i18n.mjs";
import { SEVERITIES } from "../scripts/severity.mjs";

export const CONFIG_FILE = ".orcacode-review.json";
export const CONFIG_KEYS = Object.freeze(["block_on", "language", "exclude", "rules"]);

// Keys tolerated and ignored, so a file can carry a note to its reader.
const NOTE_KEYS = new Set(["$comment", "//"]);

const fail = (error) => ({ ok: false, file: CONFIG_FILE, error });

/**
 * Read and validate the repo's config. Returns
 *   { ok: true,  file: null,        config: {} }         when there is no file
 *   { ok: true,  file: CONFIG_FILE, config: {…} }        when it parsed and validated
 *   { ok: false, file: CONFIG_FILE, error: "…" }         otherwise
 *
 * `config` is normalised: `block_on` a comma string, `exclude` an array of
 * lowercase globs, `rules` an array of { path, text, replace, source } with
 * rule files already read.
 */
export function loadLocalConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return { ok: true, file: null, config: {} };

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fail(`not valid JSON — ${e.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("must be a JSON object");

  const unknown = Object.keys(raw).filter((k) => !CONFIG_KEYS.includes(k) && !NOTE_KEYS.has(k));
  if (unknown.length) return fail(`unknown key${unknown.length === 1 ? "" : "s"} ${unknown.map((k) => `"${k}"`).join(", ")} — allowed: ${CONFIG_KEYS.join(", ")}`);

  const config = {};

  if ("block_on" in raw) {
    const v = raw.block_on;
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
    if (list === null) return fail(`"block_on" must be a string like "P0,P1" or an array of severities`);
    const cleaned = list.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    const bad = cleaned.filter((s) => !SEVERITIES.includes(s));
    if (bad.length) return fail(`"block_on" has ${bad.map((b) => `"${b}"`).join(", ")} — each entry must be one of ${SEVERITIES.join(", ")}`);
    config.block_on = cleaned.join(",");
  }

  if ("language" in raw) {
    if (!LANGUAGES.includes(raw.language)) return fail(`"language" must be one of ${LANGUAGES.join(", ")}`);
    config.language = raw.language;
  }

  if ("exclude" in raw) {
    if (!Array.isArray(raw.exclude) || raw.exclude.some((g) => typeof g !== "string" || !g.trim())) {
      return fail(`"exclude" must be an array of glob strings, e.g. ["docs/**", "**/*.generated.ts"]`);
    }
    config.exclude = raw.exclude.map((g) => g.trim());
  }

  if ("rules" in raw) {
    if (!Array.isArray(raw.rules)) return fail(`"rules" must be an array of { "path": glob, "rule": text } or { "path": glob, "rule_file": path }`);
    const rules = [];
    for (const [i, r] of raw.rules.entries()) {
      const at = `"rules"[${i}]`;
      if (!r || typeof r !== "object") return fail(`${at} must be an object`);
      if (typeof r.path !== "string" || !r.path.trim()) return fail(`${at} needs a "path" glob`);
      const hasText = typeof r.rule === "string";
      const hasFile = typeof r.rule_file === "string";
      if (hasText === hasFile) return fail(`${at} needs exactly one of "rule" (inline text) or "rule_file" (a repo-relative path)`);
      const extra = Object.keys(r).filter((k) => !["path", "rule", "rule_file", "replace"].includes(k));
      if (extra.length) return fail(`${at} has unknown key${extra.length === 1 ? "" : "s"} ${extra.map((k) => `"${k}"`).join(", ")}`);
      if ("replace" in r && typeof r.replace !== "boolean") return fail(`${at} "replace" must be true or false`);

      let text = r.rule;
      if (hasFile) {
        // Confined to the repo: a rule file is project content, and a config
        // that points outside the checkout is a config that reads someone
        // else's files into a prompt.
        const abs = path.resolve(root, r.rule_file);
        if (!abs.startsWith(`${path.resolve(root)}${path.sep}`)) return fail(`${at} "rule_file" must stay inside the repository`);
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch {
          return fail(`${at} "rule_file" ${r.rule_file} could not be read`);
        }
      }
      text = text.trim();
      if (!text) return fail(`${at} rule text is empty`);
      rules.push({ path: r.path.trim(), text, replace: r.replace === true, source: hasFile ? r.rule_file : "inline" });
    }
    config.rules = rules;
  }

  return { ok: true, file: CONFIG_FILE, config };
}

/** The file `review config init` writes. `language` is the caller's, so the template already says what they would have said. */
export function configTemplate({ language = "en", blockOn, comment = "" } = {}) {
  const doc = {
    ...(comment ? { $comment: comment } : {}),
    block_on: blockOn === undefined ? "P0,P1" : String(blockOn).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).join(","),
    language,
    exclude: [],
    rules: [],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
