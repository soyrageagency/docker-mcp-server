/**
 * Bundled-asset access — works the same whether we're running from `dist/` on a
 * machine with Node, or as a single-file standalone binary (Node SEA) with no
 * Node installed at all.
 *
 * When packaged, the panel's static files and the update channel are baked into
 * the executable and read from the SEA blob; otherwise they're read from disk.
 * Callers pass both an asset key and the on-disk path, and get back whichever is
 * available — so the same code path serves both builds.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type SeaApi = { isSea(): boolean; getRawAsset(key: string): ArrayBuffer };

let seaMod: SeaApi | null = null;
try {
  // `node:sea` exists on modern Node; isSea() is false unless we're a binary.
  const require = createRequire(import.meta.url);
  seaMod = require("node:sea") as SeaApi;
} catch {
  seaMod = null;
}

/** True when running as an injected single-file executable. */
export function isPackaged(): boolean {
  try {
    return Boolean(seaMod?.isSea());
  } catch {
    return false;
  }
}

/** Read a bundled asset as a Buffer: from the SEA blob when packaged, else disk. */
export function readAssetBuffer(key: string, diskPath: string): Buffer {
  if (seaMod && isPackaged()) {
    try {
      return Buffer.from(seaMod.getRawAsset(key));
    } catch {
      /* fall through to disk */
    }
  }
  return readFileSync(diskPath);
}

/** Read a bundled asset as UTF-8 text. Returns null if it can't be read. */
export function readAssetText(key: string, diskPath: string): string | null {
  try {
    return readAssetBuffer(key, diskPath).toString("utf8");
  } catch {
    return null;
  }
}
