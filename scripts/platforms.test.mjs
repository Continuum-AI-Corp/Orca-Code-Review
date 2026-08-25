// Tests for the agent-platform catalog and the skill-tree installer.
//
// Two classes of bug are worth guarding against here. Catalog bugs are silent:
// a duplicate id or a too-generic detection marker scatters files into
// directories the user never asked about, and nothing errors. Installer bugs
// are destructive: overwriting a skill somebody edited, or leaving a tree
// half-updated so the SKILL.md points at a reference file from a prior version.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SKILL_PLATFORMS,
  POPULAR_PLATFORM_IDS,
  findPlatform,
  detectPlatforms,
  resolveTargets,
} from "../bin/platforms.mjs";
import { installTree, readTree, treesEqual, STATUS } from "../bin/skill-tree.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ocr-plat-"));

const writeTree = (root, files) => {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
};

// ------------------------------------------------------------------ catalog ---

test("the catalog matches the orcadub platform count", () => {
  // Both Orca installers ship the same catalog. If this number moves, the other
  // repo and the README platform count move with it.
  assert.equal(SKILL_PLATFORMS.length, 36);
});

test("ids and display names are unique", () => {
  assert.equal(new Set(SKILL_PLATFORMS.map((p) => p.id)).size, SKILL_PLATFORMS.length);
  assert.equal(new Set(SKILL_PLATFORMS.map((p) => p.name)).size, SKILL_PLATFORMS.length);
});

test("every platform declares both roots", () => {
  for (const p of SKILL_PLATFORMS) {
    assert.ok(p.projectRoot, `${p.id} has no projectRoot`);
    assert.ok(p.globalRoot, `${p.id} has no globalRoot`);
    assert.doesNotMatch(p.projectRoot, /^\//, `${p.id} projectRoot must be relative`);
    assert.doesNotMatch(p.globalRoot, /^\//, `${p.id} globalRoot must be relative`);
  }
});

test("every popular id exists in the catalog", () => {
  for (const id of POPULAR_PLATFORM_IDS) assert.ok(findPlatform(id), `unknown popular id: ${id}`);
});

test("platforms with a too-generic root do not detect on that root", () => {
  // `.github` is in nearly every repo and `.` is every directory. Detecting on
  // those would preselect Copilot and OpenClaw for everyone on earth.
  assert.deepEqual(findPlatform("openclaw").detectionPaths, []);
  const copilot = findPlatform("github-copilot");
  assert.ok(copilot.detectionPaths.length > 0);
  assert.ok(!copilot.detectionPaths.includes(".github"));
});

test("Command Code does not detect on its `cmd` executable", () => {
  // `cmd` is a stock Windows binary — it would match on every Windows machine.
  assert.ok(!(findPlatform("command-code").executables ?? []).includes("cmd"));
});

// ---------------------------------------------------------------- detection ---

test("a project marker directory detects its platform", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".cursor"));
  assert.deepEqual(detectPlatforms(dir, "", null), ["cursor"]);
});

test("Codex detects on .codex, not on the .agents directory it writes to", () => {
  const withAgents = tmp();
  fs.mkdirSync(path.join(withAgents, ".agents"));
  assert.ok(!detectPlatforms(withAgents, "", null).includes("codex"));

  const withCodex = tmp();
  fs.mkdirSync(path.join(withCodex, ".codex"));
  assert.ok(detectPlatforms(withCodex, "", null).includes("codex"));
});

test("a bare .github directory does not detect GitHub Copilot", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  assert.ok(!detectPlatforms(dir, "", null).includes("github-copilot"));

  fs.writeFileSync(path.join(dir, ".github", "copilot-instructions.md"), "x");
  assert.ok(detectPlatforms(dir, "", null).includes("github-copilot"));
});

test("a home marker detects a platform absent from the project", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, ".claude"));
  assert.ok(detectPlatforms(tmp(), home, null).includes("claude"));
});

test("an executable on PATH detects a platform with no markers", () => {
  const found = detectPlatforms(tmp(), tmp(), (exe) => exe === "hermes");
  assert.deepEqual(found, ["hermes"]);
});

test("detection returns catalog order and never duplicates", () => {
  const dir = tmp();
  for (const marker of [".claude", ".cursor", ".codex"]) fs.mkdirSync(path.join(dir, marker));
  // Same platforms also visible via home + PATH — each must still appear once.
  const found = detectPlatforms(dir, dir, (exe) => exe === "claude");
  assert.deepEqual(found, ["claude", "cursor", "codex"]);
});

// ----------------------------------------------------------------- targets ---

test("platforms sharing a root collapse into one target", () => {
  // Codex, Antigravity, and Antigravity 2.0 all use .agents for project
  // installs. Without the merge, the second write would see the first one's
  // output and report a bogus conflict.
  const targets = resolveTargets({
    platformIds: ["codex", "antigravity", "antigravity2"],
    scope: "project",
    projectDir: "/repo",
    homeDir: "/home/u",
    skillName: "s",
  });
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].platformIds, ["codex", "antigravity", "antigravity2"]);
  assert.equal(targets[0].path, path.normalize("/repo/.agents/skills/s"));
});

