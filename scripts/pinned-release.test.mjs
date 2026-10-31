// What we hand out pins one release of the action (ACTION_SHA / ACTION_VERSION
// in bin/orcacode-review.mjs) — today v1.6.0, which predates this branch. So
// everything else we hand out has to be true OF THAT RELEASE at every commit of
// main, not of the action.yml beside it:
//
//   (a) a workflow value the installer (or the skill) writes must mean the
//       same to the pinned release as to the current action. "Everyone" was
//       written as "*", which the current action reads as everyone and v1.6.0
//       reads as an allowlist containing only "*" — no auto-review at all.
//   (b) a doc line that describes behaviour only the UNRELEASED action has says
//       so: it carries "from v1.7.0 (unreleased)" (or sits under a heading that
//       does). Which lines those are is derived: every input action.yml has that
//       the pinned release does not, plus the behaviours listed below. Once
//       ACTION_VERSION reaches v1.7.0 the marker itself is refused, so the
//       release bump forces a pass over the docs.
//   (c) no doc we publish names a version newer than the pin except through
//       that marker (the publish workflow runs the same check on the tarball).

import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

import { loadAction, step, readText, ROOT } from "./test-helpers/action-yaml.mjs";
import {
  UNRELEASED,
  MARKER,
  compareVersions,
  docUnits,
  unmarkedMentions,
  newerVersionRefs,
  PUBLISHED_DOCS,
} from "./doc-pins.mjs";

const { ACTION_SHA, ACTION_VERSION, authorChoices, renderWorkflow, DEFAULTS } = await import(`${ROOT}/bin/orcacode-review.mjs`);

// ---------------------------------------------------------------- the pinned release

// The pinned release, as far as these tests need it. Frozen here because CI
// checks out one commit (fetch-depth 1) and cannot `git show` the pin; where the
// pinned commit IS present the copy is compared with it. Bumping ACTION_VERSION
// fails the first test until this is brought up to the new pin.
const PINNED = {
  version: "v1.6.0",
  inputs: [
    "orcarouter-api-key", "orcarouter-url", "github-token", "brand", "router", "fix-first", "block-on",
    "auto-review-authors", "max-diff-kb", "max-diff-files", "on-oversized-diff", "settings", "report",
    "engine-version", "timeout-minutes", "precision-filter", "judge-model", "judge-threshold", "concurrency",
    "max-tools", "meter",
  ],
  // v1.6.0's allowlist gate, verbatim (action.yml, "Fetch review settings").
  authorAllowed: `author_allowed() {
          local list assoc
          list=$(printf '%s' "$1" | tr -d ' ')
          assoc=$(printf '%s' "$2" | tr -d ' ')
          if [ -z "$list" ]; then echo allow; return; fi
          if printf '%s' ",$list," | grep -qi ",$assoc,"; then echo allow; else echo deny; fi
        }`,
};

const ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", "NONE"];

