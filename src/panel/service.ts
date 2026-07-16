/**
 * Panel & monitoring data service.
 *
 * A UI/monitoring-oriented data layer shared by the panel's REST API, the
 * Prometheus `/metrics` endpoint and the terminal UI. It normalises Docker
 * payloads into compact DTOs, samples live CPU/memory usage, and — crucially —
 * supports a **demo mode** that serves realistic fabricated data (with gentle
 * jitter so it looks alive) for previews, screenshots and client demos.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type Docker from "dockerode";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { DockerClient, normalizeName } from "../docker/client.js";
import { BRAND } from "../branding.js";

/** Compact container row for the UI, including live usage when available. */
export interface ContainerDTO {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string[];
  /** Live CPU percentage (0–100·cores), if sampled. */
  cpu?: number;
  /** Live memory usage in bytes, if sampled. */
  memory?: number;
  /** Memory limit in bytes, if known. */
  memoryLimit?: number;
}

/** Host/daemon summary for the header cards. */
export interface SystemDTO {
  engine: string;
  os: string;
  arch: string;
  cpus: number;
  memoryBytes: number;
  containersRunning: number;
  containersTotal: number;
  images: number;
  demo: boolean;
  readOnly: boolean;
}

/** Image row for the images panel. */
export interface ImageDTO {
  id: string;
  tag: string;
  sizeBytes: number;
}

/** A full point-in-time snapshot used by monitoring & metrics. */
export interface Snapshot {
  system: SystemDTO;
  containers: ContainerDTO[];
  images: ImageDTO[];
  /** Aggregate CPU percentage across running containers. */
  cpuTotal: number;
  /** Aggregate memory bytes across running containers. */
  memoryUsed: number;
}

/** A single entry in a container's filesystem listing. */
export interface FileEntry {
  name: string;
  type: "dir" | "file" | "link";
  size: number;
  /** Symlink target, when known. */
  target?: string;
}

/** An alert raised by the alert engine. */
export interface Alert {
  /** Severity. */
  level: "critical" | "warning" | "info";
  /** Container the alert relates to (or "system"). */
  source: string;
  /** Short rule key, e.g. "container-down", "high-cpu", "log-error". */
  rule: string;
  /** Human-readable message. */
  message: string;
  /** ISO timestamp. */
  time: string;
}

/** Result of running a command in the panel terminal. */
export interface CommandResult {
  command: string;
  code: number;
  output: string;
}

/** A recorded container snapshot/backup. */
export interface SnapshotInfo {
  id: string;
  container: string;
  type: "commit" | "export";
  /** Image ref (commit) or file path (export). */
  ref: string;
  sizeBytes: number;
  createdAt: string;
  destination: string;
}

/** Scheduled backup configuration (in-memory). */
export interface BackupSchedule {
  enabled: boolean;
  /** 24h time "HH:MM" (local) at which the backup runs. */
  time: string;
  /** Container names to back up, or ["all"]. */
  containers: string[];
  type: "commit" | "export";
  /** Optional email address (delivered via the webhook payload). */
  email: string;
}

/** Curated inspect summary for the details drawer. */
export interface InspectSummary {
  name: string;
  image: string;
  id: string;
  created: string;
  state: string;
  health: string;
  restartPolicy: string;
  command: string;
  ports: string[];
  mounts: string[];
  networks: string[];
  env: string[];
}

/** Network row for the System tab. */
export interface NetworkDTO {
  name: string;
  id: string;
  driver: string;
  scope: string;
}

/** Volume row for the System tab. */
export interface VolumeDTO {
  name: string;
  driver: string;
  mountpoint: string;
}

/** Actions the panel can request. */
export type ContainerAction = "start" | "stop" | "restart";

