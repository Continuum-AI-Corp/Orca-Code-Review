#!/usr/bin/env node
// Neutralise what a PR checkout could use to steer the review without changing
// a line of reviewed code. Run on the checkout BEFORE anything reads it (the
// size guard and the engine both do).
//
//   node harden-checkout.mjs [--dir <checkout>] [--base <ref>]
//
//   1. Every symlink in the work tree is deleted — tracked (`git ls-files -s`
//      mode 120000) and untracked alike, files and directories. A committed
//      `notes.md -> /proc/self/environ` would otherwise let an engine whose
//      tools read "files in the repo" read outside it. Only the link goes; its
//      target is never touched.
//   2. Repository attributes lose their say over `diff`: `* !diff` is written
//      to $GIT_DIR/info/attributes, which outranks every .gitattributes in the
//      tree. `!diff` means UNSPECIFIED, so git goes back to sniffing content —
//      a fork's `* -diff` (or the `binary` macro) can no longer turn code into
//      "Binary files differ", while a real binary stays binary. Works on any
//      git; GIT_ATTR_SOURCE would need git 2.40.
//   3. PR-controlled engine configuration goes: `.opencodereview/` is removed,
//      and the root `.gitignore` — which the engine reads to decide what to
//      skip — is replaced by the base revision's (or removed when the base has
//      none), so a PR cannot ignore its own changes.
//
// Prints a JSON report to stdout. Exits 1 if any step fails: a checkout that
// could not be hardened must not be reviewed as if it had been.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opts = { dir: process.cwd(), base: "" };
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--dir") opts.dir = argv[++i];
  else if (argv[i] === "--base") opts.base = argv[++i];
}

const fail = (msg) => {
  console.error(`harden-checkout: ${msg}`);
  process.exit(1);
};

const git = (...args) =>
  spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: opts.dir,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

const top = git("rev-parse", "--show-toplevel");
if (top.status !== 0) fail(`not a git checkout: ${opts.dir}`);
const workTree = top.stdout.trim();

// ---- 1. symlinks ---------------------------------------------------------
const removed = [];
const unlinkLink = (abs) => {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return; // already gone
  }
  if (!st.isSymbolicLink()) return;
  fs.unlinkSync(abs);
  removed.push(path.relative(workTree, abs));
};

try {
  // Tracked links first, by mode — the index is the authority on what the PR
  // committed, whatever the work tree looks like.
  const ls = git("ls-files", "-s", "-z");
  if (ls.status !== 0) throw new Error(ls.stderr.trim() || "git ls-files failed");
  for (const rec of ls.stdout.split("\0")) {
    if (!rec.startsWith("120000 ")) continue;
    const rel = rec.slice(rec.indexOf("\t") + 1);
    unlinkLink(path.join(workTree, rel));
  }
  // Then everything else on disk, untracked included. lstat-based: a link to a
  // directory is removed, never descended into.
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (d === workTree && e.name === ".git") continue;
      if (e.isSymbolicLink()) unlinkLink(abs);
      else if (e.isDirectory()) walk(abs);
    }
  };
  walk(workTree);
} catch (e) {
  fail(`could not remove symlinks (${e.message})`);
}

// ---- 2. attributes -------------------------------------------------------
const attrPath = (() => {
  const r = git("rev-parse", "--git-path", "info/attributes");
  if (r.status !== 0) fail("cannot locate $GIT_DIR/info/attributes");
  return path.resolve(workTree, r.stdout.trim());
})();
try {
  fs.mkdirSync(path.dirname(attrPath), { recursive: true });
  const prior = fs.existsSync(attrPath) ? fs.readFileSync(attrPath, "utf8") : "";
  if (!/^\* !diff$/m.test(prior)) {
    fs.writeFileSync(attrPath, `${prior}${prior && !prior.endsWith("\n") ? "\n" : ""}* !diff\n`);
  }
} catch (e) {
  fail(`could not neutralise repository attributes (${e.message})`);
}

// ---- 3. PR-controlled engine config ----------------------------------------
try {
  fs.rmSync(path.join(workTree, ".opencodereview"), { recursive: true, force: true });
} catch (e) {
  fail(`could not remove .opencodereview (${e.message})`);
}
let gitignore = "unchanged";
if (opts.base) {
  const ignorePath = path.join(workTree, ".gitignore");
  const atBase = git("show", `${opts.base}:.gitignore`);
  try {
    fs.rmSync(ignorePath, { force: true, recursive: true });
    if (atBase.status === 0) {
      fs.writeFileSync(ignorePath, atBase.stdout);
      gitignore = "base";
    } else {
      gitignore = "removed";
    }
  } catch (e) {
    fail(`could not restore the base .gitignore (${e.message})`);
  }
}

process.stdout.write(`${JSON.stringify({ removed_symlinks: removed, attributes: attrPath, gitignore })}\n`);
