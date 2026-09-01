/**
 * AI credentials — where your Claude / ChatGPT keys live.
 *
 * A company laptop shouldn't have API keys scattered through shell profiles and
 * `.env` files. `ragedocker ia login` walks you through it once and writes a
 * single file at `~/.ragedocker/ai.json`, owner-readable only. Everything else —
 * the TUI copilot, the panel's AI terminal — reads from there.
 *
 * Two slots so a team can keep both a shared work key and a personal one, or a
 * fast cheap model alongside a strong one, and switch between them without
 * re-entering anything: `primary` and `secondary`.
 *
 * Environment variables still win when set (`DOCKER_MCP_AI_*`), so an unattended
 * gateway is configured the way it always was; the file is the interactive path
 * for a human at a terminal.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Which AI service an account talks to. */
export type AiProvider = "anthropic" | "openai" | "custom";

/** One configured AI account. The key is a secret; never log or echo it. */
export interface AiAccount {
  provider: AiProvider;
  /** API key / bearer token. */
  key: string;
  /** Model id — sensible default per provider when the user just hits enter. */
  model: string;
  /** Base URL. Fixed for the hosted providers; free-form for "custom". */
  endpoint: string;
  /** A human label so `ia list` reads nicely ("work Claude", "my ChatGPT"). */
  label: string;
}

/** The two slots plus which one is active. */
export interface AiConfig {
  active: "primary" | "secondary";
  primary: AiAccount | null;
  secondary: AiAccount | null;
}

export type AiSlot = "primary" | "secondary";

/** The defaults each provider gets when the user doesn't override them. */
export const PROVIDER_DEFAULTS: Record<AiProvider, { endpoint: string; model: string; label: string; keyHint: string; console: string }> = {
  anthropic: {
    endpoint: "https://api.anthropic.com",
    model: "claude-opus-5",
    label: "Claude",
    keyHint: "sk-ant-…",
    console: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    label: "ChatGPT",
    keyHint: "sk-…",
    console: "https://platform.openai.com/api-keys",
  },
  custom: {
    endpoint: "http://localhost:11434/v1",
    model: "llama3.1",
    label: "Local model",
    keyHint: "(often blank for Ollama / LM Studio)",
    console: "https://ollama.com",
  },
};

const EMPTY: AiConfig = { active: "primary", primary: null, secondary: null };

/** The file we read and write. Honours RAGEDOCKER_HOME for tests and CI. */
export function credentialsPath(): string {
  const base = process.env.RAGEDOCKER_HOME?.trim() || join(homedir(), ".ragedocker");
  return join(base, "ai.json");
}

/** Load the stored config. Never throws; a corrupt file reads as empty. */
export function loadCredentials(): AiConfig {
  const path = credentialsPath();
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AiConfig>;
    return {
      active: raw.active === "secondary" ? "secondary" : "primary",
      primary: normaliseAccount(raw.primary),
      secondary: normaliseAccount(raw.secondary),
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Persist the config, creating the directory and locking the file down. */
export function saveCredentials(config: AiConfig): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  // Keys are secrets: 0600, so no other user on the box can read them.
  try { chmodSync(path, 0o600); } catch { /* Windows / unsupported fs — best effort */ }
}

/** Fill in the defaults for a provider around a key the user supplied. */
export function buildAccount(provider: AiProvider, key: string, model = "", endpoint = "", label = ""): AiAccount {
  const d = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    key: key.trim(),
    model: model.trim() || d.model,
    endpoint: (endpoint.trim() || d.endpoint).replace(/\/+$/, ""),
    label: label.trim() || d.label,
  };
}

/** Write one slot and make it the active one. */
export function setAccount(slot: AiSlot, account: AiAccount): AiConfig {
  const config = loadCredentials();
  config[slot] = account;
  config.active = slot;
  saveCredentials(config);
  return config;
}

/** Switch the active slot (if it has an account). */
export function useSlot(slot: AiSlot): AiConfig {
  const config = loadCredentials();
  if (config[slot]) { config.active = slot; saveCredentials(config); }
  return config;
}

/** Remove one slot, or both when none is named. */
export function clearAccount(slot?: AiSlot): AiConfig {
  const config = loadCredentials();
  if (slot) config[slot] = null;
  else { config.primary = null; config.secondary = null; }
  if (!config[config.active]) config.active = config.primary ? "primary" : "secondary";
  saveCredentials(config);
  return config;
}

/**
 * The account the app should use right now.
 *
 * Precedence: an explicit `DOCKER_MCP_AI_*` environment configuration wins (so
 * a server deployment is unchanged), otherwise the active slot from the file.
 */
export function activeAccount(): AiAccount | null {
  const envKey = process.env.DOCKER_MCP_AI_KEY?.trim();
  const envEndpoint = process.env.DOCKER_MCP_AI_ENDPOINT?.trim();
  if (envKey || envEndpoint) {
    // The legacy env path is OpenAI-compatible; that's what it always was.
    return buildAccount("openai", envKey ?? "", process.env.DOCKER_MCP_AI_MODEL ?? "", envEndpoint ?? "", "env");
  }
  const config = loadCredentials();
  return config[config.active] ?? config.primary ?? config.secondary;
}

/** Mask a key for display — first 6 and last 4, nothing in between. */
export function maskKey(key: string): string {
  if (!key) return "(none)";
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function normaliseAccount(raw: unknown): AiAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.key !== "string" && typeof a.endpoint !== "string") return null;
  const provider: AiProvider = a.provider === "anthropic" || a.provider === "custom" ? a.provider : "openai";
  return buildAccount(provider, String(a.key ?? ""), String(a.model ?? ""), String(a.endpoint ?? ""), String(a.label ?? ""));
}
