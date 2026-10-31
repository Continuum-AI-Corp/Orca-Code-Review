// CR-9: the review engine's supply chain.
//
// The action used to run `npm install -g "@alibaba-group/open-code-review@1.3.13"`:
// the version pin covered the top-level package only, install scripts ran (the
// package's postinstall downloads a 40 MB Go binary and checks it against a
// checksum file fetched from the SAME release — no independent pin), and
// nothing checked the tarball's integrity. Its own `uses:` steps were tags.
//
// scripts/install-engine.mjs now: refuses any engine-version without pinned
// checksums in scripts/engine-pins.json; verifies the npm tarball against the
// pinned sha512 SRI before installing it with --ignore-scripts into a prefix
// under $RUNNER_TEMP; downloads the platform binary itself and verifies it
// against the pinned sha256. Every failure fails closed, and nothing is left
// installed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

import { step, readText, actionSteps } from "./test-helpers/action-yaml.mjs";

const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const INSTALLER = path.join(SCRIPTS, "install-engine.mjs");
const PINS = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "engine-pins.json"), "utf8"));

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-engine-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const sri = (buf) => `sha512-${crypto.createHash("sha512").update(buf).digest("base64")}`;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const platformKey = `${process.platform}-${process.arch}`;

let n = 0;
// A stand-in engine package whose postinstall would leave a marker if it ran.
function fakeEngine() {
  n += 1;
  const root = path.join(dir, `pkg${n}`);
  const pkg = path.join(root, "package");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  const marker = path.join(root, "postinstall-ran");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@alibaba-group/open-code-review",
      version: "9.9.9",
      bin: { ocr: "bin/ocr.js" },
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','ran')"` },
    }),
  );
  fs.writeFileSync(path.join(pkg, "bin", "ocr.js"), "#!/usr/bin/env node\nconsole.log('ocr wrapper');\n");
  const tgz = path.join(root, "engine.tgz");
  const r = spawnSync("tar", ["-czf", tgz, "-C", root, "package"]);
  assert.equal(r.status, 0, String(r.stderr));
  const binary = path.join(root, "opencodereview");
  fs.writeFileSync(binary, `#!/bin/sh\necho engine ${n}\n`);
  const pins = path.join(root, "pins.json");
  const tgzBuf = fs.readFileSync(tgz);
  fs.writeFileSync(
    pins,
    JSON.stringify({
      "9.9.9": {
        integrity: sri(tgzBuf),
        binaries: { [platformKey]: { url: "https://example.invalid/opencodereview", sha256: sha256(fs.readFileSync(binary)) } },
      },
    }),
  );
  return { root, tgz, binary, pins, marker };
}

const install = (args) => spawnSync("node", [INSTALLER, ...args], { encoding: "utf8" });

