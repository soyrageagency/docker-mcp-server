/**
 * Docker Compose tools.
 *
 * Read-only:
 *   • compose_ps     — show the services and health of a stack.
 *   • compose_config — validate & render the effective configuration.
 *
 * State-changing (skipped in read-only mode):
 *   • deploy_stack    — `compose up -d` (optionally --build).
 *   • compose_down    — tear a stack down.
 *   • compose_restart — restart all/selected services.
 *   • compose_pull    — pull the latest images.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import type { ComposeResult, ComposeTarget } from "../docker/compose.js";
import { fail, guard, ok } from "../utils/result.js";

/** Shared input fields identifying a Compose project. */
const targetShape = {
  file: z
    .string()
    .min(1)
    .describe(
      "Path to a compose file, or a directory containing one " +
        "(compose.yaml / docker-compose.yml). Relative paths resolve against " +
        "the server's configured Compose working directory.",
    ),
  project: z
    .string()
    .optional()
    .describe("Explicit Compose project name (defaults to the folder name)."),
};

/** Turn a ComposeResult into a readable tool result. */
function present(action: string, result: ComposeResult): ReturnType<typeof ok> {
  const body = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");

  if (result.code !== 0) {
    return fail(
      `${action} failed (exit ${result.code}).\n\n${body || "(no output)"}`,
    );
  }
  return ok(`${action} succeeded.\n\n\`\`\`\n${body || "(no output)"}\n\`\`\``);
}

export function registerComposeTools(ctx: ToolContext): void {
  const { server, compose, config, logger } = ctx;

  // ---------- Read-only tools (always available) --------------------------
  server.registerTool(
    "compose_ps",
    {
      title: "Compose: list services",
      description:
        "List the services defined by a Compose stack and their current " +
        "state/health. Point `file` at the compose file or its directory.",
      inputSchema: targetShape,
    },
    async (args) =>
      guard(async () => {
        const result = await compose.ps(args as ComposeTarget);
        if (result.code !== 0) return present("compose ps", result);

        // `--format json` yields one JSON object per line; render compactly.
        const services = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .filter((entry): entry is Record<string, unknown> => entry !== null);

        if (services.length === 0) {
          return ok("No services are currently running for this stack.");
        }

        const lines = services.map((svc) => {
          const name = svc.Service ?? svc.Name ?? "?";
          const state = svc.State ?? "?";
          const status = svc.Status ?? "";
          return `• ${name}: ${state} ${status}`.trimEnd();
        });

        return ok(`${services.length} service(s):\n\n${lines.join("\n")}`);
      }),
  );

  server.registerTool(
    "compose_config",
    {
      title: "Compose: validate config",
      description:
        "Validate a Compose file and render its fully-resolved configuration " +
        "(interpolated variables, merged overrides). A non-zero result means " +
        "the file has errors.",
      inputSchema: targetShape,
    },
    async (args) =>
      guard(async () => present("compose config", await compose.config(args as ComposeTarget))),
  );

  // ---------- State-changing tools (respect read-only mode) ---------------
  if (config.readOnly) {
    logger.info("Read-only mode: Compose deploy/down/restart tools are disabled.");
    return;
  }

  server.registerTool(
    "deploy_stack",
    {
      title: "Compose: deploy stack",
      description:
        "Deploy or update a Compose stack in the background (`compose up -d`). " +
        "Optionally rebuild images and/or scope to specific services. This is " +
        "the one-shot 'ship it' action.",
      inputSchema: {
        ...targetShape,
        build: z
          .boolean()
          .optional()
          .describe("Rebuild images before starting (default: false)."),
        services: z
          .array(z.string())
          .optional()
          .describe("Limit the action to these services (default: all)."),
      },
    },
    async ({ file, project, build, services }) =>
      guard(async () =>
        present(
          "deploy_stack",
          await compose.up({ file, project }, { build, services }),
        ),
      ),
  );

  server.registerTool(
    "compose_down",
    {
      title: "Compose: tear down stack",
      description:
        "Stop and remove a Compose stack (`compose down`). Set " +
        "`removeVolumes` to also delete named volumes — destructive.",
      inputSchema: {
        ...targetShape,
        removeVolumes: z
          .boolean()
          .optional()
          .describe("Also remove named volumes (default: false)."),
      },
    },
    async ({ file, project, removeVolumes }) =>
      guard(async () =>
        present(
          "compose_down",
          await compose.down({ file, project }, { volumes: removeVolumes }),
        ),
      ),
  );

  server.registerTool(
    "compose_restart",
    {
      title: "Compose: restart services",
      description:
        "Restart all services in a stack, or only the ones you name.",
      inputSchema: {
        ...targetShape,
        services: z
          .array(z.string())
          .optional()
          .describe("Services to restart (default: all)."),
      },
    },
    async ({ file, project, services }) =>
      guard(async () =>
        present(
          "compose_restart",
          await compose.restart({ file, project }, services ?? []),
        ),
      ),
  );

  server.registerTool(
    "compose_pull",
    {
      title: "Compose: pull images",
      description:
        "Pull the latest images referenced by a stack without starting it. " +
        "Pair with `deploy_stack` to perform a rolling update.",
      inputSchema: {
        ...targetShape,
        services: z
          .array(z.string())
          .optional()
          .describe("Services to pull (default: all)."),
      },
    },
    async ({ file, project, services }) =>
      guard(async () =>
        present(
          "compose_pull",
          await compose.pull({ file, project }, services ?? []),
        ),
      ),
  );
}
