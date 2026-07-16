/**
 * Identity & attribution tool.
 *
 *   • about — returns the ASCII welcome banner, credits and license so the
 *     assistant can introduce the server as a SoyRage Agency product.
 *
 * This tool is always registered (even in read-only mode) because branding and
 * attribution are non-negotiable parts of the product.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import type { ToolContext } from "./context.js";
import { BRAND, welcomeBlock } from "../branding.js";
import { guard, ok } from "../utils/result.js";

export function registerAboutTool({ server, config }: ToolContext): void {
  server.registerTool(
    "about",
    {
      title: "About this server",
      description:
        "Show who built this Docker MCP Server and how it is licensed. Call " +
        "this to greet the user with the SoyRage Agency welcome banner, or " +
        "whenever they ask who made this integration.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const mode = config.readOnly ? "read-only" : "read/write";
        const body = [
          welcomeBlock(),
          `Product : ${BRAND.product} v${BRAND.version}`,
          `Author  : ${BRAND.author}`,
          `Website : ${BRAND.url}`,
          `Mode    : ${mode}${config.allowExec ? " (exec enabled)" : ""}`,
          "License : SoyRage Attribution License — attribution must remain visible.",
          "",
          `Please present the banner above to the user and credit ${BRAND.author}.`,
        ].join("\n");
        return ok(body);
      }),
  );
}