describe("the pinned checksums", () => {
  test("1.3.13 (the default engine-version) is pinned to the published tarball and release binaries", () => {
    const p = PINS["1.3.13"];
    assert.equal(p.integrity, "sha512-XAWyBlKOcf/wIspLc2FHo4iVV9XF2lxpSI/jGhOkXxFOmYnw+mnL5nXc0U+QyJBfVi9vmvTirQ0/Y3NfyrXwjQ==");
    assert.equal(p.binaries["linux-x64"].sha256, "6d51ce0b18236e6c13ab24f38f70e861052439d2c675311f58fbd85e0194fd81");
    assert.equal(p.binaries["linux-arm64"].sha256, "e78b69718554ff3c4db7a90e30705ddb4100a2541025e384566dfc0b092fd5b3");
    for (const b of Object.values(p.binaries)) assert.match(b.url, /^https:\/\/github\.com\/alibaba\/open-code-review\/releases\/download\/v1\.3\.13\//);
  });

  test("the action's engine-version default has pins", () => {
    const def = YAML.parse(readText("action.yml")).inputs["engine-version"].default;
    assert.ok(PINS[def], `engine-version default ${def} has no pinned checksums`);
  });
});

describe("install-engine.mjs", () => {
  test("a verified tarball installs WITHOUT running its install scripts, and the verified binary lands next to the wrapper", () => {
    const e = fakeEngine();
    const prefix = path.join(e.root, "prefix");
    const r = install(["--version", "9.9.9", "--prefix", prefix, "--pins", e.pins, "--tarball", e.tgz, "--binary", e.binary]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(e.marker), false, "the package's postinstall ran");
    assert.equal(r.stdout.trim(), path.join(prefix, "bin"));
    assert.ok(fs.existsSync(path.join(prefix, "bin", "ocr")));
    const placed = path.join(prefix, "lib", "node_modules", "@alibaba-group", "open-code-review", "bin", "opencodereview");
    assert.deepEqual(fs.readFileSync(placed), fs.readFileSync(e.binary));
    assert.ok(fs.statSync(placed).mode & 0o100, "the engine binary is not executable");
  });

  test("an engine-version with no pins is refused (fail closed)", () => {
    const e = fakeEngine();
    const prefix = path.join(e.root, "prefix");
    const r = install(["--version", "1.0.0", "--prefix", prefix, "--pins", e.pins, "--tarball", e.tgz, "--binary", e.binary]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no pinned checksums/i);
    assert.equal(fs.existsSync(path.join(prefix, "bin", "ocr")), false);
  });

  test("a tarball that does not match the pinned integrity is refused before anything is installed", () => {
    const e = fakeEngine();
    fs.appendFileSync(e.tgz, Buffer.from([0]));
    const prefix = path.join(e.root, "prefix");
    const r = install(["--version", "9.9.9", "--prefix", prefix, "--pins", e.pins, "--tarball", e.tgz, "--binary", e.binary]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /integrity/i);
    assert.equal(fs.existsSync(path.join(prefix, "bin", "ocr")), false);
  });

  test("a binary that does not match the pinned sha256 is refused and nothing is left installed", () => {
    const e = fakeEngine();
    fs.appendFileSync(e.binary, "tampered");
    const prefix = path.join(e.root, "prefix");
    const r = install(["--version", "9.9.9", "--prefix", prefix, "--pins", e.pins, "--tarball", e.tgz, "--binary", e.binary]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sha256/i);
    assert.equal(fs.existsSync(path.join(prefix, "bin", "ocr")), false);
  });

  test("a platform with no pinned binary is refused", () => {
    const e = fakeEngine();
    const pins = JSON.parse(fs.readFileSync(e.pins, "utf8"));
    pins["9.9.9"].binaries = { "plan9-mips": { url: "https://x.invalid/b", sha256: "0".repeat(64) } };
    fs.writeFileSync(e.pins, JSON.stringify(pins));
    const r = install(["--version", "9.9.9", "--prefix", path.join(e.root, "p"), "--pins", e.pins, "--tarball", e.tgz, "--binary", e.binary]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(platformKey));
  });
});

describe("action.yml installs the engine through the verifier", () => {
  test("the install step runs install-engine.mjs and puts its prefix on PATH", () => {
    const s = step("Install review engine");
    assert.match(s.env.INSTALLER, /scripts\/install-engine\.mjs$/);
    assert.match(s.env.ENGINE_PREFIX, /runner\.temp/);
    assert.match(s.run, /node "\$INSTALLER" --version "\$ENGINE_VERSION" --prefix "\$ENGINE_PREFIX"/);
    assert.match(s.run, /GITHUB_PATH/);
  });

  test("no step installs an npm package with its scripts enabled", () => {
    for (const st of actionSteps()) {
      for (const line of String(st.run || "").split("\n")) {
        if (/^\s*#/.test(line)) continue;
        if (/\bnpm\s+(install|i|ci)\b/.test(line)) {
          assert.match(line, /--ignore-scripts/, `${st.name}: ${line.trim()}`);
        }
      }
    }
  });
});

describe("every uses: is pinned to a commit SHA with its version in a comment", () => {
  // Comments are read through the parser's document model (a trailing comment
  // belongs to the scalar it follows), not by matching lines of text.
  function usesNodes(rel) {
    const doc = YAML.parseDocument(readText(rel));
    const out = [];
    YAML.visit(doc, {
      Pair(_, pair) {
        if (YAML.isScalar(pair.key) && pair.key.value === "uses" && YAML.isScalar(pair.value)) out.push(pair.value);
      },
    });
    return out;
  }

  for (const rel of [
    "action.yml",
    ".github/workflows/test.yml",
    ".github/workflows/self-review.yml",
    ".github/workflows/publish.yml",
    ".github/workflows/deprecate.yml",
  ]) {
    test(rel, () => {
      const nodes = usesNodes(rel).filter((v) => !String(v.value).startsWith("./"));
      assert.ok(nodes.length > 0 || rel !== "action.yml", "found no uses: in action.yml — is the parser blind?");
      for (const v of nodes) {
        assert.match(String(v.value), /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${rel}: ${v.value} is not pinned to a full SHA`);
        assert.match(String(v.comment || ""), /^\s*v\d+\.\d+\.\d+\s*$/, `${rel}: ${v.value} has no "# vX.Y.Z" comment`);
      }
    });
  }
});
