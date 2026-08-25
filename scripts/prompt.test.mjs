// Tests for the arrow-key prompts, driven by real keypress events.
//
// The streams are injected, so these push actual escape sequences ("\x1b[B" is
// Down) into a fake stdin and read what gets drawn. That matters: a TUI is the
// one surface where "it looked right when I tried it" is the only check most
// projects ever get, and this package has already shipped two bugs that every
// green test missed.

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  displayWidth,
  truncate,
  viewport,
  filterOptions,
  select,
  multiSelect,
  confirm,
  setInterruptHandler,
} from "../bin/prompt.mjs";

// A plain theme: no colour, so assertions read as plain text.
const THEME = {
  bold: (s) => s,
  dim: (s) => s,
  cyan: (s) => s,
  green: (s) => s,
  recommended: "(recommended)",
  detected: "detected",
  hintSelect: "↑↓ move · Enter select",
  hintMulti: "space toggle · Enter confirm",
  hintFilterLabel: "filter:",
  hintNoMatch: "no match",
  countSelected: (n) => `${n} selected`,
};

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  space: " ",
  esc: "\x1b",
  backspace: "\x7f",
  ctrlU: "\x15",
  ctrlC: "\x03",
};

// Builds an injectable io pair and a `press` that feeds keys one at a time,
// yielding to the event loop between each so the prompt can redraw.
function harness({ columns = 80, rows = 24 } = {}) {
  const input = new PassThrough();
  input.setRawMode = () => {};
  input.isTTY = true;

  const output = new PassThrough();
  output.columns = columns;
  output.rows = rows;
  let written = "";
  output.on("data", (chunk) => { written += chunk.toString(); });

  const press = async (...keys) => {
    for (const k of keys) {
      input.write(k);
      await new Promise((r) => setImmediate(r));
    }
  };

  // `frame()` is the list as it stands right now — call it BEFORE the final
  // Enter, since answering collapses the frame to a one-line summary.
  return { io: { input, output }, press, frames: () => written, frame: () => lastFrame(written) };
}

// The last frame drawn — everything after the final cursor-up.
const lastFrame = (text) => text.split(/\x1b\[\d+A/).pop();

// ------------------------------------------------------------------- width ---

test("display width counts CJK as two columns and ANSI as zero", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("\x1b[?25habc"), 3); // cursor sequences are zero-width too
  assert.equal(displayWidth("\x1b[0Jabc"), 3);
  assert.equal(displayWidth("\rabc"), 3); // carriage return consumes no column
  assert.equal(displayWidth("安装"), 4);
  assert.equal(displayWidth("\x1b[1mabc\x1b[0m"), 3);
  assert.equal(displayWidth("修改配置 x"), 10);
});

test("truncate fits the budget including the ellipsis", () => {
  assert.equal(truncate("abcdef", 10), "abcdef");
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.ok(displayWidth(truncate("安装配置选项", 7)) <= 7);
});

test("truncate never cuts inside an escape sequence", () => {
  // Cutting mid-sequence emits a fragment the terminal prints as garbage.
  const coloured = `\x1b[32m${"x".repeat(40)}\x1b[0m`;
  const cut = truncate(coloured, 10);
  for (const fragment of cut.split("\x1b[")) {
    if (fragment === "") continue;
    assert.match(fragment, /^[0-9;]*m/, `broken escape sequence in: ${JSON.stringify(cut)}`);
  }
});

test("truncate closes a colour it cut into", () => {
  // Otherwise the colour bleeds into the rest of the screen.
  const cut = truncate(`\x1b[32m${"x".repeat(40)}\x1b[0m`, 10);
  assert.ok(cut.endsWith("\x1b[0m"), `no reset: ${JSON.stringify(cut)}`);
});

test("a line of pure escape codes is not truncated", () => {
  const codes = "\x1b[32m\x1b[1m\x1b[0m";
  assert.equal(truncate(codes, 2), codes);
});

// ---------------------------------------------------------------- viewport ---

test("a list shorter than the window is shown whole", () => {
  assert.deepEqual(viewport(5, 0, 12), { start: 0, end: 5 });
});

test("the window follows the cursor without running off either end", () => {
  assert.deepEqual(viewport(36, 0, 10), { start: 0, end: 10 });
  assert.deepEqual(viewport(36, 35, 10), { start: 26, end: 36 });
  assert.deepEqual(viewport(36, 20, 10), { start: 15, end: 25 });
});

