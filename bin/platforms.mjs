// Agent Skill platform catalog, ported from orcadub-mcp-server so both Orca
// products install skills to the same places under the same IDs. Keep the
// entries, their order, and their IDs in sync with
// `internal/skill_installer.go` there — a user who runs both installers should
// not have to learn two names for the same editor.
//
// Layout rule: every platform's skill lives at
//   <base>/<root>/skills/<skill-name>/
// where <base> is the project directory or the user's home, and <root> is the
// platform's project or global root.
//
// Detection is deliberately conservative — a false positive preselects a
// platform the user does not have and scatters files into directories they
// never asked for. Three signals, in order: a project marker, a home marker,
// then an executable on PATH.
//
//   detectionPaths: undefined  -> use [projectRoot] as the project marker
//   detectionPaths: []         -> project detection disabled for this platform

import fs from "node:fs";
import path from "node:path";

export const SKILL_PLATFORMS = Object.freeze([
  {
    id: "claude",
    name: "Claude Code",
    projectRoot: ".claude",
    globalRoot: ".claude",
    globalDetectionPaths: [".claude"],
    executables: ["claude"],
  },
  { id: "cursor", name: "Cursor", projectRoot: ".cursor", globalRoot: ".cursor" },
  {
    id: "codex",
    name: "Codex",
    projectRoot: ".agents",
    globalRoot: ".agents",
    // Codex reads skills from `.agents`, but `.agents` is a shared convention —
    // several hosts write there. Detect on `.codex`, which is Codex-specific.
    detectionPaths: [".codex"],
    globalDetectionPaths: [".codex"],
    executables: ["codex"],
  },
  { id: "opencode", name: "OpenCode", projectRoot: ".opencode", globalRoot: ".config/opencode" },
  { id: "windsurf", name: "Windsurf", projectRoot: ".windsurf", globalRoot: ".windsurf" },
  { id: "cline", name: "Cline", projectRoot: ".cline", globalRoot: ".cline" },
  { id: "roocode", name: "RooCode", projectRoot: ".roo", globalRoot: ".roo" },
  { id: "continue", name: "Continue", projectRoot: ".continue", globalRoot: ".continue" },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    projectRoot: ".github",
    globalRoot: ".github",
    // `.github` exists in almost every repo, so it cannot be the marker —
    // it would preselect Copilot for everyone. Require a Copilot-specific file.
    detectionPaths: [
      ".github/copilot-instructions.md",
      ".github/instructions",
      ".github/prompts",
      ".github/skills",
    ],
  },
  { id: "gemini", name: "Gemini CLI", projectRoot: ".gemini", globalRoot: ".gemini" },
  { id: "amazon-q", name: "Amazon Q Developer", projectRoot: ".amazonq", globalRoot: ".amazonq" },
  { id: "qwen", name: "Qwen Code", projectRoot: ".qwen", globalRoot: ".qwen" },
  { id: "kilocode", name: "Kilo Code", projectRoot: ".kilocode", globalRoot: ".kilocode" },
  { id: "auggie", name: "Auggie (Augment CLI)", projectRoot: ".augment", globalRoot: ".augment" },
  { id: "kimicode", name: "Kimi Code", projectRoot: ".kimi-code", globalRoot: ".kimi-code" },
  { id: "kiro", name: "Kiro", projectRoot: ".kiro", globalRoot: ".kiro" },
  { id: "lingma", name: "Lingma", projectRoot: ".lingma", globalRoot: ".lingma" },
  { id: "junie", name: "Junie", projectRoot: ".junie", globalRoot: ".junie" },
  { id: "codebuddy", name: "CodeBuddy Code", projectRoot: ".codebuddy", globalRoot: ".codebuddy" },
  { id: "costrict", name: "CoStrict", projectRoot: ".cospec", globalRoot: ".cospec" },
  { id: "crush", name: "Crush", projectRoot: ".crush", globalRoot: ".crush" },
  { id: "factory", name: "Factory Droid", projectRoot: ".factory", globalRoot: ".factory" },
  { id: "iflow", name: "iFlow", projectRoot: ".iflow", globalRoot: ".iflow" },
  { id: "pi", name: "Pi", projectRoot: ".pi", globalRoot: ".pi/agent" },
  { id: "qoder", name: "Qoder", projectRoot: ".qoder", globalRoot: ".qoder" },
  {
    id: "antigravity",
    name: "Antigravity",
    projectRoot: ".agents",
    globalRoot: ".gemini/antigravity",
    detectionPaths: [],
  },
  {
    id: "antigravity2",
    name: "Antigravity 2.0",
    projectRoot: ".agents",
    globalRoot: ".gemini/config",
    detectionPaths: [],
  },
  { id: "bob", name: "Bob Shell", projectRoot: ".bob", globalRoot: ".bob" },
  { id: "forgecode", name: "ForgeCode", projectRoot: ".forge", globalRoot: ".forge" },
  { id: "trae", name: "Trae", projectRoot: ".trae", globalRoot: ".trae" },
  { id: "trae-cn", name: "Trae CN", projectRoot: ".trae-cn", globalRoot: ".trae-cn" },
  { id: "zcode", name: "ZCode", projectRoot: ".zcode", globalRoot: ".zcode" },
  { id: "mimocode", name: "MimoCode", projectRoot: ".mimocode", globalRoot: ".config/mimocode" },
  {
    id: "hermes",
    name: "Hermes",
    projectRoot: ".hermes",
    globalRoot: ".hermes",
    globalDetectionPaths: [".hermes"],
    executables: ["hermes"],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    projectRoot: ".",
    globalRoot: ".openclaw",
    // Its project root is the bare workspace `skills/` directory, which is far
    // too generic to detect on. Fall back to the home marker and the binary.
    detectionPaths: [],
    globalDetectionPaths: [".openclaw"],
    executables: ["openclaw"],
  },
  {
    id: "command-code",
    name: "Command Code",
    projectRoot: ".commandcode",
    globalRoot: ".commandcode",
    globalDetectionPaths: [".commandcode"],
    // Deliberately no executable check: its binary is `cmd`, which is a
    // standard Windows executable and would match on every Windows machine.
  },
]);