const pinnedActionYml = () => {
  const r = spawnSync("git", ["show", `${ACTION_SHA}:action.yml`], { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
};

function decide(fn, list, assoc) {
  const r = spawnSync("bash", ["-c", `set -eo pipefail\n${fn}\nauthor_allowed "$1" "$2"\n`, "bash", list, assoc], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const currentAuthorAllowed = () => step("settings").run.match(/author_allowed\(\) \{[\s\S]*?\n[ \t]*\}/)[0];

describe("the frozen copy of the pinned release is the pinned release", () => {
  test("it describes ACTION_VERSION (bump the copy with the pin)", () => {
    assert.equal(PINNED.version, ACTION_VERSION);
  });

  test("where the pinned commit is available, its inputs and allowlist gate match the copy", (t) => {
    const yml = pinnedActionYml();
    if (!yml) return t.skip(`${ACTION_SHA} is not in this checkout (shallow clone)`);
    assert.deepEqual(Object.keys(YAML.parse(yml).inputs), PINNED.inputs);
    const fn = yml.match(/author_allowed\(\) \{[\s\S]*?\n[ \t]*\}/);
    assert.ok(fn, "the pinned action.yml has no author_allowed");
    assert.equal(fn[0], PINNED.authorAllowed);
  });
});

// ------------------------------------------------------------- (a) installer values

describe("(a) every auto-review-authors answer the installer writes means the same to the pinned release", () => {
  const choices = authorChoices((k) => k);

  test('"Everyone" is the explicit list of every association, not "*"', () => {
    const everyone = choices.find((c) => c.label === "config.authorsAll");
    assert.deepEqual(everyone.value.split(","), ASSOCIATIONS);
    const yaml = renderWorkflow({ ...DEFAULTS, "auto-review-authors": everyone.value });
    assert.match(yaml, new RegExp(`^\\s+auto-review-authors: "${ASSOCIATIONS.join(",")}"`, "m"));
  });

  for (const choice of choices) {
    test(`${choice.label} (${choice.value}): the pinned and the current gate agree for every association`, () => {
      for (const assoc of ASSOCIATIONS) {
        const pinned = decide(PINNED.authorAllowed, choice.value, assoc);
        const now = decide(currentAuthorAllowed(), choice.value, assoc);
        assert.equal(now, pinned, `${assoc}: pinned ${pinned}, current ${now}`);
      }
    });
  }

  test('"Everyone" lets every association through the pinned release', () => {
    const everyone = choices.find((c) => c.label === "config.authorsAll");
    for (const assoc of ASSOCIATIONS) assert.equal(decide(PINNED.authorAllowed, everyone.value, assoc), "allow", assoc);
  });

  test('the current action still reads "*" as everyone (kept for anyone who wrote it)', () => {
    for (const assoc of ASSOCIATIONS) assert.equal(decide(currentAuthorAllowed(), "*", assoc), "allow", assoc);
  });

  test("the skill's install question offers the same two values", () => {
    const skill = readText("skills/orca-review-action/SKILL.md");
    for (const c of choices) assert.ok(skill.includes(`"${c.value}"`), `SKILL.md does not offer ${c.value}`);
    assert.doesNotMatch(skill, /Everyone\*? → `"\*"`/, 'the skill still writes "*" for everyone');
  });
});

// ------------------------------------------------------------------ (b) doc markers

// Behaviour only the unreleased action has, beyond its new inputs. Each is a
// pattern a doc line describing it would contain.
const UNRELEASED_BEHAVIOURS = [
  [/statuses: write/, "the statuses: write permission (the head-SHA status)"],
  [/commit status/i, "the commit status on the PR head"],
  [/OrcaCode Review`?\*{0,2} status/, "the OrcaCode Review status"],
  [/never (receives|holds?) (it|your|the|a)\b/i, "the key-holding proxy"],
  // v1.6.0 reads an UNSET auto-review-authors as everyone, on any repository.
  [/(unset|left out|leaving the input out|not set)[^|.]*?OWNER,\s*MEMBER,\s*COLLABORATOR/i, "the public-repo default of auto-review-authors"],
  // v1.6.0 trusts the workflow's `if:` alone to keep outsiders' commands out.
  [/action (itself )?(refuses|ignores|honou?rs)[^.|]*(command|comment)/i, "the action's own comment-command check"],
  // v1.6.0 installs whatever engine-version names, unverified.
  [/engine-pins/, "the pinned engine checksums"],
  // v1.6.0 judges only the PR's author, never who pushed.
  [/\bpusher\b|push(ed|es)? to a fork PR/i, "the pusher check"],
  // v1.6.0 runs on whatever event the workflow wires it to.
  [/pull_request_review/, "the event allowlist"],
  // v1.6.0 sends the key to any orcarouter-url.
  [/\bmust be https\b|plain[- ]http/i, "the https-only gateway URL"],
];

const termsFor = () => {
  const added = Object.keys(loadAction().inputs).filter((k) => !PINNED.inputs.includes(k));
  return [
    ...added.map((k) => [new RegExp(`\\b${k}\\b`), `the ${k} input`]),
    ...UNRELEASED_BEHAVIOURS,
  ];
};

const DOCS = () => [
  ...PUBLISHED_DOCS.map((rel) => [rel, readText(rel)]),
  ["SECURITY.md", readText("SECURITY.md")],
  ["workflows/orca-code-review.yml", readText("workflows/orca-code-review.yml")],
  ["bin/orcacode-review.mjs renderWorkflow()", renderWorkflow({ ...DEFAULTS })],
];

describe("(b) a doc line about unreleased behaviour says it is unreleased", () => {
  const pinIsBefore = compareVersions(ACTION_VERSION, UNRELEASED) < 0;

  test("the derived terms include the new inputs (the scan is not blind)", () => {
    const labels = termsFor().map(([, l]) => l);
    assert.ok(labels.includes("the on-skipped-review input"), labels.join(", "));
    assert.ok(labels.includes("the status-context input"), labels.join(", "));
  });

  if (pinIsBefore) {
    for (const [name, text] of DOCS()) {
      test(`${name}: every mention carries "${MARKER}"`, () => {
        const bad = unmarkedMentions(name, text, termsFor());
        assert.deepEqual(bad, []);
      });
    }

    test("the scan finds the mentions it is meant to (anti-hollow)", () => {
      let seen = 0;
      for (const [name, text] of DOCS()) {
        for (const unit of docUnits(name, text)) if (termsFor().some(([re]) => re.test(unit.text))) seen += 1;
      }
      assert.ok(seen >= 10, `only ${seen} mentions found — the unit splitter or the terms are broken`);
    });
  } else {
    test(`ACTION_VERSION ${ACTION_VERSION} has shipped ${UNRELEASED}: no doc may still call it unreleased`, () => {
      for (const [name, text] of DOCS()) assert.ok(!text.toLowerCase().includes(MARKER), `${name} still says "${MARKER}"`);
    });
  }

  test("an unmarked mention is caught; a marked one, or one under a marked heading, is not", () => {
    const terms = [[/on-skipped-review/, "x"]];
    assert.equal(unmarkedMentions("t.md", "Set `on-skipped-review`.\n", terms).length, 1);
    assert.equal(unmarkedMentions("t.md", `Set \`on-skipped-review\` (${MARKER}).\n`, terms).length, 0);
    assert.equal(unmarkedMentions("t.md", `## New ${MARKER}\n\nSet \`on-skipped-review\`.\n`, terms).length, 0);
    assert.equal(unmarkedMentions("t.md", `## New ${MARKER}\n\nx\n\n## Old\n\nSet \`on-skipped-review\`.\n`, terms).length, 1);
    assert.equal(unmarkedMentions("t.md", "| a | b |\n|---|---|\n| `on-skipped-review` | x |\n", terms).length, 1);
    assert.equal(unmarkedMentions("t.yml", "x: 1 # on-skipped-review here\n", terms).length, 1);
    assert.equal(unmarkedMentions("t.yml", `x: 1 # ${MARKER}: on-skipped-review\n`, terms).length, 0);
  });
});

