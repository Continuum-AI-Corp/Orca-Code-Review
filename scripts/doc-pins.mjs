#!/usr/bin/env node
// Keep what we publish true of the release we pin.
//
// Everything this repository hands a customer pins ONE release of the action
// (ACTION_SHA / ACTION_VERSION in bin/orcacode-review.mjs). main moves ahead of
// it, so a doc on main can describe behaviour the pinned release does not have.
// Two rules, used by scripts/pinned-release.test.mjs on every PR and by the
// publish workflow on the packed tarball:
//
//   1. A doc unit (a paragraph, list item, table row, code line, or a YAML
//      comment block) that describes unreleased behaviour carries MARKER, or
//      sits under a heading that does.
//   2. No published doc names an action version newer than the pin, except as
//      that marker.
//
//   node scripts/doc-pins.mjs --pack <npm pack --dry-run --json output>
//     checks rule 2 over every README / skills file in the tarball, exits 1
//     (with ::error:: annotations) if any names a newer version.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The next release. Bump with the release that ships it: once ACTION_VERSION
// reaches it, scripts/pinned-release.test.mjs refuses the marker everywhere.
export const UNRELEASED = "v1.7.0";
export const MARKER = `from ${UNRELEASED} (unreleased)`;

// The docs the npm tarball carries that describe the action.
export const PUBLISHED_DOCS = [
  "README.md",
  "skills/orca-review-action/SKILL.md",
  "skills/orca-review-action/references/inputs.md",
  "skills/orca-review-action/references/troubleshooting.md",
  "skills/orca-review-action/assets/workflow.yml",
  "skills/orca-review/SKILL.md",
  "skills/orca-review/references/contract.md",
];

const parse = (v) => {
  const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`not a version: ${v}`);
  return m.slice(1).map(Number);
};

export function compareVersions(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// --------------------------------------------------------------------- units

function markdownUnits(text) {
  const units = [];
  const headings = [];
  let cur = null;
  let fence = null;
  const flush = () => {
    if (cur) units.push(cur);
    cur = null;
  };
  const unit = (line, n) => ({ text: line, line: n, headings: headings.map((h) => h.text) });
  text.split("\n").forEach((line, i) => {
    const n = i + 1;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence}`).test(line)) fence = null;
      else units.push(unit(line, n)); // every code line is a unit of its own
      return;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      flush();
      fence = open[1][0] === "`" ? "`{3,}" : "~{3,}";
      return;
    }
    const h = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      while (headings.length && headings[headings.length - 1].level >= h[1].length) headings.pop();
      headings.push({ level: h[1].length, text: h[2] });
      units.push(unit(line, n));
      return;
    }
    if (!line.trim()) return flush();
    if (/^\s*\|/.test(line)) {
      flush();
      units.push(unit(line, n)); // a table row
      return;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      cur = unit(line, n); // a list item, with its continuation lines
      return;
    }
    if (cur) cur.text += `\n${line}`;
    else cur = unit(line, n);
  });
  flush();
  return units;
}

function yamlUnits(text) {
  const units = [];
  let cur = null;
  const flush = () => {
    if (cur) units.push(cur);
    cur = null;
  };
  text.split("\n").forEach((line, i) => {
    const n = i + 1;
    if (/^\s*#/.test(line)) {
      if (/^\s*#\s*$/.test(line)) return flush(); // a blank comment line ends a block
      if (cur) cur.text += `\n${line}`;
      else cur = { text: line, line: n, headings: [] };
      return;
    }
    flush();
    if (line.trim()) units.push({ text: line, line: n, headings: [] }); // with its trailing comment
  });
  flush();
  return units;
}

/** A doc split into the units rule 1 is applied to (`text` folded to one line). */
export function docUnits(name, text) {
  return (/\.md$/i.test(name) ? markdownUnits(text) : yamlUnits(text)).map((u) => ({ ...u, text: flat(u.text) }));
}

// The marker, at the start of a sentence too ("From v1.7.0 (unreleased)").
const hasMarker = (t) => t.toLowerCase().includes(MARKER);

// A unit as one line of prose: comment markers and line breaks folded, so a
// phrase or the marker broken across lines is still found.
const flat = (t) => t.replace(/\n[ \t]*(#[ \t]?)?/g, " ").replace(/^[ \t]*#[ \t]?/, "").replace(/[ \t]+/g, " ");

/** Units that mention one of `terms` ([RegExp, label] pairs) without the marker. */
export function unmarkedMentions(name, text, terms) {
  const out = [];
  for (const u of docUnits(name, text)) {
    const line = flat(u.text);
    const hit = terms.find(([re]) => re.test(line));
    if (!hit) continue;
    if (hasMarker(line) || u.headings.some(hasMarker)) continue;
    out.push(`${name}:${u.line}: ${hit[1]} — ${u.text.split("\n")[0].trim().slice(0, 100)}`);
  }
  return out;
}

/** Action versions newer than `pin` that `text` names other than as MARKER. */
export function newerVersionRefs(text, pin) {
  const out = [];
  for (const m of String(text).matchAll(/\bv1\.\d+\.\d+\b/g)) {
    if (compareVersions(m[0], pin) <= 0) continue;
    const start = m.index - "from ".length;
    if (start >= 0 && text.slice(start, start + MARKER.length).toLowerCase() === MARKER) continue;
    out.push(m[0]);
  }
  return out;
}

// ----------------------------------------------------------------------- CLI

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--pack");
  if (i < 0 || !argv[i + 1]) {
    console.error("usage: node scripts/doc-pins.mjs --pack <npm pack --dry-run --json output>");
    process.exit(2);
  }
  const root = path.resolve(HERE, "..");
  const { ACTION_VERSION } = await import(pathToFileURL(path.join(root, "bin", "orcacode-review.mjs")).href);
  const pack = JSON.parse(fs.readFileSync(argv[i + 1], "utf8"));
  const files = pack[0].files
    .map((f) => f.path)
    .filter((p) => (p === "README.md" || p.startsWith("skills/")) && /\.(md|ya?ml)$/i.test(p));
  if (!files.includes("README.md")) {
    console.error("::error::the tarball has no README.md — the doc check would be checking nothing");
    process.exit(1);
  }
  let bad = 0;
  for (const p of files) {
    const refs = newerVersionRefs(fs.readFileSync(path.join(root, p), "utf8"), ACTION_VERSION);
    if (refs.length) {
      bad += 1;
      console.log(
        `::error file=${p}::names ${[...new Set(refs)].join(", ")}, newer than the pinned ${ACTION_VERSION}. ` +
          `Mark unreleased behaviour "${MARKER}", or release and bump the pin first (RELEASE.md).`,
      );
    }
  }
  if (bad) process.exit(1);
  console.log(`docs ok — ${files.length} published doc(s) name nothing newer than ${ACTION_VERSION} outside "${MARKER}"`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
