/**
 * Presentation helpers.
 *
 * Tools return human-readable text that an LLM can quote back to the user, so
 * these helpers turn raw Docker payloads into compact, aligned tables and
 * friendly units (bytes → "1.4 GB", uptime → "3 days ago").
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

/** Render a value as a human-readable byte size (SI-ish, base 1024). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, exponent);
  const decimals = exponent === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[exponent]}`;
}

/** Turn a Unix timestamp (seconds) into a relative "x ago" string. */
export function formatRelativeTime(unixSeconds: number): string {
  if (!unixSeconds) return "unknown";
  const deltaMs = Date.now() - unixSeconds * 1000;
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Truncate a string to `max` characters with an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Render a fixed-width, left-aligned ASCII table. Empty tables render a short
 * placeholder so the model gets a clear "nothing here" signal.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "(no results)";

  const widths = headers.map((header, columnIndex) =>
    Math.max(
      header.length,
      ...rows.map((row) => (row[columnIndex] ?? "").length),
    ),
  );

  const pad = (cells: string[]): string =>
    cells
      .map((cell, index) => (cell ?? "").padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  const separator = widths.map((width) => "-".repeat(width)).join("  ");

  return [pad(headers), separator, ...rows.map((row) => pad(row))].join("\n");
}

/** Pretty-print an object as fenced JSON for the model to read. */
export function asJsonBlock(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}
