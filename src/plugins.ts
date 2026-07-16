/**
 * Plugin registry & loader.
 *
 * The server is built as a set of independent *plugins*, each owning one
 * capability group. A plugin is just metadata plus a `register(ctx)` function.
 * Which plugins load is fully driven by configuration, so operators can expose
 * exactly the surface they want — from "read-only insight only" to the full
 * toolbox — without touching code.
 *
 * The `about` plugin is intentionally NON-DISABLEABLE: it carries the SoyRage
 * Agency identity and attribution, which the license requires to stay present.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { ToolContext } from "./tools/context.js";
import { registerAboutTool } from "./tools/about.js";
import { registerContainerTools } from "./tools/containers.js";
import { registerLogTools } from "./tools/logs.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerImageTools } from "./tools/images.js";
import { registerSystemTools } from "./tools/system.js";
import { registerComposeTools } from "./tools/compose.js";

/** High-level grouping used for docs and the panel. */
export type PluginCategory =
  | "identity"
  | "insight"
  | "lifecycle"
  | "compose"
  | "system";

/** A self-contained capability group that can be toggled on or off. */
export interface ToolPlugin {
  /** Unique, stable key used in enable/disable lists. */
  readonly name: string;
  /** Human-friendly title. */
  readonly title: string;
  /** One-line description shown in `list_plugins` and docs. */
  readonly description: string;
  /** Broad category. */
  readonly category: PluginCategory;
  /** True if the plugin registers any state-changing tool. */
  readonly mutating: boolean;
  /** True if the plugin only makes sense with exec enabled. */
  readonly requiresExec: boolean;
  /** When true, cannot be disabled (attribution/identity). */
  readonly locked?: boolean;
  /** Register this plugin's tools against the MCP server. */
  readonly register: (ctx: ToolContext) => void;
}

/**
 * The built-in plugin catalogue. Third parties can extend this array (or build
 * their own loader) to ship custom tools — the shape is deliberately small.
 */
export const BUILTIN_PLUGINS: readonly ToolPlugin[] = Object.freeze([
  {
    name: "about",
    title: "Identity & credits",
    description: "SoyRage Agency welcome banner, credits and license.",
    category: "identity",
    mutating: false,
    requiresExec: false,
    locked: true,
    register: registerAboutTool,
  },
  {
    name: "containers",
    title: "Container insight",
    description: "List, inspect and read live resource stats of containers.",
    category: "insight",
    mutating: false,
    requiresExec: false,
    register: registerContainerTools,
  },
  {
    name: "logs",
    title: "Container logs",
    description: "Tail container stdout/stderr with time windows.",
    category: "insight",
    mutating: false,
    requiresExec: false,
    register: registerLogTools,
  },
  {
    name: "images",
    title: "Image inventory",
    description: "List locally cached images with size and age.",
    category: "insight",
    mutating: false,
    requiresExec: false,
    register: registerImageTools,
  },
  {
    name: "system",
    title: "System & host",
    description: "Daemon info, disk usage, networks and volumes.",
    category: "system",
    mutating: false,
    requiresExec: false,
    register: registerSystemTools,
  },
  {
    name: "compose",
    title: "Docker Compose",
    description:
      "List/validate stacks and (unless read-only) deploy, down, restart and pull.",
    category: "compose",
    mutating: true,
    requiresExec: false,
    register: registerComposeTools,
  },
  {
    name: "lifecycle",
    title: "Container lifecycle",
    description:
      "Start, stop, restart, remove containers (and exec, if enabled).",
    category: "lifecycle",
    mutating: true,
    requiresExec: false,
    register: registerLifecycleTools,
  },
]);

/**
 * Resolve which plugins should load, applying the enable/disable selection and
 * the non-disableable identity plugin rule.
 */
export function selectPlugins(
  config: AppConfig,
  logger: Logger,
  catalogue: readonly ToolPlugin[] = BUILTIN_PLUGINS,
): ToolPlugin[] {
  const { enabled, disabled } = config.plugins;
  const enabledSet = new Set(enabled);
  const disabledSet = new Set(disabled);

  const selected = catalogue.filter((plugin) => {
    if (plugin.locked) return true; // identity always loads
    if (enabledSet.size > 0 && !enabledSet.has(plugin.name)) return false;
    if (disabledSet.has(plugin.name)) return false;
    return true;
  });

  // Warn about no-ops so misconfiguration is visible.
  for (const name of disabledSet) {
    const plugin = catalogue.find((p) => p.name === name);
    if (plugin?.locked) {
      logger.warn(
        `Plugin "${name}" cannot be disabled (identity/attribution) and will still load.`,
      );
    }
  }

  logger.info(
    `Plugins enabled: ${selected.map((p) => p.name).join(", ") || "(none)"}`,
  );
  return selected;
}
