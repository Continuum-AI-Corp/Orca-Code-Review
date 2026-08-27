// Contract tests for the shipped routing recipes.
//
// These files are documentation with consequences: an operator pastes one into
// their router and it becomes the live model policy. They have drifted twice —
// once on the fact contract (`x-cr-prev-tier` documented as none|cheap|strong
// after only one value was ever sent), and once by losing the judge rule while
// the copy inside the control plane kept it. Both were caught by a person
// reading the file, which is the wrong last line of defence.
//
// Cross-repo agreement CANNOT be asserted here — the authority for what setup
// provisions is a Go constant in another repository, and nothing in this one can
// see it. What these tests do instead is pin the properties that make a recipe
// self-consistent, so it cannot silently decay into something that parses and
// routes wrongly.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const RECIPES = join(dirname(fileURLToPath(import.meta.url)), "..", "recipes");
const ACTION_RECIPE = "orcacode-review.dsl.yaml";

const read = (name) => readFileSync(join(RECIPES, name), "utf8");

// The rule ids and models, without a YAML parser: these files are line-oriented
// by convention and the shape is what is being asserted.
function rules(src) {
  const out = [];
  let id = null;
  for (const line of src.split("\n")) {
    const idMatch = line.match(/^\s*-\s*id:\s*(\S+)/);
    if (idMatch) {
      id = idMatch[1];
      continue;
    }
    const useMatch = line.match(/^\s*use:\s*\{\s*model:\s*"([^"]+)"/);
    if (useMatch && id) {
      out.push({ id, model: useMatch[1] });
      id = null;
    }
  }
  return out;
}

function defaultModel(src) {
  const i = src.lastIndexOf("default:");
  if (i < 0) return "";
  const m = src.slice(i).match(/model:\s*"([^"]+)"/);
  return m ? m[1] : "";
}

describe("every shipped recipe", () => {
  const names = readdirSync(RECIPES).filter((f) => f.endsWith(".dsl.yaml"));

  test("there is at least one, and this suite sees the Action's", () => {
    assert.ok(names.length > 0, "no recipes found — has the directory moved?");
    assert.ok(names.includes(ACTION_RECIPE), `${ACTION_RECIPE} is missing`);
  });

  for (const name of names) {
    test(`${name}: routes everything somewhere`, () => {
      const src = read(name);
      assert.match(src, /^version:\s*1\s*$/m, "a recipe needs a version");
      assert.ok(defaultModel(src), "a recipe with no default can drop a request");
      for (const r of rules(src)) {
        assert.ok(r.model, `rule ${r.id} names no model`);
      }
    });

    test(`${name}: every rule can actually be reached`, () => {
      // A rule whose condition nothing sends is worse than no rule: the router
      // reads as a policy the workspace is not running. The Action stamps
      // x-cr-lens only on the judge call, and x-cr-prev-tier/p0p1 on every call.
      const src = read(name);
      const conditions = src.split("\n").filter((l) => /^\s*when:/.test(l));
      for (const c of conditions) {
        assert.match(
          c,
          /headers\["x-cr-(lens|prev-tier|prev-p0p1)"\]/,
          `condition keys on a fact nothing sends: ${c.trim()}`,
        );
      }
    });
  }
});

describe("the Action's recipe", () => {
  test("keeps the judge rule", () => {
    // Deleting it does not disable the judge — the Action runs the L2 pass either
    // way — it sends the judge to `default:`, i.e. the reviewer's own model. This
    // file lost the rule once while the control plane's copy kept it, so a
    // workspace pasting it got a judge that grades its own work.
    const found = rules(read(ACTION_RECIPE)).find((r) => r.id === "judge");
    assert.ok(found, "no judge rule — a pasted copy would send the judge to the default");
  });

  test("does not point the judge at the default's model", () => {
    // The whole property, and it fails silently: a judge sharing the reviewer's
    // model agrees with it and still reports the pass as successful.
    const src = read(ACTION_RECIPE);
    const judge = rules(src).find((r) => r.id === "judge");
    assert.ok(judge, "no judge rule to check");
    assert.notEqual(
      judge.model,
      defaultModel(src),
      "the judge names the default's model — that is not an independent second opinion",
    );
  });

  test("carries no per-angle rule, which no Action call can reach", () => {
    // The review call stamps no angle. Those rules belong to the multi-angle
    // reviewer, and shipping them here described a policy that never applied.
    const ids = rules(read(ACTION_RECIPE)).map((r) => r.id);
    for (const lens of ["ripple", "parity", "ordering", "failure", "assumption", "conventions"]) {
      assert.ok(!ids.includes(lens), `carries the ${lens} rule, which the Action never triggers`);
    }
  });

  test("names the router by the alias the action defaults to", () => {
    // The recipe tells the reader which router to paste it into. When the router
    // was renamed, this line was the one that had to move with it — and the
    // failure mode of getting it wrong is a not-found on every review.
    const src = read(ACTION_RECIPE);
    const actionYml = readFileSync(join(RECIPES, "..", "action.yml"), "utf8");
    const m = actionYml.match(/default:\s*"orcarouter\/([a-z0-9-]+)"/);
    assert.ok(m, "could not read the router input's default from action.yml");
    assert.ok(
      src.includes(`orcarouter/${m[1]}`),
      `the recipe does not mention orcarouter/${m[1]}, which is what the action asks for`,
    );
  });
});
