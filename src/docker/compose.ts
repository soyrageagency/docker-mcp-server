/**
 * Docker Compose driver.
 *
 * The Docker Engine API does not expose Compose directly, so this module
 * shells out to the official `docker compose` CLI. Every invocation is fully
 * argument-quoted (no shell interpolation) to avoid injection, and file paths
 * are resolved against a configurable base directory.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";

/** Result of a Compose CLI invocation. */
export interface ComposeResult {
  /** Process exit code (0 = success). */
  code: number;
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
}

/** Options accepted by every Compose command. */
export interface ComposeTarget {
  /** Path to a compose file OR a directory containing one. */
  file: string;
  /** Optional explicit project name (`-p`). */
  project?: string;
}

/** Raised when a compose file path cannot be found on disk. */
export class ComposeFileNotFoundError extends Error {
  constructor(path: string) {
    super(`Compose file or directory not found: ${path}`);
    this.name = "ComposeFileNotFoundError";
  }
}

const DEFAULT_COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

/** Drives the `docker compose` CLI in a safe, promisified way. */
export class ComposeDriver {
  private readonly log: Logger;
  private readonly baseCwd: string;

  constructor(config: AppConfig, logger: Logger) {
    this.log = logger.child("compose");
    this.baseCwd = config.composeCwd;
  }

  /**
   * Resolve a caller-supplied path to an absolute compose file. Accepts either
   * a direct file path or a directory (in which case a conventional filename
   * is discovered).
   */
  private resolveComposeFile(file: string): string {
    const absolute = isAbsolute(file) ? file : resolve(this.baseCwd, file);

    if (existsSync(absolute)) {
      // If it's a directory, look for a conventional compose file inside it.
      const asDir = DEFAULT_COMPOSE_FILENAMES.map((name) =>
        resolve(absolute, name),
      ).find((candidate) => existsSync(candidate));
      // existsSync(absolute) is true for both files and dirs; prefer the file
      // itself unless a compose file is found within (directory case).
      return asDir ?? absolute;
    }

    throw new ComposeFileNotFoundError(absolute);
  }

  /** Build the base argument list shared by all subcommands. */
  private baseArgs(target: ComposeTarget): string[] {
    const composeFile = this.resolveComposeFile(target.file);
    const args = ["compose", "-f", composeFile];
    if (target.project) args.push("-p", target.project);
    return args;
  }

  /**
   * Spawn `docker <args>` without a shell. Output is buffered and returned.
   * A non-zero exit code is NOT treated as a throw — callers inspect `code`
   * so they can surface stderr to the LLM verbatim.
   */
  private run(args: string[]): Promise<ComposeResult> {
    this.log.debug("docker " + args.join(" "));

    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("docker", args, {
        cwd: this.baseCwd,
        shell: false,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          rejectPromise(
            new Error(
              "The `docker` CLI was not found on PATH. Compose tools require Docker Desktop or the docker-compose-plugin to be installed.",
            ),
          );
          return;
        }
        rejectPromise(err);
      });

      child.on("close", (code) => {
        resolvePromise({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  /** `docker compose ps` — list the services of a project. */
  ps(target: ComposeTarget): Promise<ComposeResult> {
    return this.run([...this.baseArgs(target), "ps", "--format", "json"]);
  }

  /** `docker compose config` — validate and render the effective config. */
  config(target: ComposeTarget): Promise<ComposeResult> {
    return this.run([...this.baseArgs(target), "config"]);
  }

  /**
   * `docker compose up -d` — deploy/refresh a stack in the background.
   * Optionally rebuilds images and scopes the action to specific services.
   */
  up(
    target: ComposeTarget,
    options: { build?: boolean; services?: string[] } = {},
  ): Promise<ComposeResult> {
    const args = [...this.baseArgs(target), "up", "-d", "--remove-orphans"];
    if (options.build) args.push("--build");
    if (options.services?.length) args.push(...options.services);
    return this.run(args);
  }

  /** `docker compose down` — stop and remove a stack. */
  down(
    target: ComposeTarget,
    options: { volumes?: boolean } = {},
  ): Promise<ComposeResult> {
    const args = [...this.baseArgs(target), "down", "--remove-orphans"];
    if (options.volumes) args.push("--volumes");
    return this.run(args);
  }

  /** `docker compose restart` — restart all or selected services. */
  restart(
    target: ComposeTarget,
    services: string[] = [],
  ): Promise<ComposeResult> {
    return this.run([...this.baseArgs(target), "restart", ...services]);
  }

  /** `docker compose pull` — pull the latest images for a stack. */
  pull(target: ComposeTarget, services: string[] = []): Promise<ComposeResult> {
    return this.run([...this.baseArgs(target), "pull", ...services]);
  }
}
