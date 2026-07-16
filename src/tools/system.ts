/**
 * Host- and daemon-level tools.
 *
 *   • system_info   — daemon summary (version, OS, resources, counts).
 *   • disk_usage    — reclaimable space across images/containers/volumes.
 *   • list_networks — user and default networks.
 *   • list_volumes  — named volumes and their drivers.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import type { ToolContext } from "./context.js";
import { formatBytes, renderTable, truncate } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

export function registerSystemTools({ server, docker }: ToolContext): void {
  server.registerTool(
    "system_info",
    {
      title: "System info",
      description:
        "Summarise the Docker daemon: engine version, host OS/architecture, " +
        "CPU and memory available, and how many containers/images exist. Use " +
        "this to answer 'what does this server look like?'.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const [info, version] = await Promise.all([
          docker.info(),
          docker.version(),
        ]);

        const get = (obj: Record<string, unknown>, key: string): string =>
          obj[key] === undefined ? "n/a" : String(obj[key]);

        const memBytes = Number(info.MemTotal ?? 0);
        const lines = [
          `Engine:        ${get(version, "Version")} (API ${get(version, "ApiVersion")})`,
          `Host OS:       ${get(info, "OperatingSystem")} / ${get(info, "OSType")}-${get(info, "Architecture")}`,
          `Kernel:        ${get(info, "KernelVersion")}`,
          `CPUs:          ${get(info, "NCPU")}`,
          `Memory:        ${formatBytes(memBytes)}`,
          `Containers:    ${get(info, "Containers")} (running ${get(info, "ContainersRunning")}, stopped ${get(info, "ContainersStopped")})`,
          `Images:        ${get(info, "Images")}`,
          `Storage driver:${" "}${get(info, "Driver")}`,
          `Docker root:   ${get(info, "DockerRootDir")}`,
        ];

        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "disk_usage",
    {
      title: "Disk usage",
      description:
        "Report Docker disk usage across images, containers and volumes " +
        "(equivalent to `docker system df`), highlighting reclaimable space.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const df = await docker.diskUsage();

        const sumSize = (items: unknown): number =>
          Array.isArray(items)
            ? items.reduce(
                (sum, item) =>
                  sum + Number((item as { Size?: number }).Size ?? 0),
                0,
              )
            : 0;

        const images = df.Images;
        const containers = df.Containers;
        const volumes = df.Volumes;

        const rows = [
          [
            "Images",
            String(Array.isArray(images) ? images.length : 0),
            formatBytes(sumSize(images)),
          ],
          [
            "Containers",
            String(Array.isArray(containers) ? containers.length : 0),
            formatBytes(sumSize(containers)),
          ],
          [
            "Volumes",
            String(Array.isArray(volumes) ? volumes.length : 0),
            formatBytes(
              Array.isArray(volumes)
                ? volumes.reduce(
                    (sum, v) =>
                      sum +
                      Number(
                        (v as { UsageData?: { Size?: number } }).UsageData
                          ?.Size ?? 0,
                      ),
                    0,
                  )
                : 0,
            ),
          ],
        ];

        return ok(renderTable(["TYPE", "COUNT", "SIZE"], rows));
      }),
  );

  server.registerTool(
    "list_networks",
    {
      title: "List networks",
      description:
        "List Docker networks with their driver and scope. Useful to " +
        "understand how containers can reach one another.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const networks = await docker.listNetworks();
        const rows = networks.map((net) => [
          truncate(net.Name, 28),
          (net.Id ?? "").slice(0, 12),
          net.Driver ?? "—",
          net.Scope ?? "—",
        ]);
        return ok(renderTable(["NAME", "ID", "DRIVER", "SCOPE"], rows));
      }),
  );

  server.registerTool(
    "list_volumes",
    {
      title: "List volumes",
      description:
        "List named Docker volumes and their storage driver. These persist " +
        "data beyond a container's lifecycle.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const volumes = await docker.listVolumes();
        const rows = volumes.map((vol) => [
          truncate(vol.Name, 32),
          vol.Driver ?? "—",
          truncate(vol.Mountpoint ?? "—", 40),
        ]);
        return ok(renderTable(["NAME", "DRIVER", "MOUNTPOINT"], rows));
      }),
  );
}