/** Compute CPU % from dockerode's raw accounting deltas. */
function cpuPercent(stats: Docker.ContainerStats): number {
  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    (stats.cpu_stats.system_cpu_usage ?? 0) -
    (stats.precpu_stats.system_cpu_usage ?? 0);
  const cores =
    stats.cpu_stats.online_cpus ??
    stats.cpu_stats.cpu_usage.percpu_usage?.length ??
    1;
  if (systemDelta <= 0 || cpuDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * cores * 100;
}

/** Unified data provider; delegates to Docker or fabricated demo data. */
export class PanelService {
  private readonly demo: boolean;
  /** Demo baselines, mutated with light jitter to feel live. */
  private readonly demoBase = demoContainers();
  /** Names with auto-restart enabled (in-memory registry). */
  private readonly autoRestart = new Set<string>();
  /** Rolling event log of raised alerts (most recent last). */
  private readonly alertLog: Alert[] = [];
  private watchdog: NodeJS.Timeout | null = null;
  /** In-memory snapshot registry. */
  private readonly snapshotLog: SnapshotInfo[] = [];
  /** Backup schedule + scheduler bookkeeping. */
  private schedule: BackupSchedule = { enabled: false, time: "03:00", containers: ["all"], type: "commit", email: "" };
  private scheduler: NodeJS.Timeout | null = null;
  private lastScheduleRun = "";

  constructor(
    private readonly docker: DockerClient,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.demo = config.panel.demo;
    if (this.demo) {
      this.logger.info("Panel running in DEMO mode (mock data).");
      this.snapshotLog.push(
        { id: "snap-1001", container: "postgres", type: "export", ref: "./snapshots/postgres-20260716-0300.tar", sizeBytes: 214_958_080, createdAt: "2026-07-16T03:00:04.000Z", destination: "local + webhook" },
        { id: "snap-1000", container: "api", type: "commit", ref: "soyrage-snapshot/api:20260715-0300", sizeBytes: 189_792_256, createdAt: "2026-07-15T03:00:02.000Z", destination: "local" },
      );
    }
  }

  get isDemo(): boolean {
    return this.demo;
  }
  get isReadOnly(): boolean {
    return this.config.readOnly;
  }

  /** Host summary. */
  async system(): Promise<SystemDTO> {
    if (this.demo) return demoSystem(this.config.readOnly);
    const [info, version] = await Promise.all([
      this.docker.info(),
      this.docker.version(),
    ]);
    return {
      engine: String(version.Version ?? "unknown"),
      os: String(info.OperatingSystem ?? "unknown"),
      arch: String(info.Architecture ?? ""),
      cpus: Number(info.NCPU ?? 0),
      memoryBytes: Number(info.MemTotal ?? 0),
      containersRunning: Number(info.ContainersRunning ?? 0),
      containersTotal: Number(info.Containers ?? 0),
      images: Number(info.Images ?? 0),
      demo: false,
      readOnly: this.config.readOnly,
    };
  }

  /** Container list WITH live usage (CPU %, memory) for running containers. */
  async containers(): Promise<ContainerDTO[]> {
    if (this.demo) return this.demoContainersLive();

    const list = await this.docker.listContainers(true);
    const rows: ContainerDTO[] = list.map((c) => ({
      id: c.Id.slice(0, 12),
      name: normalizeName(c.Names[0] ?? c.Id),
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: (c.Ports ?? [])
        .filter((p) => p.PublicPort)
        .map((p) => `${p.PublicPort}→${p.PrivatePort}/${p.Type}`),
    }));

    // Sample live stats for running containers, in parallel, best-effort.
    await Promise.all(
      rows.map(async (row, index) => {
        if (row.state !== "running") return;
        try {
          const handle = this.docker.raw.getContainer(list[index].Id);
          const stats = (await handle.stats({
            stream: false,
          })) as unknown as Docker.ContainerStats;
          row.cpu = Number(cpuPercent(stats).toFixed(2));
          row.memory = stats.memory_stats.usage ?? 0;
          row.memoryLimit = stats.memory_stats.limit ?? 0;
        } catch {
          /* stats are best-effort; leave undefined */
        }
      }),
    );
    return rows;
  }

  /** Image list. */
  async images(): Promise<ImageDTO[]> {
    if (this.demo) return demoImages();
    const list = await this.docker.listImages();
    return list.flatMap((img) => {
      const tags = img.RepoTags?.length ? img.RepoTags : ["<none>:<none>"];
      return tags.map((tag) => ({
        id: (img.Id ?? "").replace("sha256:", "").slice(0, 12),
        tag,
        sizeBytes: img.Size,
      }));
    });
  }

  /** A full snapshot for monitoring dashboards and the metrics endpoint. */
  async snapshot(): Promise<Snapshot> {
    const [system, containers, images] = await Promise.all([
      this.system(),
      this.containers(),
      this.images(),
    ]);
    const running = containers.filter((c) => c.state === "running");
    const cpuTotal = running.reduce((sum, c) => sum + (c.cpu ?? 0), 0);
    const memoryUsed = running.reduce((sum, c) => sum + (c.memory ?? 0), 0);
    // Bugfix: derive container counts from the actual list so the header cards
    // stay consistent with the grid (e.g. after stopping a container in demo).
    const consistent: SystemDTO = {
      ...system,
      containersTotal: containers.length,
      containersRunning: running.length,
      images: images.length,
    };
    return {
      system: consistent,
      containers,
      images,
      cpuTotal: Number(cpuTotal.toFixed(2)),
      memoryUsed,
    };
  }

  /** Recent logs for one container. */
  async logs(reference: string, tail = 200): Promise<string> {
    if (this.demo) return demoLogs(reference);
    const handle = await this.docker.resolveContainer(reference);
    const raw = (await handle.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    })) as unknown as Buffer;
    return Buffer.from(raw)
      .toString("utf8")
      .replace(/[ --]/g, "")
      .trim();
  }

  /** Perform a lifecycle action. Rejected in read-only mode. */
  async act(reference: string, action: ContainerAction): Promise<void> {
    if (this.config.readOnly) {
      throw new Error("Server is in read-only mode; actions are disabled.");
    }
    if (this.demo) {
      this.logger.info(`(demo) ${action} ${reference}`);
      this.applyDemoAction(reference, action);
      return;
    }
    const handle = await this.docker.resolveContainer(reference);
    if (action === "start") await handle.start();
    else if (action === "stop") await handle.stop({ t: 10 });
    else await handle.restart({ t: 10 });
  }

  // ---- Auto-restart watchdog ---------------------------------------------

  /** Names with auto-restart currently enabled. */
  autoRestartList(): string[] {
    return [...this.autoRestart];
  }

  /** Enable/disable auto-restart for a container. */
  setAutoRestart(name: string, enabled: boolean): void {
    if (enabled) this.autoRestart.add(name);
    else this.autoRestart.delete(name);
    this.logger.info(`Auto-restart ${enabled ? "enabled" : "disabled"} for ${name}`);
  }

  /**
   * Start the background watchdog: every `intervalMs`, any container that has
   * auto-restart enabled but is not running is restarted (unless read-only).
   * Each intervention is recorded as an alert.
   */
  startWatchdog(intervalMs = 5000): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => void this.tickWatchdog(), intervalMs);
    if (typeof this.watchdog.unref === "function") this.watchdog.unref();
  }

  /** Stop the watchdog (used on shutdown). */
  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private async tickWatchdog(): Promise<void> {
    if (this.autoRestart.size === 0 || this.config.readOnly) return;
    try {
      const containers = await this.containers();
      for (const c of containers) {
        if (!this.autoRestart.has(c.name)) continue;
        if (c.state !== "running") {
          this.addAlert({
            level: "warning",
            source: c.name,
            rule: "auto-restart",
            message: `Container "${c.name}" was ${c.state}; auto-restarting.`,
          });
          try {
            await this.act(c.name, "start");
            this.addAlert({
              level: "info",
              source: c.name,
              rule: "auto-restart",
              message: `Container "${c.name}" restarted by watchdog.`,
            });
          } catch (err) {
            this.addAlert({
              level: "critical",
              source: c.name,
              rule: "auto-restart",
              message: `Auto-restart of "${c.name}" failed: ${(err as Error).message}`,
            });
          }
        }
      }
    } catch {
      /* transient; try again next tick */
    }
  }

  // ---- Alerts -------------------------------------------------------------

  /** Append an alert to the rolling log (bounded to the last 200). */
  private addAlert(alert: Omit<Alert, "time">): void {
    this.alertLog.push({ ...alert, time: nowIso() });
    if (this.alertLog.length > 200) this.alertLog.shift();
  }

  /**
   * Compute the current alerts: live state-based rules (down / high CPU / high
   * memory / unhealthy) plus a scan of recent logs for error/warn lines, merged
   * with the rolling event log (watchdog interventions, etc.).
   */
  async alerts(): Promise<Alert[]> {
    const snap = await this.snapshot();
    const active: Alert[] = [];
    const t = nowIso();

    for (const c of snap.containers) {
      if (c.state === "exited" && !this.autoRestart.has(c.name)) {
        active.push({ level: "critical", source: c.name, rule: "container-down", message: `Container "${c.name}" is down (${c.status}).`, time: t });
      }
      if (/unhealthy/i.test(c.status)) {
        active.push({ level: "critical", source: c.name, rule: "unhealthy", message: `Container "${c.name}" reports unhealthy.`, time: t });
      }
      if (c.state === "running") {
        const cpuOfCore = c.cpu ?? 0;
        if (cpuOfCore >= 85) {
          active.push({ level: "warning", source: c.name, rule: "high-cpu", message: `High CPU on "${c.name}": ${cpuOfCore.toFixed(1)}%.`, time: t });
        }
        const memPct = c.memoryLimit ? ((c.memory ?? 0) / c.memoryLimit) * 100 : 0;
        if (memPct >= 85) {
          active.push({ level: "warning", source: c.name, rule: "high-memory", message: `High memory on "${c.name}": ${memPct.toFixed(0)}% of limit.`, time: t });
        }
      }
    }

    // Log-based alerts: scan a short tail of each running container's logs.
    const running = snap.containers.filter((c) => c.state === "running");
    await Promise.all(
      running.map(async (c) => {
        try {
          const text = await this.logs(c.name, 60);
          for (const line of text.split("\n")) {
            if (/\b(error|fatal|panic|exception)\b/i.test(line)) {
              active.push({ level: "warning", source: c.name, rule: "log-error", message: truncate(line, 140), time: t });
              break; // one per container to avoid noise
            }
          }
        } catch {
          /* ignore */
        }
      }),
    );

    // Most recent first: event log then active rules.
    return [...this.alertLog].reverse().concat(active);
  }

  // ---- File browser -------------------------------------------------------

  /** List a directory inside a container. */
  async listFiles(name: string, path = "/"): Promise<{ path: string; entries: FileEntry[] }> {
    const clean = normalizePath(path);
    if (this.demo) return { path: clean, entries: demoListDir(name, clean) };

    const handle = await this.docker.resolveContainer(name);
    const info = await handle.inspect();
    if (!info.State.Running) throw new Error(`Container "${name}" is not running.`);

    // Safe: arguments are passed as an array, never through a shell.
    const out = await this.exec(handle, ["ls", "-la", clean]);
    return { path: clean, entries: parseLsOutput(out) };
  }

  /** Read a text file inside a container (bounded to 128 KB). */
  async readFile(name: string, path: string): Promise<{ path: string; content: string; truncated: boolean }> {
    const clean = normalizePath(path);
    if (this.demo) return { path: clean, content: demoReadFile(name, clean), truncated: false };

    const handle = await this.docker.resolveContainer(name);
    const info = await handle.inspect();
    if (!info.State.Running) throw new Error(`Container "${name}" is not running.`);

    const out = await this.exec(handle, ["cat", clean]);
    const limit = 128 * 1024;
    const truncated = out.length > limit;
    return { path: clean, content: truncated ? out.slice(0, limit) : out, truncated };
  }

  /**
   * Write a text file inside a container (editor save). Blocked in read-only
   * mode. Content is streamed to `sh -c 'cat > "$1"'` with the path passed as
   * an argument (no shell interpolation of the path).
   */
  async writeFile(name: string, path: string, content: string): Promise<{ path: string; bytes: number }> {
    if (this.config.readOnly) throw new Error("Server is read-only; saving is disabled.");
    if (content.length > 256 * 1024) throw new Error("File too large to save from the panel (256 KB max).");
    const clean = normalizePath(path);
    if (this.demo) {
      demoWrite(name, clean, content);
      return { path: clean, bytes: Buffer.byteLength(content) };
    }

    const handle = await this.docker.resolveContainer(name);
    const info = await handle.inspect();
    if (!info.State.Running) throw new Error(`Container "${name}" is not running.`);

    const exec = await handle.exec({
      Cmd: ["sh", "-c", 'cat > "$1"', "sh", clean],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      stream.on("error", rejectPromise);
      stream.on("end", () => resolvePromise());
      stream.on("close", () => resolvePromise());
      stream.end(Buffer.from(content, "utf8"));
    });
    const inspect = await exec.inspect();
    if (inspect.ExitCode && inspect.ExitCode !== 0) {
      throw new Error(`Save failed (exit ${inspect.ExitCode}). Is the path writable?`);
    }
    this.addAlert({ level: "info", source: name, rule: "edit", message: `Saved ${clean}` });
    return { path: clean, bytes: Buffer.byteLength(content) };
  }

  /** Whether the AI copilot is available (demo simulates it). */
  get aiEnabled(): boolean {
    return this.demo || Boolean(this.config.panel.aiEndpoint);
  }

  /**
   * AI copilot. `mode`:
   *  - "command": natural language → a suggested docker command + explanation
   *  - "edit":    rewrite file `context` per the `prompt` instruction
   * Uses an OpenAI-compatible endpoint when configured; falls back to a helpful
   * message (and a heuristic command) otherwise. Demo mode simulates it.
   */
  async aiAssist(
    mode: "command" | "edit",
    prompt: string,
    context = "",
  ): Promise<{ command?: string; explanation?: string; content?: string; text?: string; source: string }> {
    if (this.demo) return demoAi(mode, prompt, context);

    const endpoint = this.config.panel.aiEndpoint;
    if (!endpoint) {
      return {
        source: "unconfigured",
        text: "AI is not configured. Set DOCKER_MCP_AI_ENDPOINT / DOCKER_MCP_AI_KEY / DOCKER_MCP_AI_MODEL — works with OpenAI, Ollama, LM Studio or any OpenAI-compatible API.",
        command: heuristicCommand(prompt),
      };
    }

    const names = (await this.containers()).map((c) => c.name).join(", ");
    const system =
      mode === "edit"
        ? "You are a careful text-file editor. Given a file and an instruction, return ONLY the full new file content — no explanations, no markdown code fences."
        : `You are a Docker CLI copilot. The user describes what they want in plain language. Reply ONLY with a compact JSON object {"command":"<one safe docker command>","explanation":"<one short sentence>"}. Available containers: ${names}. Never invent destructive flags.`;
    const user = mode === "edit" ? `Instruction: ${prompt}\n\n--- FILE ---\n${context}` : prompt;

    const raw = await this.callLLM(endpoint, system, user);
    if (mode === "edit") return { source: "ai", content: stripFences(raw) };
    // command mode: try to parse the JSON object.
    try {
      const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      return { source: "ai", command: String(json.command ?? ""), explanation: String(json.explanation ?? "") };
    } catch {
      return { source: "ai", text: raw };
    }
  }

  /** Minimal OpenAI-compatible chat call. */
  private async callLLM(endpoint: string, system: string, user: string): Promise<string> {
    const url = endpoint.replace(/\/$/, "") + "/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.panel.aiKey ? { Authorization: `Bearer ${this.config.panel.aiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.panel.aiModel,
        temperature: 0.1,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI endpoint returned ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }

  /** Run a command inside a container and return its combined output. */
  private async exec(handle: Docker.Container, cmd: string[]): Promise<string> {
    const exec = await handle.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({});
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      stream.on("data", (d: Buffer) => chunks.push(Buffer.from(d)));
      stream.on("end", () =>
        resolvePromise(
          Buffer.concat(chunks)
            .toString("utf8")
            .replace(/[ --]/g, ""),
        ),
      );
      stream.on("error", rejectPromise);
    });
  }

  // ---- Terminal (docker/compose command runner) --------------------------

  /**
   * Run a `docker …` (or `docker compose …`) command typed in the panel
   * terminal. Commands are parsed into an argv array and spawned WITHOUT a
   * shell (no injection). A deny-list blocks dangerous verbs; write verbs are
   * blocked in read-only mode; read verbs are always allowed.
   */
  async runCommand(input: string): Promise<CommandResult> {
    const argv = parseArgv(input);
    if (argv.length === 0) return { command: input, code: 0, output: "" };
    if (argv[0] !== "docker") {
      return { command: input, code: 1, output: "Only `docker …` commands are allowed here." };
    }
    const sub = argv[1] ?? "";
    if (DENY_SUBCOMMANDS.has(sub)) {
      return { command: input, code: 1, output: `\`docker ${sub}\` is disabled in the panel terminal for safety.` };
    }
    const write = !isReadCommand(argv);
    if (write && this.config.readOnly) {
      return { command: input, code: 1, output: "Server is read-only; this command changes state and is blocked." };
    }
    if (this.demo) {
      return { command: input, code: 0, output: demoCommand(argv) };
    }
    return this.spawnDocker(argv.slice(1), input);
  }

  private spawnDocker(args: string[], command: string): Promise<CommandResult> {
    return new Promise((resolvePromise) => {
      const child = spawn("docker", args, { shell: false, windowsHide: true });
      let out = "";
      const cap = (b: Buffer) => (out += b.toString());
      child.stdout.on("data", cap);
      child.stderr.on("data", cap);
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolvePromise({ command, code: 127, output: e.code === "ENOENT" ? "`docker` CLI not found on PATH." : String(e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ command, code: code ?? -1, output: out.trim() || "(no output)" });
      });
    });
  }

  // ---- Snapshots & scheduled backups -------------------------------------

  /** List recorded snapshots (most recent first). */
  listSnapshots(): SnapshotInfo[] {
    return [...this.snapshotLog];
  }

  /** Create a snapshot of a container (image commit or filesystem export). */
  async createSnapshot(container: string, type: "commit" | "export" = "commit"): Promise<SnapshotInfo> {
    const ts = fileStamp();
    const hasHook = Boolean(this.config.panel.backupWebhook);
    const destination = "local" + (hasHook ? " + webhook" : "");

    let info: SnapshotInfo;
    if (this.demo) {
      info = {
        id: "snap-" + ts,
        container,
        type,
        ref: type === "commit" ? `soyrage-snapshot/${container}:${ts}` : `${this.config.panel.backupDir}/${container}-${ts}.tar`,
        sizeBytes: type === "commit" ? 120_000_000 + Math.floor(Math.random() * 80_000_000) : 180_000_000 + Math.floor(Math.random() * 60_000_000),
        createdAt: nowIso(),
        destination,
      };
    } else if (type === "commit") {
      const ref = `soyrage-snapshot/${container}:${ts}`;
      const handle = await this.docker.resolveContainer(container);
      await handle.commit({ repo: `soyrage-snapshot/${container}`, tag: ts });
      let size = 0;
      try {
        const img = await this.docker.raw.getImage(ref).inspect();
        size = Number(img.Size ?? 0);
      } catch {
        /* size best-effort */
      }
      info = { id: "snap-" + ts, container, type, ref, sizeBytes: size, createdAt: nowIso(), destination };
    } else {
      const dir = isAbsolute(this.config.panel.backupDir)
        ? this.config.panel.backupDir
        : resolve(process.cwd(), this.config.panel.backupDir);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = resolve(dir, `${container}-${ts}.tar`);
      const res = await this.spawnDocker(["export", "-o", file, container], `docker export ${container}`);
      if (res.code !== 0) throw new Error(res.output);
      const size = existsSync(file) ? statSync(file).size : 0;
      info = { id: "snap-" + ts, container, type, ref: file, sizeBytes: size, createdAt: nowIso(), destination };
    }

    this.snapshotLog.unshift(info);
    if (this.snapshotLog.length > 100) this.snapshotLog.pop();
    this.addAlert({ level: "info", source: container, rule: "snapshot", message: `Snapshot created: ${info.ref}` });
    await this.notify(info);
    return info;
  }

  /** Get the current backup schedule. */
  getSchedule(): BackupSchedule {
    return { ...this.schedule };
  }

  /** Update the backup schedule (fields are validated/coerced). */
  setSchedule(next: Record<string, unknown>): BackupSchedule {
    const s = this.schedule;
    if (typeof next.enabled === "boolean") s.enabled = next.enabled;
    if (typeof next.time === "string") {
      const m = /^(\d{1,2}):(\d{2})$/.exec(next.time.trim());
      if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) {
        s.time = `${m[1].padStart(2, "0")}:${m[2]}`;
      }
    }
    if (Array.isArray(next.containers)) s.containers = next.containers.map(String);
    if (next.type === "commit" || next.type === "export") s.type = next.type;
    if (typeof next.email === "string") s.email = next.email;
    this.logger.info(`Backup schedule updated: ${JSON.stringify(s)}`);
    return this.getSchedule();
  }

  /** Start the once-a-minute backup scheduler (idempotent). */
  startScheduler(): void {
    if (this.scheduler) return;
    this.scheduler = setInterval(() => void this.tickScheduler(), 30_000);
    if (typeof this.scheduler.unref === "function") this.scheduler.unref();
  }

  private async tickScheduler(): Promise<void> {
    if (!this.schedule.enabled) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (hhmm !== this.schedule.time) return;
    const key = now.toISOString().slice(0, 16); // dedupe within the minute
    if (key === this.lastScheduleRun) return;
    this.lastScheduleRun = key;

    this.addAlert({ level: "info", source: "system", rule: "backup", message: `Scheduled backup starting (${this.schedule.type}).` });
    try {
      const list = await this.containers();
      const targets = this.schedule.containers.includes("all")
        ? list.filter((c) => c.state === "running").map((c) => c.name)
        : this.schedule.containers;
      for (const name of targets) {
        await this.createSnapshot(name, this.schedule.type);
      }
    } catch (err) {
      this.addAlert({ level: "critical", source: "system", rule: "backup", message: `Scheduled backup failed: ${(err as Error).message}` });
    }
  }

  /** POST a backup notification to the configured webhook (email/cloud bridge). */
  private async notify(snapshot: SnapshotInfo): Promise<void> {
    const url = this.config.panel.backupWebhook;
    if (!url || this.demo) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "backup", product: BRAND.product, author: BRAND.author, email: this.schedule.email || undefined, snapshot }),
      });
    } catch (err) {
      this.addAlert({ level: "warning", source: "system", rule: "notify", message: `Backup webhook failed: ${(err as Error).message}` });
    }
  }

  // ---- Details, networks & volumes ---------------------------------------

  /** Curated inspect summary for the details drawer. */
  async inspectSummary(name: string): Promise<InspectSummary> {
    if (this.demo) return demoInspect(name);
    const handle = await this.docker.resolveContainer(name);
    const d = await handle.inspect();
    const ports = Object.entries(d.NetworkSettings?.Ports ?? {}).flatMap(([k, v]) =>
      (v ?? []).map((b) => `${b.HostPort}→${k}`),
    );
    return {
      name: normalizeName(d.Name),
      image: d.Config?.Image ?? "",
      id: d.Id.slice(0, 12),
      created: d.Created ?? "",
      state: d.State?.Status ?? "",
      health: d.State?.Health?.Status ?? "n/a",
      restartPolicy: d.HostConfig?.RestartPolicy?.Name || "no",
      command: [d.Path, ...(d.Args ?? [])].join(" ").trim(),
      ports: ports.length ? ports : ["—"],
      mounts: (d.Mounts ?? []).map((m) => `${m.Source ?? m.Name ?? "?"} → ${m.Destination}`),
      networks: Object.keys(d.NetworkSettings?.Networks ?? {}),
      env: (d.Config?.Env ?? []).map((e) => redactEnv(e)),
    };
  }

  /** Networks for the System tab. */
  async networks(): Promise<NetworkDTO[]> {
    if (this.demo) return demoNetworks();
    const nets = await this.docker.listNetworks();
    return nets.map((n) => ({ name: n.Name, id: (n.Id ?? "").slice(0, 12), driver: n.Driver ?? "—", scope: n.Scope ?? "—" }));
  }

  /** Volumes for the System tab. */
  async volumes(): Promise<VolumeDTO[]> {
    if (this.demo) return demoVolumes();
    const vols = await this.docker.listVolumes();
    return vols.map((v) => ({ name: v.Name, driver: v.Driver ?? "—", mountpoint: v.Mountpoint ?? "—" }));
  }

  /**
   * Render a snapshot in the Prometheus text exposition format so it can be
   * scraped by Prometheus, Grafana Agent, Zabbix (Prometheus preprocessing or
   * HTTP agent), VictoriaMetrics, etc.
   */
  async prometheus(): Promise<string> {
    const snap = await this.snapshot();
    const L: string[] = [];
    const push = (line: string) => L.push(line);

    // Build info — attribution travels with your monitoring, too. ❤
    push("# HELP dockermcp_build_info Build & author metadata.");
    push("# TYPE dockermcp_build_info gauge");
    push(
      `dockermcp_build_info{product="${esc(BRAND.product)}",author="${esc(
        BRAND.author,
      )}",version="${esc(BRAND.version)}",url="${esc(BRAND.url)}"} 1`,
    );

    push("# HELP dockermcp_up 1 if the exporter is running.");
    push("# TYPE dockermcp_up gauge");
    push("dockermcp_up 1");

    gauge(push, "dockermcp_host_cpus", "Logical CPUs on the host.", snap.system.cpus);
    gauge(push, "dockermcp_host_memory_bytes", "Total host memory in bytes.", snap.system.memoryBytes);
    gauge(push, "dockermcp_containers_total", "Total containers.", snap.system.containersTotal);
    gauge(push, "dockermcp_containers_running", "Running containers.", snap.system.containersRunning);
    gauge(push, "dockermcp_images_total", "Locally cached images.", snap.system.images);
    gauge(push, "dockermcp_cpu_percent_total", "Aggregate container CPU percent.", snap.cpuTotal);
    gauge(push, "dockermcp_memory_used_bytes", "Aggregate container memory bytes.", snap.memoryUsed);

    // Per-container series.
    push("# HELP dockermcp_container_running 1 if the container is running.");
    push("# TYPE dockermcp_container_running gauge");
    for (const c of snap.containers) {
      push(`dockermcp_container_running{${labels(c)}} ${c.state === "running" ? 1 : 0}`);
    }
    push("# HELP dockermcp_container_cpu_percent Container CPU percent.");
    push("# TYPE dockermcp_container_cpu_percent gauge");
    for (const c of snap.containers) {
      push(`dockermcp_container_cpu_percent{${labels(c)}} ${c.cpu ?? 0}`);
    }
    push("# HELP dockermcp_container_memory_bytes Container memory usage in bytes.");
    push("# TYPE dockermcp_container_memory_bytes gauge");
    for (const c of snap.containers) {
      push(`dockermcp_container_memory_bytes{${labels(c)}} ${c.memory ?? 0}`);
    }

    // Auto-restart & alerts (state-based, cheap — no log scanning here).
    gauge(push, "dockermcp_autorestart_enabled", "Containers with auto-restart on.", this.autoRestart.size);
    push("# HELP dockermcp_container_autorestart 1 if auto-restart is enabled.");
    push("# TYPE dockermcp_container_autorestart gauge");
    for (const c of snap.containers) {
      push(`dockermcp_container_autorestart{${labels(c)}} ${this.autoRestart.has(c.name) ? 1 : 0}`);
    }
    const activeAlerts = snap.containers.filter(
      (c) =>
        (c.state === "exited" && !this.autoRestart.has(c.name)) ||
        /unhealthy/i.test(c.status) ||
        (c.state === "running" && (c.cpu ?? 0) >= 85),
    ).length;
    gauge(push, "dockermcp_alerts_active", "Active state-based alerts.", activeAlerts);

    return L.join("\n") + "\n";
  }

  // ---- Demo helpers -------------------------------------------------------

  /** Demo container list with gentle live jitter so usage looks real. */
  private demoContainersLive(): ContainerDTO[] {
    return this.demoBase.map((c) => {
      if (c.state !== "running") return { ...c, cpu: 0, memory: 0 };
      const jitterCpu = Math.max(0, (c.cpu ?? 0) + (Math.random() - 0.5) * 0.8);
      const jitterMem =
        (c.memory ?? 0) * (1 + (Math.random() - 0.5) * 0.06);
      return {
        ...c,
        cpu: Number(jitterCpu.toFixed(2)),
        memory: Math.round(jitterMem),
      };
    });
  }

  /** Reflect a lifecycle action in the demo baseline so the UI updates. */
  private applyDemoAction(reference: string, action: ContainerAction): void {
    const target = this.demoBase.find((c) => c.name === reference);
    if (!target) return;
    if (action === "stop") {
      target.state = "exited";
      target.status = "Exited (0) just now";
    } else {
      target.state = "running";
      target.status = "Up a few seconds";
    }
  }
}

