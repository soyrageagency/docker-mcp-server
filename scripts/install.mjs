#!/usr/bin/env node
/**
 * One-command installer / configurator for beginners.
 *
 * Registers this Docker MCP Server in your AI client's config (Claude Desktop
 * by default) with the correct absolute path — no manual JSON editing. It
 * builds the project first if needed, backs up any existing config, and MERGES
 * the entry so your other MCP servers are preserved.
 *
 *   node scripts/install.mjs                 # configure Claude Desktop
 *   node scripts/install.mjs --client claude # (same)
 *   node scripts/install.mjs --print         # just print the JSON snippet
 *
 * Crafted by SoyRage Agency — https://soyrage.es/  ·  https://www.paypal.com/paypalme/soyrageagency
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "index.js");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  blue: "\x1b[38;5;39m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
};
const say = (s) => process.stdout.write(s + "\n");
const ok = (s) => say(`${c.green}✓${c.reset} ${s}`);
const warn = (s) => say(`${c.yellow}!${c.reset} ${s}`);

say("");
say(`${c.blue}${c.bold}  Docker MCP Server — installer${c.reset}  ${c.dim}by SoyRage Agency${c.reset}`);
say(`${c.dim}  https://soyrage.es/${c.reset}`);
say("");

// 1) Ensure the project is built.
if (!existsSync(DIST)) {
  warn("Build output not found — building now (npm install && npm run build)…");
  const npm = platform() === "win32" ? "npm.cmd" : "npm";
  if (!existsSync(join(ROOT, "node_modules"))) run(npm, ["install"]);
  run(npm, ["run", "build"]);
}
if (!existsSync(DIST)) fail("Build failed: dist/index.js is still missing.");
ok(`Server built at ${c.dim}${DIST}${c.reset}`);

// 2) The MCP server entry we want to install.
const entry = {
  command: "node",
  args: [DIST],
  env: {
    DOCKER_MCP_READONLY: "false",
    DOCKER_MCP_ALLOW_EXEC: "false",
    DOCKER_MCP_DEFAULT_LOG_TAIL: "200",
  },
};

if (has("--print")) {
  say("");
  say(JSON.stringify({ mcpServers: { docker: entry } }, null, 2));
  say("");
  process.exit(0);
}

// 3) Locate the Claude Desktop config for this OS.
const configPath = claudeConfigPath();
if (!configPath) fail("Unsupported platform for auto-config. Use --print and paste it manually.");
say(`${c.dim}Target config:${c.reset} ${configPath}`);

// 4) Merge & write (with a backup).
let config = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    warn("Existing config is not valid JSON; a fresh one will be written (old kept as .bak).");
  }
  copyFileSync(configPath, configPath + ".bak");
  ok(`Backed up existing config → ${c.dim}${configPath}.bak${c.reset}`);
} else {
  mkdirSync(dirname(configPath), { recursive: true });
  warn("No existing config found — creating a new one. (Is Claude Desktop installed?)");
}

config.mcpServers = config.mcpServers || {};
const existed = Boolean(config.mcpServers.docker);
config.mcpServers.docker = entry;
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
ok(`${existed ? "Updated" : "Added"} the "docker" MCP server in your Claude config.`);

// 5) Done — next steps + a friendly nudge.
say("");
say(`${c.green}${c.bold}  All set!${c.reset}`);
say(`  1. Fully ${c.bold}restart Claude Desktop${c.reset} (quit from the tray, not just the window).`);
say(`  2. Ask it: ${c.blue}"What Docker containers are running?"${c.reset}`);
say("");
say(`  ${c.dim}Optional visual dashboard:${c.reset} ${c.bold}npm run panel${c.reset}  →  http://127.0.0.1:4600`);
say(`  ${c.dim}Terminal UI:${c.reset}              ${c.bold}npm run tui${c.reset}`);
say("");
say(`  ${c.yellow}Enjoying it?${c.reset} Support development: ${c.blue}https://www.paypal.com/paypalme/soyrageagency${c.reset}`);
say(`  ${c.yellow}★${c.reset} And a star helps a lot: ${c.blue}https://github.com/soyrageagency/docker-mcp-server${c.reset}`);
say("");

// ---- helpers --------------------------------------------------------------

function claudeConfigPath() {
  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "linux":
      return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Claude", "claude_desktop_config.json");
    default:
      return null;
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) fail(`Command failed: ${cmd} ${args.join(" ")}`);
}

function fail(msg) {
  say(`${c.red}✗ ${msg}${c.reset}`);
  process.exit(1);
}
