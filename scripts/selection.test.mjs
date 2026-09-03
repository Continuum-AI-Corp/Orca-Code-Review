// The vendored Open Code Review rules and the port of its matcher.
//
// Two things are worth guarding: that the matcher agrees with doublestar and
// with gitignore where upstream's Go does (so local file selection stays the
// selection CI applies), and that the vendored corpus is complete — every
// checklist the path map names must exist, or a plan quietly loses a rule.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  VENDOR_DIR,
  IGNORED_DIRS,
  REASON,
  expandBraces,
  globMatch,
  isIgnored,
  extOf,
  isAllowedExt,
  isDefaultExcludedPath,
  excludeReason,
  partition,
  resolveRule,
  groupRules,
} from "../bin/selection.mjs";

// ------------------------------------------------------------------- glob ---

test("globstar spans zero or more directories, wherever it sits", () => {
  for (const [p, s] of [
    ["**/*.go", "a.go"],
    ["**/*.go", "x/y/a.go"],
    ["**/__tests__/**", "__tests__/x.js"],
    ["**/__tests__/**", "src/__tests__/x.js"],
    ["a/**/b", "a/b"],
    ["a/**/b", "a/x/y/b"],
    ["lib/**/*.sol", "lib/forge-std/x.sol"],
  ]) assert.equal(globMatch(p, s), true, `${p} should match ${s}`);
  for (const [p, s] of [
    ["**/*.go", "a.py"],
    ["a/**/b", "a/xb"],
    ["lib/**/*.sol", "src/x.sol"],
    ["**/__tests__/**", "src/tests/x.js"],
  ]) assert.equal(globMatch(p, s), false, `${p} should not match ${s}`);
});

test("a single star never crosses a slash — the root-only idiom depends on it", () => {
  assert.equal(globMatch("*_test.go", "foo_test.go"), true);
  assert.equal(globMatch("*_test.go", "pkg/foo_test.go"), false);
});

test("braces expand at every depth, and classes and ? are honoured", () => {
  assert.deepEqual(expandBraces("**/*.{a,b}.{x,y}"), ["**/*.a.x", "**/*.a.y", "**/*.b.x", "**/*.b.y"]);
  assert.equal(globMatch("**/*.test.{js,jsx,ts,tsx}", "src/app.test.tsx"), true);
  assert.equal(globMatch("**/*{mapper,dao}*.xml", "src/usermapper.xml"), true);
  assert.equal(globMatch("**/*.[ch]", "x.c"), true);
  assert.equal(globMatch("**/*.[ch]", "x.o"), false);
  assert.equal(globMatch("a?c", "abc"), true);
  assert.equal(globMatch("a?c", "a/c"), false);
});

// --------------------------------------------------------------- gitignore ---

const GI = ["*.log", "build/", "!keep.log", "/root.txt", "docs/*.md", "**/gen/*.js"];

test("gitignore is resolved in order with last match winning and ! inverting", () => {
  assert.equal(isIgnored("app.log", GI), true);
  assert.equal(isIgnored("keep.log", GI), false, "a later negation re-admits");
});

test("a slashless pattern matches a basename at any depth; a slash anchors it", () => {
  assert.equal(isIgnored("deep/app.log", GI), true);
  assert.equal(isIgnored("root.txt", GI), true);
  assert.equal(isIgnored("sub/root.txt", GI), false, "a leading / names the root file only");
  assert.equal(isIgnored("docs/a.md", GI), true);
  // Same as git: "docs/*.md" is relative to the .gitignore, not "any docs dir".
  assert.equal(isIgnored("x/docs/a.md", GI), false);
});

test("a directory pattern excludes everything below a directory of that name", () => {
  assert.equal(isIgnored("build/a.js", GI), true);
  assert.equal(isIgnored("src/build/a.js", GI), true);
  assert.equal(isIgnored("build", GI), false, "a file named like the directory is not the directory");
});

test("the always-skipped directories cannot be re-admitted by a negation", () => {
  assert.equal(isIgnored("node_modules/x.js", ["!node_modules/"]), true);
  assert.equal(isIgnored("vendor/y.go", []), true);
  assert.equal(isIgnored("vendored/y.go", []), false, "prefix means a path component, not a string prefix");
  assert.ok(IGNORED_DIRS.includes(".git/"));
});

// --------------------------------------------------------------- exclusion ---

test("extension is taken from the basename, lowercased, and a dotfile has none", () => {
  assert.equal(extOf("a/B.GO"), ".go");
  assert.equal(extOf(".env"), "");
  assert.equal(extOf("Makefile"), "");
  assert.equal(extOf("dir.v1/file"), "");
});

test("exclusion reasons follow upstream's order and vocabulary", () => {
  const r = (f) => excludeReason(f, []);
  assert.equal(r({ path: "src/a.go" }), "");
  assert.equal(r({ path: "src/a_test.go" }), "default_path");
  assert.equal(r({ path: "img.png" }), "unsupported_ext");
  assert.equal(r({ path: "a.bin", binary: true }), "binary");
  assert.equal(r({ path: "old.go", deleted: true }), "deleted");
  // Extensionless files pass the extension gate: no extension is not an
  // unsupported one.
  assert.equal(r({ path: "Makefile" }), "");
  // Ignore list beats everything, including "it is binary".
  assert.equal(r({ path: "node_modules/a.bin", binary: true }), "ignored");
  // A deleted test file is reported as a test file — deleted is the last check.
  assert.equal(r({ path: "a_test.go", deleted: true }), "default_path");
  for (const code of Object.keys(REASON)) assert.ok(REASON[code], `reason text for ${code}`);
});