/** Current time as ISO string (kept in one place for testability). */
function nowIso(): string {
  return new Date().toISOString();
}

/** Truncate a string to a max length with an ellipsis. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

/** Normalise and harden a POSIX path (collapse .., strip trailing slash). */
function normalizePath(input: string): string {
  const raw = (input || "/").replace(/\\/g, "/");
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** Parse `ls -la` output into typed entries. */
function parseLsOutput(output: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^total\s/.test(trimmed)) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 9) continue;
    const perms = cols[0];
    const size = Number.parseInt(cols[4], 10) || 0;
    let name = cols.slice(8).join(" ");
    let target: string | undefined;
    let type: FileEntry["type"] = "file";
    if (perms[0] === "d") type = "dir";
    else if (perms[0] === "l") {
      type = "link";
      const arrow = name.indexOf(" -> ");
      if (arrow >= 0) {
        target = name.slice(arrow + 4);
        name = name.slice(0, arrow);
      }
    }
    if (name === "." || name === "..") continue;
    entries.push({ name, type, size, target });
  }
  // Directories first, then alphabetical.
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
}

/** A filesystem-safe timestamp like 20260716-030004. */
function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Redact obvious secrets in an ENV entry (KEY=value). */
function redactEnv(entry: string): string {
  const eq = entry.indexOf("=");
  if (eq < 0) return entry;
  const key = entry.slice(0, eq);
  if (/(pass|secret|token|key|pwd|auth)/i.test(key)) return `${key}=••••••`;
  return entry;
}

