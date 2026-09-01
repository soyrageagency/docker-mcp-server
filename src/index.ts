#!/usr/bin/env node
/**
 * Docker MCP Server — entry point.
 *
 * Boots a Model Context Protocol server over stdio that lets any MCP-capable
 * LLM (Claude Desktop, Cursor, Continue, …) manage a Docker host in natural
 * language: list containers, tail logs, restart services and deploy Compose
 * stacks — with built-in read-only and allowlist safety rails.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { DockerClient } from "./docker/client.js";
import { ComposeDriver } from "./docker/compose.js";
import { BUILTIN_PLUGINS, selectPlugins } from "./plugins.js";
import type { PluginInfo } from "./tools/context.js";
import { isEntryPoint } from "./entry.js";
import { startHttpTransport } from "./transport/http.js";
import { ASCII_BANNER, BRAND, mcpInstructions } from "./branding.js";

/** Human-readable identity advertised to MCP clients. */
const SERVER_NAME = "docker-mcp-server";
const SERVER_VERSION = BRAND.version;

export async function runMcp(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  // Print the welcome banner to stderr (never stdout, which is reserved for
  // the JSON-RPC protocol stream).
  process.stderr.write(`${ASCII_BANNER}\n`);
  process.stderr.write(
    `  ${BRAND.product} v${BRAND.version} — by ${BRAND.author} (${BRAND.url})\n\n`,
  );

  logger.info(`Starting ${SERVER_NAME} v${SERVER_VERSION}`);
  logger.debug("Configuration", {
    dockerHost: config.dockerHost || "(platform default)",
    readOnly: config.readOnly,
    allowExec: config.allowExec,
    allowlist: config.containerAllowlist,
  });

  // Build collaborators.
  const docker = new DockerClient(config, logger);
  const compose = new ComposeDriver(config, logger);

  // Fail fast (with a helpful hint) if the daemon is unreachable.
  try {
    await docker.ping();
    logger.info("Connected to the Docker daemon.");
  } catch (error) {
    logger.error(
      "Could not reach the Docker daemon. Is Docker running and is DOCKER_HOST correct?",
      error,
    );
    // We still start the server: individual tool calls will return a clean
    // error, which is friendlier inside a chat client than a hard crash.
  }

  // Resolve the modular plugin selection from configuration, then register
  // each enabled plugin. The full catalogue (with per-plugin enabled state) is
  // handed to tools via the context so `list_plugins` can report it.
  const selected = selectPlugins(config, logger);
  const enabledNames = new Set(selected.map((p) => p.name));
  const pluginInfo: PluginInfo[] = BUILTIN_PLUGINS.map((p) => ({
    name: p.name,
    title: p.title,
    category: p.category,
    mutating: p.mutating,
    enabled: enabledNames.has(p.name),
  }));

  /**
   * Build a fully wired server. Over HTTP this is called once per session, so
   * it must not share mutable state between calls.
   */
  const createMcpServer = (): McpServer => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: mcpInstructions() },
    );
    const context = { server, docker, compose, config, logger, plugins: pluginInfo };
    for (const plugin of selected) plugin.register(context);
    return server;
  };

  logger.info(
    config.readOnly
      ? "Tools registered in READ-ONLY mode."
      : "Tools registered in full read/write mode.",
  );

  // Over the network, or over stdio (STDOUT is the JSON-RPC stream; logs go
  // to STDERR).
  let stop: () => Promise<void>;
  if (config.http.enabled) {
    stop = await startHttpTransport(config.http, createMcpServer, logger);
  } else {
    const server = createMcpServer();
    await server.connect(new StdioServerTransport());
    logger.info("MCP server is ready and listening on stdio.");
    stop = () => server.close();
  }

  // Graceful shutdown so the client sees a clean disconnect.
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down.`);
    void stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (isEntryPoint(import.meta.url)) {
  runMcp().catch((error) => {
    // Last-resort handler: write to stderr and exit non-zero.
    process.stderr.write(`Fatal: ${error instanceof Error ? error.stack : error}\n`);
    process.exit(1);
  });
}
