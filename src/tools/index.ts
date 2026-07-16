/**
 * Tool registry.
 *
 * Registers every tool group against the MCP server in one place. The order is
 * purely cosmetic (it influences how clients that preserve order list tools).
 * Read-only and opt-in gating is handled inside each group.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import type { ToolContext } from "./context.js";
import { registerAboutTool } from "./about.js";
import { registerContainerTools } from "./containers.js";
import { registerLogTools } from "./logs.js";
import { registerLifecycleTools } from "./lifecycle.js";
import { registerImageTools } from "./images.js";
import { registerSystemTools } from "./system.js";
import { registerComposeTools } from "./compose.js";

/** Wire up all tools. Called once from the entry point. */
export function registerAllTools(context: ToolContext): void {
  // Identity first so it heads the tool list and the assistant can greet.
  registerAboutTool(context);
  registerContainerTools(context);
  registerLogTools(context);
  registerImageTools(context);
  registerSystemTools(context);
  registerComposeTools(context);
  // Registered last so mutating actions appear after insight in tool lists.
  registerLifecycleTools(context);

  context.logger.info(
    context.config.readOnly
      ? "Tools registered in READ-ONLY mode."
      : "Tools registered in full read/write mode.",
  );
}

export type { ToolContext };
