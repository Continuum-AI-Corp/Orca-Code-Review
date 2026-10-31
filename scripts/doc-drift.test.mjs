// Docs that restate what the code does, held to the code.
//
//   - skills/orca-review-action/references/inputs.md lists every input with its
//     default; the skill tells agents to read it "before answering a question
//     about behavior — do not guess a default". Its judge-model default named a
//     model the action has not defaulted to for several releases. Every row is
//     now compared with action.yml.
//   - the github-token row left out what the token is used for from v1.7.0:
//     writing the commit status on the PR head.
//   - publish.yml's fetch-depth comment named a "v1 tag check" that no longer
//     exists; what needs the history is the pinned-commit check.
//   - "comment runs never cancel anything": GitHub keeps at most one RUNNING and
//     one PENDING job per concurrency group, and a newly queued job cancels the
//     pending one even with cancel-in-progress off. So a comment never cancels a
//     running review, but a third comment replaces a second one still waiting.
//     Every place that says "never cancel" has to say that.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

import { loadAction, readText, shippedWorkflows } from "./test-helpers/action-yaml.mjs";
import { docUnits } from "./doc-pins.mjs";

const INPUTS_MD = "skills/orca-review-action/references/inputs.md";

// Every `| \`name\` | default | what |` row of inputs.md's input tables.
function inputRows() {
  const rows = new Map();
  for (const line of readText(INPUTS_MD).split("\n")) {
    const m = line.match(/^\|\s*`([a-z-]+)`\s*\|\s*(.*?)\s*\|\s*(.*)\|\s*$/);
    if (m) rows.set(m[1], { def: m[2], what: m[3] });
  }
  return rows;
}

describe("inputs.md matches action.yml", () => {
  const inputs = loadAction().inputs;

  test("every input has a row (and every row is an input)", () => {
    const rows = inputRows();
    const dashboardOnly = new Set(["auto_review", "trigger", "exhaustive", "quiet", "rubric"]);
    assert.deepEqual([...rows.keys()].filter((k) => !dashboardOnly.has(k)).sort(), Object.keys(inputs).sort());
  });

  test("every default a row states as a value is action.yml's default", () => {
    const rows = inputRows();
    let compared = 0;
    for (const [name, spec] of Object.entries(inputs)) {
      const { def } = rows.get(name);
      const code = def.match(/^`([^`]*)`(?: \(engine default\))?$/);
      const actual = spec.default === undefined ? undefined : String(spec.default);
      if (def === "—") {
        assert.equal(spec.required, true, `${name}: inputs.md says there is no default`);
      } else if (code) {
        const stated = code[1] === '""' ? "" : code[1];
        assert.equal(stated, actual, `${name}: inputs.md says ${def}, action.yml says ${JSON.stringify(actual)}`);
        compared += 1;
      }
    }
    assert.ok(compared >= 15, `only ${compared} defaults compared — the row parser is not reading the tables`);
  });

  test("judge-model: the default is empty — the router's recipe picks the judge", () => {
    assert.equal(inputs["judge-model"].default, "");
    assert.match(inputRows().get("judge-model").def, /^`""`$/);
  });

  test("github-token: the row says it also writes the commit status (statuses: write)", () => {
    assert.match(inputs["github-token"].description, /commit status/);
    const { what } = inputRows().get("github-token");
    assert.match(what, /commit status/);
    assert.match(what, /statuses: write/);
  });
});

describe("publish.yml says why it fetches the full history", () => {
  test("the fetch-depth comment names the pinned-commit check, not a v1 tag check", () => {
    const doc = YAML.parseDocument(readText(".github/workflows/publish.yml"));
    let comment = null;
    YAML.visit(doc, {
      Pair(_, pair) {
        if (YAML.isScalar(pair.key) && pair.key.value === "fetch-depth") comment = String(pair.value.comment || "");
      },
    });
    assert.ok(comment, "no fetch-depth comment");
    assert.doesNotMatch(comment, /v1 tag/);
    assert.match(comment, /ACTION_SHA|pinned/);
  });
});

describe('"never cancel" is said precisely', () => {
  const claims = async () => {
    const out = [];
    const docs = [
      ["README.md", readText("README.md")],
      ["SECURITY.md", readText("SECURITY.md")],
      ...(await shippedWorkflows()).map((w) => [w.name, w.text]),
    ];
    for (const [name, text] of docs) {
      for (const u of docUnits(name.endsWith(".md") ? name : `${name}.yml`, text)) {
        if (/never cancel|cannot cancel/i.test(u.text)) out.push({ name, line: u.line, text: u.text });
      }
    }
    return out;
  };

  test("the docs make the claim (the check is not hollow)", async () => {
    assert.ok((await claims()).length >= 4);
  });

  test("every such claim says a newer comment replaces a PENDING one", async () => {
    for (const c of await claims()) {
      assert.match(c.text, /pending/i, `${c.name}:${c.line}: ${c.text.slice(0, 160)}`);
    }
  });
});
