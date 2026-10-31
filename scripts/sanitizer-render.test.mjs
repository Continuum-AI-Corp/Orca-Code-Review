// sanitizeUntrusted() judged by what a real CommonMark + GFM renderer makes of
// its output, not by what the output looks like as text.
//
// The sanitizer is a hand-written tokenizer, and a tokenizer that disagrees
// with the renderer about one character is a bypass: it treated `\` + backtick
// as an escaped backtick even when the backslash was itself escaped (`\\`), so
//
//     \\`x` [Approve](https://evil/login) <img src="https://evil/p.png"> `
//
// was taken for one long code span and passed through unchanged, while GFM
// renders a code span `x`, then a live link and a live image. A setext
// underline of one `-` was not escaped either, so `foo\n-` printed a heading.
//
// So every input below — a corpus of known tricks and a seeded fuzz over the
// characters markdown gives meaning to — is sanitised, placed the way the
// action places finding text, rendered with micromark + micromark-extension-gfm
// (exact-pinned devDependencies; the action itself never installs them), and
// the HTML is held to four properties:
//   1. no tag the fragment did not get from markdown itself (no <img>, no
//      <details>, no <sub>, nothing raw), and no HTML comment;
//   2. no heading;
//   3. every link points into this repository or the OrcaRouter docs host;
//   4. text the action writes after the fragment is still a paragraph of its
//      own — the fragment cannot swallow it into code.
//
// micromark is not GitHub's renderer (cmark-gfm), but both implement the same
// two specs; a disagreement between them would be a bug report against one.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

import { sanitizeUntrusted } from "./publish-guard.mjs";
import { step } from "./test-helpers/action-yaml.mjs";

const REPO = { owner: "acme", repo: "widgets" };
const S = (t, o = {}) => sanitizeUntrusted(t, { repo: REPO, serverUrl: "https://github.com", ...o });

// Raw HTML is let through on purpose: the point is to SEE any that survives.
const render = (md) =>
  micromark(md, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: true,
    allowDangerousProtocol: true,
  });

// Tags markdown itself produces from the syntax a finding may legitimately use.
const MARKDOWN_TAGS = new Set([
  "p", "code", "pre", "em", "strong", "del", "ul", "ol", "li", "blockquote", "hr", "br",
  "table", "thead", "tbody", "tr", "th", "td", "input", "a",
]);

const decodeAttr = (v) =>
  v.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function linkAllowed(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return false; // relative, scheme-relative-looking or garbage: not ours
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === "www.orcarouter.ai" || host === "orcarouter.ai") return true;
  if (host !== "github.com") return false;
  const p = u.pathname.toLowerCase();
  return p === "/acme/widgets" || p.startsWith("/acme/widgets/");
}

// The properties, as a list of violations (empty = fine).
function violations(html, { after = null } = {}) {
  const bad = [];
  if (/<!--/.test(html)) bad.push("an HTML comment survived");
  for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)) {
    const tag = m[1].toLowerCase();
    if (/^h[1-6]$/.test(tag)) bad.push(`a heading: ${m[0]}`);
    else if (!MARKDOWN_TAGS.has(tag)) bad.push(`raw HTML: ${m[0]}`);
    else if (tag === "a" && m[0].startsWith("<a")) {
      const href = m[0].match(/\bhref="([^"]*)"/);
      if (!href || !linkAllowed(decodeAttr(href[1]))) bad.push(`a link off-site: ${m[0]}`);
    }
  }
  if (after && !html.includes(`<p>${after}</p>`)) bad.push(`the text after the fragment was swallowed: ${after}`);
  return bad;
}

// The ways action.yml places finding text: a body that starts its own block, a
// one-line title inside the badge's bold (normalised as "Post review
// comments" mk() does it), and a whole finding continuing the badge's line.
const titleOf = (t) => t.replace(/\*\*/g, "").replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
function placements(input) {
  return [
    ["body", `${S(input)}\n\nAFTERTEXT`, "AFTERTEXT"],
    ["title", `🟠 **P1** **${S(titleOf(input), { atLineStart: false, maxChars: 200 })}**\n\nAFTERTEXT`, "AFTERTEXT"],
    ["continued", `\`a.js\`: 🟠 **P1** ${S(input, { atLineStart: false })}\n\nAFTERTEXT`, "AFTERTEXT"],
  ];
}

function check(input) {
  const found = [];
  for (const [where, md, after] of placements(input)) {
    for (const v of violations(render(md), { after })) found.push(`${where}: ${v}`);
  }
  return found;
}

