// CR-3 (repo side) and the README quickstart (CR-12).
//
// Every workflow this repository hands a customer — the installer's rendered
// one, the example, the skill's asset and the README quickstart — used to pin
// `Continuum-AI-Corp/orca-code-review@v1`, a tag RELEASE.md told maintainers to
// force-move (and to force-push "immutable" v1.<n> tags). Whoever can move a tag
// decides what runs, with the customer's OrcaRouter key, in every repository
// that pins it. They now pin one full commit SHA with a `# v1.x.y` comment
// (bumped deliberately at release time), all four the same; the quickstart is a
// complete workflow with the maintainer gate, not a bare `uses:`; and
// RELEASE.md never moves or force-pushes a version tag.
//
// Comments are read through the YAML parser's document model.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

import { readText, ROOT } from "./test-helpers/action-yaml.mjs";

const { ACTION_SHA, ACTION_VERSION, renderWorkflow, DEFAULTS } = await import(`${ROOT}/bin/orcacode-review.mjs`);

// The `uses:` scalar nodes of a YAML document, comments attached.
function usesOf(text) {
  const doc = YAML.parseDocument(text);
  const out = [];
  YAML.visit(doc, {
    Pair(_, pair) {
      if (YAML.isScalar(pair.key) && pair.key.value === "uses" && YAML.isScalar(pair.value)) out.push(pair.value);
    },
  });
  return { doc: doc.toJS(), uses: out };
}

// The README's quickstart is the ```yaml block that names this action.
function readmeQuickstart() {
  const readme = readText("README.md");
  const blocks = [...readme.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.find((b) => b.includes("Continuum-AI-Corp/orca-code-review@"));
  assert.ok(block, "the README has no yaml block using the action");
  return block;
}

describe("the action is pinned to one commit everywhere it is handed out", () => {
  test("the installer exports a full SHA and its release version", () => {
    assert.match(ACTION_SHA, /^[0-9a-f]{40}$/);
    assert.match(ACTION_VERSION, /^v1\.\d+\.\d+$/);
  });

  const copies = () => [
    ["installer", renderWorkflow({ ...DEFAULTS })],
    ["workflows/orca-code-review.yml", readText("workflows/orca-code-review.yml")],
    ["skill asset", readText("skills/orca-review-action/assets/workflow.yml")],
    ["README quickstart", readmeQuickstart()],
  ];

  for (const [name] of [["installer"], ["workflows/orca-code-review.yml"], ["skill asset"], ["README quickstart"]]) {
    test(`${name}: uses @<ACTION_SHA> # ${"<ACTION_VERSION>"}`, () => {
      const text = copies().find(([n]) => n === name)[1];
      const own = usesOf(text).uses.filter((u) => String(u.value).startsWith("Continuum-AI-Corp/orca-code-review@"));
      assert.equal(own.length, 1, `${name}: expected one use of the action`);
      assert.equal(own[0].value, `Continuum-AI-Corp/orca-code-review@${ACTION_SHA}`);
      assert.equal(String(own[0].comment || "").trim(), ACTION_VERSION);
    });
  }
});

describe("the README quickstart is a complete, gated workflow (CR-12)", () => {
  test("it parses as a workflow whose comment trigger is limited to maintainers", () => {
    const { doc } = usesOf(readmeQuickstart());
    assert.ok(doc.on?.pull_request_target, "the quickstart must be a whole workflow, not a bare step");
    assert.match(doc.jobs.review.if, /\["OWNER", "MEMBER", "COLLABORATOR"\]/);
    assert.equal(doc.permissions.statuses, "write");
    assert.ok(doc.jobs.review.concurrency, "job-level concurrency (CR-6)");
    assert.equal(doc.concurrency, undefined);
  });
});

describe("release hygiene", () => {
  test("Dependabot keeps the pinned actions current", () => {
    const cfg = YAML.parse(readText(".github/dependabot.yml"));
    const gha = cfg.updates.find((u) => u["package-ecosystem"] === "github-actions");
    assert.ok(gha, "no github-actions entry");
    assert.equal(gha.directory, "/");
  });

  test("RELEASE.md never moves or force-pushes a version tag", () => {
    const md = readText("RELEASE.md");
    const code = [...md.matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
    assert.doesNotMatch(code, /git tag (-f|--force)/, "a release step re-points a tag");
    assert.doesNotMatch(code, /git push[^\n]*(--force|-f\b)/, "a release step force-pushes");
    assert.match(md, /immutable/i, "the immutable-release setting is documented");
    assert.match(md, /ruleset/i, "the tag ruleset is documented");
  });
});
