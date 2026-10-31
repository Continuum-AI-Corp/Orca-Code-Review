#!/usr/bin/env node
// Install the review engine (@alibaba-group/open-code-review) from pinned,
// verified bytes, with no install scripts.
//
//   node install-engine.mjs --version <v> --prefix <dir>
//     [--pins <engine-pins.json>]      (default: next to this script)
//     [--tarball <file.tgz>]           (default: `npm pack` from the registry)
//     [--binary <file>]                (default: download the pinned URL)
//
// The engine is two artifacts: an npm package that is only a node wrapper
// (bin/ocr.js) plus a postinstall, and a ~40 MB Go binary the postinstall
// downloads from the GitHub release and checks against a checksum file fetched
// from that SAME release — no independent pin. So both are pinned here, in
// scripts/engine-pins.json, per version:
//   1. the npm tarball is fetched (`npm pack --ignore-scripts`) and its sha512
//      compared with the pinned SRI integrity BEFORE anything is unpacked;
//   2. it is installed with `npm install -g --ignore-scripts --offline` from
//      that local file into --prefix (the package has no dependencies, so
//      nothing else is fetched and no lifecycle script runs);
//   3. the platform's binary is downloaded from the pinned URL and its sha256
//      compared with the pinned value, then placed where the wrapper looks.
// Any mismatch, missing pin or failure exits 1 and removes --prefix: there is
// no "install anyway". Prints the directory to put on PATH (<prefix>/bin).
//
// A version not in the pins file is refused. Bumping the engine means adding
// its pins (registry `dist.integrity`, and the release's sha256 for each
// binary, verified by downloading them) in the same change as the bump.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = "@alibaba-group/open-code-review";

const argv = process.argv.slice(2);
const opts = { pins: path.join(HERE, "engine-pins.json") };
for (let i = 0; i < argv.length; i += 1) {
  const k = argv[i];
  if (["--version", "--prefix", "--pins", "--tarball", "--binary"].includes(k)) opts[k.slice(2)] = argv[++i];
}

let prefixCreated = false;
const fail = (msg) => {
  console.error(`install-engine: ${msg}`);
  if (prefixCreated) fs.rmSync(opts.prefix, { recursive: true, force: true });
  process.exit(1);
};

if (!opts.version || !opts.prefix) fail("usage: --version <v> --prefix <dir> [--pins f] [--tarball f] [--binary f]");

let pins;
try {
  pins = JSON.parse(fs.readFileSync(opts.pins, "utf8"));
} catch (e) {
  fail(`cannot read the pinned checksums (${e.message})`);
}
const pin = pins[opts.version];
if (!pin || typeof pin.integrity !== "string" || !pin.binaries) {
  fail(
    `engine-version ${opts.version} has no pinned checksums in this release of the action ` +
      `(pinned: ${Object.keys(pins).join(", ") || "none"}). Use a pinned version, or upgrade the action.`,
  );
}
const key = `${process.platform}-${process.arch}`;
const binPin = pin.binaries[key];
if (!binPin || !/^[0-9a-f]{64}$/.test(binPin.sha256 || "") || !/^https:\/\//.test(binPin.url || "")) {
  fail(`engine ${opts.version} has no pinned binary for ${key} (pinned: ${Object.keys(pin.binaries).join(", ")})`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-engine-"));
const cleanupWork = () => fs.rmSync(work, { recursive: true, force: true });
process.on("exit", cleanupWork);

// ---- 1. the npm tarball, verified before use -------------------------------
let tarball = opts.tarball;
if (!tarball) {
  const r = spawnSync(
    "npm",
    ["pack", `${PKG}@${opts.version}`, "--ignore-scripts", "--pack-destination", work, "--json"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) fail(`npm pack ${PKG}@${opts.version} failed: ${(r.stderr || "").trim().split("\n").pop()}`);
  let name;
  try {
    name = JSON.parse(r.stdout)[0].filename;
  } catch {
    fail("npm pack printed no filename");
  }
  tarball = path.join(work, path.basename(name));
}
let tgz;
try {
  tgz = fs.readFileSync(tarball);
} catch (e) {
  fail(`cannot read the engine tarball (${e.message})`);
}
const [algo, expected] = pin.integrity.split(/-(.+)/);
if (algo !== "sha512" || !expected) fail(`pinned integrity for ${opts.version} is not a sha512 SRI`);
const actual = crypto.createHash("sha512").update(tgz).digest("base64");
if (actual !== expected) {
  fail(`the ${PKG}@${opts.version} tarball does not match its pinned integrity (got sha512-${actual}) — refusing to install it`);
}

// ---- 2. the engine binary, verified before anything is installed -----------
let binary;
if (opts.binary) {
  try {
    binary = fs.readFileSync(opts.binary);
  } catch (e) {
    fail(`cannot read the engine binary (${e.message})`);
  }
} else {
  // curl, not fetch: it honours a self-hosted runner's proxy settings, and
  // --proto keeps every hop of GitHub's release redirect on https.
  const dest = path.join(work, "opencodereview");
  const r = spawnSync(
    "curl",
    ["-fsSL", "--proto", "=https", "--proto-redir", "=https", "--retry", "3", "-o", dest, binPin.url],
    { encoding: "utf8" },
  );
  if (r.error) fail(`curl is needed to download the engine binary (${r.error.message})`);
  if (r.status !== 0) fail(`downloading ${binPin.url} failed: ${(r.stderr || "").trim()}`);
  binary = fs.readFileSync(dest);
}
const binSha = crypto.createHash("sha256").update(binary).digest("hex");
if (binSha !== binPin.sha256) {
  fail(`the engine binary for ${key} does not match its pinned sha256 (got ${binSha}) — refusing to install it`);
}

// ---- 3. install, scripts off, nothing else fetched ----------------------------
fs.rmSync(opts.prefix, { recursive: true, force: true });
fs.mkdirSync(opts.prefix, { recursive: true });
prefixCreated = true;
const local = path.join(work, "engine.tgz");
fs.writeFileSync(local, tgz); // exactly the bytes that were verified
const r = spawnSync(
  "npm",
  ["install", "-g", "--prefix", opts.prefix, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", local],
  { encoding: "utf8" },
);
if (r.status !== 0) fail(`npm install from the verified tarball failed: ${(r.stderr || "").trim().split("\n").pop()}`);

const pkgDir = path.join(opts.prefix, "lib", "node_modules", ...PKG.split("/"));
const wrapper = path.join(opts.prefix, "bin", "ocr");
if (!fs.existsSync(path.join(pkgDir, "package.json")) || !fs.existsSync(wrapper)) {
  fail("the installed package is missing its wrapper (bin/ocr)");
}
const binDest = path.join(pkgDir, "bin", "opencodereview");
fs.mkdirSync(path.dirname(binDest), { recursive: true });
fs.writeFileSync(binDest, binary, { mode: 0o755 });
fs.chmodSync(binDest, 0o755);

console.error(`install-engine: ${PKG}@${opts.version} (${key}) installed from verified bytes into ${opts.prefix}`);
process.stdout.write(`${path.join(opts.prefix, "bin")}\n`);