// Shown first in the picker when nothing is detected, so the list opens on
// names most users recognize instead of 36 rows of alphabet soup.
export const POPULAR_PLATFORM_IDS = Object.freeze([
  "claude",
  "codex",
  "cursor",
  "github-copilot",
  "gemini",
  "opencode",
  "windsurf",
]);

export function findPlatform(id) {
  return SKILL_PLATFORMS.find((p) => p.id === id);
}

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Returns the IDs of platforms that appear to be in use, in catalog order.
 * `lookPath` resolves an executable name to a path (or throws / returns null).
 */
export function detectPlatforms(projectDir, homeDir, lookPath) {
  const detected = [];

  for (const platform of SKILL_PLATFORMS) {
    const projectMarkers = platform.detectionPaths ?? [platform.projectRoot];

    if (projectDir && projectMarkers.some((m) => exists(path.join(projectDir, m)))) {
      detected.push(platform.id);
      continue;
    }
    if (homeDir && (platform.globalDetectionPaths ?? []).some((m) => exists(path.join(homeDir, m)))) {
      detected.push(platform.id);
      continue;
    }
    if (lookPath && (platform.executables ?? []).some((exe) => Boolean(lookPath(exe)))) {
      detected.push(platform.id);
    }
  }

  return detected;
}

/**
 * Maps platform IDs to destination directories, collapsing platforms that
 * resolve to the same path into one target.
 *
 * This matters: Codex, Antigravity, and Antigravity 2.0 all use `.agents` for
 * project installs. Without the merge, one install would be reported three
 * times and — worse — the second write would see the first one's output and
 * report a spurious conflict.
 */
export function resolveTargets({ platformIds, scope, projectDir, homeDir, skillName }) {
  if (scope !== "project" && scope !== "global") {
    throw new Error(`unknown install scope "${scope}" (use project or global)`);
  }

  const targets = [];
  const byPath = new Map();

  for (const id of platformIds) {
    const platform = findPlatform(id);
    if (!platform) throw new Error(`unknown platform "${id}"`);

    const base = scope === "global" ? homeDir : projectDir;
    const root = scope === "global" ? platform.globalRoot : platform.projectRoot;
    if (!base || !path.isAbsolute(base)) {
      throw new Error(`${scope} install base must be an absolute path: "${base}"`);
    }

    const dir = path.normalize(path.join(base, root, "skills", skillName));

    const existing = byPath.get(dir);
    if (existing) {
      existing.platformIds.push(platform.id);
      existing.platformNames.push(platform.name);
      continue;
    }

    const target = { platformIds: [platform.id], platformNames: [platform.name], path: dir };
    byPath.set(dir, target);
    targets.push(target);
  }

  return targets;
}