test("the window is always exactly the requested height", () => {
  for (let cursor = 0; cursor < 36; cursor++) {
    const { start, end } = viewport(36, cursor, 10);
    assert.equal(end - start, 10, `cursor ${cursor}`);
    assert.ok(cursor >= start && cursor < end, `cursor ${cursor} outside window`);
  }
});

// ------------------------------------------------------------------ filter ---

const PLATFORMS = [
  { label: "Claude Code", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "CodeBuddy Code", value: "codebuddy" },
  { label: "Cursor", value: "cursor" },
];

test("filtering matches label and value, case-insensitively", () => {
  // "cod" hits Claude too, via "Claude **Cod**e" — substring, not prefix.
  assert.deepEqual(filterOptions(PLATFORMS, "cod").map((o) => o.value), ["claude", "codex", "codebuddy"]);
  assert.deepEqual(filterOptions(PLATFORMS, "codex").map((o) => o.value), ["codex"]);
  assert.deepEqual(filterOptions(PLATFORMS, "CURSOR").map((o) => o.value), ["cursor"]);
  assert.equal(filterOptions(PLATFORMS, "").length, 4);
  assert.equal(filterOptions(PLATFORMS, "zzz").length, 0);
});

// ------------------------------------------------------------------ select ---

const OPTIONS = [
  { label: "Install", value: "init", recommended: true, detail: "writes the workflow" },
  { label: "Reconfigure", value: "reconfigure" },
  { label: "Doctor", value: "doctor" },
];

test("Enter takes the default without moving", async () => {
  const { io, press } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  await press(KEY.enter);
  assert.equal(await answer, "init");
});

test("Down then Enter takes the next option", async () => {
  const { io, press } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  await press(KEY.down, KEY.enter);
  assert.equal(await answer, "reconfigure");
});

test("Up from the first option wraps to the last", async () => {
  const { io, press } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  await press(KEY.up, KEY.enter);
  assert.equal(await answer, "doctor");
});

test("j and k move like the arrow keys", async () => {
  const { io, press } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  await press("j", "j", "k", KEY.enter);
  assert.equal(await answer, "reconfigure");
});

test("a number key jumps straight to that option", async () => {
  const { io, press } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  await press("3", KEY.enter);
  assert.equal(await answer, "doctor");
});

test("defaultIndex decides where the cursor starts", async () => {
  const { io, press } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io, defaultIndex: 2 });
  await press(KEY.enter);
  assert.equal(await answer, "doctor");
});

test("only the highlighted row shows its detail", async () => {
  const { io, press, frame } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  const shown = frame();
  assert.match(shown, /writes the workflow/);
  assert.equal(shown.match(/writes the workflow/g).length, 1);
  await press(KEY.enter);
  await answer;
});