/** Split a command line into argv, honouring simple single/double quotes. */
function parseArgv(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input.trim())) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/** Verbs never allowed from the panel terminal (too open/interactive). */
const DENY_SUBCOMMANDS = new Set([
  "run", "swarm", "login", "logout", "context", "plugin", "trust", "secret",
  "node", "service", "attach", "checkpoint",
]);

/** Second-level read verbs for grouped commands. */
const READ_SECONDARY: Record<string, Set<string>> = {
  network: new Set(["ls", "inspect"]),
  volume: new Set(["ls", "inspect"]),
  system: new Set(["df", "info", "events"]),
  compose: new Set(["ps", "config", "logs", "ls", "images", "top"]),
  image: new Set(["ls", "inspect", "history"]),
  container: new Set(["ls", "inspect", "logs", "stats", "top", "port", "diff"]),
};

/** Top-level read verbs (safe even in read-only mode). */
const READ_TOP = new Set([
  "ps", "images", "logs", "inspect", "stats", "top", "version", "info",
  "port", "diff", "history", "events", "df",
]);

/** Decide whether a docker command only reads state. */
function isReadCommand(argv: string[]): boolean {
  const sub = argv[1] ?? "";
  if (READ_TOP.has(sub)) return true;
  const secondary = READ_SECONDARY[sub];
  if (secondary) return secondary.has(argv[2] ?? "");
  return false;
}

