// publish-guard.mjs — the one funnel every byte the action posts to GitHub goes
// through (comments, reviews, the PR description, commit statuses).
//
// Two jobs, both because what the action posts is partly written by the PR:
//   1. sanitizeUntrusted(): finding text and file paths come from the engine,
//      which read a fork's files. They must not ping people (@org/team), carry
//      HTML (<img>, <details>, comments that fake the action's own markers),
//      link anywhere but this repository and the OrcaRouter docs, forge
//      headings ("## OrcaCode Review ✅ No findings"), or run on without bound.
//   2. redactSecrets() / guardGithub(): the OrcaRouter key and the GitHub token
//      never appear in anything posted — raw, base64 (at any alignment inside a
//      longer base64 run), base64url, URL-encoded, or as the Basic-auth value.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeUntrusted,
  codeSpan,
  redactSecrets,
  guardGithub,
  MAX_FINDING_CHARS,
} from "./publish-guard.mjs";

const REPO = { owner: "acme", repo: "widgets" };
const clean = (t) => sanitizeUntrusted(t, { repo: REPO });

describe("sanitizeUntrusted: mentions", () => {
  test("@user and @org/team are neutralised with a zero-width joiner", () => {
    const out = clean("cc @alice and @acme/security-team please look");
    assert.doesNotMatch(out, /@alice|@acme\//);
    assert.match(out, /@\u200Dalice/);
    assert.match(out, /@\u200Dacme\/security-team/);
  });

  test("a mention inside code is neutralised too (GitHub would not ping, but a mis-parse must not)", () => {
    assert.doesNotMatch(clean("use `@Override` here"), /@Override/);
  });
});

describe("sanitizeUntrusted: HTML", () => {
  test("<img> and other tags are escaped, not rendered", () => {
    const out = clean('see <img src="https://evil.example/t.png" onerror=alert(1)> and <details>x</details>');
    assert.doesNotMatch(out, /<img|<details/i);
    assert.match(out, /&lt;img/);
  });

  test("HTML comments are removed — including ones faking the action's markers", () => {
    const out = clean("before <!-- orca-code-review-summary --> after <!-- unclosed");
    assert.doesNotMatch(out, /<!--|orca-code-review-summary/);
    assert.match(out, /before/);
    assert.match(out, /after/);
  });

  test("code spans and fenced blocks keep their < characters", () => {
    assert.match(clean("the type `List<String>` is raw"), /`List<String>`/);
    assert.match(clean("```html\n<div onclick=x>\n```"), /<div onclick=x>/);
  });

  test("an escaped backtick does not open a code span", () => {
    assert.doesNotMatch(clean("\\`<img src=x>`"), /<img/);
  });

  test("an unclosed backtick does not make the rest code", () => {
    assert.doesNotMatch(clean("`<img src=x>"), /<img/);
  });

  test("a code span cannot run across a blank line", () => {
    assert.doesNotMatch(clean("`a\n\n<img src=x>`"), /<img/);
  });
});

describe("sanitizeUntrusted: links", () => {
  test("[x](https://evil) is not a link any more", () => {
    const out = clean("click [here](https://evil.example/phish) now");
    assert.doesNotMatch(out, /\]\(https:\/\/evil/);
    assert.match(out, /`https:\/\/evil\.example\/phish`/, "the URL stays visible, defanged in code");
  });

  test("images are not rendered", () => {
    assert.doesNotMatch(clean("![logo](https://evil.example/i.png)"), /!\[[^\]]*\]\(/);
  });

  test("a bare URL to another host is defanged; this repo and the docs host stay links", () => {
    const out = clean(
      "a https://evil.example/x b https://github.com/acme/widgets/blob/main/a.js#L3 " +
        "c https://github.com/other/repo d https://www.orcarouter.ai/code-review e www.evil.example",
    );
    assert.match(out, /`https:\/\/evil\.example\/x`/);
    assert.match(out, /`https:\/\/github\.com\/other\/repo`/);
    assert.match(out, /`www\.evil\.example`/);
    assert.match(out, /[^`]https:\/\/github\.com\/acme\/widgets\/blob\/main\/a\.js#L3/);
    assert.match(out, /[^`]https:\/\/www\.orcarouter\.ai\/code-review/);
  });

  test("a reference-style link definition cannot form", () => {
    const out = clean("[ref]\n\n[ref]: https://evil.example");
    assert.doesNotMatch(out, /^\[ref\]:/m);
  });
});

describe("sanitizeUntrusted: forged structure and size", () => {
  test("a finding cannot start a heading (no fake '## OrcaCode Review ✅ No findings')", () => {
    const out = clean("ok\n## 🐳 OrcaCode Review\n\n✅ **No findings**\n===\n");
    assert.doesNotMatch(out, /^\s{0,3}#/m);
    assert.doesNotMatch(out, /^\s{0,3}=+\s*$/m);
  });

  test("length is capped", () => {
    const out = clean("x".repeat(MAX_FINDING_CHARS * 2));
    assert.ok(out.length <= MAX_FINDING_CHARS + 40, `got ${out.length}`);
    assert.match(out, /truncated/);
  });
});

describe("codeSpan: a file path as inline code", () => {
  test("backticks, newlines and control characters cannot break out", () => {
    const out = codeSpan("a`b\n## x\u0000.js");
    assert.equal((out.match(/`/g) || []).length, 2);
    assert.doesNotMatch(out, /\n/);
  });
});

describe("redactSecrets", () => {
  const KEY = "sk-orca-0123456789abcdefXYZ";
  const TOKEN = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";
  const secrets = [KEY, TOKEN];
  const b64 = (s) => Buffer.from(s).toString("base64");

  test("raw values", () => {
    const out = redactSecrets(`key=${KEY} token=${TOKEN}`, secrets);
    assert.ok(!out.includes(KEY) && !out.includes(TOKEN));
    assert.match(out, /\[REDACTED\]/);
  });

  test("base64, base64url and URL-encoded forms", () => {
    const weird = "sk/orca+key=0123456789&?";
    for (const form of [b64(KEY), b64(KEY).replace(/=+$/, ""), Buffer.from(weird).toString("base64url"), encodeURIComponent(weird)]) {
      const out = redactSecrets(`x ${form} y`, [KEY, weird]);
      assert.ok(!out.includes(form), `not redacted: ${form}`);
    }
  });

  test("base64 of the secret embedded at any alignment in a longer run", () => {
    for (const prefix of ["", "a", "ab", "abc", "Authorization: Basic "]) {
      const blob = b64(`${prefix}${KEY}${"tail-bytes"}`);
      const out = redactSecrets(blob, [KEY]);
      assert.notEqual(out, blob, `prefix ${JSON.stringify(prefix)} slipped through`);
    }
  });

  test("the GitHub Basic-auth value is redacted", () => {
    const basic = b64(`x-access-token:${TOKEN}`);
    assert.ok(!redactSecrets(`AUTHORIZATION: basic ${basic}`, secrets).includes(basic));
  });

  test("short or empty secrets are ignored rather than shredding the text", () => {
    assert.equal(redactSecrets("a b c", ["", "a", undefined]), "a b c");
  });

  test("hex, lower, upper and mixed case", () => {
    const hex = Buffer.from(KEY).toString("hex");
    const mixed = [...hex].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join("");
    for (const form of [hex, hex.toUpperCase(), mixed]) {
      const out = redactSecrets(`dump: ${form} end`, [KEY]);
      assert.ok(!out.includes(form), `not redacted: ${form}`);
      assert.match(out, /^dump: \[REDACTED\] end$/);
    }
  });

  test("a copy split by invisible characters (zero-width, joiners, soft hyphen, bidi marks) is redacted", () => {
    for (const z of ["​", "‌", "‍", "⁠", "﻿", "­", "‎"]) {
      const split = [...KEY].join(z);
      const out = redactSecrets(`x ${split} y`, [KEY]);
      assert.equal(out, "x [REDACTED] y", `split by U+${z.codePointAt(0).toString(16)}`);
    }
    const b64split = b64(KEY).replace(/(.{4})/g, "$1​");
    assert.ok(!redactSecrets(b64split, [KEY]).replace(/​/g, "").includes(b64(KEY).slice(4, 20)));
  });

  test("invisible characters elsewhere are left alone (a neutralised @‍mention stays neutralised)", () => {
    const text = `ping @‍alice about ${KEY}`;
    assert.equal(redactSecrets(text, [KEY]), "ping @‍alice about [REDACTED]");
  });
});

describe("guardGithub: every posting method is redacted on the way out", () => {
  const KEY = "sk-orca-0123456789abcdefXYZ";
  function fake() {
    const calls = [];
    const rec = (name) => async (args) => {
      calls.push({ name, args });
      return { data: {} };
    };
    return {
      calls,
      github: {
        paginate: async () => [],
        rest: {
          issues: { createComment: rec("createComment"), updateComment: rec("updateComment"), listComments: rec("listComments") },
          pulls: { createReview: rec("createReview"), update: rec("pullsUpdate"), get: rec("pullsGet") },
          repos: { createCommitStatus: rec("createCommitStatus") },
        },
      },
    };
  }

  test("comment, review (body + inline bodies), PR description and status description", async () => {
    const { github, calls } = fake();
    const gh = guardGithub(github, { secrets: [KEY] });
    await gh.rest.issues.createComment({ body: `a ${KEY}` });
    await gh.rest.issues.updateComment({ body: `b ${KEY}` });
    await gh.rest.pulls.createReview({ body: `c ${KEY}`, comments: [{ path: "x", body: `d ${KEY}` }] });
    await gh.rest.pulls.update({ body: `e ${KEY}` });
    await gh.rest.repos.createCommitStatus({ description: `f ${KEY}` });
    assert.equal(calls.length, 5);
    assert.ok(!JSON.stringify(calls).includes(KEY), JSON.stringify(calls));
  });

  test("reads pass through untouched", async () => {
    const { github, calls } = fake();
    const gh = guardGithub(github, { secrets: [KEY] });
    await gh.rest.pulls.get({ pull_number: 1 });
    assert.equal(calls[0].name, "pullsGet");
    assert.equal(gh.paginate, github.paginate);
  });

  test("secrets default to the CR_REDACT_* environment variables", async () => {
    const { github, calls } = fake();
    process.env.CR_REDACT_API_KEY = KEY;
    try {
      const gh = guardGithub(github);
      await gh.rest.issues.createComment({ body: `z ${KEY}` });
    } finally {
      delete process.env.CR_REDACT_API_KEY;
    }
    assert.ok(!calls[0].args.body.includes(KEY));
  });
});
