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
//                                OrcaRouter docs host;
//                              - neutralises @mentions with a zero-width joiner;
//                              - demotes heading and setext lines, so a finding
//                                cannot print "## OrcaCode Review ✅ No findings";
//                              - caps the length;
//                              - leaves inline code and fenced blocks alone
//                                (code quotes keep their `<`), and closes a fence
//                                the fragment left open so it cannot swallow, or
//                                be closed by, the text after it.
//   codeSpan(text)           a file path as inline code that cannot break out.
//   guardGithub(github)      wraps the github-script client so every posting
//                            call (comments, reviews, the PR description, commit
//                            statuses, check runs) has the OrcaRouter key and the
//                            GitHub token REDACTED from what it sends — raw,
//                            base64 at any alignment, base64url, URL-encoded.
//
// The tokenizer errs one way only: whatever it is unsure is code, it treats as
// text and escapes. Treating real code as text costs a cosmetic `&lt;`;
// treating text as code would let HTML through.

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

function allowedUrl(raw, { repo, serverUrl }) {
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

const URL_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<]*/gi;

// Escape one run of plain (non-code) text on ONE line.
function escapeText(t, opts) {
  let out = "";
  let last = 0;
  for (const m of t.matchAll(URL_RE)) {
    // Trailing punctuation is not part of the link (GFM's rule): a sentence's
    // full stop or a markdown link's closing parenthesis stays outside.
    let url = m[0];
    for (;;) {
      if (/[?!.,:;*_~'"]$/.test(url)) url = url.slice(0, -1);
      else if (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
      else break;
    }
    out += escapePlain(t.slice(last, m.index));
    out += allowedUrl(url, opts) ? url : codeSpan(url, 400);
    last = m.index + url.length;
  }
  return out + escapePlain(t.slice(last));
}
const escapePlain = (t) => t.replace(/</g, "&lt;").replace(/\[/g, "\\[").replace(/\]/g, "\\]");

// One line outside any fenced block: inline code spans (open AND close on this
// line — a multi-line span is treated as text, the safe direction) pass
// through; everything else is escaped.
function sanitizeLine(line, atLineStart, opts) {
  let body = line;
  let lead = "";
  if (atLineStart) {
    // Headings and setext underlines: a finding must not forge structure.
    if (/^ {0,3}#/.test(body)) {
      const i = body.indexOf("#");
      lead = `${body.slice(0, i)}\\`;
      body = body.slice(i);
    } else if (/^ {0,3}(=+|-{2,})[ \t]*$/.test(body)) {
      const i = body.search(/[=-]/);
      lead = `${body.slice(0, i)}\\`;
      body = body.slice(i);
    }
  }
  let out = "";
  let text = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "`") {
      text += "\\`";
      i += 2;
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
        text += "`".repeat(n); // a lone run is literal text
        i += n;
        continue;
      }
      out += escapeText(text, opts) + body.slice(i, close + n);
      text = "";
      i = close + n;
      continue;
    }
    text += ch;
    i += 1;
  }
  return lead + out + escapeText(text, opts);
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
    if (lineStart) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
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
function formsOf(secret) {
  const s = String(secret);
  const forms = new Set([s]);
  const enc = encodeURIComponent(s);
  if (enc !== s) forms.add(enc);
  const bytes = Buffer.from(s, "utf8");
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
  return [...forms].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text, secrets = []) {
  let out = String(text ?? "");
  const usable = secrets.filter((s) => typeof s === "string" && s.length >= MIN_SECRET);
  for (const s of usable) {
    for (const f of formsOf(s)) {
      if (f && out.includes(f)) out = out.split(f).join("[REDACTED]");
    }
  }
  return out;
}

export const defaultSecrets = () =>
  [process.env.CR_REDACT_API_KEY, process.env.CR_REDACT_GITHUB_TOKEN].filter(Boolean);

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
          return (args, ...rest) => v.call(target, redactArgs(args, secrets), ...rest);
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
