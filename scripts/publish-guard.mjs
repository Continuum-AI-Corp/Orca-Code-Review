// The one funnel for everything the action posts to GitHub.
//
// What the action posts is partly written by the pull request: finding text
// comes from an engine that read the fork's files, and file paths are the
// fork's own. So two guards, used by every posting path in action.yml:
//
//   sanitizeUntrusted(text)  for each attacker-influenced FRAGMENT (a finding's
//                            title or body, a reason) before the action wraps it
//                            in its own markdown. It:
//                              - removes HTML comments (so nothing can forge the
//                                action's <!-- orca-code-review-* --> markers,
//                                which the action adds after sanitising);
//                              - escapes `<` outside code, so no HTML renders
//                                (<img>, <details>, <sub>…);
//                              - escapes `[` `]` outside code, so no markdown
//                                link, image or reference definition forms, and
//                                defangs every bare URL into inline code unless
//                                it points into this repository or the
//                                OrcaRouter docs host (then it is emitted as an
//                                explicit `<…>` autolink, so nothing after it can
//                                extend it);
//                              - neutralises @mentions with a zero-width joiner;
//                              - demotes heading and setext lines — inside list
//                                items and quotes too — so a finding cannot
//                                print "## OrcaCode Review ✅ No findings", and
//                                keeps tables from forming (a table row would cut
//                                a code span open at a `|`);
//                              - caps the length;
//                              - leaves inline code and fenced blocks alone
//                                (code quotes keep their `<`), and closes a fence
//                                the fragment left open so it cannot swallow, or
//                                be closed by, the text after it.
//   codeSpan(text)           a file path as inline code that cannot break out.
//   isOwn(comment)           whether a comment is the action's own (its markers
//                            count only there) — the identity funnel,
//                            scripts/identity.mjs.
//   guardGithub(github)      wraps the github-script client so every posting
//                            call (comments, reviews, the PR description, commit
//                            statuses, check runs) has the OrcaRouter key and the
//                            GitHub token REDACTED from what it sends — raw,
//                            base64 at any alignment, base64url, URL-encoded,
//                            hex in any case, and split by invisible characters.
//
// The tokenizer errs one way only: whatever it is unsure is code, it treats as
// text and escapes. Treating real code as text costs a cosmetic `&lt;`;
// treating text as code would let HTML through. It is held to what a real
// CommonMark + GFM renderer makes of its output, over a corpus and a seeded
// fuzz, by scripts/sanitizer-render.test.mjs.

import { isOwn, ownLogin, recordIdentity } from "./identity.mjs";

export { isOwn, ownLogin };

export const MAX_FINDING_CHARS = 3000;
export const MAX_POSTED_FINDINGS = 50;
export const BODY_LIMIT = 60000;

const ZWJ = "\u200D";
const DOCS_HOSTS = new Set(["www.orcarouter.ai", "orcarouter.ai"]);

// ------------------------------------------------------------------ helpers

