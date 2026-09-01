/**
 * MCP prompts & resources.
 *
 * Tools answer a question the user already knew how to ask. Prompts are the
 * other half: the client lists them, so the user discovers "why is this
 * container failing" without needing to know that `find_restart_loops`,
 * `get_logs` and `inspect_container` exist or what order to call them in.
 *
 * Resources expose the host as readable context — a client can attach
 * `docker://host/overview` to a conversation instead of the model spending
 * three tool calls rebuilding the same picture.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { formatBytes, formatRelativeTime, renderTable, truncate } from "../utils/format.js";

/** Wrap prompt text in the message envelope the MCP SDK expects. */
function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(ctx: ToolContext): void {
  const { server, docker, config } = ctx;

  // ── Prompts ──────────────────────────────────────────────────────────────

  server.registerPrompt(
    "debug-container",
    {
      title: "Debug a failing container",
      description:
        "Work out why a container is unhealthy, restarting or refusing to " +
        "start, from its logs, config and environment.",
      argsSchema: {
        container: z.string().describe("Container name or id."),
      },
    },
    ({ container }) =>
      userPrompt(
        `Container \`${container}\` is not behaving. Work out why.\n\n` +
          "1. `inspect_container` — state, exit code, restart count, healthcheck.\n" +
          "2. `get_logs` — read the tail, and go further back if the tail is only " +
          "the symptom of something earlier.\n" +
          "3. `list_networks` and `list_volumes` if it looks like connectivity or " +
          "storage rather than the app itself.\n\n" +
          "Then tell me:\n" +
          "- What is actually failing, quoting the log line that shows it.\n" +
          "- Why, if the logs support a conclusion. Say so if they do not — a " +
          "confident wrong diagnosis costs me more than an honest \"not clear yet\".\n" +
          "- The fix, as a command I can run.\n\n" +
          "Do not restart or change anything without asking me first.",
      ),
  );

  server.registerPrompt(
    "audit-host",
    {
      title: "Audit the Docker host",
      description:
        "Read-only sweep of health, waste and risky configuration, ending in a " +
        "short prioritised list of what to do.",
      argsSchema: {
        focus: z
          .enum(["everything", "health", "disk", "security"])
          .optional()
          .describe("Narrow the audit. Defaults to everything."),
      },
    },
    ({ focus }) => {
      const area = focus ?? "everything";
      const steps: Record<string, string[]> = {
        health: [
          "1. `host_health` — the overall picture.",
          "2. `find_restart_loops` — anything crash-looping, with its logs.",
          "3. `list_containers` with all=true — what is down that should be up.",
        ],
        disk: [
          "1. `find_unused_resources` — images, volumes and dead containers.",
          "2. `system_info` — where the disk actually went.",
          "3. `list_images` — duplicated tags and old builds.",
        ],
        security: [
          "1. `list_containers` — what is exposed, and on which ports.",
          "2. `inspect_container` on anything with a published port — is it bound " +
            "to 0.0.0.0 when it only needs loopback?",
          "3. Look for privileged containers, host networking, and the Docker " +
            "socket mounted into a container.",
        ],
        everything: [
          "1. `host_health` — start here.",
          "2. `find_restart_loops` — what is failing right now.",
          "3. `find_unused_resources` — what is wasted.",
          "4. `list_containers` — what is exposed and how.",
        ],
      };
      return userPrompt(
        `Audit my Docker host, focusing on ${area}.\n\n` +
          `${steps[area].join("\n")}\n\n` +
          "Then give me:\n" +
          "- A one-line verdict.\n" +
          "- What needs attention now, worst first, each with the fix.\n" +
          "- What can wait.\n\n" +
          "Only mention findings you actually observed — do not pad the list. If " +
          "nothing is wrong, say so plainly. Read-only: propose actions, do not take them.",
      );
    },
  );

  server.registerPrompt(
    "review-compose",
    {
      title: "Review a Compose stack",
      description:
        "Read a docker-compose file and point out what will bite later: " +
        "missing healthchecks, unpinned images, data that is not persisted.",
      argsSchema: {
        path: z.string().optional().describe("Path to the compose file. Defaults to the discovered one."),
      },
    },
    ({ path }) =>
      userPrompt(
        `Review my Compose stack${path ? ` at \`${path}\`` : ""}.\n\n` +
          "Use `compose_config` to read it, and `list_containers` to see what it " +
          "is doing right now.\n\n" +
          "Look for the things that hurt months later:\n" +
          "- Images pinned to `latest`, so a redeploy silently changes versions.\n" +
          "- Services with no healthcheck, so Compose thinks a broken container is fine.\n" +
          "- State written inside the container instead of a volume — data that a " +
          "`docker compose down` would delete.\n" +
          "- Ports published to 0.0.0.0 that only need to be reachable internally.\n" +
          "- Secrets sitting in environment variables in the file itself.\n" +
          "- No restart policy on something that should survive a reboot.\n\n" +
          "Give me the concrete diff for each, most damaging first. Skip anything " +
          "the file already gets right rather than listing it as praise.",
      ),
  );

  server.registerPrompt(
    "free-up-space",
    {
      title: "Free up disk",
      description:
        "Find reclaimable space and rank it by how much it returns against how " +
        "risky it is to remove.",
      argsSchema: {},
    },
    () =>
      userPrompt(
        "My Docker host is low on disk. Find what I can reclaim.\n\n" +
          "1. `find_unused_resources` — the breakdown.\n" +
          "2. `system_info` — the totals it fits into.\n" +
          "3. `list_images` — old tags and duplicate layers.\n\n" +
          "Rank what you find by (space returned ÷ risk). Give me the exact command " +
          "for each and say what I lose by running it. Volumes go in their own " +
          "section, clearly marked as irreversible — an unreferenced volume is " +
          "often the database of a stack I stopped on purpose. Do not prune anything.",
      ),
  );

  // ── Resources ────────────────────────────────────────────────────────────

  server.registerResource(
    "host-overview",
    "docker://host/overview",
    {
      title: "Host overview",
      description:
        "Containers, images and disk usage in one snapshot. Attach this instead " +
        "of making the model rebuild the same picture from three tool calls.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const [info, containers, images] = await Promise.all([
        docker.info(),
        docker.listContainers(true),
        docker.listImages(),
      ]);

      const containerTable = renderTable(
        ["NAME", "STATE", "IMAGE", "PORTS", "STATUS"],
        containers.map((c) => [
          truncate((c.Names?.[0] ?? c.Id).replace(/^\//, ""), 28),
          c.State,
          truncate(c.Image, 32),
          (c.Ports ?? [])
            .filter((p) => p.PublicPort)
            .map((p) => `${p.PublicPort}→${p.PrivatePort}`)
            .join(", ") || "—",
          truncate(c.Status ?? "", 24),
        ]),
      );

      const imageTable = renderTable(
        ["SIZE", "TAG", "CREATED"],
        images
          .slice()
          .sort((a, b) => b.Size - a.Size)
          .slice(0, 20)
          .map((i) => [
            formatBytes(i.Size),
            truncate(i.RepoTags?.[0] ?? "<untagged>", 44),
            formatRelativeTime(i.Created),
          ]),
      );

      const text = [
        `Docker host overview — generated ${new Date().toISOString()}`,
        `Docker ${String(info.ServerVersion ?? "?")} on ${String(info.OperatingSystem ?? "?")}, ` +
          `${String(info.NCPU ?? "?")} CPU(s), ${formatBytes(Number(info.MemTotal ?? 0))} RAM`,
        "",
        `CONTAINERS (${containers.length}, ${containers.filter((c) => c.State === "running").length} running)`,
        containerTable,
        "",
        `IMAGES (${images.length}, 20 largest)`,
        imageTable,
      ].join("\n");

      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    },
  );

  server.registerResource(
    "capabilities",
    "docker://server/capabilities",
    {
      title: "Server capabilities",
      description:
        "Which plugins are loaded, whether the server is read-only, whether " +
        "exec is allowed, and what the allowlist permits. Read this before " +
        "assuming a tool exists.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const text = [
        `Docker MCP Server — mode: ${config.readOnly ? "READ-ONLY" : "read/write"}`,
        `Exec into containers: ${config.allowExec ? "allowed" : "disabled"}`,
        `Daemon: ${config.dockerHost || "(platform default socket)"}`,
        config.containerAllowlist.length
          ? `Allowlist: only ${config.containerAllowlist.join(", ")} are reachable.`
          : "Allowlist: empty — every container is reachable.",
        "",
        renderTable(
          ["PLUGIN", "ENABLED", "MUTATING", "TITLE"],
          ctx.plugins.map((p) => [p.name, p.enabled ? "yes" : "no", p.mutating ? "yes" : "no", p.title]),
        ),
      ].join("\n");
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    },
  );
}
