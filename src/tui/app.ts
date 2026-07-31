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

import { spawn } from "node:child_process";
import { BRAND, ASCII_BANNER } from "../branding.js";
import type { PanelService, ContainerDTO, SystemDTO, InspectSummary } from "../panel/service.js";
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
import { checkForUpdate, type UpdateStatus } from "../update/channel.js";

/** Humanise bytes for compact display. */
function bytes(n?: number): string {
  if (!n) return "0B";
  const u = ["B", "K", "M", "G", "T"];
  const e = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** e).toFixed(e === 0 ? 0 : 1)}${u[e]}`;
}

type Mode = "splash" | "main";
export type Input = "normal" | "ai" | "confirm" | "message" | "filter" | "volume" | "snapshots" | "menu";
type SortKey = "name" | "cpu" | "mem" | "state";

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
  private update: UpdateStatus | null = null;
  /** Lazy-loaded inspect detail for the selected container (LazyDocker-style). */
  private detail: InspectSummary | null = null;
  private detailFor = "";
  /** An in-flight lifecycle animation (start/stop/restart). */
  private anim: { name: string; kind: string; frame: number; done?: boolean } | null = null;
  private animTimer: NodeJS.Timeout | null = null;
  // View controls.
  private filter = "";
  private sortKey: SortKey = "name";
  private sortDesc = false;
  private frozen = false;
  private freezeOverride = false;
  private logFollow = true;
  private logTail = 200;
  private volumeInput = "";
  // Animation frame ticker (drives the live state glyphs) and the action menu.
  private tick = 0;
  private ticker: NodeJS.Timeout | null = null;
  private menuIndex = 0;
  private menuItems: Array<{ label: string; key?: string; run: () => void }> = [];

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

  private readonly onData = (key: string) => this.onKey(key);

  private setupInput(): void {
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.resume();
    this.inp.setEncoding("utf8");
    this.inp.on("data", this.onData);
  }

  /**
   * Hand the terminal to an interactive child (a shell, an editor), then take it
   * back. We leave the alt-screen and raw mode, detach our key handler, run the
   * child with inherited stdio, and on exit restore everything and repaint.
   */
  private runInteractive(cmd: string, args: string[], note: string): Promise<void> {
    return new Promise((resolvePromise) => {
      if (this.timer) clearInterval(this.timer);
      if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
      this.inp.removeListener("data", this.onData);
      if (this.inp.isTTY) this.inp.setRawMode(false);
      this.out.write(ctl.showCursor + ctl.exitAlt);
      this.out.write(`\n  ${note}\n\n`);

      const child = spawn(cmd, args, { stdio: "inherit" });
      const finish = (line: string) => {
        this.out.write(`\n  ${line}\n  ${"Press any key to return to the dashboard."}\n`);
        // Re-enter our world; the next keypress is swallowed as the "any key".
        const resume = () => {
          this.inp.removeListener("data", resume);
          this.out.write(ctl.enterAlt + ctl.hideCursor + ctl.clear);
          if (this.inp.isTTY) this.inp.setRawMode(true);
          this.inp.on("data", this.onData);
          this.timer = setInterval(() => void this.refresh(), 3000);
          this.ticker = setInterval(() => { this.tick++; if (this.mode === "main") this.render(); }, 220);
          if (typeof this.ticker.unref === "function") this.ticker.unref();
          void this.refresh();
          resolvePromise();
        };
        this.inp.resume();
        this.inp.setEncoding("utf8");
        if (this.inp.isTTY) this.inp.setRawMode(true);
        this.inp.on("data", resume);
      };
      child.on("error", (e: NodeJS.ErrnoException) => finish(e.code === "ENOENT" ? `Command not found: ${cmd}` : String(e)));
      child.on("close", (code) => finish(code === 0 ? "Session ended." : `Exited with code ${code}.`));
    });
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
    if (this.input === "filter") return this.onFilterKey(key);
    if (this.input === "volume") return this.onVolumeKey(key);
    if (this.input === "snapshots") return this.onSnapshotsKey(key);
    if (this.input === "menu") return this.onMenuKey(key);

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
      case "m":
      case "\r":
      case "\n":
        this.openMenu();
        return;
      case "g":
        this.jump("top");
        break;
      case "G":
        this.jump("bottom");
        break;
      case "/":
        this.input = "filter"; this.render();
        return;
      case "o":
        this.cycleSort();
        break;
      case "O":
        this.sortDesc = !this.sortDesc; this.selected = 0; this.render(); void this.loadDetail();
        break;
      case " ":
        this.frozen = !this.frozen;
        this.status = this.frozen ? color.yellow("⏸ Live updates paused (space to resume).") : color.green("▶ Live updates resumed.");
        this.render();
        break;
      case "y":
        this.copyId();
        break;
      case "i":
        void this.showInspect();
        return;
      case "n":
        void this.showNetworks();
        return;
      case "v":
        void this.showVolumes();
        return;
      case "A":
        void this.showAlerts();
        return;
      case "b":
        this.confirmSnapshot();
        return;
      case "B":
        this.openSnapshots();
        return;
      case "e":
        void this.openShell();
        return;
      case "c":
        void this.editCompose();
        return;
      case "V":
        this.startVolume();
        return;
      case "f":
        if (this.showLogs) { this.logFollow = !this.logFollow; this.status = color.gray(`Log follow ${this.logFollow ? "on" : "off"}`); this.render(); }
        break;
      case "+":
      case "=":
        if (this.showLogs) { this.logTail = Math.min(2000, this.logTail + 100); void this.loadLogs(); }
        break;
      case "-":
      case "_":
        if (this.showLogs) { this.logTail = Math.max(50, this.logTail - 100); void this.loadLogs(); }
        break;
      case "r":
        this.status = "Refreshing…";
        this.freezeOverride = true;
        void this.refresh();
        break;
      case "?":
        this.message = this.helpText(); this.messageTitle = "Keyboard shortcuts"; this.input = "message";
        return this.render();
      case "a":
      case ":":
        if (this.service.aiEnabled) { this.input = "ai"; this.aiInput = ""; this.render(); }
        else { this.status = color.yellow("AI off — run 'ragedocker ia login' to sign in to Claude or ChatGPT."); this.render(); }
        return;
      case "l":
        this.showLogs = !this.showLogs;
        if (this.showLogs) void this.loadLogs();
        else this.render();
        break;
      case "u":
        if (this.update?.hasUpdate) {
          this.message = this.changelogText(); this.messageTitle = "What's new"; this.input = "message";
          return this.render();
        }
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

  /** Live-editing the container name/image filter. */
  private onFilterKey(key: string): void {
    if (key === "\x1b") { this.filter = ""; this.input = "normal"; this.selected = 0; this.render(); void this.loadDetail(); return; }
    if (key === "\r" || key === "\n") { this.input = "normal"; this.render(); return; }
    if (key === "\x7f" || key === "\b") this.filter = this.filter.slice(0, -1);
    else if (key >= " " && key.length === 1) this.filter += key;
    this.selected = 0;
    this.render();
    void this.loadDetail();
  }

  /** Typing the "host:container[:ro]" bind spec. */
  private onVolumeKey(key: string): void {
    if (key === "\x1b") { this.input = "normal"; this.volumeInput = ""; this.render(); return; }
    if (key === "\r" || key === "\n") { this.submitVolume(); return; }
    if (key === "\x7f" || key === "\b") this.volumeInput = this.volumeInput.slice(0, -1);
    else if (key >= " " && key.length === 1) this.volumeInput += key;
    this.render();
  }

  /** Cycle the sort column: name → cpu → mem → state → name. */
  private cycleSort(): void {
    const order: SortKey[] = ["name", "cpu", "mem", "state"];
    this.sortKey = order[(order.indexOf(this.sortKey) + 1) % order.length];
    // CPU/mem read most naturally biggest-first.
    this.sortDesc = this.sortKey === "cpu" || this.sortKey === "mem";
    this.selected = 0;
    this.status = color.gray(`Sorted by ${this.sortKey}`);
    this.render();
    void this.loadDetail();
  }

  /** Copy the selected container's full ID to the clipboard (OSC 52). */
  private copyId(): void {
    const c = this.current();
    if (!c) return;
    const b64 = Buffer.from(c.id).toString("base64");
    this.out.write(`\x1b]52;c;${b64}\x07`);
    this.status = color.green(`✓ Copied ${c.name} id to clipboard`);
    this.render();
  }

  /** Full inspect overlay: command, health, networks, mounts and env. */
  private async showInspect(): Promise<void> {
    const c = this.current();
    if (!c) return;
    this.status = color.gray("Inspecting…"); this.render();
    try {
      const d = await this.service.inspectSummary(c.name);
      const lines: string[] = [
        `${color.gray("Name")}     ${color.bold(d.name)}`,
        `${color.gray("Image")}    ${d.image}`,
        `${color.gray("Id")}       ${color.dim(d.id)}`,
        `${color.gray("Created")}  ${d.created}`,
        `${color.gray("State")}    ${d.state}   ${color.gray("Health")} ${healthTag(d.health, c.status)}`,
        `${color.gray("Restart")}  ${d.restartPolicy}`,
        `${color.gray("Command")}  ${d.command}`,
        "",
        color.accent("Networks"), ...(d.networks.length ? d.networks.map((n) => "  " + n) : ["  " + color.gray("none")]),
        "",
        color.accent("Ports"), ...(d.ports.length ? d.ports.map((p) => "  " + p) : ["  " + color.gray("none")]),
        "",
        color.accent("Mounts"), ...(d.mounts.length ? d.mounts.map((m) => "  " + m) : ["  " + color.gray("none")]),
        "",
        color.accent(`Environment (${d.env.length})`), ...(d.env.length ? d.env.map((e) => "  " + color.dim(e)) : ["  " + color.gray("none")]),
      ];
      this.showMessage(lines.join("\n"), `Inspect · ${c.name}`);
    } catch (err) {
      this.showMessage(`Inspect failed: ${(err as Error).message}`);
    }
  }

  /** Networks overlay. */
  private async showNetworks(): Promise<void> {
    this.status = color.gray("Loading networks…"); this.render();
    try {
      const nets = await this.service.networks();
      const body = nets.length
        ? nets.map((n) => `${color.bold(padEnd(n.name, 22))} ${color.gray(padEnd(n.driver, 10))} ${color.dim(n.scope)}  ${color.dim(n.id.slice(0, 12))}`).join("\n")
        : color.gray("No networks.");
      this.showMessage(body, `Networks (${nets.length})`);
    } catch (err) {
      this.showMessage(`Could not list networks: ${(err as Error).message}`);
    }
  }

  /** Volumes overlay. */
  private async showVolumes(): Promise<void> {
    this.status = color.gray("Loading volumes…"); this.render();
    try {
      const vols = await this.service.volumes();
      const body = vols.length
        ? vols.map((v) => `${color.bold(padEnd(v.name, 26))} ${color.gray(padEnd(v.driver, 8))} ${color.dim(v.mountpoint)}`).join("\n")
        : color.gray("No volumes.");
      this.showMessage(body, `Volumes (${vols.length})`);
    } catch (err) {
      this.showMessage(`Could not list volumes: ${(err as Error).message}`);
    }
  }

  /** Current alerts overlay. */
  private async showAlerts(): Promise<void> {
    this.status = color.gray("Checking alerts…"); this.render();
    try {
      const alerts = await this.service.alerts();
      if (!alerts.length) return this.showMessage(color.green("✓ No active alerts. Everything looks healthy."), "Alerts");
      const glyph = (l: string) => l === "critical" ? color.red("●") : l === "warning" ? color.yellow("●") : color.brightBlue("●");
      const body = alerts.map((a) => `${glyph(a.level)} ${color.bold(padEnd(a.source, 16))} ${a.message}`).join("\n");
      this.showMessage(body, `Alerts (${alerts.length})`);
    } catch (err) {
      this.showMessage(`Could not load alerts: ${(err as Error).message}`);
    }
  }

  /** Confirm then snapshot the selected container (image commit). */
  private confirmSnapshot(): void {
    const c = this.current();
    if (!c) return;
    if (this.service.isReadOnly) { this.status = color.yellow("Read-only mode — snapshots are disabled."); this.render(); return; }
    this.pending = {
      label: `Snapshot ${c.name} (docker commit)`,
      run: async () => {
        this.status = color.gray(`Snapshotting ${c.name}…`); this.render();
        try {
          const snap = await this.service.createSnapshot(c.name, "commit");
          this.showMessage(`✓ Snapshot created\n\n${color.gray("ref")}  ${snap.ref}\n${color.gray("size")} ${bytes(snap.sizeBytes)}`, "Snapshot");
        } catch (err) {
          this.showMessage(`Snapshot failed: ${(err as Error).message}`);
        }
      },
    };
    this.input = "confirm"; this.render();
  }

  /** Open an interactive shell inside the selected container (docker exec -it). */
  private async openShell(): Promise<void> {
    const c = this.current();
    if (!c) return;
    if (this.service.isDemo) {
      this.showMessage("Interactive shells aren't available in demo mode.\nRun against a real Docker host to drop into a container.", "Shell");
      return;
    }
    if (c.state !== "running") { this.status = color.yellow(`${c.name} is not running.`); this.render(); return; }
    // Prefer bash, fall back to sh — decided inside the container.
    await this.runInteractive(
      "docker",
      ["exec", "-it", c.name, "sh", "-lc", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
      `${color.accent("❯")} shell in ${color.bold(c.name)}  ${color.dim("(type 'exit' to return)")}`,
    );
  }

  /** Edit a compose file in the user's $EDITOR (suspends the dashboard). */
  private async editCompose(): Promise<void> {
    if (this.service.isDemo) {
      this.showMessage("Compose editing isn't available in demo mode.\nRun against a real host with a docker-compose.yml nearby.", "Compose");
      return;
    }
    const files = this.service.findComposeFiles();
    if (files.length === 0) { this.showMessage("No compose files found near the working directory.\nStart the panel/TUI from a folder with a docker-compose.yml.", "Compose"); return; }
    const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "nano");
    const file = files[0];
    await this.runInteractive(editor, [file], `${color.accent("✎")} editing ${color.bold(file)} ${color.dim("with " + editor)}`);
  }

  /** Open the per-container action menu over the current selection. */
  private openMenu(): void {
    const c = this.current();
    if (!c) return;
    const ro = this.service.isReadOnly;
    const running = c.state === "running";
    const items: Array<{ label: string; key?: string; run: () => void }> = [
      { label: "View logs", key: "l", run: () => { this.showLogs = true; void this.loadLogs(); } },
      { label: "Full inspect", key: "i", run: () => void this.showInspect() },
      { label: "Open shell (exec)", key: "e", run: () => void this.openShell() },
      { label: "Copy id", key: "y", run: () => this.copyId() },
    ];
    if (!ro) {
      if (!running) items.push({ label: "Start", key: "S", run: () => void this.action("start") });
      if (running) items.push({ label: "Stop", key: "s", run: () => void this.action("stop") });
      if (running) items.push({ label: "Restart", key: "R", run: () => void this.action("restart") });
      items.push({ label: "Snapshot (commit)", key: "b", run: () => this.confirmSnapshot() });
      items.push({ label: "Restore a snapshot…", key: "B", run: () => this.openSnapshots() });
      items.push({ label: "Attach a volume…", key: "V", run: () => this.startVolume() });
      items.push({ label: "Edit docker-compose…", key: "c", run: () => void this.editCompose() });
    }
    items.push({ label: "Networks", key: "n", run: () => void this.showNetworks() });
    items.push({ label: "Volumes", key: "v", run: () => void this.showVolumes() });
    items.push({ label: "Alerts", key: "A", run: () => void this.showAlerts() });
    this.menuItems = items;
    this.menuIndex = 0;
    this.input = "menu";
    this.render();
  }

  private onMenuKey(key: string): void {
    const n = this.menuItems.length;
    if (n === 0 || key === "\x1b" || key === "q") { this.input = "normal"; this.render(); return; }
    if (key === "\x1b[A" || key === "k") { this.menuIndex = (this.menuIndex - 1 + n) % n; return this.render(); }
    if (key === "\x1b[B" || key === "j") { this.menuIndex = (this.menuIndex + 1) % n; return this.render(); }
    if (key === "\r" || key === "\n") { const it = this.menuItems[this.menuIndex]; this.input = "normal"; it.run(); return; }
    const hit = this.menuItems.find((i) => i.key === key);
    if (hit) { this.input = "normal"; hit.run(); }
  }

  /** The action-menu body, with the highlighted row and shortcut hints. */
  private menuText(): string {
    const width = Math.max(...this.menuItems.map((i) => (i.label + (i.key ? "  [" + i.key + "]" : "")).length));
    return this.menuItems.map((it, i) => {
      const raw = padEnd(it.label + (it.key ? "  [" + it.key + "]" : ""), width);
      return i === this.menuIndex ? color.bgAccent(" " + raw + " ") : "  " + raw;
    }).join("\n");
  }

  /** Snapshot picker → restore (numbered overlay). */
  private openSnapshots(): void {
    const snaps = this.service.listSnapshots();
    if (snaps.length === 0) { this.showMessage(`No snapshots yet. Press ${color.accent("b")} to create one from the selected container.`, "Snapshots"); return; }
    this.input = "snapshots";
    this.render();
  }

  /** Attach an extra volume via a one-line "host:container[:ro]" prompt. */
  private startVolume(): void {
    const c = this.current();
    if (!c) return;
    if (this.service.isReadOnly) { this.status = color.yellow("Read-only mode — attaching volumes is disabled."); this.render(); return; }
    this.volumeInput = "";
    this.input = "volume";
    this.render();
  }

  private submitVolume(): void {
    const c = this.current();
    const spec = this.volumeInput.trim();
    this.input = "normal"; this.volumeInput = "";
    if (!c || !spec) { this.render(); return; }
    const m = /^([^:]+):([^:]+)(:ro)?$/.exec(spec);
    if (!m) { this.status = color.red('Format: host:container  (add :ro for read-only)'); this.render(); return; }
    const [, hostPath, containerPath, ro] = m;
    this.pending = {
      label: `Recreate ${c.name} with ${hostPath}:${containerPath}${ro ? " (ro)" : ""}`,
      run: async () => {
        this.status = color.gray(`Recreating ${c.name}…`); this.render();
        try {
          const r = await this.service.attachVolume(c.name, hostPath, containerPath, Boolean(ro));
          this.showMessage(`✓ ${r.message}`, "Volume attached");
          await this.refresh();
        } catch (err) {
          this.showMessage(`Attach failed: ${(err as Error).message}`);
        }
      },
    };
    this.input = "confirm"; this.render();
  }

  /** Handle key presses while the snapshot picker is open. */
  private onSnapshotsKey(key: string): void {
    if (key === "\x1b" || key === "q") { this.input = "normal"; this.render(); return; }
    const snaps = this.service.listSnapshots().slice(0, 9);
    const idx = Number(key) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < snaps.length) {
      const snap = snaps[idx];
      this.input = "normal";
      this.pending = {
        label: `Restore ${snap.ref} (${snap.type})`,
        run: async () => {
          this.status = color.gray("Restoring…"); this.render();
          try {
            const r = await this.service.restoreSnapshot(snap.id);
            this.showMessage(`✓ ${r.message}`, "Restore");
            await this.refresh();
          } catch (err) {
            this.showMessage(`Restore failed: ${(err as Error).message}`);
          }
        },
      };
      this.input = "confirm";
      this.render();
    }
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
      `  ${color.accent("Enter")} or ${color.accent("m")}   open the action menu over the selected container`,
      color.gray("Navigation"),
      "  ↑/↓  j/k     move selection      g/G  top / bottom",
      "  /            filter by name/image      o  cycle sort   O  reverse",
      "  space        pause / resume live updates",
      "",
      color.gray("Inspect"),
      "  l  logs      i  full inspect      y  copy id to clipboard",
      "  n  networks  v  volumes           A  alerts",
      "  In logs:  f follow · +/- change tail length",
      "",
      color.gray("Actions"),
      "  S  start     s  stop     R  restart",
      "  b  snapshot   B  restore a snapshot   V  attach a volume",
      "  e  shell into container   c  edit docker-compose ($EDITOR)",
      "",
      color.gray("AI copilot"),
      `  ${color.accent("a")}  or  ${color.accent(":")}    give an order in plain language, e.g.:`,
      `     ${color.brightCyan('"restart web"')}   ${color.brightCyan('"why did api crash"')}   ${color.brightCyan('"show running containers"')}`,
      "  The AI proposes a docker command; confirm with y before it runs.",
      "",
      color.gray("General"),
      "  r  refresh      u  what's new      ?  this help      q  quit",
    ].join("\n");
  }

  /** Containers after the active filter and sort — what the list actually shows. */
  private visible(): ContainerDTO[] {
    const f = this.filter.trim().toLowerCase();
    const list = f
      ? this.containers.filter((c) => c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f))
      : this.containers.slice();
    const dir = this.sortDesc ? -1 : 1;
    list.sort((a, b) => {
      switch (this.sortKey) {
        case "cpu": return dir * ((a.cpu ?? 0) - (b.cpu ?? 0));
        case "mem": return dir * ((a.memory ?? 0) - (b.memory ?? 0));
        case "state": return dir * a.state.localeCompare(b.state);
        default: return dir * a.name.localeCompare(b.name);
      }
    });
    return list;
  }

  private move(delta: number): void {
    const list = this.visible();
    if (list.length === 0) return;
    this.selected = (this.selected + delta + list.length) % list.length;
    this.showLogs = false;
    this.render();
    void this.loadDetail();
  }

  /** Jump to the first or last row. */
  private jump(to: "top" | "bottom"): void {
    const list = this.visible();
    if (list.length === 0) return;
    this.selected = to === "top" ? 0 : list.length - 1;
    this.showLogs = false;
    this.render();
    void this.loadDetail();
  }

  /** Fetch the inspect summary for the selected container, once, lazily. */
  private async loadDetail(): Promise<void> {
    const c = this.current();
    if (!c) { this.detail = null; this.detailFor = ""; return; }
    if (this.detailFor === c.id) return;
    this.detailFor = c.id;
    this.detail = null;
    try {
      const d = await this.service.inspectSummary(c.name);
      if (this.current()?.id === c.id) { this.detail = d; if (!this.showLogs && this.mode === "main") this.render(); }
    } catch { /* details are a bonus, never fatal */ }
  }

  private current(): ContainerDTO | undefined {
    return this.visible()[this.selected];
  }

  // ---- Lifecycle ----------------------------------------------------------

  private async enterMain(): Promise<void> {
    this.mode = "main";
    await this.refresh();
    void this.loadDetail();
    this.timer = setInterval(() => void this.refresh(), 3000);
    // A gentle frame ticker so the state glyphs breathe / spin / blink.
    this.ticker = setInterval(() => {
      this.tick++;
      if (this.mode === "main") this.render();
    }, 220);
    if (typeof this.ticker.unref === "function") this.ticker.unref();
    void this.checkUpdate();
  }

  /** Fetch the update channel once in the background; silent on any failure. */
  private async checkUpdate(): Promise<void> {
    try {
      const status = await checkForUpdate();
      if (status?.hasUpdate) {
        this.update = status;
        if (this.mode === "main" && this.input === "normal") this.render();
      }
    } catch { /* an update notice is a nicety, never an error */ }
  }

  private async action(kind: "start" | "stop" | "restart"): Promise<void> {
    const c = this.current();
    if (!c) return;
    if (this.service.isReadOnly) {
      this.status = color.yellow("Read-only mode — actions are disabled.");
      this.render();
      return;
    }
    // Animate the row while the daemon works — a pulsing spinner, held for at
    // least a beat so even an instant (demo) action reads as motion.
    this.startAnim(c.name, kind);
    const floor = new Promise<void>((r) => setTimeout(r, 850));
    try {
      await Promise.all([this.service.act(c.name, kind), floor]);
      this.stopAnim();
      this.status = color.green(`✓ ${verb(kind)} ${c.name}`);
      await this.refresh();
    } catch (err) {
      this.stopAnim();
      this.status = color.red(`✗ ${(err as Error).message}`);
      this.render();
    }
  }

  /** Begin the lifecycle spinner and drive its frames. */
  private startAnim(name: string, kind: string): void {
    this.anim = { name, kind, frame: 0 };
    if (this.animTimer) clearInterval(this.animTimer);
    this.animTimer = setInterval(() => {
      if (this.anim) { this.anim.frame++; this.render(); }
    }, 80);
    this.render();
  }

  private stopAnim(): void {
    if (this.animTimer) { clearInterval(this.animTimer); this.animTimer = null; }
    this.anim = null;
  }

  private async loadLogs(): Promise<void> {
    const c = this.current();
    if (!c) return;
    this.logs = "Loading…";
    this.render();
    try {
      this.logs = await this.service.logs(c.name, this.logTail);
    } catch (err) {
      this.logs = `Error: ${(err as Error).message}`;
    }
    this.render();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    // A frozen view still refreshes on an explicit [r]; the timer path skips it.
    if (this.frozen && !this.freezeOverride) return;
    this.freezeOverride = false;
    this.refreshing = true;
    try {
      const snap = await this.service.snapshot();
      this.system = snap.system;
      this.containers = snap.containers;
      if (this.selected >= this.visible().length) this.selected = 0;
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
    if (this.animTimer) clearInterval(this.animTimer);
    if (this.ticker) clearInterval(this.ticker);
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
    await this.loadDetail();
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

    const banner = this.updateBanner(cols);
    if (banner) lines.push(banner);

    const bodyHeight = Math.max(6, rows - 5 - (banner ? 1 : 0));
    const leftW = Math.max(34, Math.floor(cols * 0.42));
    const rightW = cols - leftW - 1;

    const shown = this.visible().length;
    const total = this.containers.length;
    const countLabel = shown === total ? `${total}` : `${shown}/${total}`;
    const sortLabel = color.dim(` ↕${this.sortKey}${this.sortDesc ? "↓" : "↑"}`);
    const left = drawBox(
      `Containers (${countLabel})${this.filter ? color.dim(" /" + this.filter) : ""}${sortLabel}`,
      this.containerRows(leftW - 4, bodyHeight - 2),
      leftW,
      bodyHeight,
    );
    const right = drawBox(
      this.showLogs
        ? `Logs · ${this.current()?.name ?? ""} ${color.dim(`(tail ${this.logTail}${this.logFollow ? " · following" : ""})`)}`
        : "Details",
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
    if (this.input === "snapshots") this.overlay(lines, "Restore a snapshot", this.snapshotsText(), cols, rows);
    if (this.input === "menu") this.overlay(lines, `☰ ${this.current()?.name ?? "Actions"}`, this.menuText(), cols, rows);
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
    const animating = this.anim;
    const list = this.visible();
    for (let i = 0; i < list.length && i < height; i++) {
      const c = list[i];
      const isAnim = animating && animating.name === c.name;
      const dot = isAnim
        ? color.accent(SPINNER[animating!.frame % SPINNER.length])
        : animatedGlyph(c, this.tick);
      const cpu = c.state === "running" ? `${(c.cpu ?? 0).toFixed(1)}%` : "—";
      const mem = c.state === "running" ? bytes(c.memory) : "—";
      const label = isAnim ? `${c.name} ${color.dim(gerund(animating!.kind))}` : c.name;
      const name = padEnd(label, Math.max(8, width - 20));
      let line = `${dot} ${name} ${padStart(cpu, 6)} ${padStart(mem, 6)}`;
      if (i === this.selected) line = color.bgAccent(padEnd(line, width));
      rows.push(line);
    }
    if (rows.length === 0) rows.push(color.gray(this.filter ? `No matches for "${this.filter}".` : "No containers."));
    return rows;
  }

  private detailRows(width: number, height: number): string[] {
    const c = this.current();
    if (!c) return [color.gray("Select a container.")];
    const memPct = c.memoryLimit ? ((c.memory ?? 0) / c.memoryLimit) * 100 : 0;
    const field = (k: string, v: string) =>
      `${color.gray(padEnd(k, 10))} ${v}`;
    const d = this.detail && this.detailFor === c.id ? this.detail : null;

    const rows: string[] = [
      field("Name", color.bold(c.name)),
      field("Image", c.image),
      field("State", `${stateGlyph(c.state)} ${healthTag(d?.health, c.status)}`),
      field("Status", c.status),
      field("ID", color.dim(c.id.slice(0, 12))),
    ];

    // LazyDocker-level detail from the inspect summary, when it's loaded.
    if (d) {
      if (d.created) rows.push(field("Uptime", `${age(d.created)} ${color.dim("· started " + shortDate(d.created))}`));
      if (d.command) rows.push(field("Command", color.dim(truncate(d.command, width - 12))));
      if (d.restartPolicy) rows.push(field("Restart", d.restartPolicy));
      rows.push(field("Networks", d.networks.length ? d.networks.join(", ") : color.gray("—")));
      rows.push(field("Ports", c.ports.length ? c.ports.join(", ") : color.gray("—")));
      rows.push(field("Mounts", d.mounts.length ? `${d.mounts.length} · ${truncate(d.mounts[0], width - 20)}` : color.gray("none")));
      rows.push(field("Env", d.env.length ? color.dim(`${d.env.length} variables`) : color.gray("none")));
    } else {
      rows.push(field("Ports", c.ports.length ? c.ports.join(", ") : color.gray("—")));
      rows.push(color.dim("  loading inspect…"));
    }

    rows.push("");
    rows.push(field("CPU", c.state === "running" ? `${bar(Math.min(100, c.cpu ?? 0), 16)} ${(c.cpu ?? 0).toFixed(1)}%` : color.gray("—")));
    rows.push(field("Memory", c.state === "running" ? `${bar(memPct, 16)} ${bytes(c.memory)}${c.memoryLimit ? "/" + bytes(c.memoryLimit) : ""}` : color.gray("—")));
    rows.push("");
    rows.push(color.dim("[l] logs · [S] start · [s] stop · [R] restart"));

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
    else if (this.input === "filter") keys = `${color.accent("filter ❯")} ${color.bold(this.filter)}${color.dim("▏")}   ${color.gray("Esc to clear · Enter to keep")}`;
    else if (this.input === "volume") keys = `${color.accent("volume ❯")} ${color.bold(this.volumeInput)}${color.dim("▏")}   ${color.gray("host:container[:ro] · Enter · Esc")}`;
    else if (this.input === "snapshots") keys = color.gray("press 1-9 to restore that snapshot · Esc to cancel");
    else if (this.input === "menu") keys = color.gray("↑/↓ choose · Enter run · shortcut letter · Esc close");
    else if (this.input === "confirm" && this.pending) keys = color.yellow(`${this.pending.label}   run? y / n`);
    else if (this.input === "message") keys = color.gray("press any key to dismiss");
    else if (this.showLogs) keys = "l back · f follow · +/- tail · a AI · r refresh · ? help · q";
    else keys = `${color.accent("Enter/m")} menu · ↑/↓ move · / filter · o sort · l logs · a AI · ? help · q quit`;
    const status = this.status && this.input === "normal" ? `  ${this.status}` : "";
    const flags = this.frozen && this.input === "normal" ? `  ${color.yellow("⏸ paused")}` : "";
    return truncate(` ${color.gray(keys)}${status}${flags}`, cols);
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

  /** A single-line update notice under the resource bar; null when up to date. */
  private updateBanner(cols: number): string | null {
    const u = this.update;
    if (!u || !u.hasUpdate) return null;
    const rel = u.newer[0];
    const tag = u.critical
      ? color.bold(color.red(" SECURITY UPDATE "))
      : color.bgAccent(" UPDATE ");
    const msg = `${color.bold(u.latest)} available ${color.dim("(you have " + u.current + ")")} — ${rel?.title ?? "see changelog"}`;
    const hint = color.gray("press [u] for changelog");
    const text = ` ${tag} ${msg}`;
    const pad = Math.max(1, cols - 2 - stripLen(text) - stripLen(hint));
    return truncate(text + " ".repeat(pad) + hint, cols);
  }

  /** The numbered snapshot list shown in the restore picker. */
  private snapshotsText(): string {
    const snaps = this.service.listSnapshots().slice(0, 9);
    const lines = snaps.map((s, i) =>
      `${color.accent(String(i + 1))}  ${color.bold(padEnd(s.container, 14))} ${color.gray(padEnd(s.type, 7))} ${color.dim(bytes(s.sizeBytes))}  ${s.ref}`);
    lines.push("");
    lines.push(color.dim("A commit snapshot starts a new container; an export imports a new image. Nothing is overwritten."));
    return lines.join("\n");
  }

  /** The modal body for [u]: every release newer than what's running. */
  private changelogText(): string {
    const u = this.update;
    if (!u) return "";
    const lines: string[] = [
      `${color.bold(BRAND.product)} ${color.gray(u.current)} ${color.dim("→")} ${color.accent(color.bold(u.latest))}`,
      "",
    ];
    for (const rel of u.newer) {
      lines.push(`${color.accent("●")} ${color.bold(rel.version)} ${color.gray(rel.date)}${rel.critical ? color.red("  (security)") : ""}`);
      if (rel.title) lines.push(`  ${rel.title}`);
      for (const h of rel.highlights ?? []) lines.push(`  ${color.gray("·")} ${h}`);
      if (rel.url) lines.push(`  ${color.brightBlue(rel.url)}`);
      lines.push("");
    }
    lines.push(color.dim("Update: npm i -g docker-mcp-server@latest   ·   press any key to close"));
    return lines.join("\n");
  }

  private footerBrand(cols: number): string {
    const text = `${color.accent("SoyRage Agency")} ${color.dim("·")} ${color.brightBlue(BRAND.url)} ${color.dim("·")} ${color.yellow("★")} star us ${color.dim("·")} ${color.dim("support")} ${color.brightBlue(BRAND.donate)}`;
    return " " + text + " ".repeat(Math.max(0, cols - 2 - stripLen(text)));
  }
}

/** Braille spinner frames for lifecycle animations. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A coloured dot for a container state (static — used in the details pane). */
function stateGlyph(state: string): string {
  if (state === "running") return color.green("●");
  if (state === "exited" || state === "dead") return color.red("●");
  return color.yellow("●");
}

/**
 * An expressive, *animated* status glyph — far more than a red/green dot. Each
 * state gets its own motion so a glance across the list reads like a heartbeat
 * monitor: healthy containers breathe, unhealthy ones blink for attention,
 * transitional ones spin.
 */
function animatedGlyph(c: ContainerDTO, tick: number): string {
  const status = c.status || "";
  const restarting = /restart/i.test(status);
  const starting = /health:\s*starting|\(starting\)/i.test(status);
  const unhealthy = /unhealthy/i.test(status);
  const healthy = /healthy/i.test(status);

  if (restarting) return color.accent(SPINNER[tick % SPINNER.length]);

  if (c.state === "running") {
    if (unhealthy) return (tick % 2 ? color.red("▲") : color.yellow("△")); // blink to grab attention
    if (starting) return color.yellow(SPINNER[tick % SPINNER.length]);
    // Healthy / plain running: a gentle two-frame heartbeat (~every 0.9s).
    const beat = Math.floor(tick / 4) % 4 === 0;
    if (healthy) return beat ? color.brightGreen("◉") : color.green("●");
    return beat ? color.green("◉") : color.green("●");
  }
  if (c.state === "paused") return color.brightCyan("⏸");
  if (c.state === "exited" || c.state === "dead") return color.red("○");
  if (c.state === "created") return color.gray("◌");
  // restarting/removing/other transient
  return color.yellow(SPINNER[tick % SPINNER.length]);
}

/** Health/state label, preferring the inspected health when it's meaningful. */
function healthTag(health: string | undefined, status: string): string {
  const h = (health ?? "").toLowerCase();
  if (h === "healthy") return color.green("healthy");
  if (h === "unhealthy") return color.red("unhealthy");
  if (h === "starting") return color.yellow("starting");
  if (/unhealthy/i.test(status)) return color.red("unhealthy");
  if (/healthy/i.test(status)) return color.green("healthy");
  return color.gray("no healthcheck");
}

/** Compact age from an ISO timestamp, e.g. "3d 4h", "12m". */
function age(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  let s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "Jul 27 14:03" from an ISO timestamp. */
function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const dt = new Date(t);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][dt.getMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${mon} ${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

/** Past-tense confirmation verb. */
function verb(kind: string): string {
  return kind === "restart" ? "restarted" : kind === "start" ? "started" : "stopped";
}

/** Present-continuous label shown next to the spinner. */
function gerund(kind: string): string {
  return kind === "restart" ? "restarting…" : kind === "start" ? "starting…" : "stopping…";
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
