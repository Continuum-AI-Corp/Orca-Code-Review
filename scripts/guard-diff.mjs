#!/usr/bin/env node
// The diff the oversized-diff guard measures.
//
//   node guard-diff.mjs --base <ref> --head <ref> --out <pr.diff> --lockfiles <out.json>
//   (run inside the hardened checkout)
//
// The merge-base diff of the PR — the range the engine reviews — WITHOUT the
// files whose name is a standard lockfile's. Hardening the checkout (`* !diff`)
// stopped a fork's .gitattributes from hiding its change, and with it stopped
// the `-diff` most repositories put on their lockfiles: a dependency bump
// regenerates megabytes of lockfile, which then counted toward max-diff-kb and
// skipped ordinary PRs. Matching by NAME, never by an attribute the PR could
// set, and leaving a file out of the count can only make the guard review more.
// The engine is unaffected: it reads the hardened checkout's own full diff.
//
// Writes the diff to --out and {"lockfiles": [paths]} to --lockfiles. Fails
// OPEN: if no diff can be produced it writes an empty one (the guard then
// reviews) and says so on stdout as a ::warning:: — a guard glitch must never
// kill the review. Always exits 0.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LOCKFILE_NAMES = Object.freeze([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
]);

// At any depth, by exact file name: `:(glob)**/<name>` matches `<name>` at the
// root too.
const lockPathspecs = (mode) => LOCKFILE_NAMES.map((n) => `:(${mode}glob)**/${n}`);

const git = (args, outFd) =>
  spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
    stdio: ["ignore", outFd ?? "pipe", "pipe"],
  });

// The merge-base range (git >= 2.30), else the equivalent three-dot form.
function diff(base, head, extra, outFd) {
  let r = git(["diff", ...extra.flags, "--merge-base", base, head, "--", ...extra.paths], outFd);
  if (r.status !== 0) r = git(["diff", ...extra.flags, `${base}...${head}`, "--", ...extra.paths], outFd);
  return r;
}

function main() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") opts.base = argv[++i];
    else if (argv[i] === "--head") opts.head = argv[++i];
    else if (argv[i] === "--out") opts.out = argv[++i];
    else if (argv[i] === "--lockfiles") opts.lockfiles = argv[++i];
  }
  let lockfiles = [];
  let ok = false;
  if (opts.base && opts.head && opts.out) {
    const fd = fs.openSync(opts.out, "w");
    try {
      ok = diff(opts.base, opts.head, { flags: [], paths: [".", ...lockPathspecs("exclude,")] }, fd).status === 0;
    } finally {
      fs.closeSync(fd);
    }
    if (ok) {
      const names = diff(opts.base, opts.head, { flags: ["--name-only", "-z", "--no-renames"], paths: lockPathspecs("") });
      if (names.status === 0) lockfiles = names.stdout.split("\0").filter(Boolean).sort();
    }
  }
  if (!ok) {
    if (opts.out) fs.writeFileSync(opts.out, "");
    console.log("::warning::OrcaCode Review: diff generation failed — size guard failing open.");
  }
  if (opts.lockfiles) fs.writeFileSync(opts.lockfiles, JSON.stringify({ lockfiles }));
  console.log(`guard diff: ${lockfiles.length} lockfile(s) not counted${lockfiles.length ? ` (${lockfiles.join(", ")})` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.log(`::warning::OrcaCode Review: the guard diff failed (${e.message}) — size guard failing open.`);
  }
  process.exit(0);
}
