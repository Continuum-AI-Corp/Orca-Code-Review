// Arrow-key prompts, written against the terminal directly.
//
// orcadub gets these from `huh`. This package has no dependencies and keeps it
// that way — `npx` downloads the whole tree before running anything, so a TUI
// library is latency every user pays to see one menu.
//
// Three things here are less obvious than they look:
//
//   * Redrawing in place needs an exact line count. A line wider than the
//     terminal wraps into two, the count goes wrong, and every subsequent
//     redraw eats a line of the user's scrollback. Everything is truncated to
//     the terminal width before it is written.
//   * Truncating has to measure DISPLAY width, not `.length`. The Chinese menu
//     labels are double-width, and ANSI colour sequences are zero-width.
//   * Raw mode must be released before anything else touches stdin — most of
//     all `gh secret set`, which is spawned with inherited stdio and prompts
//     for a credential.

import readline from "node:readline";

// Overridable so a test can assert Ctrl-C handling without killing the runner.
let onInterrupt = () => process.exit(130);
export function setInterruptHandler(fn) {
  const previous = onInterrupt;
  onInterrupt = fn;
  return () => { onInterrupt = previous; };
}

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_BELOW = `${ESC}[0J`;

// ------------------------------------------------------------------ width ---

// Every CSI sequence, not just colour. Cursor show/hide and erase sequences
// occupy no columns either, and a width that counted them would truncate a
// line that fits.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// East Asian Wide / Fullwidth. Enough for the Chinese strings this ships with;
// not a complete wcwidth, and it does not need to be.
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text).replace(ANSI, "")) {
    const cp = ch.codePointAt(0);
    // C0 controls — carriage return above all — move the cursor without
    // consuming a column. Counting them truncates lines that would have fit.
    if (cp < 0x20 || cp === 0x7f) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

const RESET = `${ESC}[0m`;
const ANSI_AT_START = /^\x1b\[[0-9;?]*[A-Za-z]/;

/**
 * Truncates to `max` display columns, ellipsis included in the budget.
 *
 * Escape sequences are copied through without being counted — cutting inside
 * one emits a fragment the terminal prints as garbage, and counting one as
 * five columns truncates a line that would have fit. A reset is appended when
 * the cut happened inside a coloured run, so the colour cannot bleed into the
 * rest of the screen.
 */
export function truncate(text, max) {
  const s = String(text);
  if (max <= 0) return "";
  if (displayWidth(s) <= max) return s;

  let out = "";
  let width = 0;
  let coloured = false;

  for (let i = 0; i < s.length; ) {
    const escape = ANSI_AT_START.exec(s.slice(i));
    if (escape) {
      out += escape[0];
      i += escape[0].length;
      coloured = escape[0] !== RESET;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    const w = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (width + w > max - 1) break;
    out += ch;
    width += w;
    i += ch.length;
  }

  return `${out}…${coloured ? RESET : ""}`;
}

// --------------------------------------------------------------- viewport ---

/**
 * The slice of a long list to show, keeping the cursor roughly centred and
 * never scrolling past either end.
 */
export function viewport(total, cursor, height) {
  if (height >= total) return { start: 0, end: total };
  const half = Math.floor(height / 2);
  const start = Math.max(0, Math.min(cursor - half, total - height));
  return { start, end: start + height };
}

/** Substring match over label and value, so `cod` finds both Codex and CodeBuddy. */
export function filterOptions(options, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => `${o.label} ${o.value ?? ""}`.toLowerCase().includes(q));
}

// ------------------------------------------------------------------ screen ---

export const canPrompt = () =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stdin.setRawMode);

// Streams are injected so the prompts can be driven by a test. Everything below
// touches `io`, never `process.stdin` / `process.stdout` directly.
const defaultIO = () => ({ input: process.stdin, output: process.stdout });

const columns = (out) => out.columns || 80;
const listHeight = (out) => Math.max(3, Math.min(12, (out.rows || 24) - 8));

class Screen {
  constructor(output) {
    this.output = output;
    this.lines = 0;
  }

  render(lines) {
    const width = columns(this.output) - 1;
    const body = lines.map((l) => truncate(l, width)).join("\n");
    const out = this.lines > 0 ? `${ESC}[${this.lines}A\r${CLEAR_BELOW}${body}\n` : `${body}\n`;
    this.output.write(out);
    this.lines = lines.length;
  }

  /**
   * Replaces the whole frame with a one-line summary.
   *
   * Without this every answered prompt stays fully expanded — five menus deep
   * and the screen is a wall of options the user already dismissed, with the
   * question they are actually on pushed off the top.
   */
  collapse(summary) {
    const rewind = this.lines > 0 ? `${ESC}[${this.lines}A\r${CLEAR_BELOW}` : "";
    // Truncated like any other line: a long question plus a long answer wraps,
    // and a wrapped summary is the one line the user actually reads afterwards.
    this.output.write(`${rewind}${truncate(summary, columns(this.output) - 1)}\n`);
    this.lines = 0;
  }
}

// Reads single keypresses until `handler` returns a non-undefined value.
// Always restores the terminal, including on Ctrl-C and on a thrown handler.
function readKeys(handler, { input, output }) {
  return new Promise((resolve, reject) => {
    const stdin = input;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    output.write(HIDE_CURSOR);

    const cleanup = () => {
      stdin.off("keypress", onKey);
      stdin.setRawMode?.(Boolean(wasRaw));
      stdin.pause();
      output.write(SHOW_CURSOR);
    };

    const onKey = (str, key = {}) => {
      // Ctrl-C inside raw mode does not raise SIGINT — nothing would stop the
      // process, and the terminal would be left with no cursor and no echo.
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        onInterrupt();
        // Reached only when a test replaces the handler; the real one exits.
        return reject(new Error("interrupted"));
      }
      try {
        const result = handler(str, key);
        if (result !== undefined) {
          cleanup();
          resolve(result);
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    };

    stdin.on("keypress", onKey);
  });
}

const isUp = (k) => k.name === "up" || k.name === "k" || (k.name === "p" && k.ctrl);
const isDown = (k) => k.name === "down" || k.name === "j" || (k.name === "n" && k.ctrl);

// ------------------------------------------------------------------ select ---

/**
 * Single choice. `options` is [{label, value, detail, recommended}].
 * ↑/↓ or j/k to move, 1-9 jumps, Enter confirms.
 */
export async function select(question, options, { defaultIndex = 0, theme, io = defaultIO() } = {}) {
  const t = theme;
  let cursor = Math.max(0, Math.min(defaultIndex, options.length - 1));
  const screen = new Screen(io.output);

  const draw = () => {
    const height = listHeight(io.output);
    const { start, end } = viewport(options.length, cursor, height);
    const lines = ["", t.bold(question)];

    if (start > 0) lines.push(t.dim(`     ↑ ${start} more`));
    for (let i = start; i < end; i++) {
      const o = options[i];
      const active = i === cursor;
      const marker = active ? t.cyan("❯") : " ";
      const label = active ? t.bold(o.label) : o.label;
      const tag = o.recommended ? t.dim(` ${t.recommended}`) : "";
      lines.push(`  ${marker} ${label}${tag}`);
      // Only the highlighted row explains itself; showing every detail at once
      // turns a five-item menu into a wall of text.
      if (active && o.detail) lines.push(`     ${t.dim(o.detail)}`);
    }
    if (end < options.length) lines.push(t.dim(`     ↓ ${options.length - end} more`));

    lines.push(t.dim(`     ${t.hintSelect}`));
    screen.render(lines);
  };

  draw();
  const chosen = await readKeys((str, key) => {
    if (isUp(key)) { cursor = (cursor - 1 + options.length) % options.length; draw(); return; }
    if (isDown(key)) { cursor = (cursor + 1) % options.length; draw(); return; }
    if (key.name === "home") { cursor = 0; draw(); return; }
    if (key.name === "end") { cursor = options.length - 1; draw(); return; }
    if (/^[1-9]$/.test(str ?? "")) {
      const n = Number(str) - 1;
      if (n < options.length) { cursor = n; draw(); }
      return;
    }
    if (key.name === "return" || key.name === "enter") return options[cursor].value;
    return undefined;
  }, io);

  screen.collapse(`${t.bold(question)}  ${t.cyan(options.find((o) => o.value === chosen).label)}`);
  return chosen;
}

// ------------------------------------------------------------- multiSelect ---

/**
 * Multiple choice. ↑/↓ to move, Space toggles, `a` all, `n` none,
 * `/` filters, Enter confirms.
 */
export async function multiSelect(question, options, { preselected = [], theme, io = defaultIO() } = {}) {
  const t = theme;
  const chosen = new Set(preselected);
  let query = "";
  let filtering = false;
  let cursor = 0;
  const screen = new Screen(io.output);

  const visible = () => filterOptions(options, query);

  const draw = () => {
    const list = visible();
    cursor = Math.max(0, Math.min(cursor, list.length - 1));
    const height = listHeight(io.output);
    const { start, end } = viewport(list.length, cursor, height);

    const lines = ["", t.bold(question)];
    if (filtering || query) lines.push(`     ${t.dim(t.hintFilterLabel)} ${query}${filtering ? t.cyan("▏") : ""}`);
    if (start > 0) lines.push(t.dim(`     ↑ ${start} more`));

    if (list.length === 0) lines.push(`     ${t.dim(t.hintNoMatch)}`);
    for (let i = start; i < end; i++) {
      const o = list[i];
      const active = i === cursor;
      const box = chosen.has(o.value) ? t.green("[x]") : t.dim("[ ]");
      const label = active ? t.bold(o.label) : o.label;
      const tag = o.detected ? t.green(`  ← ${t.detected}`) : "";
      lines.push(`  ${active ? t.cyan("❯") : " "} ${box} ${label}${tag}`);
    }

    if (end < list.length) lines.push(t.dim(`     ↓ ${list.length - end} more`));
    lines.push(t.dim(`     ${t.countSelected(chosen.size)} · ${filtering ? t.hintFiltering : t.hintMulti}`));
    screen.render(lines);
  };

  draw();
  const result = await readKeys((str, key) => {
    const list = visible();

    if (filtering) {
      // Ctrl-U rather than Esc. A lone ESC byte is indistinguishable from the
      // start of an escape sequence, so Node's decoder holds it until the next
      // key arrives — pressing Esc would appear to freeze the prompt. Esc is
      // still honoured on the rare occasion it does get delivered.
      if (key.name === "escape" || (key.ctrl && key.name === "u")) {
        filtering = false; query = ""; cursor = 0; draw(); return;
      }
      if (key.name === "return" || key.name === "enter") { filtering = false; draw(); return; }
      if (key.name === "backspace") {
        if (query === "") { filtering = false; draw(); return; }
        query = query.slice(0, -1); cursor = 0; draw(); return;
      }
      if (isUp(key) || isDown(key)) { filtering = false; draw(); return; }
      if (str && !key.ctrl && !key.meta && str >= " ") { query += str; cursor = 0; draw(); }
      return;
    }

    if (isUp(key)) { cursor = list.length ? (cursor - 1 + list.length) % list.length : 0; draw(); return; }
    if (isDown(key)) { cursor = list.length ? (cursor + 1) % list.length : 0; draw(); return; }
    if (key.name === "space") {
      const o = list[cursor];
      if (o) { chosen.has(o.value) ? chosen.delete(o.value) : chosen.add(o.value); draw(); }
      return;
    }
    if (str === "a") { for (const o of list) chosen.add(o.value); draw(); return; }
    if (str === "n") { for (const o of list) chosen.delete(o.value); draw(); return; }
    if (str === "/") { filtering = true; draw(); return; }
    if (query && (key.name === "escape" || (key.ctrl && key.name === "u"))) {
      query = ""; cursor = 0; draw(); return;
    }
    if (key.name === "return" || key.name === "enter") {
      // Confirming an empty set is almost always a mis-press, and it silently
      // does nothing at all. Make the user clear it deliberately with Ctrl-C.
      if (chosen.size === 0) return undefined;
      return options.filter((o) => chosen.has(o.value)).map((o) => o.value);
    }
    return undefined;
  }, io);

  const names = options.filter((o) => result.includes(o.value)).map((o) => o.label);
  screen.collapse(`${t.bold(question)}  ${t.cyan(names.join(", "))}`);
  return result;
}

// ----------------------------------------------------------------- confirm ---

/** Single keypress: y / n / Enter for the default. */
export async function confirm(question, defaultYes, { theme, io = defaultIO() } = {}) {
  const t = theme;
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  io.output.write(`${t.bold(question)} ${t.dim(suffix)} `);

  const answer = await readKeys((str, key) => {
    if (key.name === "return" || key.name === "enter") return defaultYes;
    const c = (str ?? "").toLowerCase();
    if (c === "y") return true;
    if (c === "n") return false;
    if (key.name === "escape") return false;
    return undefined;
  }, io);

  io.output.write(`${answer ? "yes" : "no"}\n`);
  return answer;
}