/** Escape a Prometheus label value. */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/** Build the common `name`/`state` label set for a container series. */
function labels(c: ContainerDTO): string {
  return `name="${esc(c.name)}",state="${esc(c.state)}",image="${esc(c.image)}"`;
}

/** Emit a single-value gauge with HELP/TYPE headers. */
function gauge(
  push: (l: string) => void,
  name: string,
  help: string,
  value: number,
): void {
  push(`# HELP ${name} ${help}`);
  push(`# TYPE ${name} gauge`);
  push(`${name} ${value}`);
}

// ---------------------------------------------------------------------------
// Demo data — deliberately realistic so the panel & TUI look great out of box.
// ---------------------------------------------------------------------------

function demoSystem(readOnly: boolean): SystemDTO {
  return {
    engine: "27.3.1",
    os: "SoyRage Lab (Debian 12)",
    arch: "x86_64",
    cpus: 8,
    memoryBytes: 33_567_776_768,
    containersRunning: 6,
    containersTotal: 7,
    images: 14,
    demo: true,
    readOnly,
  };
}

function demoContainers(): ContainerDTO[] {
  const GB = 1024 ** 3;
  return [
    { id: "a1b2c3d4e5f6", name: "web", image: "nginx:alpine", state: "running", status: "Up 3 days (healthy)", ports: ["443→443/tcp", "80→80/tcp"], cpu: 0.4, memory: 41_943_040, memoryLimit: GB },
    { id: "b2c3d4e5f6a1", name: "api", image: "soyrage/api:1.8.2", state: "running", status: "Up 3 days (healthy)", ports: ["8080→8080/tcp"], cpu: 3.1, memory: 268_435_456, memoryLimit: 2 * GB },
    { id: "c3d4e5f6a1b2", name: "worker", image: "soyrage/worker:1.8.2", state: "running", status: "Up 3 days", ports: [], cpu: 1.7, memory: 157_286_400, memoryLimit: GB },
    { id: "d4e5f6a1b2c3", name: "postgres", image: "postgres:16-alpine", state: "running", status: "Up 3 days (healthy)", ports: ["5432→5432/tcp"], cpu: 0.9, memory: 402_653_184, memoryLimit: 2 * GB },
    { id: "e5f6a1b2c3d4", name: "redis", image: "redis:7-alpine", state: "running", status: "Up 3 days", ports: ["6379→6379/tcp"], cpu: 0.2, memory: 20_971_520, memoryLimit: 512 * 1024 ** 2 },
    { id: "f6a1b2c3d4e5", name: "grafana", image: "grafana/grafana:11.2.0", state: "running", status: "Up 3 days (healthy)", ports: ["3000→3000/tcp"], cpu: 0.6, memory: 96_468_992, memoryLimit: GB },
    { id: "0a1b2c3d4e5f", name: "backup", image: "soyrage/backup:latest", state: "exited", status: "Exited (0) 6 hours ago", ports: [], cpu: 0, memory: 0, memoryLimit: 0 },
  ];
}