test("partition keeps order and attaches a human reason to each exclusion", (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "sel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
  const { files, excluded } = partition(
    [{ path: "src/a.ts" }, { path: "debug.log" }, { path: "src/a.test.ts" }, { path: "b.py" }],
    dir,
  );
  assert.deepEqual(files.map((f) => f.path), ["src/a.ts", "b.py"]);
  assert.deepEqual(
    excluded.map((e) => [e.path, e.code]),
    [["debug.log", "ignored"], ["src/a.test.ts", "default_path"]],
  );
  assert.equal(excluded[0].reason, REASON.ignored);
});

test("the allowlist and the default excludes are case-insensitive", () => {
  assert.equal(isAllowedExt(".GO"), true);
  assert.equal(isDefaultExcludedPath("SRC/FOO_TEST.GO"), true);
});

// ------------------------------------------------------------------- rules ---

test("first matching pattern wins, in file order, so the specific beats the general", () => {
  // Three patterns match a workflow file; the one declared first is the answer.
  assert.equal(resolveRule(".github/workflows/ci.yml").pattern, ".github/workflows/**/*.{yaml,yml}");
  assert.equal(resolveRule(".github/dependabot.yml").pattern, ".github/**/*.{yaml,yml}");
  assert.equal(resolveRule("conf/app.yaml").pattern, "**/*.{yaml,yml}");
  assert.equal(resolveRule("x/pom.xml").pattern, "**/pom.xml");
});

test("an unmatched path gets the default checklist, named as such", () => {
  const r = resolveRule("README.md");
  assert.equal(r.pattern, "default");
  assert.match(r.rule, /#### Correctness/);
});

test("matching is case-insensitive on both sides", () => {
  assert.equal(resolveRule("a/b.R").pattern, "**/*.R");
  assert.equal(resolveRule("a/b.r").pattern, "**/*.R");
  assert.equal(resolveRule("SRC/MAIN.GO").pattern, "**/*.go");
});

test("a .m file is MATLAB by path and Objective-C by content", (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "sniff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "plot.m"), "% MATLAB comment\nx = 1;\n");
  fs.writeFileSync(path.join(dir, "View.m"), "\n#import <UIKit/UIKit.h>\n@implementation View\n");
  fs.writeFileSync(path.join(dir, "hdr.m"), "// license header\n#import <Foundation/Foundation.h>\n");
  const matlab = resolveRule("plot.m", { repoDir: dir });
  const objc = resolveRule("View.m", { repoDir: dir });
  const commented = resolveRule("hdr.m", { repoDir: dir });
  assert.match(matlab.rule, /MATLAB/i);
  assert.match(objc.rule, /Objective-C/i);
  assert.match(commented.rule, /Objective-C/i, "a C comment opener is itself an ObjC signal");
  // The glob that matched is reported unchanged; the sniff only swaps the text.
  assert.equal(objc.pattern, "**/*.m");
  // Unreadable: the path-based answer stands.
  assert.match(resolveRule("missing.m", { repoDir: dir }).rule, /MATLAB/i);
});

test("groups join files only when pattern and checklist both coincide", () => {
  const g = groupRules(["a.go", "b/c.go", "x.ts", "y.tsx", "README.md"]);
  assert.deepEqual(
    g.map((x) => [x.group_id, x.pattern, x.files]),
    [
      [1, "**/*.go", ["a.go", "b/c.go"]],
      [2, "**/*.{ts,js,tsx,jsx,mjs,cjs}", ["x.ts", "y.tsx"]],
      [3, "default", ["README.md"]],
    ],
  );
  for (const x of g) {
    assert.equal(x.source, "system");
    assert.ok(x.rule.length > 0);
  }
});

// ------------------------------------------------------------------ vendor ---

test("every checklist the path map names is present in the vendored corpus", () => {
  const sys = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, "system_rules.json"), "utf8"));
  const docs = new Set(fs.readdirSync(path.join(VENDOR_DIR, "rule_docs")));
  const named = new Set([sys.default_rule, "objc.md", ...Object.values(sys.path_rule_map)]);
  for (const d of named) assert.ok(docs.has(d), `missing rule doc ${d}`);
  // And nothing vendored that nothing names — a stray file is a sign the copy
  // came from a different tag than UPSTREAM says.
  for (const d of docs) assert.ok(named.has(d), `unreferenced rule doc ${d}`);
});

test("the vendored directory carries its licence and provenance", () => {
  const license = fs.readFileSync(path.join(VENDOR_DIR, "LICENSE"), "utf8");
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0/);
  const upstream = fs.readFileSync(path.join(VENDOR_DIR, "UPSTREAM"), "utf8");
  assert.match(upstream, /alibaba\/open-code-review/);
  assert.match(upstream, /tag\s+v\d+\.\d+\.\d+/);
  assert.match(upstream, /commit\s+[0-9a-f]{40}/);
});

test("the package ships the vendored corpus", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("vendor/"), "vendor/ must be in package.json files or the plan has no rules");
});

test("nothing in the harness spawns ocr any more", () => {
  for (const f of ["harness.mjs", "review.mjs", "selection.mjs"]) {
    const src = fs.readFileSync(new URL(`../bin/${f}`, import.meta.url), "utf8");
    assert.ok(!/spawnSync\(\s*"ocr"/.test(src), `${f} still shells out to ocr`);
  }
});
