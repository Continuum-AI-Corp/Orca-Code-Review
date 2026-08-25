// Tests for the `npx orcacode-review` workflow renderer.
//
// The renderer decides what a consumer's CI actually does, so the two
// properties worth pinning are: (1) it only writes inputs that differ from
// their documented default — a file that echoes defaults implies control it
// does not have when the dashboard is authoritative; and (2) what it writes is
// readable back by `reconfigure`, so the round trip cannot silently drift.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULTS,
  renderWorkflow,
  parseOverrides,
} from "../bin/orcacode-review.mjs";

const withBlock = (yaml) =>
  yaml.slice(yaml.indexOf("        with:")).split("\n").slice(1).filter((l) => l.trim());

test("all-default config writes only the api key", () => {
  const yaml = renderWorkflow({ ...DEFAULTS });
  const lines = withBlock(yaml);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /orcarouter-api-key: \$\{\{ secrets\.ORCAROUTER_API_KEY \}\}/);
});

test("non-default inputs are written, defaults are not", () => {
  const yaml = renderWorkflow({
    settings: "false",
    "block-on": "P0",
    "on-oversized-diff": "fail", // default — must be omitted
    "auto-review-authors": "OWNER,MEMBER",
  });
  assert.match(yaml, /^\s+settings: "false"/m);
  assert.match(yaml, /^\s+block-on: "P0"/m);
  assert.match(yaml, /^\s+auto-review-authors: "OWNER,MEMBER"/m);
  assert.doesNotMatch(yaml, /^\s+on-oversized-diff:/m);
});

test('block-on "" (never block) is written, not dropped as falsy', () => {
  // An explicit empty string is a deliberate "none", not an absent value. If it
  // were dropped, a user who chose comment-only mode would silently get the
  // P0,P1 default and their merges would start failing.
  const yaml = renderWorkflow({ ...DEFAULTS, "block-on": "" });
  assert.match(yaml, /^\s+block-on: ""/m);
});

test("undefined inputs are skipped", () => {
  const yaml = renderWorkflow({ ...DEFAULTS, "auto-review-authors": undefined });
  assert.doesNotMatch(yaml, /auto-review-authors/);
});

test("the generated workflow keeps the security-critical scaffolding", () => {
  const yaml = renderWorkflow({ ...DEFAULTS });
  // pull_request_target is what lets a fork PR be reviewed at all.
  assert.match(yaml, /pull_request_target:/);
  // The author-association gate is what stops a drive-by commenter from
  // spending paid quota with /orcacode-review.
  assert.match(yaml, /\["OWNER", "MEMBER", "COLLABORATOR"\]/);
  // All four command spellings the GitHub App accepts.
  for (const cmd of ["/orcacode-review", "/orcacode review", "@orcacode-review", "@orcacode review"]) {
    assert.ok(yaml.includes(`'${cmd}'`), `missing command spelling: ${cmd}`);
  }
  assert.match(yaml, /pull-requests: write/);
  assert.match(yaml, /issues: write/);
});

test("render -> parse round-trips every input", () => {
  const cfg = {
    settings: "false",
    "block-on": "",
    "on-oversized-diff": "pass",
    "auto-review-authors": "OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR",
  };
  assert.deepEqual(parseOverrides(renderWorkflow(cfg)), cfg);
});

test("parsing a defaults-only workflow reports the defaults", () => {
  assert.deepEqual(parseOverrides(renderWorkflow({ ...DEFAULTS })), { ...DEFAULTS });
});

test("commented-out example inputs are not read as overrides", () => {
  // The shipped template documents optional inputs as comments. Treating one as
  // a real value would make `reconfigure` show a change the file never had.
  const text = [
    "        with:",
    "          orcarouter-api-key: ${{ secrets.ORCAROUTER_API_KEY }}",
    '          # settings: "false"',
    '          # block-on: "P0"',
  ].join("\n");
  assert.deepEqual(parseOverrides(text), { ...DEFAULTS });
});

test("a trailing comment on a real input does not leak into the value", () => {
  const text = '          block-on: "P0"  # severities that fail the check\n';
  assert.equal(parseOverrides(text)["block-on"], "P0");
});
