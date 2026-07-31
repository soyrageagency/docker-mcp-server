/**
 * Update & announcement channel — a JSON in the repo, read by both faces.
 *
 * A single file (`updates.json`, published at the repo's raw URL) is the source
 * of truth for "is there a newer version, and what changed?". The TUI and the
 * web panel both read it through here: fetch, compare against the running
 * version, and surface a small, dismissable notice with the changelog. No
 * telemetry travels the other way — this is a one-way read of a public file.
 *
 * Three principles, ported from the same pattern elsewhere in the suite:
 *   • Silent on failure. A blocked network or a malformed file must never break
 *     a launch or print a stack trace — you simply get no notice.
 *   • Cached. The remote file is read at most once every few hours (a small file
 *     under ~/.ragedocker), so repeated launches don't hammer the network.
 *   • Opt-out. Set DOCKER_MCP_NO_UPDATE_CHECK=1 (or RAGEDOCKER_NO_UPDATE_CHECK)
 *     and nothing is ever fetched.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../branding.js";
import { isPackaged, readAssetText } from "../assets.js";

/** One shipped release, with a short human changelog. */
export interface Release {
  version: string;
  date: string;
  title: string;
  highlights: string[];
  url: string;
  /** A security or data-loss fix everyone should take promptly. */
  critical?: boolean;
}

/** A note shown regardless of version — news, not a version bump. */
export interface Announcement {
  id: string;
  date: string;
  title: string;
  body: string;
  url?: string;
  level?: "info" | "warning";
}

/** The published channel document. */
export interface UpdateChannel {
  product: string;
  latest: string;
  releases: Release[];
  announcements?: Announcement[];
}

/** What the faces render: the verdict plus the changelog since `current`. */
export interface UpdateStatus {
  current: string;
  latest: string;
  hasUpdate: boolean;
  /** Every release newer than what's running, newest first — the changelog. */
  newer: Release[];
  /** Any release in `newer` marked critical. */
  critical: boolean;
  announcements: Announcement[];
  checkedAt: number;
  source: "network" | "cache" | "bundled";
}

/** Where the published channel lives; overridable for testing / forks. */
export function channelUrl(): string {
  const override = process.env.DOCKER_MCP_UPDATE_URL?.trim();
  if (override) return override;
  return "https://raw.githubusercontent.com/soyrageagency/docker-mcp-server/main/updates.json";
}

/** Has the user turned the whole thing off? */
export function updatesDisabled(): boolean {
  const flag = (process.env.DOCKER_MCP_NO_UPDATE_CHECK ?? process.env.RAGEDOCKER_NO_UPDATE_CHECK ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

/** Compare two dotted numeric versions. Returns >0 if a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.\-+]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.\-+]/).map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // six hours

function cachePath(): string {
  const base = process.env.RAGEDOCKER_HOME?.trim() || join(homedir(), ".ragedocker");
  return join(base, "update-cache.json");
}

/** The copy shipped with the build, so there's always something to show offline. */
function bundledChannel(): UpdateChannel | null {
  try {
    // Standalone binary → read the embedded asset.
    if (isPackaged()) {
      const text = readAssetText("updates.json", "updates.json");
      if (text) return parseChannel(text);
    }
    // dist/update/channel.js → dist/updates.json (copied at build time).
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [resolve(here, "../updates.json"), resolve(here, "../../updates.json")]) {
      if (existsSync(candidate)) return parseChannel(readFileSync(candidate, "utf8"));
    }
  } catch { /* best effort */ }
  return null;
}

function parseChannel(raw: string): UpdateChannel | null {
  try {
    const data = JSON.parse(raw) as Partial<UpdateChannel>;
    if (!data || typeof data.latest !== "string" || !Array.isArray(data.releases)) return null;
    return {
      product: typeof data.product === "string" ? data.product : BRAND.product,
      latest: data.latest,
      releases: data.releases.filter((r): r is Release => Boolean(r && typeof r.version === "string")),
      announcements: Array.isArray(data.announcements) ? data.announcements : [],
    };
  } catch {
    return null;
  }
}

/** Fetch the channel over the network with a short timeout. Null on any failure. */
async function fetchChannel(timeoutMs: number): Promise<UpdateChannel | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(channelUrl(), {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": `${BRAND.product}/${BRAND.version}` },
    });
    if (!res.ok) return null;
    return parseChannel(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readCache(): { at: number; channel: UpdateChannel } | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as { at?: number; channel?: unknown };
    if (typeof raw.at !== "number" || !raw.channel) return null;
    const channel = parseChannel(JSON.stringify(raw.channel));
    return channel ? { at: raw.at, channel } : null;
  } catch {
    return null;
  }
}

function writeCache(channel: UpdateChannel, at: number): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ at, channel }, null, 2), "utf8");
  } catch { /* best effort — a read-only home is fine */ }
}

/** Turn a channel document into the verdict for the running version. */
export function evaluate(channel: UpdateChannel, current: string, source: UpdateStatus["source"], checkedAt: number): UpdateStatus {
  const newer = channel.releases
    .filter((r) => compareVersions(r.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return {
    current,
    latest: channel.latest,
    hasUpdate: compareVersions(channel.latest, current) > 0,
    newer,
    critical: newer.some((r) => r.critical),
    announcements: channel.announcements ?? [],
    checkedAt,
    source,
  };
}

/**
 * The one call the faces make. Returns the status, or null when checking is
 * disabled or nothing could be read at all. `now` is injectable for tests.
 *
 * Freshness: a cache younger than the TTL is used as-is (no network). Otherwise
 * we try the network; on success the cache is refreshed, on failure we fall back
 * to a stale cache, then to the bundled copy.
 */
export async function checkForUpdate(opts: { current?: string; force?: boolean; now?: number; timeoutMs?: number } = {}): Promise<UpdateStatus | null> {
  if (updatesDisabled()) return null;
  const current = opts.current ?? BRAND.version;
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? 4000;

  const cached = readCache();
  if (!opts.force && cached && now - cached.at < CACHE_TTL_MS) {
    return evaluate(cached.channel, current, "cache", cached.at);
  }

  const fresh = await fetchChannel(timeoutMs);
  if (fresh) {
    writeCache(fresh, now);
    return evaluate(fresh, current, "network", now);
  }

  if (cached) return evaluate(cached.channel, current, "cache", cached.at);

  const bundled = bundledChannel();
  if (bundled) return evaluate(bundled, current, "bundled", now);

  return null;
}
