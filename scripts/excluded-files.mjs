#!/usr/bin/env node
// Which changed files the review engine does NOT review, and why.
//
//   node excluded-files.mjs --base <ref> --head <ref> --out <file.json>
//   (run inside the checkout)
//
// The engine silently skips tests, fixtures, snapshots, generated code,
// unsupported file types, binaries and anything the root .gitignore matches.
// That is a sensible default for review quality and a blind spot for a merge
// gate: a PR that moves its interesting change into `fixtures/` or a
// `*.generated.*` file is reviewed as if it had none. This lists them so the
// summary can say so — the reader decides whether that is fine.
//
// The rules are the engine's own, from the vendored data and its JavaScript
// port in bin/selection.mjs (the same port the local review uses). Writes
//   {"excluded":[{"path","code","reason"}...], "omitted": <n beyond the cap>}
// Always exits 0 with a (possibly empty) list: this is a disclosure, and a
// failure to compute it must not fail the review — it is reported on stderr
// and the file then carries `"error"`.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAP = 200;

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--base") opts.base = argv[++i];
  else if (argv[i] === "--head") opts.head = argv[++i];
  else if (argv[i] === "--out") opts.out = argv[++i];
}

const write = (obj) => {
  const json = JSON.stringify(obj);
  if (opts.out) fs.writeFileSync(opts.out, json);
  process.stdout.write(`${json}\n`);
};

const git = (...args) =>
  spawnSync("git", ["-c", "core.quotepath=false", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

// The same range the engine reviews: merge-base diff, falling back to the
// three-dot form on a git without --merge-base.
function diff(...flags) {
  let r = git("diff", ...flags, "--merge-base", opts.base, opts.head);
  if (r.status !== 0) r = git("diff", ...flags, `${opts.base}...${opts.head}`);
  if (r.status !== 0) throw new Error(r.stderr.trim() || "git diff failed");
  return r.stdout.split("\0");
}

try {
  if (!opts.base || !opts.head) throw new Error("usage: --base <ref> --head <ref> --out <file>");
  const { partition } = await import(pathToFileURL(path.join(HERE, "..", "bin", "selection.mjs")).href);

  // --name-status -z: "<status>\0<path>\0" pairs (renames off, so one path).
  const files = new Map();
  const ns = diff("--name-status", "--no-renames", "-z");
  for (let i = 0; i + 1 < ns.length; i += 2) {
    if (!ns[i]) continue;
    files.set(ns[i + 1], { path: ns[i + 1], deleted: ns[i].startsWith("D") });
  }
  // --numstat -z: "<added>\t<deleted>\t<path>\0"; "-\t-" marks a binary.
  for (const rec of diff("--numstat", "--no-renames", "-z")) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]+)$/);
    if (m && m[1] === "-" && files.has(m[3])) files.get(m[3]).binary = true;
  }

  const { excluded } = partition([...files.values()], process.cwd());
  // Deleted files leave nothing to review; listing them says nothing useful.
  const shown = excluded.filter((e) => e.code !== "deleted");
  write({ excluded: shown.slice(0, CAP), omitted: Math.max(0, shown.length - CAP) });
} catch (e) {
  console.error(`excluded-files: could not list skipped files (${e.message})`);
  write({ excluded: [], omitted: 0, error: "could not list skipped files" });
}
