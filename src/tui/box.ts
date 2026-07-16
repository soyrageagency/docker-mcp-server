/**
 * Rounded box renderer for the TUI.
 *
 * Draws a titled, bordered box of a fixed width/height and fits content lines
 * inside it, padding/truncating each to the inner width. Returns an array of
 * exactly `height` strings so panels can be composed side by side.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { color, padEnd, truncate, visLen } from "./ansi.js";

/**
 * @param title   Box title, drawn into the top border.
 * @param content Content lines (may contain ANSI).
 * @param width   Total box width including borders.
 * @param height  Total box height including borders (>= 2).
 */
export function drawBox(
  title: string,
  content: string[],
  width: number,
  height: number,
): string[] {
  const inner = Math.max(1, width - 2);
  const bodyHeight = Math.max(0, height - 2);

  // Top border with an embedded title: ╭─ Title ─────╮
  const label = ` ${title} `;
  const labelLen = visLen(label);
  const dashes = Math.max(0, inner - labelLen - 1);
  const top =
    color.gray("╭─") +
    color.accent(label) +
    color.gray("─".repeat(dashes) + "╮");

  const lines: string[] = [top];
  for (let i = 0; i < bodyHeight; i++) {
    const raw = content[i] ?? "";
    const cell = padEnd(truncate(raw, inner), inner);
    lines.push(`${color.gray("│")}${cell}${color.gray("│")}`);
  }
  lines.push(color.gray("╰" + "─".repeat(inner) + "╯"));
  return lines;
}
