/**
 * Docker Engine client.
 *
 * Thin, well-typed wrapper around `dockerode`. It centralises connection
 * construction (socket, npipe or secured TCP), applies the optional container
 * allowlist and exposes small helpers the tools build on. Compose operations
 * live in `./compose.ts` because they shell out to the Docker CLI.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Docker from "dockerode";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";

/** Raised when a caller targets a container excluded by the allowlist. */
export class ContainerNotAllowedError extends Error {
  constructor(reference: string) {
    super(
      `Container "${reference}" is not covered by DOCKER_MCP_CONTAINER_ALLOWLIST and cannot be accessed.`,
    );
    this.name = "ContainerNotAllowedError";
  }
}

/** Raised when a referenced container simply does not exist. */
export class ContainerNotFoundError extends Error {
  constructor(reference: string) {
    super(`No container matches "${reference}".`);
    this.name = "ContainerNotFoundError";
  }
}

/**
 * Convert the environment configuration into `dockerode` connection options.
 * Supports three transports:
 *   1. Explicit `unix://` / `npipe://` paths.
 *   2. Secured or plain TCP daemons (`tcp://host:port`), with optional TLS.
 *   3. The platform default socket when nothing is configured.
 */
function buildDockerOptions(config: AppConfig): Docker.DockerOptions {
  const host = config.dockerHost;

  // No host configured → let dockerode pick the platform default socket.
  if (!host) return {};

  if (host.startsWith("unix://")) {
    return { socketPath: host.replace("unix://", "") };
  }

  if (host.startsWith("npipe://")) {
    return { socketPath: host.replace("npipe://", "") };
  }

  // TCP (with or without an explicit tcp:// scheme).
  const url = new URL(host.includes("://") ? host : `tcp://${host}`);
  const useTls = config.dockerTlsVerify || url.protocol === "https:";
  const options: Docker.DockerOptions = {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : useTls ? 2376 : 2375,
    protocol: useTls ? "https" : "http",
  };

  if (useTls && config.dockerCertPath) {
    options.ca = readFileSync(join(config.dockerCertPath, "ca.pem"));
    options.cert = readFileSync(join(config.dockerCertPath, "cert.pem"));
    options.key = readFileSync(join(config.dockerCertPath, "key.pem"));
  }

  return options;
}

/** Normalise a Docker "Names" array or "/name" string into a bare name. */
export function normalizeName(name: string): string {
  return name.replace(/^\//, "");
}

/**
 * Application-facing Docker client. Instances are cheap; one is created at
 * startup and shared across every tool.
 */
export class DockerClient {
  private readonly docker: Docker;
  private readonly log: Logger;
  private readonly allowlist: readonly string[];

  constructor(config: AppConfig, logger: Logger) {
    this.docker = new Docker(buildDockerOptions(config));
    this.log = logger.child("docker");
    this.allowlist = config.containerAllowlist;
  }

  /** Direct access to the underlying dockerode instance (advanced use). */
  get raw(): Docker {
    return this.docker;
  }

  /** Verify connectivity by pinging the daemon. Throws on failure. */
  async ping(): Promise<void> {
    await this.docker.ping();
    this.log.debug("Daemon ping succeeded");
  }

  /**
   * Decide whether a container name is permitted by the allowlist.
   * An empty allowlist permits everything. Matching is prefix-based so a
   * single entry (`web`) covers scaled replicas (`web-1`, `web-2`).
   */
  isAllowed(name: string): boolean {
    if (this.allowlist.length === 0) return true;
    const bare = normalizeName(name);
    return this.allowlist.some(
      (entry) => bare === entry || bare.startsWith(entry),
    );
  }

  /** List containers, honouring the allowlist. */
  async listContainers(all: boolean): Promise<Docker.ContainerInfo[]> {
    const containers = await this.docker.listContainers({ all });
    if (this.allowlist.length === 0) return containers;
    return containers.filter((c) =>
      c.Names.some((n) => this.isAllowed(n)),
    );
  }

  /**
   * Resolve a user-supplied reference (name, short id or full id) to a
   * dockerode Container handle, enforcing the allowlist along the way.
   */
  async resolveContainer(reference: string): Promise<Docker.Container> {
    const ref = normalizeName(reference.trim());
    const containers = await this.docker.listContainers({ all: true });

    const match = containers.find((c) => {
      const byId = c.Id === ref || c.Id.startsWith(ref);
      const byName = c.Names.some((n) => normalizeName(n) === ref);
      return byId || byName;
    });

    if (!match) throw new ContainerNotFoundError(reference);

    const allowed = match.Names.some((n) => this.isAllowed(n));
    if (!allowed) throw new ContainerNotAllowedError(reference);

    return this.docker.getContainer(match.Id);
  }

  /** Fetch a fresh `ContainerInfo` summary for a resolved container. */
  async describeContainer(reference: string): Promise<Docker.ContainerInfo> {
    const container = await this.resolveContainer(reference);
    const containers = await this.docker.listContainers({ all: true });
    const info = containers.find((c) => c.Id === container.id);
    if (!info) throw new ContainerNotFoundError(reference);
    return info;
  }

  /** List images. */
  async listImages(): Promise<Docker.ImageInfo[]> {
    return this.docker.listImages();
  }

  /** List user-defined and default networks. */
  async listNetworks(): Promise<Docker.NetworkInspectInfo[]> {
    return this.docker.listNetworks();
  }

  /** List named volumes. */
  async listVolumes(): Promise<Docker.VolumeInspectInfo[]> {
    const result = await this.docker.listVolumes();
    return result.Volumes ?? [];
  }

  /** Daemon-wide info (`docker info`). */
  async info(): Promise<Record<string, unknown>> {
    return (await this.docker.info()) as Record<string, unknown>;
  }

  /** Disk usage (`docker system df`). */
  async diskUsage(): Promise<Record<string, unknown>> {
    return (await this.docker.df()) as Record<string, unknown>;
  }

  /** Daemon version details (`docker version`). */
  async version(): Promise<Record<string, unknown>> {
    return (await this.docker.version()) as unknown as Record<string, unknown>;
  }
}
