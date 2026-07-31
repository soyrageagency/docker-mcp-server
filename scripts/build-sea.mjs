/**
 * Build a standalone `ragedocker` executable — no Node, no npm required to run.
 *
 * Uses Node's Single Executable Applications (SEA): we bundle the already-built
 * `dist/` into one CommonJS file with esbuild, embed the panel's static assets
 * and the update channel, generate the SEA blob, copy the running Node binary,
 * and inject the blob with postject. The result is a single file a user can
 * download and run.
 *
 * Usage:  node scripts/build-sea.mjs          (build for the current OS)
 *
 * Requires a prior `npm run build` (this script runs it for you).
 *
 * Crafted by SoyRage Agency — https://soyrage.es/
 */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "postject";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build");
const platform = process.platform;
const exeName = platform === "win32" ? "ragedocker.exe" : "ragedocker";

const log = (m) => process.stdout.write(`[sea] ${m}\n`);

/** Run a Node script (absolute paths, no shell — safe with spaces in paths). */
function node(args) {
  execFileSync(process.execPath, args, { stdio: "inherit", cwd: root });
}

async function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // 1) Ensure dist/ is fresh (dist has plain .js paths esbuild can resolve).
  log("building dist/ …");
  node([join(root, "node_modules/typescript/bin/tsc")]);
  node([join(root, "scripts/copy-public.mjs")]);

  // 2) Bundle dist/ragedocker.js → build/ragedocker.cjs (single CommonJS file).
  log("bundling with esbuild …");
  await build({
    entryPoints: [join(root, "dist/ragedocker.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: join(out, "ragedocker.cjs"),
    // docker-modem require()s ssh2 at load time; we never use SSH hosts, so map
    // it to an empty stub (the real module has a native addon that can't embed).
    alias: { ssh2: join(root, "scripts/sea-stub-ssh2.cjs") },
    // ws / ssh2 optional native speedups — left external. Their requires sit in
    // try/catch, so inside the binary they throw-and-fall-back to pure JS.
    external: ["cpu-features", "bufferutil", "utf-8-validate"],
    // Give import.meta.url a real value under CJS (used by fileURLToPath paths).
    banner: { js: "const __seaMetaUrl = require('url').pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "__seaMetaUrl" },
    logLevel: "warning",
  });

  // 3) Enumerate assets to embed: the panel SPA + the update channel.
  const assets = {};
  const publicDir = join(root, "src/panel/public");
  for (const name of readdirSync(publicDir)) {
    if (statSync(join(publicDir, name)).isFile()) assets[`public/${name}`] = join(publicDir, name);
  }
  assets["updates.json"] = join(root, "updates.json");

  const seaConfig = {
    main: join(out, "ragedocker.cjs"),
    output: join(out, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  };
  writeFileSync(join(out, "sea-config.json"), JSON.stringify(seaConfig, null, 2));

  // 4) Generate the SEA blob.
  log("generating SEA blob …");
  node(["--experimental-sea-config", join(out, "sea-config.json")]);

  // 5) Copy the Node binary and inject the blob with postject (programmatic API).
  const target = join(out, exeName);
  copyFileSync(process.execPath, target);
  log(`copied node → ${exeName}`);

  log("injecting blob with postject …");
  const blob = readFileSync(join(out, "sea-prep.blob"));
  await inject(target, "NODE_SEA_BLOB", blob, {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    machoSegmentName: platform === "darwin" ? "NODE_SEA" : undefined,
  });

  const size = (statSync(target).size / (1024 * 1024)).toFixed(1);
  log(`done → build/${exeName}  (${size} MB)`);
  log(`try it:  ./build/${exeName} version`);
}

main().catch((err) => {
  process.stderr.write(`[sea] FAILED: ${err?.stack || err}\n`);
  process.exit(1);
});
