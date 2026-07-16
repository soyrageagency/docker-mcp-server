/**
 * Image inventory tools.
 *
 *   • list_images — show locally cached images with size and age.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import type { ToolContext } from "./context.js";
import {
  formatBytes,
  formatRelativeTime,
  renderTable,
  truncate,
} from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

export function registerImageTools({ server, docker }: ToolContext): void {
  server.registerTool(
    "list_images",
    {
      title: "List images",
      description:
        "List Docker images cached on the host, including repository:tag, " +
        "size and how long ago they were created. Handy for spotting stale " +
        "or oversized images before a cleanup.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const images = await docker.listImages();

        // Flatten one row per repo tag; untagged images show as <none>.
        const rows = images.flatMap((image) => {
          const tags =
            image.RepoTags && image.RepoTags.length > 0
              ? image.RepoTags
              : ["<none>:<none>"];
          return tags.map((tag) => [
            truncate(tag, 40),
            (image.Id ?? "").replace("sha256:", "").slice(0, 12),
            formatBytes(image.Size),
            formatRelativeTime(image.Created),
          ]);
        });

        const table = renderTable(
          ["REPOSITORY:TAG", "IMAGE ID", "SIZE", "CREATED"],
          rows,
        );
        const total = images.reduce((sum, image) => sum + image.Size, 0);

        return ok(
          `${images.length} image(s), ${formatBytes(total)} total on disk.\n\n${table}`,
        );
      }),
  );
}
