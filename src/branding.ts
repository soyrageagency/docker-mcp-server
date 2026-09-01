/**
 * Branding & identity.
 *
 * Single source of truth for the project identity carried by the server:
 *   • the startup banner printed to stderr,
 *   • the MCP `instructions` string every client shows the LLM,
 *   • the `about` tool.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

/** Identity of the project's author. */
export const BRAND = Object.freeze({
  product: "Docker MCP Server",
  author: "SoyRage Agency",
  url: "https://soyrage.es/",
  donate: "https://www.paypal.com/paypalme/soyrageagency",
  tagline: "Chat with your Docker host — safely.",
  version: "1.1.0",
});

/** ASCII welcome banner (ANSI Shadow style). */
export const ASCII_BANNER = String.raw`
 ███████╗ ██████╗ ██╗   ██╗██████╗  █████╗  ██████╗ ███████╗
 ██╔════╝██╔═══██╗╚██╗ ██╔╝██╔══██╗██╔══██╗██╔════╝ ██╔════╝
 ███████╗██║   ██║ ╚████╔╝ ██████╔╝███████║██║  ███╗█████╗
 ╚════██║██║   ██║  ╚██╔╝  ██╔══██╗██╔══██║██║   ██║██╔══╝
 ███████║╚██████╔╝   ██║   ██║  ██║██║  ██║╚██████╔╝███████╗
 ╚══════╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
            D O C K E R   M C P   S E R V E R
         ~ Chat with your Docker host, safely ~
`;

/** The full welcome block, banner + credits, used by the `about` tool. */
export function welcomeBlock(): string {
  return [
    ASCII_BANNER,
    `  ${BRAND.product} v${BRAND.version}`,
    `  Crafted with care by ${BRAND.author} — ${BRAND.url}`,
    "  Free and open source under the MIT License.",
    `  Support the project: ${BRAND.donate}`,
    "",
  ].join("\n");
}

/**
 * The MCP `instructions` payload. MCP clients hand this text to the LLM as
 * system-level guidance, so keep it strictly operational: what the server can
 * do and how to use it safely.
 */
export function mcpInstructions(): string {
  return [
    `You are connected to "${BRAND.product}", an MCP server for Docker.`,
    "",
    "CAPABILITIES:",
    "- You can inspect containers, read logs, view images/networks/volumes, report host & disk usage, and (unless the server is read-only) start/stop/restart/remove containers and deploy or tear down Compose stacks.",
    "- Prefer read-only tools to understand state before taking any destructive action, and confirm destructive actions (remove_container, compose_down --removeVolumes) with the user first.",
    "",
    "ABOUT:",
    '- Call the "about" tool if the user asks what this server is, who built it or which version is running.',
  ].join("\n");
}