function demoImages(): ImageDTO[] {
  return [
    { id: "9f2a1b7c3d4e", tag: "nginx:alpine", sizeBytes: 24_117_248 },
    { id: "1a2b3c4d5e6f", tag: "soyrage/api:1.8.2", sizeBytes: 189_792_256 },
    { id: "2b3c4d5e6f70", tag: "soyrage/worker:1.8.2", sizeBytes: 176_160_768 },
    { id: "3c4d5e6f7081", tag: "postgres:16-alpine", sizeBytes: 251_658_240 },
    { id: "4d5e6f708192", tag: "redis:7-alpine", sizeBytes: 41_943_040 },
    { id: "5e6f70819203", tag: "grafana/grafana:11.2.0", sizeBytes: 419_430_400 },
  ];
}

function demoLogs(reference: string): string {
  const name = reference.replace(/[^a-zA-Z0-9_-]/g, "") || "container";
  const now = "2026-07-16T09:";
  return [
    `${now}12:03 [info]  ${name}: starting up (SoyRage Lab)`,
    `${now}12:03 [info]  ${name}: configuration loaded from /etc/${name}/config.yaml`,
    `${now}12:04 [info]  ${name}: connected to postgres:5432`,
    `${now}12:04 [info]  ${name}: cache warmed (redis:6379)`,
    `${now}12:05 [info]  ${name}: listening on 0.0.0.0:8080`,
    `${now}18:22 [info]  ${name}: healthcheck ok (12ms)`,
    `${now}31:10 [warn]  ${name}: slow query 214ms — SELECT * FROM events`,
    `${now}47:55 [info]  ${name}: processed 1,204 jobs in the last hour`,
    `${now}59:01 [info]  ${name}: healthcheck ok (9ms)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Demo filesystem — a small, believable tree so the file explorer works
// without a live daemon.
// ---------------------------------------------------------------------------

interface DemoNode {
  type: "dir" | "file" | "link";
  size?: number;
  target?: string;
  content?: string;
  children?: Record<string, DemoNode>;
}

function demoTree(name: string): DemoNode {
  const file = (size: number, content: string): DemoNode => ({ type: "file", size, content });
  return {
    type: "dir",
    children: {
      app: {
        type: "dir",
        children: {
          "server.js": file(4213, `// ${name} entry point — SoyRage Lab\nconst express = require("express");\nconst app = express();\napp.get("/health", (_, res) => res.json({ ok: true }));\napp.listen(8080, () => console.log("${name} listening on :8080"));\n`),
          "package.json": file(612, `{\n  "name": "${name}",\n  "version": "1.8.2",\n  "scripts": { "start": "node server.js" }\n}\n`),
          public: { type: "dir", children: { "index.html": file(198, "<!doctype html><title>SoyRage</title><h1>OK</h1>\n") } },
        },
      },
      etc: {
        type: "dir",
        children: {
          [name]: { type: "dir", children: { "config.yaml": file(340, `service: ${name}\nlog_level: info\ndatabase:\n  host: postgres\n  port: 5432\ncache:\n  host: redis\n  port: 6379\n`) } },
          hostname: file(12, `${name}\n`),
          hosts: file(174, "127.0.0.1\tlocalhost\n172.18.0.4\t" + name + "\n"),
        },
      },
      "var": {
        type: "dir",
        children: {
          log: { type: "dir", children: { "app.log": file(20480, demoLogs(name) + "\n") } },
          "www": { type: "link", target: "/app/public" },
        },
      },
      "entrypoint.sh": file(286, "#!/bin/sh\nset -e\necho \"Starting " + name + "…\"\nexec node /app/server.js\n"),
      ".dockerenv": file(0, ""),
    },
  };
}

