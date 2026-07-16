/**
 * Runtime configuration.
 *
 * All server behaviour is driven by environment variables so the same binary
 * can be dropped into any MCP client (Claude Desktop, Cursor, Continue, …)
 * without code changes. Values are parsed and validated once, at startup.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Supported diagnostic log levels, ordered by verbosity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Minimal, dependency-free `.env` loader.
 *
 * We intentionally avoid pulling in `dotenv` to keep the dependency surface
 * tiny. Only `KEY=value` lines are honoured; existing `process.env` values
 * always win so an MCP client can override the file.
 */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;

  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip matching surrounding quotes, if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Read a boolean flag; accepts `true/1/yes/on` (case-insensitive). */
function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/** Read a positive integer, falling back when unset or invalid. */
function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read and normalise a comma-separated list, dropping empty entries. */
function envList(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Fully-resolved, immutable server configuration. */
export interface AppConfig {
  /** Docker Engine endpoint (empty string means "platform default"). */
  readonly dockerHost: string;
  /** Directory holding ca/cert/key PEM files for TLS, if any. */
  readonly dockerCertPath: string;
  /** Whether to verify the daemon's TLS certificate. */
  readonly dockerTlsVerify: boolean;
  /** When true, all mutating tools are hidden. */
  readonly readOnly: boolean;
  /** When true, the `exec_in_container` tool is exposed. */
  readonly allowExec: boolean;
  /** Optional container name/prefix allowlist (empty = allow all). */
  readonly containerAllowlist: readonly string[];
  /** Default number of log lines returned when a caller omits `tail`. */
  readonly defaultLogTail: number;
  /** Base directory used to resolve relative Compose project paths. */
  readonly composeCwd: string;
  /** Diagnostic log level for stderr output. */
  readonly logLevel: LogLevel;
}

/**
 * Build the configuration object. Called once from the entry point.
 * Loading `.env` here (rather than at import time) keeps behaviour explicit
 * and test-friendly.
 */
export function loadConfig(): AppConfig {
  loadDotEnv();

  const level = (process.env.DOCKER_MCP_LOG_LEVEL ?? "info").toLowerCase();
  const logLevel: LogLevel = ["debug", "info", "warn", "error"].includes(level)
    ? (level as LogLevel)
    : "info";

  return Object.freeze({
    dockerHost: process.env.DOCKER_HOST?.trim() ?? "",
    dockerCertPath: process.env.DOCKER_CERT_PATH?.trim() ?? "",
    dockerTlsVerify: envFlag("DOCKER_TLS_VERIFY"),
    readOnly: envFlag("DOCKER_MCP_READONLY"),
    allowExec: envFlag("DOCKER_MCP_ALLOW_EXEC"),
    containerAllowlist: Object.freeze(envList("DOCKER_MCP_CONTAINER_ALLOWLIST")),
    defaultLogTail: envInt("DOCKER_MCP_DEFAULT_LOG_TAIL", 200),
    composeCwd: process.env.DOCKER_MCP_COMPOSE_CWD?.trim() || process.cwd(),
    logLevel,
  });
}
