/**
 * Host diagnostics — the questions you actually ask when something is off.
 *
 *   • host_health           — one scored report: daemon reachability, unhealthy
 *                             healthchecks, restart loops, containers that
 *                             should be up but aren't, and disk pressure.
 *   • find_restart_loops    — containers stuck crash-looping, with the exit code
 *                             and the tail of the log that explains why.
 *   • find_unused_resources — dangling images, unused volumes and dead
 *                             containers, with the space each would return.
 *
 * All read-only, so they stay available in read-only mode.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { z } from "zod";
import type Docker from "dockerode";
import type { ToolContext } from "./context.js";
import { formatBytes, formatRelativeTime, renderTable, truncate } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

type Severity = "critical" | "warning" | "ok";

interface Finding {
  readonly severity: Severity;
  readonly area: string;
  readonly detail: string;
}

const ICON: Record<Severity, string> = { critical: "✗", warning: "!", ok: "✓" };
const RANK: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };

/** Docker prefixes container names with a slash. */
function displayName(info: Docker.ContainerInfo): string {
  return (info.Names?.[0] ?? info.Id).replace(/^\//, "");
}

/** Shape of the bits of `docker inspect` this module cares about. */
interface InspectState {
  Status?: string;
  Running?: boolean;
  ExitCode?: number;
  StartedAt?: string;
  FinishedAt?: string;
  RestartCount?: number;
  Health?: { Status?: string; FailingStreak?: number };
}

/** Fetch inspect data for a container, tolerating a container that vanished. */
async function inspectState(
  docker: Docker,
  id: string,
): Promise<{ state: InspectState; restartPolicy: string } | undefined> {
  try {
    const raw = (await docker.getContainer(id).inspect()) as unknown as {
      State?: InspectState;
      RestartCount?: number;
      HostConfig?: { RestartPolicy?: { Name?: string } };
    };
    return {
      state: {
        ...(raw.State ?? {}),
        RestartCount: raw.RestartCount ?? raw.State?.RestartCount ?? 0,
      },
      restartPolicy: raw.HostConfig?.RestartPolicy?.Name ?? "no",
    };
  } catch {
    return undefined;
  }
}

/**
 * Turn a raw `docker logs` response into text.
 *
 * Without a TTY the daemon multiplexes stdout and stderr into frames, each
 * prefixed by an 8-byte header: [stream, 0, 0, 0, big-endian length]. Printing
 * the buffer as-is leaves those headers interleaved through the output as
 * unreadable bytes, so walk the frames instead. With a TTY there is no framing
 * and the buffer is already text — detected by the header not being well formed.
 */
function demuxLogs(buf: Buffer): string {
  if (buf.length < 8 || buf[0] > 2 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) {
    return buf.toString("utf8");
  }
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    if (size === 0) break;
    const start = offset + 8;
    const end = Math.min(start + size, buf.length);
    parts.push(buf.toString("utf8", start, end));
    offset = end;
  }
  return parts.join("");
}

