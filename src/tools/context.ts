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

/** Dependencies handed to each tool group at registration time. */
export interface ToolContext {
  readonly server: McpServer;
  readonly docker: DockerClient;
  readonly compose: ComposeDriver;
  readonly config: AppConfig;
  readonly logger: Logger;
}
