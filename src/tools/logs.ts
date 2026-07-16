/**
 * Container log retrieval.
 *
 *   • container_logs — fetch the tail of a container's stdout/stderr.
 *
 * Docker multiplexes stdout and stderr over a single stream with an 8-byte
 * header per frame when a TTY is not allocated. We demultiplex it here so the
 * LLM receives clean, readable text.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { normalizeName } from "../docker/client.js";
import { guard, ok } from "../utils/result.js";

/**
 * Strip Docker's stream-multiplexing headers from a non-TTY log buffer.
 * Each frame is: [stream(1)][000][size(4, big-endian)][payload(size)].
 * If the buffer doesn't look framed (TTY containers), it is returned as-is.
 */
function demultiplex(buffer: Buffer): string {
  const chunks: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    // A valid header has stream type 0, 1 or 2 and three zero bytes after it.
    const looksFramed =
      (streamType === 0 || streamType === 1 || streamType === 2) &&
      buffer[offset + 1] === 0 &&
      buffer[offset + 2] === 0 &&
      buffer[offset + 3] === 0;

    if (!looksFramed) return buffer.toString("utf8");

    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;

    chunks.push(buffer.subarray(start, end).toString("utf8"));
    offset = end;
  }

  return chunks.length > 0 ? chunks.join("") : buffer.toString("utf8");
}

export function registerLogTools({ server, docker, config }: ToolContext): void {
  server.registerTool(
    "container_logs",
    {
      title: "Read container logs",
      description:
        "Fetch the most recent log lines from a container's stdout/stderr. " +
        "Use this to diagnose crashes, watch startup output or confirm a " +
        "deployment. Supports an optional time window via `since`.",
      inputSchema: {
        container: z
          .string()
          .min(1)
          .describe("Container name, short id or full id."),
        tail: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe(
            "Number of trailing lines to return (default from server config).",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "Only return logs newer than this. Accepts a Unix timestamp " +
              "(seconds) or a relative value like '10m' or '2h'.",
          ),
        timestamps: z
          .boolean()
          .optional()
          .describe("Prefix each line with its timestamp (default: false)."),
      },
    },
    async ({ container, tail, since, timestamps }) =>
      guard(async () => {
        const handle = await docker.resolveContainer(container);

        const options: {
          stdout: true;
          stderr: true;
          tail: number;
          timestamps: boolean;
          since?: number;
        } = {
          stdout: true,
          stderr: true,
          tail: tail ?? config.defaultLogTail,
          timestamps: timestamps ?? false,
        };

        const sinceSeconds = parseSince(since);
        if (sinceSeconds !== undefined) options.since = sinceSeconds;

        const raw = (await handle.logs(options)) as unknown as Buffer;
        const text = demultiplex(Buffer.from(raw)).trimEnd();

        const name = normalizeName(container);
        if (!text) {
          return ok(`No log output for "${name}" in the requested window.`);
        }

        return ok(
          `Last ${options.tail} line(s) for "${name}":\n\n\`\`\`log\n${text}\n\`\`\``,
        );
      }),
  );
}

/**
 * Convert a `since` argument into an absolute Unix timestamp (seconds).
 * Accepts raw seconds ("1700000000") or relative durations ("10m", "2h", "1d").
 */
function parseSince(since?: string): number | undefined {
  if (!since) return undefined;
  const value = since.trim();

  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);

  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(value);
  if (!match) return undefined;

  const amount = Number.parseInt(match[1], 10);
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = amount * unitSeconds[match[2].toLowerCase()];
  return Math.floor(Date.now() / 1000) - seconds;
}
