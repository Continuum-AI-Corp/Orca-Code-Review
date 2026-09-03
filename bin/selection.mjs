// SPDX-License-Identifier: Apache-2.0
//
// File selection and per-file review rules, ported from Open Code Review.
//
// Derived from alibaba/open-code-review (Apache-2.0), at the tag recorded in
// vendor/open-code-review/UPSTREAM. This is a JavaScript port — a modified
// work under Apache §4(b) — of these Go sources:
//
//   internal/config/rules/system_rules.go   ordered path -> rule resolution,
//                                            brace expansion
//   internal/config/rules/sniffer.go        the ".m" MATLAB / Objective-C sniff
//   internal/config/allowlist/allowed_ext.go extension allowlist, default excludes
//   internal/diff/git.go                    always-skipped dirs, .gitignore matching
//   internal/agent/preview.go               the exclusion order and reason codes
//   internal/delegate/rulegroup.go          grouping files that share a rule
//
// The DATA it reads (checklists, path map, allowlist, exclude globs) is copied
// unmodified into vendor/open-code-review/.
//
// WHY A PORT AND NOT THE BINARY. `ocr` is a 50 MB Go executable per platform;
// what the local review needs from it is a few hundred KB of markdown and a
// glob matcher. Shipping the data and porting the matcher gives a repo that
// never installed anything the same file selection CI's engine applies — and
// the reviewer here is the user's own agent, so nothing that thinks is lost.
//
// WHAT IS NOT PORTED, deliberately: Open Code Review's user rule layers
// (.opencodereview/rule.json, the global rule file). Those are its own config
// format; a repo that uses it is a repo that has `ocr` set up, and this path is
// for repos that do not.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VENDOR_DIR = path.resolve(HERE, "..", "vendor", "open-code-review");

// ------------------------------------------------------------------- glob ---

/**
 * Expand every `{a,b,c}` group in a pattern into the list of plain patterns
 * it stands for. `system_rules.go` expands one group; the allowlist hands its
 * braces to doublestar, which expands all of them. Expanding all here serves
 * both — a pattern with one group is a pattern with all of its groups expanded.
 */
export function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open);
  if (close < 0) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const out = [];
  for (const alt of pattern.slice(open + 1, close).split(",")) {
    for (const rest of expandBraces(head + alt + tail)) out.push(rest);
  }
  return out;
}

const cache = new Map();

/**
 * doublestar's Match semantics as a RegExp, for one brace-free pattern:
 *   `**`  as a whole segment spans zero or more directories
 *   `*`   any run of non-`/` characters
 *   `?`   one non-`/` character
 *   `[…]` a character class; `[!…]` negates
 * Anchored at both ends — doublestar.Match is a whole-string match.
 */
