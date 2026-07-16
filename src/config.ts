/**
 * Runtime configuration.
 *
 * Configuration is layered so the server is *super customizable* without code
 * changes. Precedence, lowest to highest:
 *
 *   1. Built-in defaults (below).
 *   2. An optional JSON config file (`docker-mcp.config.json`, or the path in
 *      `DOCKER_MCP_CONFIG`).
 *   3. A local `.env` file.
 *   4. Real environment variables (what your MCP client passes).
 *
 * This lets a user ship a curated `docker-mcp.config.json` (which plugins are
 * enabled, allowlist, panel port…) and still override anything per-launch.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Supported diagnostic log levels, ordered by verbosity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Shape of the optional JSON config file. All fields are optional. */
interface FileConfig {
  dockerHost?: string;
  dockerCertPath?: string;
  dockerTlsVerify?: boolean;
  readOnly?: boolean;
  allowExec?: boolean;
  containerAllowlist?: string[];
  defaultLogTail?: number;
  composeCwd?: string;
  logLevel?: string;
  plugins?: { enabled?: string[]; disabled?: string[] };
  panel?: { host?: string; port?: number; demo?: boolean };
}

/** Read and parse the JSON config file, if present. Never throws. */
function loadConfigFile(): FileConfig {
  const path = resolve(
    process.cwd(),
    process.env.DOCKER_MCP_CONFIG?.trim() || "docker-mcp.config.json",
  );
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch {
    // A malformed config file should not crash startup; fall back to defaults.
    process.stderr.write(
      `[docker-mcp] Warning: could not parse config file at ${path}; ignoring it.\n`,
    );
    return {};
  }
}

/**
 * Minimal, dependency-free `.env` loader. Existing `process.env` values always
 * win so an MCP client can override the file.
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/** Read a boolean flag with a fallback; accepts `true/1/yes/on`. */
function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/** Read a positive integer with a fallback. */
function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read a comma-separated list, falling back to `fallback` when unset. */
function envList(name: string, fallback: readonly string[]): string[] {
  const value = process.env[name];
  if (value === undefined) return [...fallback];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Read a string with a fallback. */
function envStr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

/** Plugin enable/disable selection. */
export interface PluginSelection {
  /** When non-empty, ONLY these plugins are considered (allowlist). */
  readonly enabled: readonly string[];
  /** Plugins to switch off (applied after `enabled`). */
  readonly disabled: readonly string[];
}

/** Interactive panel settings. */
export interface PanelConfig {
  readonly host: string;
  readonly port: number;
  /** Serve fabricated demo data instead of touching a real daemon. */
  readonly demo: boolean;
}

/** Fully-resolved, immutable server configuration. */
export interface AppConfig {
  readonly dockerHost: string;
  readonly dockerCertPath: string;
  readonly dockerTlsVerify: boolean;
  readonly readOnly: boolean;
  readonly allowExec: boolean;
  readonly containerAllowlist: readonly string[];
  readonly defaultLogTail: number;
  readonly composeCwd: string;
  readonly logLevel: LogLevel;
  readonly plugins: PluginSelection;
  readonly panel: PanelConfig;
}

/** Build the configuration object. Called once from each entry point. */
export function loadConfig(): AppConfig {
  const file = loadConfigFile();
  loadDotEnv();

  const rawLevel = envStr(
    "DOCKER_MCP_LOG_LEVEL",
    file.logLevel ?? "info",
  ).toLowerCase();
  const logLevel: LogLevel = ["debug", "info", "warn", "error"].includes(
    rawLevel,
  )
    ? (rawLevel as LogLevel)
    : "info";

  return Object.freeze({
    dockerHost: envStr("DOCKER_HOST", file.dockerHost ?? ""),
    dockerCertPath: envStr("DOCKER_CERT_PATH", file.dockerCertPath ?? ""),
    dockerTlsVerify: envFlag("DOCKER_TLS_VERIFY", file.dockerTlsVerify ?? false),
    readOnly: envFlag("DOCKER_MCP_READONLY", file.readOnly ?? false),
    allowExec: envFlag("DOCKER_MCP_ALLOW_EXEC", file.allowExec ?? false),
    containerAllowlist: Object.freeze(
      envList("DOCKER_MCP_CONTAINER_ALLOWLIST", file.containerAllowlist ?? []),
    ),
    defaultLogTail: envInt(
      "DOCKER_MCP_DEFAULT_LOG_TAIL",
      file.defaultLogTail ?? 200,
    ),
    composeCwd:
      envStr("DOCKER_MCP_COMPOSE_CWD", file.composeCwd ?? "") || process.cwd(),
    logLevel,
    plugins: Object.freeze({
      enabled: Object.freeze(
        envList("DOCKER_MCP_PLUGINS", file.plugins?.enabled ?? []),
      ),
      disabled: Object.freeze(
        envList("DOCKER_MCP_DISABLED_PLUGINS", file.plugins?.disabled ?? []),
      ),
    }),
    panel: Object.freeze({
      host: envStr("DOCKER_MCP_PANEL_HOST", file.panel?.host ?? "127.0.0.1"),
      port: envInt("DOCKER_MCP_PANEL_PORT", file.panel?.port ?? 4600),
      demo: envFlag("DOCKER_MCP_PANEL_DEMO", file.panel?.demo ?? false),
    }),
  });
}