const stripControls = (t) =>
  String(t ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

function stripHtmlComments(t) {
  let out = t;
  for (;;) {
    const i = out.indexOf("<!--");
    if (i < 0) return out;
    const j = out.indexOf("-->", i + 4);
    out = j < 0 ? out.slice(0, i) : out.slice(0, i) + out.slice(j + 3);
  }
}

const neutraliseMentions = (t) => t.replace(/@(?=[A-Za-z0-9_])/g, `@${ZWJ}`);

/** A value as one inline code span: no newline, no control char, no backtick. */
export function codeSpan(text, max = 300) {
  const v = stripControls(text)
    .replace(/[\n\t\u2028\u2029]/g, " ")
    .replace(/`/g, "'")
    .slice(0, max);
  return `\`${neutraliseMentions(v) || " "}\``;
}

// Characters an allowed URL may carry when it is emitted as a live link. Any
// other (a bracket, a backtick, a backslash, a quote) could change what the
// renderer makes of the text around it, so such a URL is shown as code.
const SAFE_URL_CHARS = /^[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+$/;

function allowedUrl(raw, { repo, serverUrl }) {
  if (!SAFE_URL_CHARS.test(raw)) return false;
  let u;
  try {
    u = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (DOCS_HOSTS.has(host)) return true;
  let server;
  try {
    server = new URL(serverUrl || "https://github.com");
  } catch {
    return false;
  }
  if (!repo?.owner || !repo?.repo || host !== server.hostname.toLowerCase()) return false;
  const prefix = `/${repo.owner}/${repo.repo}`.toLowerCase();
  const p = u.pathname.toLowerCase();
  return p === prefix || p.startsWith(`${prefix}/`);
}

// A URL as GFM's autolink literal sees it: a scheme or `www.`, then everything
// up to whitespace or `<` — backticks included, so a URL glued to a code span
// swallows the span's opening backticks in the renderer. The tokenizer below
// therefore takes a URL run BEFORE it looks for code spans inside it.
const URL_AT = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<]*/iy;

// Trailing punctuation is not part of the link (GFM's rule): a sentence's
// full stop or a markdown link's closing parenthesis stays outside.
function trimUrl(raw) {
  let url = raw;
  for (;;) {
    if (/[?!.,:;*_~'"]$/.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
    else break;
  }
  return url;
}

// CommonMark's backslash escapes: `\` before ASCII punctuation makes it
// literal; before anything else the backslash is itself literal.
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

// Escape plain text. A backslash pair the fragment wrote (`\[`, `\\`, `\``) is
// already an escape and is kept as one — doubling its backslash would turn it
// into a literal backslash followed by a LIVE `[`. Any other backslash is
// doubled, so it can never escape a character the sanitizer adds after it
// (the backtick of a defanged URL's code span). A backtick here is a lone run
// (a code span that closes on this line is passed through by sanitizeLine), and
// is escaped so it cannot pair with a backtick the sanitizer adds.
function escapePlain(t) {
  let out = "";
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === "\\") {
      if (i + 1 < t.length && ASCII_PUNCT.test(t[i + 1])) {
        out += ch + t[i + 1];
        i += 1;
      } else out += "\\\\";
    } else if (ch === "<") out += "&lt;";
    else if (ch === "[" || ch === "]" || ch === "`") out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

// What may open a line before a block that matters: indentation, blockquote
// markers and list markers, nested in any order (`> - 1. `). A heading or a
// setext underline after them is still a heading, inside the container.
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)))*[ \t]*/;

// One line outside any fenced block, tokenised the way the renderer reads it:
//   - a backslash escapes the next character only when that is ASCII
//     punctuation (`\\` is an escaped backslash, so a backtick after it is
//     real); otherwise it is a literal backslash;
//   - a URL run (see URL_AT) is taken whole: a link only when it points into
//     this repository or the docs host, emitted as an explicit `<…>` autolink
//     so nothing after it can extend it; anything else is shown as code;
//   - an inline code span that opens AND closes on this line passes through
//     (a multi-line span is treated as text, the safe direction);
//   - everything else is escaped.
// No span the sanitizer emits is glued to a backtick before it: two runs that
// touch merge into one longer run and re-pair every span after them.
function sanitizeLine(line, atLineStart, opts) {
  let body = line;
  let lead = "";
  if (atLineStart) {
    // Headings, setext underlines (of ANY length — `foo` over a lone `-` is an
    // <h2>) and tilde fences a container would own: a finding must not forge
    // structure. The first significant character is escaped, at any depth of
    // indentation and inside any container. Over-escaping an indented code
    // line costs a visible backslash; under-escaping prints a heading.
    // (Backtick fences need no rule here: a lone backtick run is escaped.)
    //
    // And no TABLE: a table row splits its cells on `|` even inside a code
    // span, which would cut open a span this function emits or passes through
    // (a defanged URL, a quoted `a|<img>`). A table needs a delimiter row
    // (`|---|:-:|`) under its header; escaping that row's first character
    // means no table forms, and every span stays whole.
    const whole = body.match(/^[ \t]*(?=(=+|-+)[ \t]*$)/);
    const prefix = whole ? whole[0] : body.match(CONTAINER_PREFIX)[0];
    const restOf = body.slice(prefix.length);
    const delimiterRow = /^[|:-][ \t|:-]*$/.test(restOf) && /-/.test(restOf);
    if (whole || delimiterRow || /^(#|(=+|-+)[ \t]*$|~~~)/.test(restOf)) {
      lead = `${prefix}\\`;
      body = restOf;
    }
  }
  let out = lead;
  let text = "";
  const flush = () => {
    out += escapePlain(text);
    text = "";
  };
  const emit = (span) => {
    flush();
    if (span.startsWith("`") && out.endsWith("`")) out += " ";
    out += span;
  };
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "\\") {
      const pair = i + 1 < body.length && ASCII_PUNCT.test(body[i + 1]);
      text += body.slice(i, pair ? i + 2 : i + 1);
      i += pair ? 2 : 1;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (body[i + n] === "`") n += 1;
      // Find a closing run of exactly n backticks on this line.
      let j = i + n;
      let close = -1;
      while (j < body.length) {
        if (body[j] === "`") {
          let k = 1;
          while (body[j + k] === "`") k += 1;
          if (k === n) {
            close = j;
            break;
          }
          j += k;
        } else j += 1;
      }
      if (close < 0) {
        text += "`".repeat(n); // a lone run is literal text (escapePlain escapes it)
        i += n;
        continue;
      }
      emit(body.slice(i, close + n));
      i = close + n;
      continue;
    }
    if (/[a-z]/i.test(ch)) {
      URL_AT.lastIndex = i;
      const m = URL_AT.exec(body);
      const url = m ? trimUrl(m[0]) : "";
      if (url && /:\/\/|^www\./i.test(url)) {
        if (allowedUrl(url, opts)) emit(`<${/^www\./i.test(url) ? `https://${url}` : url}>`);
        else emit(codeSpan(url, 400));
        i += url.length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

/**
 * Sanitise one attacker-influenced markdown fragment. `atLineStart: false`
 * when the fragment's first line continues a line the action wrote (it is then
 * never a fence or a heading in the rendered page, so it is not treated as one).
 */
export function sanitizeUntrusted(text, { repo, serverUrl, atLineStart = true, maxChars = MAX_FINDING_CHARS } = {}) {
  const opts = { repo, serverUrl };
  let src = stripControls(text);
  let truncated = false;
  if (src.length > maxChars) {
    src = src.slice(0, maxChars);
    truncated = true;
  }
  src = stripHtmlComments(src);

  const lines = src.split("\n");
  const out = [];
  let fence = null; // { ch, n } while inside a fenced block
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const lineStart = idx > 0 || atLineStart;
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.n) fence = null;
      out.push(line);
      continue;
    }
    // A fence is trusted only at column 0. Indented by 1-3 spaces it may belong
    // to a list item, where the renderer closes it at the first line that is
    // not indented — while this loop would still pass that line through raw.
    // Such an opener is escaped instead (sanitizeLine), so it opens nothing.
    if (lineStart) {
      const open = line.match(/^(`{3,}|~{3,})(.*)$/);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fence = { ch: open[1][0], n: open[1].length };
        out.push(line);
        continue;
      }
    }
    out.push(sanitizeLine(line, lineStart, opts));
  }
  if (fence) out.push(fence.ch.repeat(fence.n));
  let result = neutraliseMentions(out.join("\n"));
  if (truncated) result += "\n\n… (truncated)";
  return result;
}

/**
 * Join already-sanitised fragments until `limit` characters, then say how many
 * were left out. Cuts only between fragments, never inside one.
 */
export function joinWithinLimit(head, parts, { sep = "\n\n---\n", limit = BODY_LIMIT, tail = "" } = {}) {
  let body = head;
  let shown = 0;
  for (const p of parts) {
    if (body.length + sep.length + p.length + tail.length + 200 > limit) break;
    body += sep + p;
    shown += 1;
  }
  if (shown < parts.length) body += `\n\n_…${parts.length - shown} more not shown (comment size limit)._`;
  return body + tail;
}

// ---------------------------------------------------------------- redaction

const MIN_SECRET = 8;

// Every string a secret may travel as. Base64 depends on where the secret
// starts within the encoded bytes, so each of the three alignments contributes
// the run of characters that the secret ALONE determines — that run appears in
// any base64 stream carrying the secret at that alignment, whatever surrounds it.
// Hex is matched in any letter case (see redactSecrets).
function formsOf(secret) {
  const s = String(secret);
  const forms = new Set([s]);
  const enc = encodeURIComponent(s);
  if (enc !== s) forms.add(enc);
  const bytes = Buffer.from(s, "utf8");
  forms.add(bytes.toString("hex"));
  for (const k of [0, 1, 2]) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64");
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + bytes.length)) / 6);
    const core = b64.slice(start, end);
    if (core.length >= 12) {
      forms.add(core);
      forms.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return [...forms];
}

// Characters that render as nothing (zero-width space/joiners, word joiner,
// BOM, soft hyphen, bidi marks — Unicode's format class). A secret split by
// them still reads as the secret, so matching ignores them; the text keeps
// them everywhere but inside a match (a neutralised @mention keeps its ZWJ).
const INVISIBLE = /\p{Cf}/u;
const HEX = /^[0-9a-f]+$/;

export function redactSecrets(text, secrets = []) {
  const src = String(text ?? "");
  const usable = secrets.filter((s) => typeof s === "string" && s.length >= MIN_SECRET);
  if (!usable.length) return src;
  // The visible text, and where each of its characters sits in `src`.
  const units = [...src];
  const at = [];
  let visible = "";
  let offset = 0;
  for (const u of units) {
    if (!INVISIBLE.test(u)) {
      at.push(offset);
      visible += u;
      // Keep one entry per UTF-16 unit so `visible` indexes line up with `at`.
      if (u.length === 2) at.push(offset + 1);
    }
    offset += u.length;
  }
  // ASCII-only lowercasing keeps every index where it was.
  const folded = visible.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const hit = new Uint8Array(src.length);
  const forms = [...new Set(usable.flatMap(formsOf))].sort((a, b) => b.length - a.length);
  for (const f of forms) {
    const hay = HEX.test(f) ? folded : visible;
    for (let i = hay.indexOf(f); i >= 0; i = hay.indexOf(f, i + 1)) {
      const from = at[i];
      const to = at[i + f.length - 1] + 1;
      hit.fill(1, from, to);
    }
  }
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    if (!hit[i]) out += src[i];
    else if (i === 0 || !hit[i - 1]) out += "[REDACTED]";
  }
  return out;
}

export const defaultSecrets = () =>
  [process.env.CR_REDACT_API_KEY, process.env.CR_REDACT_GITHUB_TOKEN].filter(Boolean);

// Which calls create a comment or review whose author GitHub reports back —
// how an App token's identity is learned when nothing else could tell it.
const CREATES = { issues: ["createComment"], pulls: ["createReview", "createReviewComment"] };

// Which calls post text, and which of their fields carry it.
const POSTING = {
  issues: ["createComment", "updateComment"],
  pulls: ["createReview", "update", "createReviewComment", "updateReview", "submitReview"],
  repos: ["createCommitStatus"],
  checks: ["create", "update"],
};

function redactArgs(args, secrets) {
  if (!args || typeof args !== "object") return args;
  const r = (v) => (typeof v === "string" ? redactSecrets(v, secrets) : v);
  const out = { ...args };
  for (const k of ["body", "description", "title", "summary", "text"]) if (k in out) out[k] = r(out[k]);
  if (Array.isArray(out.comments)) out.comments = out.comments.map((c) => ({ ...c, body: r(c?.body) }));
  if (out.output && typeof out.output === "object") {
    out.output = { ...out.output };
    for (const k of ["title", "summary", "text"]) if (k in out.output) out.output[k] = r(out.output[k]);
  }
  return out;
}

/** The github-script client, with every posting call redacted on the way out. */
export function guardGithub(github, { secrets = defaultSecrets() } = {}) {
  const wrapNamespace = (name, ns) =>
    new Proxy(ns, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v === "function" && POSTING[name]?.includes(prop)) {
          return async (args, ...rest) => {
            const res = await v.call(target, redactArgs(args, secrets), ...rest);
            if (CREATES[name]?.includes(prop)) recordIdentity(res);
            return res;
          };
        }
        return v;
      },
    });
  const rest = new Proxy(github.rest, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      return POSTING[prop] && v && typeof v === "object" ? wrapNamespace(prop, v) : v;
    },
  });
  return new Proxy(github, {
    get(target, prop, recv) {
      if (prop === "rest") return rest;
      return Reflect.get(target, prop, recv);
    },
  });
}