function walk(name: string, path: string): DemoNode | null {
  let node: DemoNode = demoTree(name);
  if (path === "/") return node;
  for (const seg of path.split("/")) {
    if (!seg) continue;
    if (node.type !== "dir" || !node.children || !node.children[seg]) return null;
    node = node.children[seg];
  }
  return node;
}

function demoListDir(name: string, path: string): FileEntry[] {
  const node = walk(name, path);
  if (!node) throw new Error(`ls: ${path}: No such file or directory`);
  if (node.type !== "dir" || !node.children) throw new Error(`ls: ${path}: Not a directory`);
  const entries: FileEntry[] = Object.entries(node.children).map(([n, child]) => ({
    name: n,
    type: child.type,
    size: child.size ?? (child.type === "dir" ? 4096 : 0),
    target: child.target,
  }));
  // Merge any overlay files (created/edited in demo mode) living in this dir.
  for (const [key, content] of demoEdits) {
    const [ovName, ovPath] = key.split("::");
    if (ovName !== name || parentDir(ovPath) !== path) continue;
    const base = baseName(ovPath);
    const existing = entries.find((e) => e.name === base);
    if (existing) existing.size = Buffer.byteLength(content);
    else entries.push({ name: base, type: "file", size: Buffer.byteLength(content) });
  }
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
}

/** In-memory overlay so demo-mode file edits persist within a session. */
const demoEdits = new Map<string, string>();
function demoWrite(name: string, path: string, content: string): void {
  demoEdits.set(`${name}::${path}`, content);
}