test("the same platforms stay separate under global scope", () => {
  // Their global roots differ (.agents, .gemini/antigravity, .gemini/config),
  // so the project-scope merge must not be assumed to hold.
  const targets = resolveTargets({
    platformIds: ["codex", "antigravity", "antigravity2"],
    scope: "global",
    projectDir: "/repo",
    homeDir: "/home/u",
    skillName: "s",
  });
  assert.equal(targets.length, 3);
});

test("global scope uses the global root, which can differ from the project root", () => {
  const [target] = resolveTargets({
    platformIds: ["opencode"],
    scope: "global",
    projectDir: "/repo",
    homeDir: "/home/u",
    skillName: "s",
  });
  assert.equal(target.path, path.normalize("/home/u/.config/opencode/skills/s"));
});

test("OpenClaw's project root is the bare workspace directory", () => {
  const [target] = resolveTargets({
    platformIds: ["openclaw"],
    scope: "project",
    projectDir: "/repo",
    homeDir: "/home/u",
    skillName: "s",
  });
  assert.equal(target.path, path.normalize("/repo/skills/s"));
});

test("unknown platform, unknown scope, and relative base are all rejected", () => {
  const base = { scope: "project", projectDir: "/repo", homeDir: "/home/u", skillName: "s" };
  assert.throws(() => resolveTargets({ ...base, platformIds: ["nope"] }), /unknown platform/);
  assert.throws(() => resolveTargets({ ...base, platformIds: ["claude"], scope: "user" }), /unknown install scope/);
  assert.throws(
    () => resolveTargets({ ...base, platformIds: ["claude"], projectDir: "relative" }),
    /must be an absolute path/,
  );
});

test("every catalog platform resolves to a path under both scopes", () => {
  for (const p of SKILL_PLATFORMS) {
    for (const scope of ["project", "global"]) {
      const [t] = resolveTargets({
        platformIds: [p.id],
        scope,
        projectDir: "/repo",
        homeDir: "/home/u",
        skillName: "s",
      });
      assert.ok(t.path.endsWith(path.join("skills", "s")), `${p.id}/${scope}: ${t.path}`);
    }
  }
});

// --------------------------------------------------------------- tree install ---

const SOURCE = { "SKILL.md": "v1\n", "references/a.md": "A\n" };

test("a fresh destination reports installed and writes the whole tree", () => {
  const src = writeTree(tmp(), SOURCE);
  const dest = path.join(tmp(), "skills", "x");
  assert.equal(installTree(src, dest), STATUS.installed);
  assert.ok(treesEqual(readTree(src), readTree(dest)));
});

test("an identical destination reports unchanged", () => {
  const src = writeTree(tmp(), SOURCE);
  const dest = path.join(tmp(), "x");
  installTree(src, dest);
  assert.equal(installTree(src, dest), STATUS.unchanged);
});

test("a differing destination reports conflict and is left untouched", () => {
  const src = writeTree(tmp(), SOURCE);
  const dest = writeTree(path.join(tmp(), "x"), { "SKILL.md": "hand-edited\n" });
  assert.equal(installTree(src, dest), STATUS.conflict);
  assert.equal(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), "hand-edited\n");
});

test("--force overwrites and reports updated", () => {
  const src = writeTree(tmp(), SOURCE);
  const dest = writeTree(path.join(tmp(), "x"), { "SKILL.md": "hand-edited\n" });
  assert.equal(installTree(src, dest, { force: true }), STATUS.updated);
  assert.ok(treesEqual(readTree(src), readTree(dest)));
});

test("a forced update removes files the new version no longer ships", () => {
  // A leftover reference file outlives the SKILL.md that pointed at it, and the
  // agent has no way to tell it is reading guidance from a prior version.
  const src = writeTree(tmp(), SOURCE);
  const dest = writeTree(path.join(tmp(), "x"), {
    "SKILL.md": "old\n",
    "references/gone.md": "stale\n",
  });
  assert.equal(installTree(src, dest, { force: true }), STATUS.updated);
  assert.ok(!fs.existsSync(path.join(dest, "references", "gone.md")));
  assert.ok(fs.existsSync(path.join(dest, "references", "a.md")));
});

test("an empty source is an error, not a silent no-op install", () => {
  assert.throws(() => installTree(tmp(), path.join(tmp(), "x")), /empty/);
});

test("no temp files survive an install", () => {
  const src = writeTree(tmp(), SOURCE);
  const dest = path.join(tmp(), "x");
  installTree(src, dest);
  installTree(src, dest, { force: true });
  const leftovers = readTree(dest);
  assert.deepEqual([...leftovers.keys()].sort(), ["SKILL.md", "references/a.md"]);
});

// --------------------------------------------------------------- the shipped skill ---

test("the bundled skill is a valid Agent Skill for every host", () => {
  // Codex, OpenCode, and Claude Code all require exactly `name` + `description`
  // in the frontmatter, and `name` must equal the directory name.
  const dir = new URL("../skills/setup-orca-code-review/", import.meta.url);
  const text = fs.readFileSync(new URL("SKILL.md", dir), "utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, "SKILL.md has no YAML frontmatter");

  const name = frontmatter[1].match(/^name:\s*(\S+)/m);
  const description = frontmatter[1].match(/^description:\s*(.+)/m);
  assert.equal(name?.[1], "setup-orca-code-review");
  assert.ok(description, "SKILL.md has no description");
  assert.ok(description[1].length <= 1024, "description exceeds the 1024-char limit hosts enforce");
  assert.match(name[1], /^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be lowercase with single hyphens");
});
