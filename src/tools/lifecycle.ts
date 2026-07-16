/**
 * Container lifecycle tools (state-changing).
 *
 *   • start_container    • stop_container
 *   • restart_container  • remove_container
 *   • exec_in_container  (opt-in via DOCKER_MCP_ALLOW_EXEC)
 *
 * The entire group is skipped when the server runs in read-only mode, so a
 * demo deployment can safely expose insight without risk of mutation.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { normalizeName } from "../docker/client.js";
import { guard, ok } from "../utils/result.js";

export function registerLifecycleTools(ctx: ToolContext): void {
  const { server, docker, config, logger } = ctx;

  // Respect read-only mode: register nothing state-changing.
  if (config.readOnly) {
    logger.info("Read-only mode: lifecycle tools are disabled.");
    return;
  }

  server.registerTool(
    "start_container",
    {
      title: "Start container",
      description:
        "Start a stopped container. No-op if it is already running. " +
        "Returns the resulting state.",
      inputSchema: {
        container: z.string().min(1).describe("Container name or id."),
      },
    },
    async ({ container }) =>
      guard(async () => {
        const handle = await docker.resolveContainer(container);
        const info = await handle.inspect();
        if (info.State.Running) {
          return ok(`Container "${normalizeName(container)}" is already running.`);
        }
        await handle.start();
        return ok(`Started "${normalizeName(container)}".`);
      }),
  );

  server.registerTool(
    "stop_container",
    {
      title: "Stop container",
      description:
        "Gracefully stop a running container (SIGTERM, then SIGKILL after a " +
        "grace period). No-op if it is already stopped.",
      inputSchema: {
        container: z.string().min(1).describe("Container name or id."),
        timeout: z
          .number()
          .int()
          .positive()
          .max(300)
          .optional()
          .describe("Seconds to wait before force-killing (default: 10)."),
      },
    },
    async ({ container, timeout }) =>
      guard(async () => {
        const handle = await docker.resolveContainer(container);
        const info = await handle.inspect();
        if (!info.State.Running) {
          return ok(`Container "${normalizeName(container)}" is already stopped.`);
        }
        await handle.stop({ t: timeout ?? 10 });
        return ok(`Stopped "${normalizeName(container)}".`);
      }),
  );

  server.registerTool(
    "restart_container",
    {
      title: "Restart container",
      description:
        "Restart a container. This is the go-to fix for 'turn it off and on " +
        "again' style requests.",
      inputSchema: {
        container: z.string().min(1).describe("Container name or id."),
        timeout: z
          .number()
          .int()
          .positive()
          .max(300)
          .optional()
          .describe("Seconds to wait before force-killing (default: 10)."),
      },
    },
    async ({ container, timeout }) =>
      guard(async () => {
        const handle = await docker.resolveContainer(container);
        await handle.restart({ t: timeout ?? 10 });
        return ok(`Restarted "${normalizeName(container)}".`);
      }),
  );

  server.registerTool(
    "remove_container",
    {
      title: "Remove container",
      description:
        "Remove a container. Requires `force` to remove a running one. This " +
        "is destructive and cannot be undone — prefer stopping first.",
      inputSchema: {
        container: z.string().min(1).describe("Container name or id."),
        force: z
          .boolean()
          .optional()
          .describe("Remove even if running (default: false)."),
        removeVolumes: z
          .boolean()
          .optional()
          .describe("Also remove anonymous volumes (default: false)."),
      },
    },
    async ({ container, force, removeVolumes }) =>
      guard(async () => {
        const handle = await docker.resolveContainer(container);
        await handle.remove({ force: force ?? false, v: removeVolumes ?? false });
        return ok(`Removed "${normalizeName(container)}".`);
      }),
  );

  // ---- Optional, powerful: run a command inside a container ---------------
  if (config.allowExec) {
    logger.info("exec_in_container tool is ENABLED (DOCKER_MCP_ALLOW_EXEC).");

    server.registerTool(
      "exec_in_container",
      {
        title: "Execute command in container",
        description:
          "Run a one-off command inside a running container and return its " +
          "combined output. The command is passed as an argument array (no " +
          "shell), e.g. [\"ls\", \"-la\", \"/app\"]. Disabled unless the " +
          "server operator opts in.",
        inputSchema: {
          container: z.string().min(1).describe("Container name or id."),
          command: z
            .array(z.string())
            .min(1)
            .describe('Argument array, e.g. ["cat", "/etc/hostname"].'),
          workdir: z
            .string()
            .optional()
            .describe("Working directory inside the container."),
        },
      },
      async ({ container, command, workdir }) =>
        guard(async () => {
          const handle = await docker.resolveContainer(container);
          const exec = await handle.exec({
            Cmd: command,
            AttachStdout: true,
            AttachStderr: true,
            WorkingDir: workdir,
          });

          const stream = await exec.start({});
          const output = await collectStream(stream);
          const inspect = await exec.inspect();

          const header = `exit code ${inspect.ExitCode ?? "?"}`;
          return ok(`\`${command.join(" ")}\` → ${header}\n\n\`\`\`\n${output.trimEnd()}\n\`\`\``);
        }),
    );
  }
}

/** Read a dockerode exec stream to completion, demultiplexing frame headers. */
function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolveStream, rejectStream) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const out: string[] = [];
      let offset = 0;
      // Best-effort demultiplex; fall back to raw text if unframed.
      while (offset + 8 <= buffer.length) {
        const type = buffer[offset];
        if (type > 2 || buffer[offset + 1] !== 0) {
          resolveStream(buffer.toString("utf8"));
          return;
        }
        const size = buffer.readUInt32BE(offset + 4);
        const start = offset + 8;
        out.push(buffer.subarray(start, start + size).toString("utf8"));
        offset = start + size;
      }
      resolveStream(out.length ? out.join("") : buffer.toString("utf8"));
    });
    stream.on("error", rejectStream);
  });
}
