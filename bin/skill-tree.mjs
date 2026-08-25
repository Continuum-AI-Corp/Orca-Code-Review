// Installing a skill *directory* into a platform's skills root.
//
// orcadub ships a single SKILL.md, so it can install with one atomic
// link-or-rename. This skill is a tree (SKILL.md + references/ + assets/), so
// the unit of comparison is the whole tree: a partially-updated skill — new
// SKILL.md pointing at a reference file from the previous version — is worse
// than either version alone, because the agent follows a link into stale
// guidance and has no way to notice.
//
// Statuses match orcadub's so both installers report the same words:
//   installed | updated | unchanged | conflict | error
//
// An existing tree that differs is NEVER overwritten without `force`. A user
// may have edited the skill; silently reverting their edits is the one failure
// mode an installer cannot apologize its way out of.

import fs from "node:fs";
import path from "node:path";

export const STATUS = Object.freeze({
  installed: "installed",
  updated: "updated",
  unchanged: "unchanged",
  conflict: "conflict",
  error: "error",
});

/** Reads a directory into a Map of posix-relative path -> Buffer. */
export function readTree(root) {
  const files = new Map();

  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) files.set(rel, fs.readFileSync(abs));
    }
  };

  walk(root, "");
  return files;
}

export function treesEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [rel, buf] of a) {
    const other = b.get(rel);
    if (!other || !buf.equals(other)) return false;
  }
  return true;
}

// Same-directory temp file + rename: the destination is either the old content
// or the new content, never a half-written file an agent might read mid-write.
function writeFileAtomic(dest, data, { noClobber = false } = {}) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(dest)}-${process.pid}-${counter++}`);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o644 });
    if (noClobber) {
      // link() fails with EEXIST rather than clobbering, which closes the gap
      // between "we checked and it was absent" and "we wrote".
      fs.linkSync(tmp, dest);
    } else {
      fs.renameSync(tmp, dest);
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* the rename already consumed it */ }
  }
}
let counter = 0;

/**
 * Installs `source` (a directory) at `dest`, returning one of STATUS.
 * Never throws for the ordinary conflict case — that is a status, not an error.
 */
export function installTree(source, dest, { force = false } = {}) {
  const wanted = readTree(source);
  if (wanted.size === 0) throw new Error(`skill source is empty: ${source}`);

  const destExists = fs.existsSync(dest);

  if (destExists) {
    const current = readTree(dest);
    if (treesEqual(wanted, current)) return STATUS.unchanged;
    if (!force) return STATUS.conflict;

    for (const [rel, data] of wanted) writeFileAtomic(path.join(dest, rel), data);

    // Drop files the new version no longer ships, so a stale reference cannot
    // outlive the SKILL.md that used to point at it.
    for (const rel of current.keys()) {
      if (!wanted.has(rel)) fs.rmSync(path.join(dest, rel), { force: true });
    }
    pruneEmptyDirs(dest);
    return STATUS.updated;
  }

  let clobbered = false;
  for (const [rel, data] of wanted) {
    try {
      writeFileAtomic(path.join(dest, rel), data, { noClobber: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Something created the tree between our check and this write. Re-read and
      // let the normal comparison decide instead of racing it.
      clobbered = true;
      break;
    }
  }
  if (!clobbered) return STATUS.installed;

  const current = readTree(dest);
  if (treesEqual(wanted, current)) return STATUS.unchanged;
  if (!force) return STATUS.conflict;
  for (const [rel, data] of wanted) writeFileAtomic(path.join(dest, rel), data);
  return STATUS.updated;
}

function pruneEmptyDirs(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(root, entry.name);
    pruneEmptyDirs(abs);
    if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
  }
}
