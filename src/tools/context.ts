/**
 * Shared tool context.
 *
 * Every tool-registration function receives one of these. It bundles the
 * collaborators tools need (Docker client, Compose driver, config, logger) so
 * individual modules stay free of global state and are trivial to test.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { DockerClient } from "../docker/client.js";
import type { ComposeDriver } from "../docker/compose.js";

/**
 * Lightweight plugin metadata surfaced to tools (e.g. `list_plugins`) without
 * pulling in the plugin module, keeping the dependency graph acyclic.
 */
export interface PluginInfo {
  readonly name: string;
  readonly title: string;
  readonly category: string;
  readonly mutating: boolean;
  readonly enabled: boolean;
}

/** Dependencies handed to each tool group at registration time. */
export interface ToolContext {
  readonly server: McpServer;
  readonly docker: DockerClient;
  readonly compose: ComposeDriver;
  readonly config: AppConfig;
  readonly logger: Logger;
  /** The full plugin catalogue with per-plugin enabled state. */
  readonly plugins: readonly PluginInfo[];
}
