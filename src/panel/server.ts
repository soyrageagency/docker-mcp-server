/**
 * Interactive panel — HTTP server & REST API.
 *
 * A tiny, dependency-free HTTP server (Node core only) that serves the static
 * single-page dashboard and a small JSON API backed by {@link PanelService}.
 * It is intentionally minimal and read-mostly; state-changing endpoints honour
 * the server's read-only mode.
 *
 * Bind address defaults to 127.0.0.1 so the panel is local-only unless you
 * deliberately expose it.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { BRAND } from "../branding.js";
import { PanelService, type ContainerAction } from "./service.js";

/** Directory holding the static SPA assets (index.html, app.js, styles.css). */
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** Read and parse a JSON request body (bounded to 64 KB). */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 65_536) {
        rejectPromise(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(data));
      } catch {
        rejectPromise(new Error("Invalid JSON body."));
      }
    });
    req.on("error", rejectPromise);
  });
}

/** Serve a static asset from PUBLIC_DIR, guarding against path traversal. */
async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = normalize(join(PUBLIC_DIR, rel));

  if (!target.startsWith(PUBLIC_DIR) || !existsSync(target)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const body = await readFile(target);
  res.writeHead(200, {
    "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
  });
  res.end(body);
}

/** Build the panel HTTP server (not yet listening). */
export function createPanelServer(
  service: PanelService,
  config: AppConfig,
  logger: Logger,
) {
  const log = logger.child("panel");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      // ---- REST API ------------------------------------------------------
      if (path === "/api/meta") {
        return sendJson(res, 200, {
          product: BRAND.product,
          author: BRAND.author,
          url: BRAND.url,
          version: BRAND.version,
          demo: service.isDemo,
          readOnly: service.isReadOnly,
        });
      }

      if (path === "/api/system") {
        return sendJson(res, 200, await service.system());
      }

      if (path === "/api/containers") {
        return sendJson(res, 200, await service.containers());
      }

      if (path === "/api/images") {
        return sendJson(res, 200, await service.images());
      }

      if (path === "/api/logs") {
        const name = url.searchParams.get("name") ?? "";
        if (!name) return sendJson(res, 400, { error: "Missing ?name=" });
        const tail = Number(url.searchParams.get("tail") ?? config.defaultLogTail);
        return sendJson(res, 200, { logs: await service.logs(name, tail) });
      }

      if (path === "/api/action" && req.method === "POST") {
        const body = (await readBody(req)) as {
          name?: string;
          action?: string;
        };
        const valid: ContainerAction[] = ["start", "stop", "restart"];
        if (!body.name || !valid.includes(body.action as ContainerAction)) {
          return sendJson(res, 400, { error: "Expected { name, action }." });
        }
        await service.act(body.name, body.action as ContainerAction);
        return sendJson(res, 200, { ok: true });
      }

      // ---- Static SPA ----------------------------------------------------
      if (req.method === "GET") {
        return await serveStatic(res, path);
      }

      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method not allowed");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Internal server error";
      log.error(`Request ${path} failed`, error);
      sendJson(res, 500, { error: message });
    }
  });
}

/** Start the panel and log its URL. Resolves once listening. */
export function startPanel(
  service: PanelService,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const server = createPanelServer(service, config, logger);
  const { host, port } = config.panel;
  return new Promise((resolvePromise) => {
    server.listen(port, host, () => {
      logger.info(`Panel ready at http://${host}:${port}`);
      resolvePromise();
    });
  });
}
