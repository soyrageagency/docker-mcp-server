/**
 * Post-build asset copier.
 *
 * `tsc` only emits the TypeScript sources; the panel's static SPA assets live
 * under `src/panel/public`. This script copies them into `dist/panel/public`
 * so the built binary can serve them. Runs cross-platform (Node core only).
 *
 * Crafted by SoyRage Agency — https://soyrage.es/
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "src/panel/public");
const to = resolve(root, "dist/panel/public");

if (!existsSync(from)) {
  console.error(`[copy-public] Source not found: ${from}`);
  process.exit(1);
}

mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`[copy-public] Copied panel assets → ${to}`);