test("a long list scrolls and reports what is off-screen", async () => {
  const many = Array.from({ length: 36 }, (_, i) => ({ label: `Item ${i}`, value: `i${i}` }));
  const { io, press, frames, frame } = harness({ rows: 20 }); // window of 12
  const answer = select("Pick", many, { theme: THEME, io });
  await press(KEY.up); // wraps to the last item
  assert.match(frames().split(/\x1b\[\d+A/).pop(), /↑ \d+ more/);
  await press(KEY.enter);
  assert.equal(await answer, "i35");
});

test("every redraw rewinds exactly as many lines as it wrote", async () => {
  // Get this wrong and each redraw eats a line of the user's scrollback.
  const { io, press, frames } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  await press(KEY.down, KEY.down, KEY.enter);
  await answer;

  const chunks = frames().split(/(?=\x1b\[\d+A)/);
  for (const chunk of chunks.slice(1)) {
    const claimed = Number(/^\x1b\[(\d+)A/.exec(chunk)[1]);
    const previous = chunks[chunks.indexOf(chunk) - 1];
    const drawn = previous.replace(/^\x1b\[\d+A\r\x1b\[0J/, "").split("\n").length - 1;
    assert.equal(claimed, drawn, "rewind does not match the previous frame's line count");
  }
});

test("no line is ever wider than the terminal", async () => {
  // A wrapped line breaks the line count, and every later redraw drifts.
  const wide = [{ label: "x".repeat(200), value: "a" }, { label: "y".repeat(200), value: "b" }];
  const { io, press, frames } = harness({ columns: 40 });
  const answer = select("Pick", wide, { theme: THEME, io });
  await press(KEY.down, KEY.enter);
  await answer;
  for (const line of frames().replace(/\x1b\[[\d;?]*[A-Za-z]/g, "").split("\n")) {
    assert.ok(displayWidth(line) < 40, `line is ${displayWidth(line)} columns: ${line.slice(0, 50)}`);
  }
});

// ------------------------------------------------------------- multiSelect ---

test("preselected values come back when Enter is pressed immediately", async () => {
  const { io, press } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { preselected: ["claude", "codex"], theme: THEME, io });
  await press(KEY.enter);
  assert.deepEqual(await answer, ["claude", "codex"]);
});

test("space toggles the highlighted row on and off", async () => {
  const { io, press } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { theme: THEME, io });
  await press(KEY.space, KEY.down, KEY.space, KEY.enter);
  assert.deepEqual(await answer, ["claude", "codex"]);

  const second = harness();
  const answer2 = multiSelect("Which?", PLATFORMS, { preselected: ["claude"], theme: THEME, io: second.io });
  await second.press(KEY.space, KEY.down, KEY.space, KEY.enter);
  assert.deepEqual(await answer2, ["codex"]);
});

test("results come back in catalog order, not the order they were clicked", async () => {
  const { io, press } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { theme: THEME, io });
  await press(KEY.down, KEY.down, KEY.down, KEY.space); // cursor
  await press(KEY.up, KEY.up, KEY.up, KEY.space); // claude
  await press(KEY.enter);
  assert.deepEqual(await answer, ["claude", "cursor"]);
});

test("`a` selects everything and `n` clears it", async () => {
  const { io, press } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { theme: THEME, io });
  await press("a");
  await press("n");
  await press("a", KEY.enter);
  assert.deepEqual(await answer, PLATFORMS.map((o) => o.value));
});

test("Enter on an empty selection does nothing", async () => {
  // Confirming nothing is almost always a mis-press, and it silently no-ops.
  const { io, press } = harness();
  let settled = false;
  const answer = multiSelect("Which?", PLATFORMS, { theme: THEME, io }).then((v) => { settled = true; return v; });
  await press(KEY.enter, KEY.enter);
  assert.equal(settled, false, "an empty selection was accepted");
  await press(KEY.space, KEY.enter);
  assert.deepEqual(await answer, ["claude"]);
});

test("/ filters, and selection survives clearing the filter", async () => {
  const { io, press } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { theme: THEME, io });
  await press("/", "c", "u", "r"); // narrows to Cursor
  await press(KEY.enter); // leaves filter entry, keeps the query
  await press(KEY.space); // ticks Cursor
  await press(KEY.ctrlU); // clears the filter
  await press(KEY.enter);
  assert.deepEqual(await answer, ["cursor"]);
});

test("backspace widens the filter again", async () => {
  const { io, press, frame } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { theme: THEME, io });
  await press("/", "c", "o", "d", "e", "x");
  await press(KEY.backspace, KEY.backspace); // back to "cod"
  await press(KEY.enter); // apply — "cod" matches claude, codex, codebuddy
  assert.match(frame(), /CodeBuddy/);
  await press(KEY.space, KEY.enter); // first match is Claude Code
  assert.deepEqual(await answer, ["claude"]);
});

test("a filter matching nothing says so instead of drawing an empty box", async () => {
  const { io, press, frame } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { preselected: ["claude"], theme: THEME, io });
  await press("/", "z", "z", "z");
  assert.match(frame(), /no match/);
  await press(KEY.ctrlU); // ctrl-u, not Esc — see the test below
  await press(KEY.enter);
  assert.deepEqual(await answer, ["claude"]);
});

test("the running count is shown", async () => {
  const { io, press, frame } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { preselected: ["claude", "codex"], theme: THEME, io });
  assert.match(frame(), /2 selected/);
  await press(KEY.enter);
  await answer;
});

// ----------------------------------------------------------------- confirm ---

test("Enter takes the default, either way round", async () => {
  const yes = harness();
  const a = confirm("Write it?", true, { theme: THEME, io: yes.io });
  await yes.press(KEY.enter);
  assert.equal(await a, true);

  const no = harness();
  const b = confirm("Delete it?", false, { theme: THEME, io: no.io });
  await no.press(KEY.enter);
  assert.equal(await b, false);
});

test("y and n answer directly, in either case", async () => {
  for (const [key, expected] of [["y", true], ["n", false], ["Y", true], ["N", false]]) {
    const { io, press } = harness();
    const answer = confirm("Sure?", false, { theme: THEME, io });
    await press(key);
    assert.equal(await answer, expected, `key ${key}`);
  }
});

test("a key that means nothing is ignored rather than taken as no", async () => {
  const { io, press } = harness();
  const answer = confirm("Sure?", true, { theme: THEME, io });
  await press("q", "z", "y");
  assert.equal(await answer, true);
});

// -------------------------------------------------------------- interrupts ---

