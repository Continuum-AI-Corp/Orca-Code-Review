// harden-checkout.mjs — what the action does to the PR checkout before
// anything reads it, and excluded-files.mjs — what it tells the reader the
// engine did NOT review.
//
// The checkout is fork-controlled, and three things in it could steer the
// review without touching a line of reviewed code:
//   - SYMLINKS. A link committed as `notes.md -> /proc/self/environ` (or to a
//     runner credential file) lets an engine whose tools read "files in the
//     repo" read outside it. Every symlink — tracked (mode 120000) or not — is
//     deleted before the engine runs.
//   - .gitattributes. `* -diff` turns every changed file into "Binary files
//     differ", so both the size guard and the engine see no code. Repository
//     attributes are neutralised for `diff` with `* !diff` in
//     $GIT_DIR/info/attributes, which outranks every .gitattributes and puts
//     git back on content sniffing (works on any git version, unlike
//     GIT_ATTR_SOURCE, which needs 2.40).
//   - the root .gitignore, which the engine reads to decide what to skip. It is
//     restored from the base revision, so a PR cannot ignore its own changes.
// And what the engine skips by default (tests, fixtures, generated code,
// unsupported file types) is listed, so a reviewer sees what was not reviewed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const HARDEN = path.join(SCRIPTS, "harden-checkout.mjs");
const EXCLUDED = path.join(SCRIPTS, "excluded-files.mjs");

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harden-"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