const CORPUS = [
  // The reported bypass and its relatives: an escaped backslash before a backtick.
  '\\\\`x` [Approve](https://evil.example/login) <img src="https://evil.example/p.png"> `',
  "\\\\`<img src=x>`",
  "\\\\\\`<img src=x>`",
  "\\`<img src=x>`",
  // A backslash the sanitizer leaves bare must not escape a backtick it adds.
  "\\https://x.example <i> `<img src=//evil.example/p.png>`",
  "x\\",
  "` https://evil.example/p",
  "``https://evil.example/p",
  // Brackets the fragment escaped itself.
  "\\[Approve\\](//evil.example/login)",
  "\\[Approve\\](https://evil.example/login)",
  "\\\\[Approve\\\\](//evil.example/login)",
  // Links, images, autolinks, reference definitions.
  "[Approve](https://evil.example/login)",
  "![x](https://evil.example/p.png)",
  "<https://evil.example>",
  "[x](<//evil.example>)",
  "[[x]](//evil.example)",
  "**[x](//evil.example)**",
  "[a]: //evil.example\n\n[a]",
  "[a]\n\n[a]: https://evil.example",
  "www.evil.example and https://evil.example/x and HTTPS://EVIL.EXAMPLE",
  "https://github.com/acme/widgets/[x](//evil.example)",
  "https://github.com/acme/widgets/x)](//evil.example)",
  "https://github.com/acme/widgets/../../evil/repo",
  "mailto:a@evil.example and a@evil.example",
  "[x](javascript:alert(1))",
  "&#91;x&#93;(//evil.example)",
  // HTML.
  "<img src=x>",
  "<details><summary>x</summary>y</details>",
  "<scr<script>ipt>",
  "<!-- orca-code-review-summary -->",
  "a <!-- b",
  "\\<img src=x>",
  "&lt;img src=x&gt;",
  // Headings: plain, indented, inside containers, setext of every length.
  "# OrcaCode Review",
  "   ## x",
  "foo\n-",
  "foo\n=",
  "foo\n---",
  "foo\n  ===",
  "- # x",
  "* ## x",
  "+ ### x",
  "1. # x",
  "1) # x",
  "> ## OrcaCode Review ✅ No findings",
  ">## x",
  "> - # x",
  "- foo\n  ===",
  "   - foo\n     ===",
  "- foo\n  -",
  "> foo\n> ---",
  // Fences: indented, inside a list, inside a quote, unclosed, info strings.
  "```\n<img src=x>",
  "```html\n<img src=x>\n```\nafter <img src=y>",
  "- x\n\n  ```\n<img src=x>\n```",
  "  ~~~\n<img src=x>",
  "  ```\n<img src=x>",
  "> ```\n<img src=x>",
  "```a`b\n<img src=x>\n```",
  "~~~\nx\n~~~~\n<img src=x>",
  "``a`<img src=x>``",
  "`a\n\n<img src=x>`",
  // Tables: a row splits on `|` even inside a code span, so a span the
  // sanitizer emits or passes through must never land in a table row.
  "| a | b |\n|---|---|\nhttps://evil.example/p|x",
  "a | b\n---|---\n`x|<img src=x>`",
  "| a |\n| :-: |\n| `<img src=x>|` |",
  "> | a | b |\n> |---|---|\n> https://evil.example/p|x",
];

describe("sanitizeUntrusted, rendered: the reported bypass", () => {
  test("an escaped backslash before a backtick does not open a code span over a link and an image", () => {
    const input = '\\\\`x` [Approve](https://evil/login) <img src="https://evil/p.png"> `';
    const html = render(S(input));
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<a /);
  });

  test("a setext underline of a single '-' does not make a heading", () => {
    assert.doesNotMatch(render(S("foo\n-")), /<h\d/);
  });
});

describe("sanitizeUntrusted, rendered: a corpus of markdown tricks", () => {
  for (const input of CORPUS) {
    test(JSON.stringify(input), () => {
      assert.deepEqual(check(input), []);
    });
  }
});

// mulberry32: a small seeded PRNG, so a failure reproduces from its seed.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  "\\", "\\", "`", "``", "```", "~~~", "[", "]", "(", ")", "<", ">", "!", "#", "=", "-", "*", "_",
  " ", "  ", "   ", "\n", "\n", "\n\n", "\t", "x", "Approve", "1.", "1)", "+", "|", ":", '"', "'", "&", "&#60;",
  "https://evil.example/p", "//evil.example/p", "www.evil.example", "https://github.com/acme/widgets/a",
  "<img src=x>", "<a href=//evil.example>", "img", "@team", "a@b.example",
];

describe("sanitizeUntrusted, rendered: a seeded fuzz", () => {
  test("3000 random arrangements of markdown's special characters render nothing unsafe", () => {
    const failures = [];
    for (let seed = 1; seed <= 3000 && failures.length < 5; seed += 1) {
      const rnd = prng(seed);
      const n = 1 + Math.floor(rnd() * 14);
      let input = "";
      for (let i = 0; i < n; i += 1) input += TOKENS[Math.floor(rnd() * TOKENS.length)];
      const found = check(input);
      if (found.length) failures.push({ seed, input, found });
    }
    assert.deepEqual(failures, []);
  });
});

describe("the placements are the action's", () => {
  test("a title is normalised to one line before it is sanitised, as titleOf() assumes", () => {
    const script = step("Post review comments").with.script;
    assert.ok(
      script.includes("S(t.replace(/\\*\\*/g, '').replace(/[.!?]+$/, '').replace(/\\s+/g, ' ').trim(), {"),
      "Post review comments no longer builds titles the way titleOf() mirrors it",
    );
  });
});

describe("the differential check is not blind", () => {
  // Without the sanitizer every property must trip, or the test proves nothing.
  test("unsanitised input trips each property", () => {
    assert.ok(violations(render("<img src=x>")).some((v) => /raw HTML/.test(v)));
    assert.ok(violations(render("# x")).some((v) => /heading/.test(v)));
    assert.ok(violations(render("foo\n-")).some((v) => /heading/.test(v)));
    assert.ok(violations(render("[a](//evil.example)")).some((v) => /off-site/.test(v)));
    assert.ok(violations(render("https://evil.example")).some((v) => /off-site/.test(v)));
    assert.ok(violations(render("<!-- x -->")).some((v) => /comment/.test(v)));
    assert.ok(violations(render("```\nx\n\nAFTERTEXT"), { after: "AFTERTEXT" }).some((v) => /swallowed/.test(v)));
  });

  test("allowed links stay links (the property is not 'no links at all')", () => {
    const html = render(S("see https://github.com/acme/widgets/blob/main/a.js and https://www.orcarouter.ai/code-review"));
    assert.equal((html.match(/<a /g) || []).length, 2, html);
    assert.deepEqual(violations(html), []);
  });
});
