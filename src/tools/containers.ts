/**
 * Read-only container insight tools.
 *
 *   • list_containers   — the "what's running?" overview
 *   • inspect_container — full low-level configuration for one container
 *   • container_stats   — a one-shot CPU / memory / network snapshot
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { z } from "zod";
import type Docker from "dockerode";
import type { ToolContext } from "./context.js";
import { normalizeName } from "../docker/client.js";
import {
  asJsonBlock,
  formatBytes,
  formatRelativeTime,
  renderTable,
  truncate,
} from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

/** Compute a percentage from Docker's raw CPU accounting deltas. */
function cpuPercent(stats: Docker.ContainerStats): number {
  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    (stats.cpu_stats.system_cpu_usage ?? 0) -
    (stats.precpu_stats.system_cpu_usage ?? 0);
  const cores =
    stats.cpu_stats.online_cpus ??
    stats.cpu_stats.cpu_usage.percpu_usage?.length ??
    1;

  if (systemDelta <= 0 || cpuDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * cores * 100;
}

export function registerContainerTools({ server, docker }: ToolContext): void {
  server.registerTool(
    "list_containers",
    {
      title: "List containers",
      description:
        "List Docker containers with their status, image, ports and uptime. " +
        "By default only running containers are shown; set `all` to include " +
        "stopped ones. This is the best starting point to understand what is " +
        "deployed on the host.",
      inputSchema: {
        all: z
          .boolean()
          .optional()
          .describe("Include stopped/exited containers (default: false)."),
      },
    },
    async ({ all }) =>
      guard(async () => {
        const containers = await docker.listContainers(all ?? false);

        const rows = containers.map((c) => {
          const name = normalizeName(c.Names[0] ?? c.Id);
          const ports = (c.Ports ?? [])
            .filter((p) => p.PublicPort)
            .map((p) => `${p.PublicPort}→${p.PrivatePort}/${p.Type}`)
            .join(", ");
          return [
            truncate(name, 24),
            truncate(c.Image, 28),
            c.State,
            truncate(c.Status, 22),
            ports || "—",
          ];
        });

        const table = renderTable(
          ["NAME", "IMAGE", "STATE", "STATUS", "PORTS"],
          rows,
        );

        const summary = `${containers.length} container(s)${
          all ? "" : " running"
        }.`;
        return ok(`${summary}\n\n${table}`);
      }),
  );

  server.registerTool(
    "inspect_container",
    {
      title: "Inspect container",
      description:
        "Return the full low-level configuration of a single container " +
        "(environment, mounts, network settings, restart policy, health, …). " +
        "Accepts a container name, short id or full id.",
      inputSchema: {
        container: z
          .string()
          .min(1)
          .describe("Container name, short id or full id."),
      },
    },
    async ({ container }) =>
      guard(async () => {
        const handle = await docker.resolveContainer(container);
        const details = await handle.inspect();

        // Surface the most useful fields as a readable header, then the raw
        // payload for anything the model wants to dig into.
        const header = [
          `Name:    ${normalizeName(details.Name)}`,
          `Image:   ${details.Config.Image}`,
          `State:   ${details.State.Status} (health: ${
            details.State.Health?.Status ?? "n/a"
          })`,
          `Created: ${details.Created}`,
          `Restart: ${details.HostConfig.RestartPolicy?.Name || "no"}`,
        ].join("\n");

        return ok(`${header}\n\n${asJsonBlock(details)}`);
      }),
  );

  server.registerTool(
    "container_stats",
    {
      title: "Container resource stats",
      description:
        "Take a one-shot snapshot of a container's live CPU %, memory usage " +
        "and network I/O. Useful to answer 'why is my server slow?'.",
      inputSchema: {
        container: z
          .string()
          .min(1)
          .describe("Container name, short id or full id."),
      },
    },
    async ({ container }) =>
      guard(async () => {
        const handle = await docker.resolveContainer(container);
        // `stream: false` returns a single sample instead of an endless stream.
        const stats = (await handle.stats({
          stream: false,
        })) as unknown as Docker.ContainerStats & {
          name?: string;
          read: string;
        };

        const memUsage = stats.memory_stats.usage ?? 0;
        const memLimit = stats.memory_stats.limit ?? 0;
        const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

        const networks = stats.networks ?? {};
        const rx = Object.values(networks).reduce((sum, n) => sum + n.rx_bytes, 0);
        const tx = Object.values(networks).reduce((sum, n) => sum + n.tx_bytes, 0);

        const lines = [
          `Container: ${normalizeName(stats.name ?? container)}`,
          `CPU:       ${cpuPercent(stats).toFixed(2)} %`,
          `Memory:    ${formatBytes(memUsage)} / ${formatBytes(
            memLimit,
          )} (${memPercent.toFixed(1)} %)`,
          `Net RX/TX: ${formatBytes(rx)} / ${formatBytes(tx)}`,
          `Sampled:   ${formatRelativeTime(
            Math.floor(new Date(stats.read).getTime() / 1000),
          )}`,
        ];

        return ok(lines.join("\n"));
      }),
  );
}
