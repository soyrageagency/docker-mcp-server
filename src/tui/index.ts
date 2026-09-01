#!/usr/bin/env node
/**
 * Terminal UI — entry point.
 *
 * The `docker-mcp-tui` binary: a creative, lazydocker-style terminal dashboard
 * for your Docker host, opening with a SoyRage Agency welcome. Reuses the same
 * configuration, Docker client and safety rails as everything else.
 *
 * Preview it without a daemon:
 *   DOCKER_MCP_PANEL_DEMO=true npm run tui
 *
 * There is also a non-interactive snapshot mode used to generate documentation:
 *   node dist/tui/index.js --frame
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

import { loadConfig } from "../config.js";
import { Logger } from "../logger.js";
import { DockerClient } from "../docker/client.js";
import { PanelService } from "../panel/service.js";
import { TuiApp } from "./app.js";
import { isEntryPoint } from "../entry.js";

export async function runTui(): Promise<void> {
  const config = loadConfig();
  // Diagnostics must stay quiet: the TUI owns the terminal.
  const logger = new Logger("error", "tui");

  const docker = new DockerClient(config, logger);
  if (!config.panel.demo) {
    try {
      await docker.ping();
    } catch {
      process.stderr.write(
        "Docker daemon unreachable. Launch with DOCKER_MCP_PANEL_DEMO=true to preview with mock data.\n",
      );
      process.exit(1);
    }
  }

  const service = new PanelService(docker, config, logger);
  const app = new TuiApp(service);

  // Non-interactive snapshot modes (for documentation/screenshots).
  if (process.argv.includes("--splash")) {
    process.stdout.write(app.splashLines(96, 22).join("\n") + "\n");
    process.exit(0);
  }
  if (process.argv.includes("--frame")) {
    const overlay = process.argv.includes("--ai")
      ? "ai"
      : process.argv.includes("--msg")
        ? "message"
        : undefined;
    const frame = await app.frame(96, 30, overlay);
    process.stdout.write(frame + "\n");
    process.exit(0);
  }

  await app.start();
}

// Run directly when invoked as the `docker-mcp-tui` binary; stay quiet when the
// unified `ragedocker` launcher imports runTui() and calls it itself.
if (isEntryPoint(import.meta.url)) {
  runTui().catch((error) => {
    process.stderr.write(
      `Fatal: ${error instanceof Error ? error.stack : error}\n`,
    );
    process.exit(1);
  });
}