let n = 0;
function repo(base, head) {
  n += 1;
  const dir = path.join(root, `r${n}`);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  base(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const baseSha = git(dir, "rev-parse", "HEAD").trim();
  head(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "head");
  return { dir, base: baseSha, head: git(dir, "rev-parse", "HEAD").trim() };
}

const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

const harden = (dir, base) =>
  spawnSync("node", [HARDEN, "--dir", dir, ...(base ? ["--base", base] : [])], { encoding: "utf8" });

function symlinksIn(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out.push(path.relative(dir, p));
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

describe("symlinks in the checkout are removed", () => {
  test("tracked, untracked and directory symlinks are all deleted; regular files stay", () => {
    const r = repo(
      (d) => write(d, "app.js", "export const a = 1;\n"),
      (d) => {
        fs.symlinkSync("/proc/self/environ", path.join(d, "notes.md")); // tracked (mode 120000)
        fs.mkdirSync(path.join(d, "docs"));
        fs.symlinkSync("/etc", path.join(d, "docs", "etc")); // tracked, to a directory
      },
    );
    fs.symlinkSync("/root", path.join(r.dir, "untracked-link")); // never committed
    assert.match(git(r.dir, "ls-files", "-s"), /^120000 /m, "fixture: a tracked symlink exists");
    assert.equal(symlinksIn(r.dir).length, 3);

    const res = harden(r.dir, r.base);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(symlinksIn(r.dir), []);
    assert.ok(fs.existsSync(path.join(r.dir, "app.js")));
  });
});

describe("repository attributes cannot hide the diff", () => {
  test("`* -diff` in a PR's .gitattributes no longer turns code into 'Binary files differ'", () => {
    const r = repo(
      (d) => write(d, "app.js", "export const a = 1;\n"),
      (d) => {
        write(d, ".gitattributes", "* -diff\n");
        write(d, "app.js", "export const a = 2; // eval(userInput)\n");
      },
    );
    const before = git(r.dir, "diff", r.base, r.head);
    assert.match(before, /Binary files .* differ/, "fixture: the attribute hides the change");

    const res = harden(r.dir, r.base);
    assert.equal(res.status, 0, res.stderr);
    const afterDiff = git(r.dir, "diff", r.base, r.head);
    assert.doesNotMatch(afterDiff, /Binary files .*app\.js.* differ/);
    assert.match(afterDiff, /\+export const a = 2; \/\/ eval\(userInput\)/);
  });

  test("the `binary` macro is neutralised too, while real binary content stays binary", () => {
    const r = repo(
      (d) => write(d, "a.js", "x\n"),
      (d) => {
        write(d, "sub/.gitattributes", "*.js binary\n");
        write(d, "sub/b.js", "const evil = 1;\n");
        fs.writeFileSync(path.join(d, "img.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
      },
    );
    assert.equal(harden(r.dir, r.base).status, 0);
    const d = git(r.dir, "diff", r.base, r.head);
    assert.match(d, /\+const evil = 1;/);
    assert.match(d, /Binary files \/dev\/null and b\/img\.bin differ/);
  });
});

describe("the root .gitignore is the base revision's", () => {
  test("a PR cannot ignore its own change from the engine", () => {
    const r = repo(
      (d) => {
        write(d, ".gitignore", "node_modules/\n");
        write(d, "auth.js", "check()\n");
      },
      (d) => {
        write(d, ".gitignore", "node_modules/\nauth.js\n");
        write(d, "auth.js", "/* removed the check */\n");
      },
    );
    assert.equal(harden(r.dir, r.base).status, 0);
    assert.equal(fs.readFileSync(path.join(r.dir, ".gitignore"), "utf8"), "node_modules/\n");
  });

  test("a .gitignore the base did not have is removed", () => {
    const r = repo(
      (d) => write(d, "a.js", "x\n"),
      (d) => write(d, ".gitignore", "*.js\n"),
    );
    assert.equal(harden(r.dir, r.base).status, 0);
    assert.equal(fs.existsSync(path.join(r.dir, ".gitignore")), false);
  });

  test("PR-controlled engine config (.opencodereview/) is removed", () => {
    const r = repo(
      (d) => write(d, "a.js", "x\n"),
      (d) => write(d, ".opencodereview/rule.json", '{"exclude":["**"]}'),
    );
    assert.equal(harden(r.dir, r.base).status, 0);
    assert.equal(fs.existsSync(path.join(r.dir, ".opencodereview")), false);
  });
});

describe("excluded-files.mjs lists what the engine skips", () => {
  test("tests, fixtures, generated code, binaries and unsupported types are listed with a reason; reviewed code is not", () => {
    const r = repo(
      (d) => write(d, "src/a.js", "a\n"),
      (d) => {
        write(d, "src/a.js", "b\n");
        write(d, "src/a.test.js", "test\n");
        write(d, "fixtures/data.json", "{}\n");
        write(d, "api.pb.go", "package x\n");
        fs.writeFileSync(path.join(d, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
      },
    );
    const out = path.join(root, `excluded-${n}.json`);
    const res = spawnSync("node", [EXCLUDED, "--base", r.base, "--head", r.head, "--out", out], {
      cwd: r.dir,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(fs.readFileSync(out, "utf8"));
    const paths = Object.fromEntries(got.excluded.map((e) => [e.path, e.code]));
    assert.equal(paths["src/a.js"], undefined, "reviewed code must not be listed");
    assert.equal(paths["src/a.test.js"], "default_path");
    assert.equal(paths["fixtures/data.json"], "default_path");
    assert.equal(paths["api.pb.go"], "default_path");
    assert.equal(paths["logo.png"], "binary");
    for (const e of got.excluded) assert.ok(e.reason, `${e.path} has no reason`);
  });

  test("a long list is capped and says how many it left out", () => {
    const r = repo(
      (d) => write(d, "a.js", "a\n"),
      (d) => {
        for (let i = 0; i < 260; i += 1) write(d, `fixtures/f${i}.json`, "{}\n");
      },
    );
    const out = path.join(root, `excluded-cap-${n}.json`);
    const res = spawnSync("node", [EXCLUDED, "--base", r.base, "--head", r.head, "--out", out], {
      cwd: r.dir,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(got.excluded.length, 200);
    assert.equal(got.omitted, 60);
  });
});