test("Ctrl-C restores the cursor before leaving", async () => {
  // Raw mode swallows SIGINT, so an unhandled Ctrl-C would leave the terminal
  // with no cursor and no echo — the user has to type `reset` blind.
  let interrupted = false;
  const restore = setInterruptHandler(() => { interrupted = true; });
  try {
    const { io, press, frames } = harness();
    const answer = select("What now?", OPTIONS, { theme: THEME, io }).catch(() => "interrupted");
    await press(KEY.ctrlC);
    assert.equal(await answer, "interrupted");
    assert.equal(interrupted, true);
    assert.ok(frames().includes("\x1b[?25h"), "cursor was never shown again");
  } finally {
    restore();
  }
});

test("raw mode is released when a prompt finishes", async () => {
  // `gh secret set` runs with inherited stdio right after a prompt. Leaving raw
  // mode on means it cannot read the credential the user types.
  const { io, press } = harness();
  const states = [];
  io.input.setRawMode = (on) => states.push(on);
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  await press(KEY.enter);
  await answer;
  assert.deepEqual(states, [true, false]);
});

test("backspacing an empty filter leaves filter mode", async () => {
  const { io, press } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { theme: THEME, io });
  await press("/", "c");
  await press(KEY.backspace); // query now empty, still filtering
  await press(KEY.backspace); // exits filter mode
  await press(KEY.space, KEY.enter); // space toggles again instead of typing
  assert.deepEqual(await answer, ["claude"]);
});

test("ctrl-u clears the filter, because Esc alone cannot be relied on", async () => {
  // A lone ESC byte is the start of every escape sequence, so Node's decoder
  // holds it until the next key arrives. Binding "clear the filter" to Esc
  // makes the prompt look frozen the moment a user presses it.
  const { io, press } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { theme: THEME, io });
  await press("/", "c", "u", "r");
  await press(KEY.ctrlU);
  await press(KEY.space, KEY.enter); // full list again -> first row is Claude
  assert.deepEqual(await answer, ["claude"]);
});

test("a lone Esc emits no keypress at all", async () => {
  // Pins the reason ctrl-u exists. If a future Node makes Esc self-delivering
  // this fails, and the ctrl-u workaround can be revisited.
  const { io, press } = harness();
  let keys = 0;
  const answer = multiSelect("Which?", PLATFORMS, { preselected: ["claude"], theme: THEME, io });
  io.input.on("keypress", () => { keys += 1; });
  await press(KEY.esc);
  assert.equal(keys, 0, "Esc was delivered on its own — reconsider the ctrl-u binding");
  await press(KEY.enter);
  assert.deepEqual(await answer, ["claude"]);
});

// ---------------------------------------------------------------- collapse ---

test("answering a prompt replaces the list with one summary line", async () => {
  // Five prompts deep, leaving each expanded buries the question the user is
  // actually on under a wall of options they already dismissed.
  const { io, press, frame } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  assert.match(frame(), /Reconfigure/, "the list should be on screen while choosing");
  await press(KEY.down, KEY.enter);
  await answer;

  const summary = frame();
  assert.match(summary, /What now\?/);
  assert.match(summary, /Reconfigure/);
  assert.doesNotMatch(summary, /Doctor/, "unchosen options survived the collapse");
  assert.doesNotMatch(summary, /↑↓/, "the key hint survived the collapse");
  assert.equal(summary.split("\n").filter(Boolean).length, 1);
});

test("a multi-select collapses to the chosen names", async () => {
  const { io, press, frame } = harness();
  const answer = multiSelect("Which?", PLATFORMS, { preselected: ["claude", "cursor"], theme: THEME, io });
  await press(KEY.enter);
  await answer;

  const summary = frame();
  assert.match(summary, /Claude Code, Cursor/);
  assert.doesNotMatch(summary, /\[ \]/, "unticked rows survived the collapse");
  assert.equal(summary.split("\n").filter(Boolean).length, 1);
});

test("the collapse rewinds exactly the frame it is replacing", async () => {
  // Off by one here and the summary overwrites a line of real output above it.
  const { io, press, frames } = harness();
  const answer = select("What now?", OPTIONS, { theme: THEME, io });
  await press(KEY.enter);
  await answer;

  const chunks = frames().split(/(?=\x1b\[\d+A)/);
  const last = chunks.at(-1);
  const claimed = Number(/^\x1b\[(\d+)A/.exec(last)[1]);
  const previous = chunks.at(-2);
  const drawn = previous.replace(/^\x1b\[\d+A\r\x1b\[0J/, "").split("\n").length - 1;
  assert.equal(claimed, drawn);
});