export function globToRegExp(pattern) {
  let hit = cache.get(pattern);
  if (hit) return hit;

  let re = "";
  const segs = pattern.split("/");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const first = i === 0;
    const last = i === segs.length - 1;
    if (seg === "**") {
      // A whole-segment globstar spans zero or more directories. Where it sits
      // decides which separator it owns: a leading one swallows the slash after
      // it, a trailing one the slash before it, a middle one repeats "/seg".
      if (first && last) re += ".*";
      else if (first) re += "(?:.*/)?";
      else if (last) re += "(?:/.*)?";
      else re += "(?:/[^/]*)*";
      continue;
    }
    // A leading globstar already emitted the separator that follows it.
    if (!first && !(i === 1 && segs[0] === "**")) re += "/";
    for (let j = 0; j < seg.length; j++) {
      const ch = seg[j];
      if (ch === "*") re += "[^/]*";
      else if (ch === "?") re += "[^/]";
      else if (ch === "[") {
        const close = seg.indexOf("]", j + 1);
        if (close < 0) {
          re += "\\[";
          continue;
        }
        let cls = seg.slice(j + 1, close);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, "\\\\")}]`;
        j = close;
      } else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  hit = new RegExp(`^${re}$`);
  cache.set(pattern, hit);
  return hit;
}

/** Whole-string glob match, braces expanded. */
export function globMatch(pattern, str) {
  for (const p of expandBraces(pattern)) if (globToRegExp(p).test(str)) return true;
  return false;
}

// ------------------------------------------------------------------- data ---

const read = (name) => fs.readFileSync(path.join(VENDOR_DIR, name), "utf8");
let data;
function load() {
  if (data) return data;
  const sys = JSON.parse(read("system_rules.json"));
  // Object key order is insertion order for string keys, which is what the Go
  // side goes to some length to preserve: first match wins.
  const pathRules = Object.entries(sys.path_rule_map || {}).map(([pattern, doc]) => ({
    pattern,
    // Lowercased once, like resolveDetail does per call; the path is lowercased
    // to match, so `*.R` and `*.r` are the same rule.
    expanded: expandBraces(pattern.toLowerCase()),
    doc,
  }));
  const docs = new Map();
  const doc = (name) => {
    if (!docs.has(name)) docs.set(name, read(path.join("rule_docs", name)).replace(/\n+$/, ""));
    return docs.get(name);
  };
  data = {
    pathRules,
    defaultDoc: sys.default_rule,
    doc,
    allowedExt: new Set(JSON.parse(read("supported_file_types.json")).map((e) => e.toLowerCase())),
    excludeGlobs: JSON.parse(read("default_exclude_patterns.json")).map((p) => p.toLowerCase()),
  };
  return data;
}

// -------------------------------------------------------------- exclusion ---

/** Directory prefixes always skipped; a .gitignore negation cannot re-admit them. */
export const IGNORED_DIRS = [
  ".idea/",
  ".vscode/",
  ".svn/",
  ".git/",
  "vendor/",
  "node_modules/",
  "target/",
  ".happypack/",
  ".cachefile/",
  "_packages/",
  "rpm/",
  "pkgs/",
];

/** The root .gitignore only, as upstream reads it. Comments and blanks dropped. */
export function loadGitignorePatterns(repoDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// One gitignore pattern body (leading "!" already removed) against a path.
function matchGitignoreBody(relPath, body) {
  if (body.endsWith("/")) return matchGitignoreDirectory(relPath, body.slice(0, -1));

  let anchored = false;
  if (body.startsWith("/")) {
    body = body.slice(1);
    anchored = true;
  }
  if (body.includes("**")) return globMatch(body, relPath);
  if (!body.includes("/")) {
    const target = anchored ? relPath : relPath.slice(relPath.lastIndexOf("/") + 1);
    return globMatch(body, target);
  }
  if (globMatch(body, relPath)) return true;
  // "src/main.go" must not match "othersrc/main.go": the suffix has to start
  // on a component boundary, and an anchored pattern names one path only.
  return !anchored && relPath.endsWith(`/${body}`);
}

function matchGitignoreDirectory(relPath, pattern) {
  let anchored = false;
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
    anchored = true;
  }
  if (!pattern) return false;
  const lastSlash = relPath.lastIndexOf("/");
  if (lastSlash < 0) return false;
  const components = relPath.slice(0, lastSlash).split("/");
  const fullPath = anchored || pattern.includes("/");
  for (let i = 0; i < components.length; i++) {
    const candidate = fullPath ? components.slice(0, i + 1).join("/") : components[i];
    if (globMatch(pattern, candidate)) return true;
  }
  return false;
}

/**
 * Skipped outright: an always-ignored directory, or ignored by the root
 * .gitignore resolved the way git resolves it — in order, last match wins, a
 * leading "!" inverts. Upstream drops these before anything else sees them.
 */
export function isIgnored(relPath, patterns) {
  for (const prefix of IGNORED_DIRS) {
    if (relPath === prefix.slice(0, -1) || relPath.startsWith(prefix)) return true;
  }
  let excluded = false;
  for (const pat of patterns) {
    const negated = pat.startsWith("!");
    const body = negated ? pat.slice(1) : pat;
    if (!body) continue;
    // A negated directory-only pattern (`!*/`) tells git to keep descending; it
    // does not re-admit the files below.
    if (negated && body.endsWith("/")) continue;
    if (matchGitignoreBody(relPath, body)) excluded = !negated;
  }
  return excluded;
}

/** Lowercased extension with the dot; "" for none. A leading dot (".env") is a name, not an extension. */
export function extOf(relPath) {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

export const isAllowedExt = (ext) => load().allowedExt.has(ext.toLowerCase());

export function isDefaultExcludedPath(relPath) {
  const lower = relPath.toLowerCase();
  return load().excludeGlobs.some((g) => globMatch(g, lower));
}

/** Reason codes, upstream's vocabulary plus `ignored` for what it drops silently. */
export const REASON = Object.freeze({
  ignored: "in an always-skipped directory, or ignored by .gitignore",
  binary: "binary",
  project_exclude: "excluded by .orcacode-review.json",
  unsupported_ext: "file type is not reviewed",
  default_path: "matches a default exclude pattern (tests, fixtures, snapshots, generated code)",
  deleted: "deleted — nothing left to review",
});

/**
 * Why a changed file is out of scope, or "" if it is in. Same order as
 * upstream's whyExcluded: ignore list, binary, the project's own excludes,
 * extension, default path, deleted. `file` is { path, binary?, deleted? };
 * `projectExclude` is the repo's `.orcacode-review.json` globs.
 */
export function excludeReason(file, gitignore, projectExclude = []) {
  if (isIgnored(file.path, gitignore)) return "ignored";
  if (file.binary) return "binary";
  const lower = file.path.toLowerCase();
  if (projectExclude.some((g) => globMatch(g.toLowerCase(), lower))) return "project_exclude";
  const ext = extOf(file.path);
  if (ext && !isAllowedExt(ext)) return "unsupported_ext";
  if (isDefaultExcludedPath(file.path)) return "default_path";
  if (file.deleted) return "deleted";
  return "";
}

/**
 * Split changed files into the reviewable and the excluded, each excluded
 * entry carrying the reason. Extensionless files (Makefile, Dockerfile) pass
 * the extension gate, as upstream: no extension is not an unsupported one.
 */
export function partition(files, repoDir, { exclude = [] } = {}) {
  const gitignore = loadGitignorePatterns(repoDir);
  const reviewable = [];
  const excluded = [];
  for (const f of files) {
    const code = excludeReason(f, gitignore, exclude);
    if (code) excluded.push({ path: f.path, code, reason: REASON[code] });
    else reviewable.push(f);
  }
  return { files: reviewable, excluded };
}

// ------------------------------------------------------------------ rules ---

// First-line signals for Objective-C in a ".m" file. MATLAB comments start
// with "%" and a MATLAB file cannot begin with "/", so a C comment opener is
// itself a signal. Not widened to a bare "#": Octave also uses ".m" and treats
// "#" as a comment.
const OBJC_PREFIXES = [
  "#import", "#include", "#pragma", "#if", "#define",
  "@import", "@interface", "@implementation", "@class", "@protocol",
  "//", "/*",
];

function firstNonBlankLine(text) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

// Peek a ".m" file's first line at `ref` (so a commit that is not checked out
// still resolves) or from the work tree. Any failure is "", which leaves the
// path-based rule — MATLAB — in place.
function peekFirstLine(relPath, repoDir, ref) {
  try {
    if (ref) {
      const r = spawnSync("git", ["-c", "core.quotepath=false", "show", "--end-of-options", `${ref}:${relPath}`], {
        cwd: repoDir,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1 << 24,
      });
      return r.status === 0 ? firstNonBlankLine(r.stdout) : "";
    }
    return firstNonBlankLine(fs.readFileSync(path.join(repoDir, relPath), "utf8"));
  } catch {
    return "";
  }
}

function sniffsAsObjC(relPath, repoDir, ref) {
  if (!relPath.toLowerCase().endsWith(".m")) return false;
  const line = peekFirstLine(relPath, repoDir, ref);
  return !!line && OBJC_PREFIXES.some((p) => line.startsWith(p));
}

/**
 * The review checklist for one path: { pattern, rule }. First matching
 * pattern in system_rules.json wins, case-insensitively; none matching falls
 * back to the default checklist with pattern "default". A ".m" file whose
 * content sniffs as Objective-C gets objc.md while keeping the glob it matched
 * as its pattern, exactly as upstream reports it.
 */
export function resolveRule(relPath, { repoDir = process.cwd(), ref = "", rules = [] } = {}) {
  const { pathRules, defaultDoc, doc } = load();
  const lower = relPath.toLowerCase();
  let hit = { pattern: "default", docName: defaultDoc };
  for (const pr of pathRules) {
    if (pr.expanded.some((p) => globToRegExp(p).test(lower))) {
      hit = { pattern: pr.pattern, docName: pr.doc };
      break;
    }
  }
  if (sniffsAsObjC(relPath, repoDir, ref)) hit.docName = "objc.md";
  const system = doc(hit.docName);

  // The project's own rule, from .orcacode-review.json, first match wins. By
  // default it is ADDED to the bundled checklist — "also check X for API files"
  // is what people mean — and only `replace: true` drops the bundled one.
  const own = rules.find((r) => globMatch(r.path.toLowerCase(), lower));
  if (own) {
    return {
      pattern: own.path,
      source: "project",
      rule: own.replace ? own.text : `${own.text}\n\n${system}`,
    };
  }
  return { pattern: hit.pattern, source: "system", rule: system };
}

/**
 * Files grouped by the checklist they resolve to, in the shape `ocr delegate
 * rule --format json` emits: { group_id, source, pattern, files, rule }. Two
 * files share a group only when pattern AND rule text coincide, so a group's
 * pattern is true of every file in it.
 */
export function groupRules(paths, opts) {
  const index = new Map();
  const groups = [];
  for (const p of paths) {
    const { pattern, source, rule } = resolveRule(p, opts);
    const key = `${source}\0${pattern}\0${rule}`;
    let g = index.get(key);
    if (!g) {
      g = { group_id: groups.length + 1, source, pattern, files: [], rule };
      index.set(key, g);
      groups.push(g);
    }
    g.files.push(p);
  }
  return groups;
}
