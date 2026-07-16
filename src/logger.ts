/**
 * Tiny structured logger.
 *
 * IMPORTANT: An MCP stdio server communicates with its client over STDOUT.
 * Anything written to STDOUT that is not a JSON-RPC message will corrupt the
 * protocol stream. Therefore every diagnostic line goes to STDERR only.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import type { LogLevel } from "./config.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** A namespaced logger that writes human-readable lines to stderr. */
export class Logger {
  constructor(
    private readonly threshold: LogLevel,
    private readonly scope = "docker-mcp",
  ) {}

  /** Derive a child logger with an extended scope (e.g. "docker-mcp:compose"). */
  child(scope: string): Logger {
    return new Logger(this.threshold, `${this.scope}:${scope}`);
  }

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.threshold]) return;

    const timestamp = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    let line = `${timestamp} ${tag} [${this.scope}] ${message}`;

    if (meta !== undefined) {
      const rendered =
        meta instanceof Error
          ? meta.stack ?? meta.message
          : typeof meta === "string"
            ? meta
            : safeJson(meta);
      line += ` ${rendered}`;
    }

    process.stderr.write(`${line}\n`);
  }
}

/** JSON.stringify that never throws (handles cycles gracefully). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
