// Contract tests for postfilter.mjs — the L1 deterministic filter that sits
// between the engine and the merge gate (`precision-filter` defaults to
// "true", so this runs on every review).
//
// It treats each finding's `existing_code` as a ground-truth locator: git-grep
// the quoted snippet in the reviewed commit's tree and decide where — or
// whether — the finding really belongs. Both failure directions cost real
// review value, so the tests pin both:
//   - too eager  -> a real defect is DROPPED, or re-homed onto the wrong file
//   - too timid  -> misfiled findings survive and the reviewer loses trust
//
// The subtle rule is the non-code classification that gates DROP. Dropping is
// only allowed when the snippet matched NOWHERE and the claimed path is
// clearly not code. `.json`/`.yaml` are deliberately ambiguous: action.yml and
// package.json are reviewable configuration, while lockfiles, locale bundles
// and build output are not. Extensionless code (Dockerfile, Makefile) once
// fell through this branch and got dropped as if it were a locale file, so
// that polarity is pinned explicitly below.
//
// These tests build a REAL git repo fixture rather than mocking git: the whole
// point of L1 is what git-grep actually reports about a real tree.

import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const POSTFILTER = join(SCRIPTS, "postfilter.mjs");

// Snippets must be >= 12 chars to be used as locators (candidateLines filter).
const IN_APP = "const uniqueInApp = computeSomethingDistinct(1);";
const ONLY_MOVED = "const snippetOnlyHere = doTheThingExactlyOnce(42);";
const TWICE = "const repeatedSnippet = sameCallTwice(7);";
const SHARED = "const sharedBetweenFiles = ambiguousHelper(0);";
const NOWHERE = "const thisAppearsNowhereInTheTree = 12345;";

// ONLY_MOVED sits on line 3 of src/moved.js — the rehome tests assert this.
const FIXTURE = {
  "src/app.js": `// header\n${IN_APP}\n`,
  "src/moved.js": `// one\n// two\n${ONLY_MOVED}\n// four\n`,
  "src/twice.js": `${TWICE}\n// filler\n${TWICE}\n`,
  "src/amb_a.js": `${SHARED}\n`,
  "src/amb_b.js": `${SHARED}\n`,
  "locales/en.json": '{ "greeting": "hello" }\n',
  "src/i18n/messages.json": '{ "k": "v" }\n',
  "dist/bundle.json": '{ "built": true }\n',
  "package-lock.json": '{ "lockfileVersion": 3 }\n',
  "docs/guide.md": "# Guide\n",
  Dockerfile: "RUN apt-get install --no-install-recommends ca-certificates\n",
  "action.yml": "name: Thing\n",
  Makefile: "all:\n\techo hi\n",
};

let repo;
let commit;
let work;
let seq = 0;