function demoReadFile(name: string, path: string): string {
  const overlaid = demoEdits.get(`${name}::${path}`);
  if (overlaid !== undefined) return overlaid;
  const node = walk(name, path);
  if (!node) throw new Error(`cat: ${path}: No such file or directory`);
  if (node.type === "dir") throw new Error(`cat: ${path}: Is a directory`);
  if (node.type === "link") return `(symlink → ${node.target})\n`;
  return node.content ?? "";
}

/** Parent directory of a POSIX path. */
function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
function baseName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Strip markdown code fences an LLM may wrap content in. */
function stripFences(text: string): string {
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/m.exec(text.trim());
  return fence ? fence[1] : text;
}

/** Best-effort natural-language → docker command (used as an AI fallback). */
function heuristicCommand(prompt: string): string {
  const p = prompt.toLowerCase();
  const names = demoContainers().map((c) => c.name);
  const target = names.find((n) => p.includes(n)) || "";
  if (/\brestart|reboot\b/.test(p)) return `docker restart ${target || "<container>"}`;
  if (/\bstop|halt|kill\b/.test(p)) return `docker stop ${target || "<container>"}`;
  if (/\bstart|launch|run again\b/.test(p)) return `docker start ${target || "<container>"}`;
  if (/\blog|crash|why|error\b/.test(p)) return `docker logs --tail 100 ${target || "<container>"}`;
  if (/\bstat|cpu|memory|ram|usage|slow\b/.test(p)) return `docker stats${target ? " " + target : ""}`;
  if (/\bimage/.test(p)) return "docker images";
  if (/\bnetwork/.test(p)) return "docker network ls";
  if (/\bvolume/.test(p)) return "docker volume ls";
  if (/\bdisk|space/.test(p)) return "docker system df";
  return "docker ps -a";
}

/** Simulated AI responses for demo mode. */
function demoAi(mode: "command" | "edit", prompt: string, context: string) {
  if (mode === "edit") {
    const banner = `# Edited by the AI copilot (demo) — request: ${prompt.slice(0, 60)}\n`;
    const body = context.startsWith("#") ? context : banner + context;
    return { source: "demo-ai", content: body };
  }
  return {
    source: "demo-ai",
    command: heuristicCommand(prompt),
    explanation: "Suggested from your request (demo AI). Configure DOCKER_MCP_AI_ENDPOINT for a real model.",
  };
}

/** Fabricated `docker …` output for demo mode. */
function demoCommand(argv: string[]): string {
  const sub = argv[1] ?? "";
  const c = demoContainers();
  if (sub === "ps") {
    const rows = c.filter((x) => x.state === "running");
    return (
      "CONTAINER ID   IMAGE                    STATUS               PORTS\n" +
      rows.map((x) => `${x.id}   ${x.image.padEnd(22)}   ${x.status.padEnd(18)}   ${x.ports.join(", ")}`).join("\n")
    );
  }
  if (sub === "images") {
    return (
      "REPOSITORY               TAG        IMAGE ID       SIZE\n" +
      demoImages().map((i) => { const [r, t] = i.tag.split(":"); return `${r.padEnd(22)}   ${(t ?? "latest").padEnd(8)}   ${i.id}   ${(i.sizeBytes / 1048576).toFixed(0)}MB`; }).join("\n")
    );
  }
  if (sub === "version") return "Client: 27.3.1\nServer: Docker Engine 27.3.1 (API 1.47)\n(SoyRage Lab demo)";
  if (sub === "info") return "Containers: 7 (6 running)\nImages: 14\nServer Version: 27.3.1\nOperating System: SoyRage Lab (Debian 12)\nCPUs: 8\nTotal Memory: 31.26GiB";
  if (sub === "stats") return c.filter((x) => x.state === "running").map((x) => `${x.name.padEnd(10)} CPU ${(x.cpu ?? 0).toFixed(1)}%  MEM ${(((x.memory ?? 0) / 1048576) | 0)}MiB`).join("\n");
  if (sub === "logs") return demoLogs(argv[argv.length - 1] || "web");
  if (sub === "network") return "NETWORK ID     NAME       DRIVER    SCOPE\n" + demoNetworks().map((n) => `${n.id}   ${n.name.padEnd(8)}   ${n.driver.padEnd(7)}   ${n.scope}`).join("\n");
  if (sub === "volume") return "DRIVER    VOLUME NAME\n" + demoVolumes().map((v) => `${v.driver.padEnd(7)}   ${v.name}`).join("\n");
  return `(demo) ran: docker ${argv.slice(1).join(" ")}\n✓ ok`;
}

function demoInspect(name: string): InspectSummary {
  const c = demoContainers().find((x) => x.name === name) ?? demoContainers()[0];
  return {
    name: c.name,
    image: c.image,
    id: c.id,
    created: "2026-07-13T08:11:52Z",
    state: c.state,
    health: /healthy/.test(c.status) ? "healthy" : "n/a",
    restartPolicy: "unless-stopped",
    command: name === "web" ? "nginx -g 'daemon off;'" : "node /app/server.js",
    ports: c.ports.length ? c.ports : ["—"],
    mounts: [`/srv/${name}/data → /data`, `soyrage_${name}_conf → /etc/${name}`],
    networks: ["soyrage_net", "bridge"],
    env: ["NODE_ENV=production", "LOG_LEVEL=info", "DB_HOST=postgres", "API_KEY=••••••"],
  };
}

function demoNetworks(): NetworkDTO[] {
  return [
    { name: "soyrage_net", id: "a1c2e3f40506", driver: "bridge", scope: "local" },
    { name: "bridge", id: "0b1c2d3e4f50", driver: "bridge", scope: "local" },
    { name: "host", id: "1c2d3e4f5061", driver: "host", scope: "local" },
    { name: "none", id: "2d3e4f506172", driver: "null", scope: "local" },
  ];
}

function demoVolumes(): VolumeDTO[] {
  return [
    { name: "soyrage_postgres_data", driver: "local", mountpoint: "/var/lib/docker/volumes/soyrage_postgres_data/_data" },
    { name: "soyrage_grafana_data", driver: "local", mountpoint: "/var/lib/docker/volumes/soyrage_grafana_data/_data" },
    { name: "demo-cache-data", driver: "local", mountpoint: "/var/lib/docker/volumes/demo-cache-data/_data" },
  ];
}