/** How long ago an ISO timestamp was, in seconds. Negative/absent → Infinity. */
function ageSeconds(iso: string | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

export function registerDiagnosticsTools({ server, docker }: ToolContext): void {
  server.registerTool(
    "host_health",
    {
      title: "Docker host health check",
      description:
        "Run a read-only health check over the Docker host and report only " +
        "what needs attention: failing healthchecks, containers crash-looping, " +
        "containers with a restart policy that are nonetheless down, and disk " +
        "pressure from reclaimable images and volumes. Use this to answer " +
        "'is anything wrong?' in one call.",
      inputSchema: {
        reclaimableWarnGb: z
          .number()
          .min(0)
          .optional()
          .describe("Flag reclaimable disk above this many GB. Default 10."),
        restartLoopThreshold: z
          .number()
          .min(1)
          .optional()
          .describe("Restart count that counts as a loop. Default 3."),
      },
    },
    async ({ reclaimableWarnGb, restartLoopThreshold }) =>
      guard(async () => {
        const reclaimLimit = (reclaimableWarnGb ?? 10) * 1024 ** 3;
        const loopLimit = restartLoopThreshold ?? 3;
        const findings: Finding[] = [];

        // — Daemon ————————————————————————————————————————————————
        const info = await docker.info();
        findings.push({
          severity: "ok",
          area: "daemon",
          detail:
            `Docker ${String(info.ServerVersion ?? "?")} on ` +
            `${String(info.OperatingSystem ?? "?")}, ` +
            `${String(info.NCPU ?? "?")} CPU(s), ${formatBytes(Number(info.MemTotal ?? 0))} RAM.`,
        });

        // — Containers ————————————————————————————————————————————
        const containers = await docker.listContainers(true);
        let unhealthy = 0;
        let looping = 0;
        let unexpectedlyDown = 0;

        for (const c of containers) {
          const name = displayName(c);
          const detail = await inspectState(docker.raw, c.Id);
          if (!detail) continue;
          const { state, restartPolicy } = detail;

          const health = state.Health?.Status;
          if (health === "unhealthy") {
            unhealthy++;
            findings.push({
              severity: "critical",
              area: `container/${name}`,
              detail: `Healthcheck failing (${state.Health?.FailingStreak ?? "?"} consecutive failures).`,
            });
          }

          const restarts = state.RestartCount ?? 0;
          if (restarts >= loopLimit && ageSeconds(state.StartedAt) < 3600) {
            looping++;
            findings.push({
              severity: "critical",
              area: `container/${name}`,
              detail: `Restarted ${restarts} time(s) and last started ${formatRelativeTime(Math.floor(Date.parse(state.StartedAt ?? "") / 1000))} — crash-looping.`,
            });
          }

          // A container told to come back on its own, that is nevertheless
          // down, is the shape of a failure nobody noticed.
          if (!state.Running && restartPolicy !== "no" && restartPolicy !== "") {
            unexpectedlyDown++;
            findings.push({
              severity: "warning",
              area: `container/${name}`,
              detail:
                `Down (exit ${state.ExitCode ?? "?"}) despite restart policy "${restartPolicy}". ` +
                "Docker gave up, or it was stopped by hand.",
            });
          }
        }

        const running = containers.filter((c) => c.State === "running").length;
        if (!unhealthy && !looping && !unexpectedlyDown) {
          findings.push({
            severity: "ok",
            area: "containers",
            detail: `${running} of ${containers.length} container(s) running, none failing.`,
          });
        }

        // — Disk —————————————————————————————————————————————————
        const usage = (await docker.diskUsage()) as unknown as {
          Images?: Array<{ Size?: number; Containers?: number }>;
          Volumes?: Array<{ UsageData?: { Size?: number; RefCount?: number } }>;
          Containers?: Array<{ SizeRw?: number; State?: string }>;
        };
        const danglingBytes = (usage.Images ?? [])
          .filter((i) => (i.Containers ?? 0) <= 0)
          .reduce((sum, i) => sum + Number(i.Size ?? 0), 0);
        const looseVolumeBytes = (usage.Volumes ?? [])
          .filter((v) => (v.UsageData?.RefCount ?? 0) <= 0)
          .reduce((sum, v) => sum + Number(v.UsageData?.Size ?? 0), 0);
        const reclaimable = danglingBytes + looseVolumeBytes;

        findings.push({
          severity: reclaimable >= reclaimLimit ? "warning" : "ok",
          area: "disk",
          detail:
            `${formatBytes(reclaimable)} reclaimable ` +
            `(${formatBytes(danglingBytes)} in unused images, ${formatBytes(looseVolumeBytes)} in unreferenced volumes).` +
            (reclaimable >= reclaimLimit ? " Run find_unused_resources for the breakdown." : ""),
        });

        findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
        const critical = findings.filter((f) => f.severity === "critical").length;
        const warnings = findings.filter((f) => f.severity === "warning").length;
        const verdict =
          critical > 0
            ? `NEEDS ATTENTION — ${critical} critical, ${warnings} warning(s).`
            : warnings > 0
              ? `MOSTLY HEALTHY — ${warnings} warning(s), nothing critical.`
              : "HEALTHY — nothing to report.";

        const table = renderTable(
          ["", "AREA", "DETAIL"],
          findings.map((f) => [ICON[f.severity], f.area, f.detail]),
        );
        return ok(`${verdict}\n\n${table}`);
      }),
  );

  server.registerTool(
    "find_restart_loops",
    {
      title: "Find crash-looping containers",
      description:
        "Find containers that keep dying and being restarted, and show the exit " +
        "code plus the tail of their logs — which is almost always where the " +
        "reason is. Saves the usual back-and-forth of ps, then inspect, then logs.",
      inputSchema: {
        minRestarts: z
          .number()
          .min(1)
          .optional()
          .describe("How many restarts count as a loop. Default 3."),
        logLines: z
          .number()
          .min(0)
          .max(200)
          .optional()
          .describe("Lines of log tail per container. Default 15, 0 to skip."),
      },
    },
    async ({ minRestarts, logLines }) =>
      guard(async () => {
        const limit = minRestarts ?? 3;
        const tail = logLines ?? 15;

        const containers = await docker.listContainers(true);
        const offenders: Array<{
          name: string;
          restarts: number;
          exitCode: number | undefined;
          status: string;
          started: string | undefined;
          id: string;
        }> = [];

        for (const c of containers) {
          const detail = await inspectState(docker.raw, c.Id);
          if (!detail) continue;
          const restarts = detail.state.RestartCount ?? 0;
          if (restarts < limit) continue;
          offenders.push({
            name: displayName(c),
            restarts,
            exitCode: detail.state.ExitCode,
            status: detail.state.Status ?? c.State,
            started: detail.state.StartedAt,
            id: c.Id,
          });
        }

        if (!offenders.length) {
          return ok(`No container has restarted ${limit}+ times. Nothing is crash-looping.`);
        }

        offenders.sort((a, b) => b.restarts - a.restarts);
        const table = renderTable(
          ["CONTAINER", "RESTARTS", "STATUS", "EXIT", "LAST START"],
          offenders.map((o) => [
            truncate(o.name, 28),
            String(o.restarts),
            o.status,
            o.exitCode === undefined ? "—" : String(o.exitCode),
            o.started ? formatRelativeTime(Math.floor(Date.parse(o.started) / 1000)) : "—",
          ]),
        );

        const sections: string[] = [`${offenders.length} container(s) crash-looping.\n\n${table}`];

        if (tail > 0) {
          for (const o of offenders) {
            try {
              const buf = (await docker.raw.getContainer(o.id).logs({
                stdout: true,
                stderr: true,
                tail,
                timestamps: false,
              })) as unknown as Buffer;
              // Multiplexed stream framing: strip the 8-byte header per chunk
              // when the daemon returns a non-TTY stream.
              const text = demuxLogs(buf).trim();
              sections.push(`--- ${o.name}: last ${tail} log line(s) ---\n${text || "(no output)"}`);
            } catch {
              sections.push(`--- ${o.name} ---\n(could not read logs)`);
            }
          }
        }

        return ok(sections.join("\n\n"));
      }),
  );

  server.registerTool(
    "find_unused_resources",
    {
      title: "Find reclaimable disk",
      description:
        "Break down what is safe to clean up: images no container uses, volumes " +
        "nothing references, and containers that exited long ago — with the " +
        "space each would return. Read-only: it reports, it never prunes. " +
        "Volumes are listed carefully, because an unreferenced volume is often " +
        "the database of a container you stopped on purpose.",
      inputSchema: {
        deadContainerDays: z
          .number()
          .min(0)
          .optional()
          .describe("List exited containers older than this. Default 7 days."),
      },
    },
    async ({ deadContainerDays }) =>
      guard(async () => {
        const deadAfter = (deadContainerDays ?? 7) * 86_400;

        const usage = (await docker.diskUsage()) as unknown as {
          Images?: Array<{ Id?: string; RepoTags?: string[]; Size?: number; Containers?: number; Created?: number }>;
          Volumes?: Array<{ Name?: string; UsageData?: { Size?: number; RefCount?: number } }>;
        };

        const danglingImages = (usage.Images ?? [])
          .filter((i) => (i.Containers ?? 0) <= 0)
          .map((i) => ({
            tag: i.RepoTags?.filter((t) => t !== "<none>:<none>")[0] ?? `<untagged> ${String(i.Id ?? "").slice(7, 19)}`,
            size: Number(i.Size ?? 0),
            created: Number(i.Created ?? 0),
          }))
          .sort((a, b) => b.size - a.size);

        const looseVolumes = (usage.Volumes ?? [])
          .filter((v) => (v.UsageData?.RefCount ?? 0) <= 0)
          .map((v) => ({ name: String(v.Name ?? ""), size: Number(v.UsageData?.Size ?? 0) }))
          .sort((a, b) => b.size - a.size);

        const containers = await docker.listContainers(true);
        const dead: Array<{ name: string; finished: string }> = [];
        for (const c of containers) {
          if (c.State === "running") continue;
          const detail = await inspectState(docker.raw, c.Id);
          if (!detail) continue;
          if (ageSeconds(detail.state.FinishedAt) < deadAfter) continue;
          dead.push({
            name: displayName(c),
            finished: detail.state.FinishedAt
              ? formatRelativeTime(Math.floor(Date.parse(detail.state.FinishedAt) / 1000))
              : "—",
          });
        }

        const imageBytes = danglingImages.reduce((s, i) => s + i.size, 0);
        const volumeBytes = looseVolumes.reduce((s, v) => s + v.size, 0);

        if (!danglingImages.length && !looseVolumes.length && !dead.length) {
          return ok("Nothing to reclaim: no unused images, unreferenced volumes or stale containers.");
        }

        const parts: string[] = [
          `Reclaimable: ${formatBytes(imageBytes + volumeBytes)} across ` +
            `${danglingImages.length} image(s) and ${looseVolumes.length} volume(s), ` +
            `plus ${dead.length} container(s) that exited over ${deadContainerDays ?? 7} day(s) ago.`,
        ];

        if (danglingImages.length) {
          parts.push(
            `IMAGES no container uses — ${formatBytes(imageBytes)}\n` +
              renderTable(
                ["SIZE", "IMAGE"],
                danglingImages.slice(0, 25).map((i) => [formatBytes(i.size), truncate(i.tag, 60)]),
              ) +
              "\nRemove with `docker image prune -a` (this also drops images you may want to keep offline).",
          );
        }
        if (looseVolumes.length) {
          parts.push(
            `VOLUMES nothing references — ${formatBytes(volumeBytes)}\n` +
              renderTable(
                ["SIZE", "VOLUME"],
                looseVolumes.slice(0, 25).map((v) => [formatBytes(v.size), truncate(v.name, 60)]),
              ) +
              "\nRead these one by one before pruning: an unreferenced volume is often the " +
              "database of a stack you stopped on purpose, and `docker volume prune` is not undoable.",
          );
        }
        if (dead.length) {
          parts.push(
            "CONTAINERS long exited\n" +
              renderTable(
                ["CONTAINER", "EXITED"],
                dead.slice(0, 25).map((d) => [truncate(d.name, 40), d.finished]),
              ),
          );
        }

        return ok(parts.join("\n\n"));
      }),
  );
}
