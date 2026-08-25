// The ORCA CODE REVIEW wordmark, in the shape orcadub uses for ORCADUB:
// block glyphs, horizontally scaled so the letters read square in a terminal
// (cells are about twice as tall as they are wide), with a blue-to-cyan
// gradient down the block.
//
// Two lines rather than one. "ORCA CODE REVIEW" on a single line is 16 glyph
// slots — about 150 columns at this scale, which is wider than any default
// terminal. Split as ORCA CODE / REVIEW it fits in 76.
//
// Glyphs are variable width: V and W need five columns to be legible, I needs
// three. Only the rows within one glyph have to agree.

const SCALE = 2; // horizontal only — vertical scaling would make it 10 rows tall
const GAP = 1; // columns between glyphs, before scaling is applied
const BLUE = "[94m";
const CYAN = "[96m";
const RESET = "[0m";

const GLYPHS = {
  O: ["████", "█  █", "█  █", "█  █", "████"],
  R: ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
  C: ["████", "█   ", "█   ", "█   ", "████"],
  A: [" ██ ", "█  █", "████", "█  █", "█  █"],
  D: ["███ ", "█  █", "█  █", "█  █", "███ "],
  E: ["████", "█   ", "███ ", "█   ", "████"],
  V: ["█   █", "█   █", "█   █", " █ █ ", "  █  "],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  W: ["█   █", "█   █", "█ █ █", "██ ██", "█   █"],
  " ": ["  ", "  ", "  ", "  ", "  "],
};

const ROWS = 5;
const LINES = ["ORCA CODE", "REVIEW"];

function renderLine(word) {
  const rows = [];
  for (let row = 0; row < ROWS; row++) {
    let out = "";
    for (const [index, letter] of [...word].entries()) {
      if (index > 0) out += " ".repeat(GAP);
      for (const cell of GLYPHS[letter][row]) out += cell.repeat(SCALE);
    }
    rows.push(out);
  }
  return rows;
}

/** The wordmark as an array of lines. `color` adds the gradient. */
export function bannerRows(color = true) {
  const blocks = LINES.map(renderLine);
  const width = Math.max(...blocks.map((b) => b[0].length));
  const total = blocks.reduce((n, b) => n + b.length, 0);

  const rows = [];
  for (const block of blocks) {
    // Center the shorter line under the longer one, or the wordmark reads as
    // two unrelated words that happen to be stacked.
    const pad = " ".repeat(Math.floor((width - block[0].length) / 2));
    for (const row of block) {
      const line = pad + row;
      rows.push(color ? `${rows.length < total / 2 ? BLUE : CYAN}${line}${RESET}` : line);
    }
  }
  return rows;
}

export function bannerWidth() {
  return Math.max(...LINES.map((w) => renderLine(w)[0].length));
}

/**
 * Prints the wordmark, or a one-line title when the terminal is too narrow.
 * A wrapped wordmark is worse than no wordmark — it reads as corruption.
 */
export function renderBanner(write, { color = true, columns = process.stdout.columns } = {}) {
  if (columns && columns < bannerWidth()) {
    write(`${color ? BLUE : ""}Orca Code Review${color ? RESET : ""}\n`);
    return;
  }
  for (const row of bannerRows(color)) write(`${row}\n`);
}
