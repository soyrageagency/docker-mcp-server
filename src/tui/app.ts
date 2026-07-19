/**
 * Terminal UI application.
 *
 * A creative, dependency-free TUI in the spirit of lazydocker: a full-screen
 * dashboard with a live container list, per-container CPU/memory gauges, a
 * details/logs pane and one-key lifecycle actions — wrapped in a SoyRage
 * Agency welcome that thanks you for using the repo and asks for a ⭐.
 *
 * Rendering is a hand-rolled ANSI frame (no curses library), which keeps the
 * dependency surface at zero and the styling fully under our control.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { BRAND, ASCII_BANNER } from "../branding.js";
import type { PanelService, ContainerDTO, SystemDTO } from "../panel/service.js";
import {
  bar,
  center,
  color,
  ctl,
  padEnd,
  padStart,
  truncate,
} from "./ansi.js";
import { drawBox } from "./box.js";

/** Humanise bytes for compact display. */
function bytes(n?: number): string {
  if (!n) return "0B";
  const u = ["B", "K", "M", "G", "T"];
  const e = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** e).toFixed(e === 0 ? 0 : 1)}${u[e]}`;
}

type Mode = "splash" | "main";
export type Input = "normal" | "ai" | "confirm" | "message";

/** The interactive terminal application. */
export class TuiApp {
  private mode: Mode = "splash";
  private containers: ContainerDTO[] = [];
  private system: SystemDTO | null = null;
  private selected = 0;
  private showLogs = false;
  private logs = "";
  private status = "";
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private input: Input = "normal";
  private aiInput = "";
  private message = "";
  private messageTitle = "";
  private pending: { label: string; run: () => Promise<void> } | null = null;

  constructor(
    private readonly service: PanelService,
    private readonly out = process.stdout,
    private readonly inp = process.stdin,
  ) {}

  /** Enter alt-screen, wire input, show splash, then run. */
  async start(): Promise<void> {
    this.out.write(ctl.enterAlt + ctl.hideCursor + ctl.clear);
    this.setupInput();
    this.out.on("resize", () => this.render());
    this.renderSplash();
  }

  // ---- Input --------------------------------------------------------------

  private setupInput(): void {
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.resume();
    this.inp.setEncoding("utf8");
    this.inp.on("data", (key: string) => this.onKey(key));
  }

  private onKey(key: string): void {
    // Ctrl-C / Ctrl-D always quit.
    if (key === "\x03" || key === "\x04") return void this.quit();

    if (this.mode === "splash") {
      this.enterMain();
      return;
    }

    if (this.input === "message") { this.message = ""; this.input = "normal"; this.render(); return; }
    if (this.input === "confirm") return this.onConfirmKey(key);
    if (this.input === "ai") return this.onAiKey(key);

    switch (key) {
      case "q":
        return void this.quit();
      case "\x1b[A": // up
      case "k":
        this.move(-1);
        break;
      case "\x1b[B": // down
      case "j":
        this.move(1);
        break;
      case "r":
        this.status = "Refreshing…";
        void this.refresh();
        break;
      case "?":
        this.message = this.helpText(); this.messageTitle = "Keyboard shortcuts"; this.input = "message";
        return this.render();
      case "a":
      case ":":
        if (this.service.aiEnabled) { this.input = "ai"; this.aiInput = ""; this.render(); }
        else { this.status = color.yellow("AI off — set DOCKER_MCP_AI_ENDPOINT (or use demo)."); this.render(); }
        return;
      case "l":
        this.showLogs = !this.showLogs;
        if (this.showLogs) void this.loadLogs();
        else this.render();
        break;
      case "s":
        void this.action("stop");
        break;
      case "S":
        void this.action("start");
        break;
      case "R":
        void this.action("restart");
        break;
      default:
        break;
    }
  }

  private onAiKey(key: string): void {
    if (key === "\x1b") { this.input = "normal"; this.aiInput = ""; this.render(); return; }
    if (key === "\r" || key === "\n") {
      const q = this.aiInput.trim(); this.input = "normal"; this.aiInput = ""; this.render();
      if (q) void this.runAi(q);
      return;
    }
    if (key === "\x7f" || key === "\b") this.aiInput = this.aiInput.slice(0, -1);
    else if (key >= " " && key.length === 1) this.aiInput += key;
    this.render();
  }

  private onConfirmKey(key: string): void {
    const pending = this.pending;
    this.pending = null;
    this.input = "normal";
    if ((key === "y" || key === "Y") && pending) void pending.run();
    else { this.status = color.gray("Cancelled."); this.render(); }
  }

  /** Ask the AI copilot; propose the docker command and confirm before running. */
  private async runAi(prompt: string): Promise<void> {
    this.status = color.gray("AI thinking…");
    this.render();
    try {
      const r = await this.service.aiAssist("command", prompt);
      if (r.command) {
        const label = `AI: ${r.command}${r.explanation ? " — " + r.explanation : ""}`;
        this.pending = { label, run: () => this.runAiCommand(r.command as string) };
        this.input = "confirm"; this.status = ""; this.render();
      } else {
        this.showMessage(r.text || "AI had no suggestion.");
      }
    } catch (err) {
      this.showMessage(`AI error: ${(err as Error).message}`);
    }
  }

  private async runAiCommand(command: string): Promise<void> {
    this.status = color.gray(`Running: ${command}`);
    this.render();
    try {
      const res = await this.service.runCommand(command);
      this.showMessage(`❯ ${command}\n\n${res.output}`, `Command output (exit ${res.code})`);
      await this.refresh();
    } catch (err) {
      this.showMessage(`Error: ${(err as Error).message}`);
    }
  }

  private showMessage(text: string, title = "AI copilot"): void {
    this.message = text; this.messageTitle = title; this.input = "message"; this.status = "";
    this.render();
  }

  private helpText(): string {
    return [
      color.gray("Navigation"),
      "  ↑/↓  j/k     move selection      l  toggle logs",
      "",
      color.gray("Actions"),
      "  S  start     s  stop     R  restart",
      "",
      color.gray("AI copilot"),
      `  ${color.accent("a")}  or  ${color.accent(":")}    give an order in plain language, e.g.:`,
      `     ${color.brightCyan('"restart web"')}   ${color.brightCyan('"why did api crash"')}   ${color.brightCyan('"show running containers"')}`,
      "  The AI proposes a docker command; confirm with y before it runs.",
      "",
      color.gray("General"),
      "  r  refresh      ?  this help      q  quit",
    ].join("\n");
  }

  private move(delta: number): void {
    if (this.containers.length === 0) return;
    this.selected =
      (this.selected + delta + this.containers.length) % this.containers.length;
    this.showLogs = false;
    this.render();
  }

  private current(): ContainerDTO | undefined {
    return this.containers[this.selected];
  }

  // ---- Lifecycle ----------------------------------------------------------

  private async enterMain(): Promise<void> {
    this.mode = "main";
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 3000);
  }

  private async action(kind: "start" | "stop" | "restart"): Promise<void> {
    const c = this.current();
    if (!c) return;
    if (this.service.isReadOnly) {
      this.status = color.yellow("Read-only mode — actions are disabled.");
      this.render();
      return;
    }
    try {
      this.status = `${kind} ${c.name}…`;
      this.render();
      await this.service.act(c.name, kind);
      this.status = color.green(`✓ ${kind} ${c.name}`);
      await this.refresh();
    } catch (err) {
      this.status = color.red(`✗ ${(err as Error).message}`);
      this.render();
    }
  }

  private async loadLogs(): Promise<void> {
    const c = this.current();
    if (!c) return;
    this.logs = "Loading…";
    this.render();
    try {
      this.logs = await this.service.logs(c.name, 200);
    } catch (err) {
      this.logs = `Error: ${(err as Error).message}`;
    }
    this.render();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const snap = await this.service.snapshot();
      this.system = snap.system;
      this.containers = snap.containers;
      if (this.selected >= this.containers.length) this.selected = 0;
      if (this.showLogs) await this.loadLogs();
      else this.render();
    } catch (err) {
      this.status = color.red(`Error: ${(err as Error).message}`);
      this.render();
    } finally {
      this.refreshing = false;
    }
  }

  private quit(): void {
    if (this.timer) clearInterval(this.timer);
    this.out.write(ctl.showCursor + ctl.exitAlt);
    this.out.write(
      `\n  Thanks for using ${color.accent(BRAND.product)} by ${color.bold(
        BRAND.author,
      )} — ${color.brightBlue(BRAND.url)}\n` +
        `  ${color.yellow("★")} If it helped you, please leave a star. See you soon!\n\n`,
    );
    process.exit(0);
  }

  // ---- Rendering ----------------------------------------------------------

  private cols(): number {
    return this.out.columns && this.out.columns > 20 ? this.out.columns : 100;
  }
  private rows(): number {
    return this.out.rows && this.out.rows > 10 ? this.out.rows : 30;
  }

  /** Paint the whole frame from a line array. */
  private paint(lines: string[]): void {
    const cols = this.cols();
    let frame = ctl.home;
    for (let i = 0; i < lines.length; i++) {
      frame += truncate(lines[i], cols) + ctl.clearLine;
      if (i < lines.length - 1) frame += "\n";
    }
    frame += ctl.clearBelow;
    this.out.write(frame);
  }

  /** Build the welcome-splash lines (also used by `--splash` snapshot mode). */
  splashLines(cols = this.cols(), rows = this.rows()): string[] {
    const banner = ASCII_BANNER.split("\n");
    const block = [
      ...banner.map((l) => color.accent(l)),
      "",
      center(color.bold(`Welcome to ${BRAND.product}`), cols),
      center(color.gray(`by ${BRAND.author} · ${BRAND.url}`), cols),
      "",
      center("Thank you for using our repository.", cols),
      center(
        `${color.yellow("★")} If it's useful, please leave a ${color.yellow(
          "star",
        )} and share it.`,
        cols,
      ),
      center(`${color.gray("Support the project:")} ${color.brightBlue(BRAND.donate)}`, cols),
      "",
      center(color.dim("Press any key to launch the dashboard…"), cols),
    ];
    const top = Math.max(1, Math.floor((rows - block.length) / 2));
    return [...Array(top).fill(""), ...block.map((l) => center(l, cols))];
  }

  private renderSplash(): void {
    this.paint(this.splashLines());
  }

  /**
   * Render one static main frame to a string (no cursor control). Used by the
   * `--frame` snapshot mode to document the TUI. Refreshes data first.
   */
  async frame(cols = 100, rows = 30, demoInput?: Input): Promise<string> {
    this.mode = "main";
    const snap = await this.service.snapshot();
    this.system = snap.system;
    this.containers = snap.containers;
    if (demoInput === "ai") { this.input = "ai"; this.aiInput = "restart the web container"; }
    else if (demoInput === "message") {
      this.input = "message"; this.messageTitle = "Command output (exit 0)";
      this.message = "❯ docker restart web-prod\n\nweb-prod\n\nContainer restarted in 1.4s — health check passing.";
    }
    return this.buildMainLines(cols, rows).join("\n");
  }

  private render(): void {
    if (this.mode !== "main") return;
    this.paint(this.buildMainLines(this.cols(), this.rows()));
  }

  private buildMainLines(cols: number, rows: number): string[] {
    const lines: string[] = [];

    lines.push(this.headerLine(cols));
    lines.push(this.resourceLine());

    const bodyHeight = Math.max(6, rows - 5);
    const leftW = Math.max(34, Math.floor(cols * 0.42));
    const rightW = cols - leftW - 1;

    const left = drawBox(
      `Containers (${this.containers.length})`,
      this.containerRows(leftW - 4, bodyHeight - 2),
      leftW,
      bodyHeight,
    );
    const right = drawBox(
      this.showLogs ? `Logs · ${this.current()?.name ?? ""}` : "Details",
      this.showLogs
        ? this.logRows(rightW - 4, bodyHeight - 2)
        : this.detailRows(rightW - 4, bodyHeight - 2),
      rightW,
      bodyHeight,
    );

    for (let i = 0; i < bodyHeight; i++) {
      lines.push(`${left[i] ?? ""} ${right[i] ?? ""}`);
    }

    lines.push(this.footerKeys(cols));
    lines.push(this.footerBrand(cols));
    if (this.input === "message" && this.message) this.overlay(lines, this.messageTitle || "Info", this.message, cols, rows);
    return lines;
  }

  private headerLine(cols: number): string {
    const brand = `${color.accent(color.bold("SOYRAGE"))} ${color.gray(
      "▸",
    )} ${color.bold("Docker TUI")}`;
    const badges: string[] = [];
    if (this.service.isDemo) badges.push(color.yellow(" DEMO "));
    if (this.service.isReadOnly) badges.push(color.brightBlue(" READ-ONLY "));
    const sys = this.system;
    const right = sys
      ? `${color.gray(sys.os)} ${color.dim("·")} Docker ${sys.engine}`
      : "";
    const rightAll = `${badges.join(" ")}  ${right}`;
    const gap = Math.max(1, cols - 1 - (7 + 3 + 10) - stripLen(rightAll));
    return ` ${brand}${" ".repeat(gap)}${rightAll}`;
  }

  private resourceLine(): string {
    const sys = this.system;
    if (!sys) return "";
    const running = this.containers.filter((c) => c.state === "running");
    const cpu = running.reduce((s, c) => s + (c.cpu ?? 0), 0);
    const cpuPct = sys.cpus ? Math.min(100, cpu / sys.cpus) : cpu;
    const mem = running.reduce((s, c) => s + (c.memory ?? 0), 0);
    const memPct = sys.memoryBytes ? (mem / sys.memoryBytes) * 100 : 0;
    const seg = [
      `${color.gray("CPU")} ${bar(cpuPct, 14)} ${padStart(cpuPct.toFixed(1) + "%", 6)}`,
      `${color.gray("MEM")} ${bar(memPct, 14)} ${padStart(bytes(mem), 7)}/${bytes(sys.memoryBytes)}`,
      `${color.gray("Running")} ${sys.containersRunning}/${sys.containersTotal}`,
      `${color.gray("Images")} ${sys.images}`,
    ];
    return " " + seg.join(color.dim("   "));
  }

  private containerRows(width: number, height: number): string[] {
    const rows: string[] = [];
    for (let i = 0; i < this.containers.length && i < height; i++) {
      const c = this.containers[i];
      const dot =
        c.state === "running"
          ? color.green("●")
          : c.state === "exited"
            ? color.red("●")
            : color.yellow("●");
      const cpu = c.state === "running" ? `${(c.cpu ?? 0).toFixed(1)}%` : "—";
      const mem = c.state === "running" ? bytes(c.memory) : "—";
      const name = padEnd(c.name, Math.max(8, width - 20));
      let line = `${dot} ${name} ${padStart(cpu, 6)} ${padStart(mem, 6)}`;
      if (i === this.selected) line = color.bgAccent(padEnd(line, width));
      rows.push(line);
    }
    if (rows.length === 0) rows.push(color.gray("No containers."));
    return rows;
  }

  private detailRows(width: number, height: number): string[] {
    const c = this.current();
    if (!c) return [color.gray("Select a container.")];
    const memPct = c.memoryLimit ? ((c.memory ?? 0) / c.memoryLimit) * 100 : 0;
    const field = (k: string, v: string) =>
      `${color.gray(padEnd(k, 10))} ${v}`;
    const rows = [
      field("Name", color.bold(c.name)),
      field("Image", c.image),
      field("State", c.state === "running" ? color.green(c.state) : color.yellow(c.state)),
      field("Status", c.status),
      field("ID", color.dim(c.id)),
      field("Ports", c.ports.length ? c.ports.join(", ") : color.gray("—")),
      "",
      field("CPU", c.state === "running" ? `${bar(Math.min(100, c.cpu ?? 0), 18)} ${(c.cpu ?? 0).toFixed(1)}%` : color.gray("—")),
      field("Memory", c.state === "running" ? `${bar(memPct, 18)} ${bytes(c.memory)}${c.memoryLimit ? "/" + bytes(c.memoryLimit) : ""}` : color.gray("—")),
      "",
      color.dim("Press [l] to view logs."),
    ];
    return rows.slice(0, height).map((r) => truncate(r, width));
  }

  private logRows(width: number, height: number): string[] {
    const all = this.logs.split("\n");
    const slice = all.slice(-height);
    return slice.map((l) => truncate(colorizeLog(l), width));
  }

  private footerKeys(cols: number): string {
    let keys: string;
    if (this.input === "ai") keys = `${color.accent("AI ❯")} ${color.bold(this.aiInput)}${color.dim("▏")}   ${color.gray("Enter to run · Esc to cancel")}`;
    else if (this.input === "confirm" && this.pending) keys = color.yellow(`${this.pending.label}   run? y / n`);
    else if (this.input === "message") keys = color.gray("press any key to dismiss");
    else keys = this.service.isReadOnly
      ? "↑/↓ move · l logs · a AI · r refresh · ? help · q quit"
      : "↑/↓ · l logs · a AI · S start · s stop · R restart · r · ? help · q";
    const status = this.status && this.input === "normal" ? `  ${this.status}` : "";
    return truncate(` ${color.gray(keys)}${status}`, cols);
  }

  /** Overlay a centered modal box (help / AI answers) onto the frame. */
  private overlay(lines: string[], title: string, text: string, cols: number, rows: number): void {
    const raw = text.split("\n");
    const w = Math.min(cols - 6, Math.max(20, ...raw.map((l) => stripLen(l))) + 4);
    const content = raw.map((l) => ` ${truncate(l, w - 4)}`);
    const box = drawBox(title, content, w, content.length + 2);
    const top = Math.max(1, Math.floor((rows - box.length) / 2));
    const left = Math.max(0, Math.floor((cols - w) / 2));
    for (let i = 0; i < box.length; i++) {
      if (top + i < lines.length) lines[top + i] = " ".repeat(left) + box[i];
    }
  }

  private footerBrand(cols: number): string {
    const text = `${color.accent("SoyRage Agency")} ${color.dim("·")} ${color.brightBlue(BRAND.url)} ${color.dim("·")} ${color.yellow("★")} star us ${color.dim("·")} ${color.dim("support")} ${color.brightBlue(BRAND.donate)}`;
    return " " + text + " ".repeat(Math.max(0, cols - 2 - stripLen(text)));
  }
}

/** Visible length ignoring ANSI (local copy to avoid import churn). */
function stripLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Colour a log line by level keyword. */
function colorizeLog(line: string): string {
  if (/\[error\]|\berror\b/i.test(line)) return color.red(line);
  if (/\[warn\]|\bwarn/i.test(line)) return color.yellow(line);
  if (/\[info\]/i.test(line)) return line.replace(/\[info\]/i, color.green("[info]"));
  return color.gray(line);
}