before(() => {
  work = mkdtempSync(join(tmpdir(), "postfilter-test-"));
  repo = join(work, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", repo]);
  // Hermetic: never read the developer's identity, signing config, or CRLF
  // rewriting — the last one would change what git-grep matches.
  git("config", "user.email", "postfilter-test@example.invalid");
  git("config", "user.name", "postfilter test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  for (const [rel, body] of Object.entries(FIXTURE)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  commit = git("rev-parse", "HEAD").trim();
});

after(() => {
  rmSync(work, { recursive: true, force: true });
});

function writeResult(body) {
  const file = join(work, `${(seq += 1)}-result.json`);
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

// Runs the filter over `comments` and returns the parsed output plus stderr.
function filter(comments, extra = {}) {
  const input = writeResult({ ...extra, comments });
  const out = join(work, `${(seq += 1)}-out.json`);
  const r = spawnSync("node", [POSTFILTER, input, repo, commit, "--out", out], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(readFileSync(out, "utf8")), stderr: r.stderr };
}

// A finding is only as good as its locator, so every case supplies both.
const finding = (path, existing_code, content = "[P1] something") => ({
  path,
  existing_code,
  content,
  start_line: 1,
  end_line: 1,
});

describe("usage", () => {
  test("missing arguments exit 2", () => {
    for (const args of [[], [writeResult({ comments: [] })], [writeResult({ comments: [] }), repo]]) {
      const r = spawnSync("node", [POSTFILTER, ...args], { encoding: "utf8" });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /usage: node postfilter\.mjs/);
    }
  });

  test("--out is optional; the report still goes to stderr", () => {
    const input = writeResult({ comments: [finding("src/app.js", IN_APP)] });
    const r = spawnSync("node", [POSTFILTER, input, repo, commit], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /in=1\s+out=1/);
  });
});

describe("snippet found in the claimed path -> keep as filed", () => {
  test("path and lines are left untouched", () => {
    const { out } = filter([finding("src/app.js", IN_APP)]);
    assert.equal(out.comments.length, 1);
    assert.equal(out.comments[0].path, "src/app.js");
    assert.equal(out.comments[0].start_line, 1);
  });
});

describe("snippet found in exactly one OTHER file -> re-home", () => {
  test("a single matching line moves the path AND the line numbers", () => {
    const { out } = filter([finding("src/app.js", ONLY_MOVED)]);
    assert.equal(out.comments.length, 1);
    const c = out.comments[0];
    assert.equal(c.path, "src/moved.js");
    assert.equal(c.start_line, 3, "the line must come from the TARGET file, not the claim");
    assert.equal(c.end_line, 3);
  });

  test("multiple matching lines re-home the path but clear the now-unusable line", () => {
    const { out } = filter([finding("src/app.js", TWICE)]);
    const c = out.comments[0];
    assert.equal(c.path, "src/twice.js", "L1 proved the code is NOT on the claimed path");
    assert.equal(c.start_line, null, "a stale line would post on an unrelated line or be rejected");
    assert.equal(c.end_line, null);
  });

  test("the re-home is reported to stderr", () => {
    const { stderr } = filter([finding("src/app.js", ONLY_MOVED)]);
    assert.match(stderr, /REHOME src\/app\.js -> src\/moved\.js:3/);
  });
});

describe("snippet found in several files -> ambiguous, keep as filed", () => {
  test("the finding stays on its original path", () => {
    const { out, stderr } = filter([finding("src/app.js", SHARED)]);
    assert.equal(out.comments.length, 1);
    assert.equal(out.comments[0].path, "src/app.js");
    assert.match(stderr, /ambiguous: 2 files/);
  });
});

describe("snippet found nowhere", () => {
  test("a code path keeps the finding as unverified", () => {
    const { out } = filter([finding("src/app.js", NOWHERE)]);
    assert.equal(out.comments.length, 1, "L1 must not drop what it merely cannot confirm");
  });

  test("a clearly-non-code path drops it", () => {
    for (const path of [
      "locales/en.json",
      "src/i18n/messages.json",
      "dist/bundle.json",
      "package-lock.json",
      "docs/guide.md",
    ]) {
      const { out } = filter([finding(path, NOWHERE)]);
      assert.equal(out.comments.length, 0, path);
    }
  });

  test("extensionless code files are NOT treated as non-code", () => {
    for (const path of ["Dockerfile", "Makefile"]) {
      const { out } = filter([finding(path, NOWHERE)]);
      assert.equal(out.comments.length, 1, `${path} must survive: it is code, not a locale bundle`);
    }
  });

  test("reviewable config keeps its findings even though it is .yml/.json", () => {
    for (const path of ["action.yml", "package.json", ".github/workflows/ci.yml"]) {
      const { out } = filter([finding(path, NOWHERE)]);
      assert.equal(out.comments.length, 1, path);
    }
  });

  test("a snippet shorter than the 12-char locator floor is never grepped", () => {
    // Too short to locate, so the finding is unverified — and on a code path
    // that means keep, not drop.
    const { out } = filter([finding("src/app.js", "x = 1;")]);
    assert.equal(out.comments.length, 1);
  });
});

describe("dedupe by normalized content", () => {
  test("the severity tag, case and whitespace are ignored when comparing", () => {
    const a = finding("src/app.js", NOWHERE, "[P1] Missing null check on user input");
    const b = finding("Dockerfile", NOWHERE, "[P2]   missing NULL   check on user input  ");
    const { out, stderr } = filter([a, b]);
    assert.equal(out.comments.length, 1, "same root cause reported twice");
    assert.equal(out.comments[0].content, "[P1] Missing null check on user input", "first wins");
    assert.match(stderr, /DROP \(dup of src\/app\.js\)/);
  });

  test("genuinely different findings both survive", () => {
    const a = finding("src/app.js", NOWHERE, "[P1] first problem");
    const b = finding("src/app.js", NOWHERE, "[P1] a completely different problem");
    assert.equal(filter([a, b]).out.comments.length, 2);
  });
});

describe("output shape", () => {
  test("non-comment top-level keys survive", () => {
    const { out } = filter([finding("src/app.js", IN_APP)], { warnings: [], model: "m" });
    assert.deepEqual(out.warnings, []);
    assert.equal(out.model, "m");
  });

  test("a missing or non-array comments field yields an empty result, not a crash", () => {
    for (const body of [{}, { comments: "nope" }]) {
      const input = writeResult(body);
      const out = join(work, `${(seq += 1)}-out.json`);
      const r = spawnSync("node", [POSTFILTER, input, repo, commit, "--out", out], {
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).comments, []);
    }
  });

  test("stderr reports the in/out counts", () => {
    const { stderr } = filter([
      finding("src/app.js", IN_APP),
      finding("locales/en.json", NOWHERE),
    ]);
    assert.match(stderr, /in=2\s+out=1/);
  });
});
