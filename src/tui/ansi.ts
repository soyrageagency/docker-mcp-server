/**
 * ANSI terminal helpers.
 *
 * A tiny, dependency-free toolkit for the terminal UI: colours, cursor control
 * and width-aware padding/truncation that accounts for invisible escape codes
 * so columns line up perfectly.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

const ESC = "\x1b[";

/** Raw control sequences. */
export const ctl = {
  enterAlt: `${ESC}?1049h`,
  exitAlt: `${ESC}?1049l`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  clear: `${ESC}2J`,
  home: `${ESC}H`,
  clearLine: `${ESC}K`,
  clearBelow: `${ESC}J`,
};

/** Move the cursor to a 1-based (row, col). */
export function moveTo(row: number, col: number): string {
  return `${ESC}${row};${col}H`;
}

/** SGR colour wrappers. */
const sgr = (code: number) => (s: string) => `${ESC}${code}m${s}${ESC}0m`;

export const color = {
  reset: `${ESC}0m`,
  dim: sgr(2),
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  black: sgr(30),
  red: sgr(31),
  green: sgr(32),
  yellow: sgr(33),
  blue: sgr(34),
  magenta: sgr(35),
  cyan: sgr(36),
  white: sgr(37),
  gray: sgr(90),
  brightBlue: sgr(94),
  brightCyan: sgr(96),
  /** SoyRage accent (256-colour blue). */
  accent: (s: string) => `${ESC}38;5;39m${s}${ESC}0m`,
  /** Inverse video for selection highlight. */
  invert: (s: string) => `${ESC}7m${s}${ESC}27m`,
  /** Background helpers. */
  bgAccent: (s: string) => `${ESC}48;5;24m${s}${ESC}0m`,
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escapes to measure the visible length of a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Visible length (ignoring escape codes). */
export function visLen(s: string): number {
  return stripAnsi(s).length;
}

/** Truncate to a visible width, preserving trailing reset. */
export function truncate(s: string, width: number): string {
  if (visLen(s) <= width) return s;
  // Walk characters, counting only visible ones, keeping escapes intact.
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < width - 1) {
    if (s[i] === "\x1b") {
      const match = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += s[i];
    visible += 1;
    i += 1;
  }
  return `${out}…${color.reset}`;
}

/** Pad a string on the right to a visible width. */
export function padEnd(s: string, width: number): string {
  const len = visLen(s);
  return len >= width ? truncate(s, width) : s + " ".repeat(width - len);
}

/** Pad a string on the left to a visible width. */
export function padStart(s: string, width: number): string {
  const len = visLen(s);
  return len >= width ? truncate(s, width) : " ".repeat(width - len) + s;
}

/** Centre a string within a visible width. */
export function center(s: string, width: number): string {
  const len = visLen(s);
  if (len >= width) return truncate(s, width);
  const left = Math.floor((width - len) / 2);
  return " ".repeat(left) + s + " ".repeat(width - len - left);
}

/**
 * Render a horizontal usage bar of the given inner width, coloured by level.
 * Example: `[██████░░░░]`.
 */
export function bar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const fill = "█".repeat(filled);
  const rest = "░".repeat(Math.max(0, width - filled));
  const paint =
    clamped >= 80 ? color.red : clamped >= 50 ? color.yellow : color.green;
  return `${paint(fill)}${color.gray(rest)}`;
}
