#!/usr/bin/env node
/**
 * `ragedocker` — one command for the whole toolkit.
 *
 *   ragedocker            an arrow-key menu (great for first-timers)
 *   ragedocker tui        the lazydocker-style terminal dashboard
 *   ragedocker panel      the web panel + monitoring API
 *   ragedocker mcp        the Model Context Protocol server (for Claude Desktop, Cursor…)
 *   ragedocker ia …       sign in to Claude or ChatGPT (login · relogin · secundaria · use · list · test · logout)
 *   ragedocker doctor     check Docker, the AI, and the configuration
 *   ragedocker version    print the version
 *
 * Everything used to be a separate binary (`docker-mcp-tui`, `docker-mcp-panel`).
 * Those still work, but a single verb people can remember — and that the README
 * can teach in one line — is friendlier than three.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { color } from "./tui/ansi.js";
import { ASCII_BANNER, BRAND } from "./branding.js";

const say = (s = "") => process.stdout.write(s + "\n");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = (argv.find((a) => !a.startsWith("-")) || "menu").toLowerCase();
  const rest = argv.slice(argv.indexOf(command) + 1);

  switch (command) {
    case "tui":
    case "dashboard": {
      const { runTui } = await import("./tui/index.js");
      return runTui();
    }
    case "panel":
    case "web": {
      const { runPanel } = await import("./panel/index.js");
      return runPanel();
    }
    case "mcp":
    case "server": {
      const { runMcp } = await import("./index.js");
      return runMcp();
    }
    case "ia":
    case "ai": {
      const { runIa } = await import("./ai/login.js");
      return runIa(rest);
    }
    case "doctor":
    case "check":
      return doctor();
    case "version":
    case "--version":
    case "-v":
      say(`${BRAND.product} v${BRAND.version} — ${BRAND.author}`);
      return;
    case "menu":
      return menu();
    case "help":
    case "--help":
    case "-h":
    default:
      return printHelp();
  }
}

function printHelp(): void {
  say(`${color.accent(ASCII_BANNER)}`);
  say(`  ${color.bold(BRAND.product)} ${color.gray("v" + BRAND.version)} ${color.dim("· by " + BRAND.author)}`);
  say();
  say(`  ${color.bold("Usage:")} ${color.accent("ragedocker")} ${color.dim("<command>")}`);
  say();
  say(`    ${color.accent("tui")}            lazydocker-style terminal dashboard`);
  say(`    ${color.accent("panel")}          web panel + monitoring API`);
  say(`    ${color.accent("mcp")}            the MCP server (Claude Desktop, Cursor, Continue…)`);
  say(`    ${color.accent("ia")} ${color.dim("<sub>")}       AI login — ${color.dim("login · relogin · secundaria · use · list · test · logout")}`);
  say(`    ${color.accent("doctor")}         check Docker, the AI and the configuration`);
  say(`    ${color.accent("menu")}           interactive menu (default when run with no command)`);
  say(`    ${color.accent("version")}        print the version`);
  say();
  say(`  ${color.gray("Preview anything with no Docker daemon:")} ${color.bold("DOCKER_MCP_PANEL_DEMO=true ragedocker tui")}`);
  say(`  ${color.gray(BRAND.author)} ${color.dim("·")} ${color.brightBlue(BRAND.url)} ${color.dim("·")} ${color.yellow("★")} ${color.gray("star us")}`);
  say();
}

/** A tiny picker for people who'd rather not memorise verbs. */
async function menu(): Promise<void> {
  // Non-interactive (piped/CI) → just show help rather than hang.
  if (!process.stdin.isTTY) return printHelp();

  say(`${color.accent(ASCII_BANNER)}`);
  say(`  ${color.bold("What would you like to do?")} ${color.dim("(type a number, then Enter)")}`);
  say();
  const items: Array<{ label: string; run: () => Promise<void> | void }> = [
    { label: "Terminal dashboard (TUI)", run: async () => (await import("./tui/index.js")).runTui() },
    { label: "Web panel", run: async () => (await import("./panel/index.js")).runPanel() },
    { label: "Sign in to Claude / ChatGPT", run: async () => (await import("./ai/login.js")).runIa(["login"]) },
    { label: "Check my setup (doctor)", run: () => doctor() },
    { label: "Help", run: () => printHelp() },
  ];
  items.forEach((it, i) => say(`    ${color.accent(String(i + 1))}) ${it.label}`));
  say();

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`  ${color.bold("Choice")} [1-${items.length}]: `, resolve));
  rl.close();
  const choice = Number(answer.trim());
  const item = items[choice - 1] ?? items[items.length - 1];
  await item.run();
}

/** `ragedocker doctor` — is everything wired up? */
async function doctor(): Promise<void> {
  const { loadConfig } = await import("./config.js");
  const { Logger } = await import("./logger.js");
  const { DockerClient } = await import("./docker/client.js");
  const { activeAccount, loadCredentials } = await import("./ai/credentials.js");
  const { verify } = await import("./ai/provider.js");

  const config = loadConfig();
  const logger = new Logger("error");
  say();
  say(`  ${color.accent(color.bold("SOYRAGE"))} ${color.gray("▸")} ${color.bold(BRAND.product)} ${color.gray("· doctor")}`);
  say();

  // Docker.
  if (config.panel.demo) {
    say(`  ${color.yellow("◐")} Docker            ${color.dim("demo mode — the daemon is not contacted")}`);
  } else {
    try {
      const docker = new DockerClient(config, logger);
      await docker.ping();
      const v = await docker.version();
      say(`  ${color.green("✓")} Docker            ${color.dim("engine " + (v.Version ?? "?") + " reachable")}`);
    } catch (err) {
      say(`  ${color.red("✗")} Docker            ${color.dim((err as Error).message)}`);
      say(`     ${color.gray("Is Docker running? Set DOCKER_HOST if it's remote, or use")} ${color.bold("DOCKER_MCP_PANEL_DEMO=true")} ${color.gray("to preview.")}`);
    }
  }

  // Read-only / allowlist posture.
  say(`  ${color.gray("·")} Mode              ${config.readOnly ? color.yellow("read-only (actions disabled)") : color.dim("full read/write")}`);
  if (config.containerAllowlist.length) say(`  ${color.gray("·")} Allowlist         ${color.dim(config.containerAllowlist.join(", "))}`);

  // AI.
  const account = activeAccount();
  if (!account) {
    const cfg = loadCredentials();
    const configured = cfg.primary || cfg.secondary;
    say(`  ${color.yellow("◐")} AI                ${color.dim(configured ? "configured but no active account" : "not configured")}`);
    say(`     ${color.gray("Sign in with")} ${color.bold("ragedocker ia login")} ${color.gray("(Claude or ChatGPT).")}`);
  } else {
    say(`  ${color.gray("·")} AI                ${color.dim(account.label + " · " + account.model)}`);
    const check = await verify(account);
    say(check.ok
      ? `  ${color.green("✓")} AI reachable      ${color.dim(check.message)}`
      : `  ${color.red("✗")} AI                ${color.dim(check.message)}`);
  }

  // Panel bind.
  say(`  ${color.gray("·")} Panel             ${color.dim("http://" + config.panel.host + ":" + config.panel.port)}`);
  say();
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