// ------------------------------------------------------- (c) no newer version, unmarked

describe("(c) no published doc names a version newer than the pin, except through the marker", () => {
  for (const [name, text] of DOCS()) {
    test(name, () => {
      assert.deepEqual(newerVersionRefs(text, ACTION_VERSION), []);
    });
  }

  test("the check sees a bare newer version, and lets the marker through", () => {
    assert.deepEqual(newerVersionRefs("pin @abc # v1.7.0", "v1.6.0"), ["v1.7.0"]);
    assert.deepEqual(newerVersionRefs("requires v1.10.2 or later", "v1.6.0"), ["v1.10.2"]);
    assert.deepEqual(newerVersionRefs(`works ${MARKER}`, "v1.6.0"), []);
    assert.deepEqual(newerVersionRefs("From v1.7.0 (unreleased) it does", "v1.6.0"), []);
    assert.deepEqual(newerVersionRefs("since v1.5.0 and v1.6.0", "v1.6.0"), []);
  });

  test("the publish workflow runs it on the packed tarball before publishing", () => {
    const publish = loadPublish();
    const steps = publish.jobs.publish.steps;
    const i = steps.findIndex((s) => /doc-pins\.mjs/.test(String(s.run || "")));
    const j = steps.findIndex((s) => /npm publish/.test(String(s.run || "")));
    assert.ok(i >= 0, "publish.yml never runs scripts/doc-pins.mjs");
    assert.ok(i < j, "the doc check must run before npm publish");
    assert.match(String(steps[i].run), /npm pack --dry-run --json/);
  });
});

function loadPublish() {
  return YAML.parse(readText(".github/workflows/publish.yml"));
}
