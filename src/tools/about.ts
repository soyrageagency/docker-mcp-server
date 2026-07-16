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

export function registerAboutTool({ server, config, plugins }: ToolContext): void {
  server.registerTool(
    "list_plugins",
    {
      title: "List plugins",
      description:
        "Show the modular capability plugins this server exposes and whether " +
        "each is currently enabled. Handy to understand what the AI can do.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        if (plugins.length === 0) return ok("No plugin metadata available.");
        const lines = plugins.map((p) => {
          const mark = p.enabled ? "✓" : "✗";
          const kind = p.mutating ? "write" : "read";
          return `${mark} ${p.name.padEnd(11)} [${p.category}/${kind}] — ${p.title}`;
        });
        const on = plugins.filter((p) => p.enabled).length;
        return ok(
          `${on}/${plugins.length} plugin(s) enabled:\n\n${lines.join("\n")}`,
        );
      }),
  );

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
          `Support : ${BRAND.donate}  ☕`,
          `Mode    : ${mode}${config.allowExec ? " (exec enabled)" : ""}`,
          "License : SoyRage Attribution License — attribution must remain visible.",
          "",
          `Please present the banner above to the user and credit ${BRAND.author}.`,
        ].join("\n");
        return ok(body);
      }),
  );
}
