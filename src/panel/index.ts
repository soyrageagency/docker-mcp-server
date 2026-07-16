#!/usr/bin/env node
/**
 * Interactive panel — entry point.
 *
 * A separate binary (`docker-mcp-panel`) that launches the minimalist web
 * dashboard. It reuses the exact same configuration, Docker client and safety
 * rails as the MCP server, so read-only mode and the allowlist apply here too.
 *
 * Run in demo mode to preview it without a daemon:
 *   DOCKER_MCP_PANEL_DEMO=true npm run panel
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { loadConfig } from "../config.js";
import { Logger } from "../logger.js";
import { DockerClient } from "../docker/client.js";
import { PanelService } from "./service.js";
import { startPanel } from "./server.js";
import { ASCII_BANNER, BRAND, verifyAttribution } from "../branding.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel, "panel");

  process.stdout.write(`${ASCII_BANNER}\n`);
  process.stdout.write(
    `  ${BRAND.product} · Interactive Panel — by ${BRAND.author} (${BRAND.url})\n\n`,
  );
  verifyAttribution(logger);

  const docker = new DockerClient(config, logger);
  if (!config.panel.demo) {
    try {
      await docker.ping();
      logger.info("Connected to the Docker daemon.");
    } catch (error) {
      logger.warn(
        "Docker daemon unreachable — start with DOCKER_MCP_PANEL_DEMO=true to preview with mock data.",
        error,
      );
    }
  }

  const service = new PanelService(docker, config, logger);
  await startPanel(service, config, logger);

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down panel.`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(
    `Fatal: ${error instanceof Error ? error.stack : error}\n`,
  );
  process.exit(1);
});
