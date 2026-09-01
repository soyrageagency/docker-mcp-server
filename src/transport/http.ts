/**
 * Streamable HTTP transport.
 *
 * The default way to run an MCP server is one process per client, talking over
 * stdio — which means the server has to live on the same machine as the AI
 * client. That is a poor fit for a homelab: the Docker daemon you want to
 * manage is on the server, and the client is your laptop.
 *
 * This serves the same MCP server over HTTP instead, so one instance running
 * beside the daemon answers every machine on the network.
 *
 * Sessions are stateful: each `initialize` mints a session id, which the client
 * echoes back in `Mcp-Session-Id`. A session is torn down when its stream closes
 * or when the client DELETEs it.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpConfig } from "../config.js";
import type { Logger } from "../logger.js";

/** Builds a fresh McpServer for a new session. */
export type ServerFactory = () => McpServer;

/** A live session: its transport and the server instance bound to it. */
interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
}

/** Compare two secrets without leaking their length through timing. */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract the bearer token from an Authorization header, if any. */
function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** A JSON-RPC shaped error, so MCP clients surface something readable. */
function sendRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

/** Read the whole request body. Rejects anything implausibly large. */
async function readBody(req: IncomingMessage, limitBytes = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error("Request body too large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Start the HTTP transport. Resolves once the listener is up; the returned
 * function shuts everything down (listener + every live session).
 */
export async function startHttpTransport(
  config: HttpConfig,
  createMcpServer: ServerFactory,
  logger: Logger,
): Promise<() => Promise<void>> {
  const sessions = new Map<string, Session>();

  // Without this a browser page on any origin could drive the server through
  // the user's own network position. The SDK checks Host/Origin for us.
  const allowedHosts = config.allowedHosts.length
    ? [...config.allowedHosts]
    : [`${config.host}:${config.port}`, `localhost:${config.port}`, `127.0.0.1:${config.port}`];

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // A plain liveness probe, so an LXC/container healthcheck has something to
    // hit that does not need MCP semantics or a token.
    if (url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", sessions: sessions.size });
      return;
    }

    if (url.pathname !== config.path) {
      sendRpcError(res, 404, `Not found. The MCP endpoint is ${config.path}.`);
      return;
    }

    if (config.token && !secretsMatch(bearerToken(req), config.token)) {
      logger.warn(`Rejected an unauthenticated ${req.method} from ${req.socket.remoteAddress}.`);
      res.setHeader("WWW-Authenticate", 'Bearer realm="docker-mcp"');
      sendRpcError(res, 401, "Missing or invalid bearer token.");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res);
      return;
    }

    // GET (stream reconnect) and DELETE (teardown) only make sense for a
    // session we know about; anything else is a stale client.
    if (req.method !== "POST") {
      sendRpcError(res, 400, "Unknown or expired session. Re-initialize.");
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      sendRpcError(res, 400, error instanceof Error ? error.message : "Malformed request body.");
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts,
      ...(config.allowedOrigins.length ? { allowedOrigins: [...config.allowedOrigins] } : {}),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
        logger.info(`MCP session ${id} opened (${sessions.size} active).`);
      },
    });

    // Every session gets its own McpServer: tool state and subscriptions must
    // not leak between clients.
    const server = createMcpServer();

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) {
        logger.info(`MCP session ${id} closed (${sessions.size} active).`);
      }
      void server.close().catch(() => {});
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const http: Server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      logger.error("Unhandled error while serving an MCP request.", error);
      if (!res.headersSent) sendRpcError(res, 500, "Internal error.");
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => {
      http.off("error", reject);
      resolve();
    });
  });

  const endpoint = `http://${config.host}:${config.port}${config.path}`;
  logger.info(`MCP server is ready over Streamable HTTP at ${endpoint}`);
  if (!config.token) {
    logger.warn(
      "No DOCKER_MCP_HTTP_TOKEN set: anyone who can reach this port can control the Docker daemon. " +
        "Set a token, and keep the port behind your VPN.",
    );
  }
  if (config.host === "0.0.0.0" || config.host === "::") {
    logger.warn(`Bound to ${config.host} — reachable from every interface. Make sure that is intended.`);
  }

  return async () => {
    for (const { transport } of sessions.values()) {
      await transport.close().catch(() => {});
    }
    sessions.clear();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
}
