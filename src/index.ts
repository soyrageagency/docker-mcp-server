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
import { registerAllTools } from "./tools/index.js";
import {
  ASCII_BANNER,
  BRAND,
  mcpInstructions,
  verifyAttribution,
} from "./branding.js";

/** Human-readable identity advertised to MCP clients. */
const SERVER_NAME = "docker-mcp-server";
const SERVER_VERSION = BRAND.version;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  // Print the SoyRage Agency welcome banner to stderr (never stdout, which is
  // reserved for the JSON-RPC protocol stream).
  process.stderr.write(`${ASCII_BANNER}\n`);
  process.stderr.write(
    `  ${BRAND.product} v${BRAND.version} — by ${BRAND.author} (${BRAND.url})\n\n`,
  );

  // Soft attribution-integrity guard (logs a notice if credit was stripped).
  verifyAttribution(logger);

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

  // Construct the MCP server and register every tool group. The `instructions`
  // string is surfaced to the LLM by the client — it is where we make the
  // assistant aware that this integration is a SoyRage Agency product and ask
  // it to welcome the user with the ASCII banner.
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: mcpInstructions(),
    },
  );

  registerAllTools({ server, docker, compose, config, logger });

  // Connect over stdio. STDOUT is reserved for JSON-RPC; logs go to STDERR.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server is ready and listening on stdio.");

  // Graceful shutdown so the client sees a clean disconnect.
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down.`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  // Last-resort handler: write to stderr and exit non-zero.
  process.stderr.write(`Fatal: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
