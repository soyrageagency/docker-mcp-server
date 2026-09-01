/**
 * Is this module the one Node was launched with?
 *
 * Each entry point (`tui`, `panel`, the MCP server) doubles as both a standalone
 * binary and something the unified `ragedocker` launcher imports and calls. When
 * imported, its top-level auto-run must stay silent; when it *is* the process
 * entry, it should run. Comparing the module URL to `process.argv[1]` — resolved
 * to a file URL so the two are the same shape — tells them apart.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

import { pathToFileURL } from "node:url";
import { isPackaged } from "./assets.js";

/** True when `moduleUrl` (an `import.meta.url`) is Node's entry script. */
export function isEntryPoint(moduleUrl: string): boolean {
  // In the standalone binary every module shares one __filename, so this check
  // is meaningless — the `ragedocker` launcher is always the entry and drives
  // the run-functions itself, so the per-module auto-run guards must stay quiet.
  if (isPackaged()) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
