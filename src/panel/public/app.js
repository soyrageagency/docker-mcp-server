/*
 * Docker Panel — front-end logic (vanilla JS, no build step).
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Attribution must remain intact (see LICENSE).
 */

"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  meta: { demo: false, readOnly: false },
  autoRestart: new Set(),
  filter: "",
  autoRefresh: true,
  timer: null,
  tab: "overview",
  containers: [],
  files: { name: "", path: "/" },
};

/* ---------------------------------------------------------------- helpers */

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function bytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const e = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / Math.pow(1024, e);
  return `${v.toFixed(e === 0 ? 0 : v >= 100 ? 0 : 1)} ${u[e]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function timeAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.round(d)}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  return `${Math.round(d / 3600)}h ago`;
}

/* ------------------------------------------------------------------- tabs */

function switchTab(tab) {
  state.tab = tab;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tabpane").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${tab}`));
  if (tab === "files") initFiles();
  if (tab === "alerts") loadAlerts();
  if (tab === "terminal") $("#term-input").focus();
  if (tab === "backups") initBackups();
  if (tab === "system") loadSystem();
}

/* --------------------------------------------------------------- overview */

function stateClass(s) {
  s = (s || "").toLowerCase();
  if (s.includes("run")) return "running";
  if (s.includes("exit") || s.includes("dead")) return "exited";
  if (s.includes("pause")) return "paused";
  return "created";
}

function usageCell(level, label, pct) {
  const tone = level >= 80 ? "hot" : level >= 50 ? "warm" : "cool";
  return `<div class="usage"><span class="mono">${escapeHtml(label)}</span>
    <div class="meter ${tone}"><span style="width:${Math.min(100, pct).toFixed(1)}%"></span></div></div>`;
}

function renderStats(snap) {
  const sys = snap.system;
  const memPct = sys.memoryBytes ? (snap.memoryUsed / sys.memoryBytes) * 100 : 0;
  const cpuPct = sys.cpus ? Math.min(100, snap.cpuTotal / sys.cpus) : snap.cpuTotal;
  const cards = [
    { k: "Running", v: `${sys.containersRunning}<small> / ${sys.containersTotal}</small>` },
    { k: "Images", v: `${sys.images}` },
    { k: "CPU load", v: `${cpuPct.toFixed(1)}<small> %</small>`, bar: cpuPct },
    { k: "Memory used", v: `${bytes(snap.memoryUsed)}`, sub: `of ${bytes(sys.memoryBytes)}`, bar: memPct },
    { k: "vCPUs", v: `${sys.cpus}` },
  ];
  $("#stats").innerHTML = cards
    .map((c) => {
      const bar = c.bar !== undefined
        ? `<div class="meter"><span style="width:${Math.min(100, c.bar).toFixed(1)}%"></span></div>`
        : "";
      const sub = c.sub ? `<div class="sub">${c.sub}</div>` : "";
      return `<div class="stat"><div class="k">${c.k}</div><div class="v">${c.v}</div>${sub}${bar}</div>`;
    })
    .join("");
  $("#engine").textContent = `${escapeHtml(sys.os)} · Docker ${escapeHtml(sys.engine)}`;
}

function renderContainers(list) {
  const disabled = state.meta.readOnly ? "disabled" : "";
  const filter = state.filter.toLowerCase();
  const rows = list.filter((c) => !filter || c.name.toLowerCase().includes(filter) || c.image.toLowerCase().includes(filter));

  $("#containers").innerHTML = rows
    .map((c) => {
      const cls = stateClass(c.state);
      const ports = c.ports.length
        ? `<div class="chips">${c.ports.map((p) => `<span class="chip">${escapeHtml(p)}</span>`).join("")}</div>`
        : '<span class="muted">—</span>';
      const running = c.state === "running";
      const cpu = running ? usageCell(Math.min(100, c.cpu ?? 0), `${(c.cpu ?? 0).toFixed(1)}%`, Math.min(100, c.cpu ?? 0)) : '<span class="muted">—</span>';
      const memPct = c.memoryLimit ? ((c.memory ?? 0) / c.memoryLimit) * 100 : 0;
      const mem = running ? usageCell(memPct, bytes(c.memory ?? 0), memPct) : '<span class="muted">—</span>';
      const on = state.autoRestart.has(c.name);
      return `
        <tr>
          <td><span class="dot ${cls}">${escapeHtml(c.state)}</span></td>
          <td class="name clickable" data-logs="${escapeHtml(c.name)}" title="View logs">${escapeHtml(c.name)}</td>
          <td class="mono">${escapeHtml(c.image)}</td>
          <td>${cpu}</td>
          <td>${mem}</td>
          <td>${ports}</td>
          <td class="center">
            <button class="toggle ${on ? "on" : ""}" data-auto="${escapeHtml(c.name)}" title="Auto-restart">⟳</button>
          </td>
          <td>
            <div class="actions">
              <button class="act" title="Details" data-details="${escapeHtml(c.name)}">ⓘ</button>
              <button class="act" title="Files" data-files="${escapeHtml(c.name)}">🗀</button>
              <button class="act" title="Snapshot" data-snap="${escapeHtml(c.name)}">📸</button>
              <button class="act" title="Start" data-act="start" data-name="${escapeHtml(c.name)}" ${disabled}>▶</button>
              <button class="act" title="Stop" data-act="stop" data-name="${escapeHtml(c.name)}" ${disabled}>■</button>
              <button class="act" title="Restart" data-act="restart" data-name="${escapeHtml(c.name)}" ${disabled}>⟳</button>
            </div>
          </td>
        </tr>`;
    })
    .join("") || `<tr><td colspan="8" class="muted">No containers match “${escapeHtml(state.filter)}”.</td></tr>`;

  $("#containers").querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.name, b.dataset.act)));
  $("#containers").querySelectorAll("[data-logs]").forEach((c) => c.addEventListener("click", () => showLogs(c.dataset.logs)));
  $("#containers").querySelectorAll("[data-files]").forEach((b) => b.addEventListener("click", () => openFiles(b.dataset.files)));
  $("#containers").querySelectorAll("[data-auto]").forEach((b) => b.addEventListener("click", () => toggleAuto(b.dataset.auto)));
  $("#containers").querySelectorAll("[data-details]").forEach((b) => b.addEventListener("click", () => showDetails(b.dataset.details)));
  $("#containers").querySelectorAll("[data-snap]").forEach((b) => b.addEventListener("click", () => quickSnapshot(b.dataset.snap)));
}

function renderImages(list) {
  $("#images").innerHTML = list
    .map((i) => `<tr><td class="name">${escapeHtml(i.tag)}</td><td class="mono">${escapeHtml(i.id)}</td><td class="right mono">${bytes(i.sizeBytes)}</td></tr>`)
    .join("");
}

async function act(name, action) {
  try {
    await api("/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, action }) });
    await refresh();
  } catch (err) {
    alert(`Action failed: ${err.message}`);
  }
}

async function toggleAuto(name) {
  const enabled = !state.autoRestart.has(name);
  try {
    const r = await api("/api/autorestart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, enabled }) });
    state.autoRestart = new Set(r.enabled);
    renderContainers(state.containers);
  } catch (err) {
    alert(`Could not toggle auto-restart: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ files */

function initFiles() {
  const sel = $("#fs-container");
  const names = state.containers.map((c) => c.name);
  sel.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (!state.files.name || !names.includes(state.files.name)) {
    state.files = { name: names[0] || "", path: "/" };
  }
  sel.value = state.files.name;
  loadDir();
}

function openFiles(name) {
  state.files = { name, path: "/" };
  switchTab("files");
  $("#fs-container").value = name;
  loadDir();
}

function renderCrumbs() {
  const parts = state.files.path.split("/").filter(Boolean);
  const crumbs = ['<span class="crumb" data-path="/">/ root</span>'];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    crumbs.push(`<span class="sep">/</span><span class="crumb" data-path="${escapeHtml(acc)}">${escapeHtml(p)}</span>`);
  }
  const el = $("#fs-crumbs");
  el.innerHTML = crumbs.join("");
  el.querySelectorAll("[data-path]").forEach((c) => c.addEventListener("click", () => { state.files.path = c.dataset.path; loadDir(); }));
}

async function loadDir() {
  const { name, path } = state.files;
  if (!name) { $("#fs-list").innerHTML = '<tr><td colspan="3" class="muted">No container selected.</td></tr>'; return; }
  renderCrumbs();
  $("#fs-list").innerHTML = '<tr><td colspan="3" class="muted">Loading…</td></tr>';
  try {
    const { entries } = await api(`/api/files?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`);
    $("#fs-list").innerHTML = entries
      .map((e) => {
        const icon = e.type === "dir" ? "🗀" : e.type === "link" ? "🔗" : "🗎";
        const nm = e.type === "link" && e.target ? `${escapeHtml(e.name)} <span class="muted">→ ${escapeHtml(e.target)}</span>` : escapeHtml(e.name);
        const cls = e.type === "dir" ? "clickable dir" : e.type === "file" ? "clickable file" : "";
        return `<tr><td>${icon}</td><td class="name ${cls}" data-type="${e.type}" data-name="${escapeHtml(e.name)}">${nm}</td><td class="right mono">${e.type === "file" ? bytes(e.size) : "—"}</td></tr>`;
      })
      .join("") || '<tr><td colspan="3" class="muted">(empty)</td></tr>';

    $("#fs-list").querySelectorAll("[data-type]").forEach((el) => {
      el.addEventListener("click", () => {
        const child = (state.files.path === "/" ? "" : state.files.path) + "/" + el.dataset.name;
        if (el.dataset.type === "dir") { state.files.path = child; loadDir(); }
        else if (el.dataset.type === "file") showFile(name, child);
      });
    });
  } catch (err) {
    $("#fs-list").innerHTML = `<tr><td colspan="3" class="muted">${escapeHtml(err.message)}</td></tr>`;
  }
}

/* ----------------------------------------------------------------- alerts */

async function loadAlerts() {
  const box = $("#alerts-list");
  box.innerHTML = '<div class="muted pad">Loading…</div>';
  try {
    const { alerts } = await api("/api/alerts");
    updateAlertBadge(alerts);
    if (alerts.length === 0) { box.innerHTML = '<div class="ok pad">✓ All clear — no active alerts.</div>'; return; }
    box.innerHTML = alerts
      .map((a) => `<div class="alert ${a.level}">
        <span class="lvl">${a.level}</span>
        <span class="src mono">${escapeHtml(a.source)}</span>
        <span class="msg">${escapeHtml(a.message)}</span>
        <span class="when muted">${timeAgo(a.time)}</span>
      </div>`)
      .join("");
  } catch (err) {
    box.innerHTML = `<div class="muted pad">Could not load alerts: ${escapeHtml(err.message)}</div>`;
  }
}

function updateAlertBadge(alerts) {
  const crit = alerts.filter((a) => a.level === "critical" || a.level === "warning").length;
  const badge = $("#alert-count");
  badge.textContent = crit;
  badge.classList.toggle("hidden", crit === 0);
  badge.classList.toggle("crit", alerts.some((a) => a.level === "critical"));
}

/* ----------------------------------------------------------------- drawer */

async function showLogs(name) {
  openDrawer(`Logs · ${name}`, "Loading…");
  try {
    const { logs } = await api(`/api/logs?name=${encodeURIComponent(name)}`);
    $("#drawer-body").textContent = logs || "(no output)";
  } catch (err) {
    $("#drawer-body").textContent = `Error: ${err.message}`;
  }
}

async function showFile(name, path) {
  openDrawer(`${name} : ${path}`, "Loading…");
  try {
    const { content, truncated } = await api(`/api/file?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`);
    $("#drawer-body").textContent = (content || "(empty)") + (truncated ? "\n\n… (truncated)" : "");
  } catch (err) {
    $("#drawer-body").textContent = `Error: ${err.message}`;
  }
}

function openDrawer(title, body) {
  $("#drawer-title").textContent = title;
  $("#drawer-body").textContent = body;
  $("#drawer").classList.remove("hidden");
  $("#scrim").classList.remove("hidden");
  document.body.classList.add("locked"); // lock background scroll (bugfix)
  $("#drawer-body").scrollTop = 0;
}
function closeDrawer() {
  $("#drawer").classList.add("hidden");
  $("#scrim").classList.add("hidden");
  document.body.classList.remove("locked");
}

/* --------------------------------------------------------------- details */

async function showDetails(name) {
  openDrawer(`Details · ${name}`, "Loading…");
  try {
    const d = await api(`/api/inspect?name=${encodeURIComponent(name)}`);
    const line = (k, v) => `${k.padEnd(14)}${v}`;
    const body = [
      line("Name", d.name),
      line("Image", d.image),
      line("ID", d.id),
      line("Created", d.created),
      line("State", `${d.state} (health: ${d.health})`),
      line("Restart", d.restartPolicy),
      line("Command", d.command || "—"),
      line("Ports", d.ports.join(", ")),
      "",
      "Networks:",
      ...d.networks.map((n) => "  • " + n),
      "",
      "Mounts:",
      ...(d.mounts.length ? d.mounts.map((m) => "  • " + m) : ["  —"]),
      "",
      "Environment:",
      ...(d.env.length ? d.env.map((e) => "  " + e) : ["  —"]),
    ].join("\n");
    $("#drawer-body").textContent = body;
  } catch (err) {
    $("#drawer-body").textContent = `Error: ${err.message}`;
  }
}

/* --------------------------------------------------------------- terminal */

const CATALOG = [
  { t: "docker ps -a", d: "List all containers (running + stopped)" },
  { t: "docker ps", d: "List running containers" },
  { t: "docker images", d: "List local images with sizes" },
  { t: "docker stats", d: "Live CPU / memory usage" },
  { t: "docker logs <c>", d: "Tail a container's logs" },
  { t: "docker logs -f <c>", d: "Follow logs live" },
  { t: "docker inspect <c>", d: "Full low-level config" },
  { t: "docker restart <c>", d: "Restart a container" },
  { t: "docker stop <c>", d: "Gracefully stop a container" },
  { t: "docker start <c>", d: "Start a stopped container" },
  { t: "docker exec <c> sh -lc 'ls -la /app'", d: "Run a command inside a container" },
  { t: "docker top <c>", d: "Processes running in a container" },
  { t: "docker network ls", d: "List networks" },
  { t: "docker volume ls", d: "List volumes" },
  { t: "docker system df", d: "Disk usage summary" },
  { t: "docker info", d: "Daemon-wide information" },
  { t: "docker version", d: "Client & server versions" },
  { t: "docker compose ps", d: "List a Compose stack's services" },
  { t: "docker compose up -d", d: "Deploy/refresh a stack in the background" },
  { t: "docker compose logs -f", d: "Follow a stack's logs" },
  { t: "docker pull <image>", d: "Pull the latest image" },
];

const term = { sugg: [], sel: 0, open: false };

function buildSuggestions(input) {
  const names = state.containers.map((c) => c.name);
  const q = input.trim().toLowerCase();
  const expanded = [];
  for (const e of CATALOG) {
    if (e.t.includes("<c>")) {
      const pool = names.length ? names : ["<container>"];
      for (const n of pool) expanded.push({ text: e.t.replace("<c>", n), desc: e.d });
    } else {
      expanded.push({ text: e.t, desc: e.d });
    }
  }
  if (!q) return expanded.slice(0, 8);
  const scored = expanded
    .map((s) => ({ ...s, score: s.text.toLowerCase().startsWith(q) ? 2 : s.text.toLowerCase().includes(q) ? 1 : 0 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

function renderSuggestions() {
  const box = $("#term-sugg");
  if (!term.open || term.sugg.length === 0) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML = term.sugg
    .map((s, i) => `<div class="sugg ${i === term.sel ? "sel" : ""}" data-i="${i}">
      <span class="sugg-cmd mono">${escapeHtml(s.text)}</span><span class="sugg-desc">${escapeHtml(s.desc)}</span></div>`)
    .join("");
  box.querySelectorAll(".sugg").forEach((el) => el.addEventListener("mousedown", (ev) => { ev.preventDefault(); acceptSugg(Number(el.dataset.i), true); }));
}

function acceptSugg(i, run) {
  const s = term.sugg[i];
  if (!s) return;
  $("#term-input").value = s.text;
  term.open = false; renderSuggestions();
  if (run) runTerm();
  $("#term-input").focus();
}

function onTermInput(e) {
  term.sugg = buildSuggestions(e.target.value);
  term.sel = 0;
  term.open = term.sugg.length > 0;
  renderSuggestions();
}

function onTermKey(e) {
  const n = term.sugg.length;
  if (term.open && n) {
    if (e.key === "ArrowDown") { term.sel = (term.sel + 1) % n; renderSuggestions(); e.preventDefault(); return; }
    if (e.key === "ArrowUp") { term.sel = (term.sel - 1 + n) % n; renderSuggestions(); e.preventDefault(); return; }
    if (e.key === "Tab") { e.preventDefault(); acceptSugg(term.sel, false); return; }
    if (e.key === "Enter") { e.preventDefault(); acceptSugg(term.sel, true); return; }
    if (e.key === "Escape") { term.open = false; renderSuggestions(); return; }
  }
  if (e.key === "Enter") { e.preventDefault(); runTerm(); }
}

async function runTerm() {
  const input = $("#term-input");
  const cmd = input.value.trim();
  if (!cmd) return;
  const out = $("#term-out");
  out.insertAdjacentHTML("beforeend", `<div class="to-cmd"><span class="prompt">❯</span> ${escapeHtml(cmd)}</div>`);
  input.value = ""; term.open = false; renderSuggestions();
  try {
    const r = await api("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) });
    const cls = r.code === 0 ? "to-out" : "to-out err";
    out.insertAdjacentHTML("beforeend", `<div class="${cls}">${escapeHtml(r.output)}</div>`);
  } catch (err) {
    out.insertAdjacentHTML("beforeend", `<div class="to-out err">${escapeHtml(err.message)}</div>`);
  }
  out.scrollTop = out.scrollHeight;
}

function seedTerminal() {
  $("#term-out").innerHTML =
    `<div class="to-out muted">Docker terminal — type <b>docker …</b>, press <b>Tab</b> to complete a suggestion, <b>↑/↓</b> to pick, <b>Enter</b> to run.
Read-only commands always work; write commands respect read-only mode. Try: <b>docker ps -a</b></div>`;
}

/* --------------------------------------------------------------- backups */

function initBackups() {
  const sel = $("#bk-container");
  sel.innerHTML = state.containers.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  $("#bk-dir").textContent = `→ ${state.meta.backupDir || "./snapshots"}`;
  $("#sc-hint").innerHTML =
    "Snapshots are written to the directory above. Set a <b>notify email</b> and a webhook (<code>DOCKER_MCP_BACKUP_WEBHOOK</code>) to forward backups to email, Google Drive or S3 via Zapier / Make / n8n.";
  loadSchedule();
  loadSnapshots();
}

async function createSnapshotUI() {
  const container = $("#bk-container").value;
  const type = $("#bk-type").value;
  if (!container) return;
  $("#bk-create").disabled = true;
  try {
    await api("/api/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ container, type }) });
    await loadSnapshots();
  } catch (err) {
    alert(`Snapshot failed: ${err.message}`);
  } finally {
    $("#bk-create").disabled = false;
  }
}

async function quickSnapshot(name) {
  try {
    await api("/api/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ container: name, type: "commit" }) });
    switchTab("backups");
  } catch (err) {
    alert(`Snapshot failed: ${err.message}`);
  }
}

async function loadSnapshots() {
  try {
    const { snapshots } = await api("/api/backups");
    $("#bk-list").innerHTML = snapshots.length
      ? snapshots.map((s) => `<tr>
          <td class="mono">${escapeHtml(new Date(s.createdAt).toLocaleString())}</td>
          <td class="name">${escapeHtml(s.container)}</td>
          <td><span class="tagpill">${escapeHtml(s.type)}</span></td>
          <td class="mono">${escapeHtml(s.ref)}</td>
          <td class="muted">${escapeHtml(s.destination)}</td>
          <td class="right mono">${bytes(s.sizeBytes)}</td></tr>`).join("")
      : '<tr><td colspan="6" class="muted">No snapshots yet.</td></tr>';
  } catch (err) {
    $("#bk-list").innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadSchedule() {
  try {
    const s = await api("/api/schedule");
    $("#sc-enabled").checked = !!s.enabled;
    $("#sc-time").value = s.time || "03:00";
    $("#sc-type").value = s.type || "commit";
    $("#sc-containers").value = (s.containers || ["all"]).join(",");
    $("#sc-email").value = s.email || "";
  } catch { /* best effort */ }
}

async function saveSchedule() {
  const body = {
    enabled: $("#sc-enabled").checked,
    time: $("#sc-time").value,
    type: $("#sc-type").value,
    containers: $("#sc-containers").value.split(",").map((x) => x.trim()).filter(Boolean),
    email: $("#sc-email").value,
  };
  try {
    await api("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    $("#sc-save").textContent = "Saved ✓";
    setTimeout(() => ($("#sc-save").textContent = "Save"), 1500);
  } catch (err) {
    alert(`Could not save schedule: ${err.message}`);
  }
}

/* ---------------------------------------------------------------- system */

async function loadSystem() {
  try {
    const [{ networks }, { volumes }] = await Promise.all([api("/api/networks"), api("/api/volumes")]);
    $("#net-list").innerHTML = networks.map((n) => `<tr><td class="name">${escapeHtml(n.name)}</td><td class="mono">${escapeHtml(n.id)}</td><td>${escapeHtml(n.driver)}</td><td class="muted">${escapeHtml(n.scope)}</td></tr>`).join("");
    $("#vol-list").innerHTML = volumes.map((v) => `<tr><td class="name">${escapeHtml(v.name)}</td><td>${escapeHtml(v.driver)}</td><td class="mono muted">${escapeHtml(v.mountpoint)}</td></tr>`).join("");
  } catch (err) {
    $("#net-list").innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(err.message)}</td></tr>`;
  }
}

/* ---------------------------------------------------------------- refresh */

async function refresh() {
  const [snap, auto] = await Promise.all([api("/api/snapshot"), api("/api/autorestart").catch(() => ({ enabled: [] }))]);
  state.containers = snap.containers;
  state.autoRestart = new Set(auto.enabled);
  renderStats(snap);
  renderContainers(snap.containers);
  renderImages(snap.images);
  // Keep the alert badge fresh without visiting the tab.
  api("/api/alerts").then(({ alerts }) => updateAlertBadge(alerts)).catch(() => {});
}

function setAutoRefresh(on) {
  state.autoRefresh = on;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (on) state.timer = setInterval(() => refresh().catch(() => {}), 5000);
}

/* -------------------------------------------------------------- bootstrap */

async function init() {
  try {
    state.meta = await api("/api/meta");
    if (state.meta.demo) $("#badge-demo").classList.remove("hidden");
    if (state.meta.readOnly) $("#badge-ro").classList.remove("hidden");
    document.title = `Docker Panel · ${state.meta.author || "SoyRage Agency"}`;
  } catch { /* best effort */ }

  $$(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  if (state.meta.terminal === false) $('.tab[data-tab="terminal"]').classList.add("hidden");
  $("#refresh").addEventListener("click", () => refresh().catch(showError));
  $("#alerts-refresh").addEventListener("click", loadAlerts);

  // Terminal
  seedTerminal();
  $("#term-input").addEventListener("input", onTermInput);
  $("#term-input").addEventListener("keydown", onTermKey);
  $("#term-input").addEventListener("blur", () => setTimeout(() => { term.open = false; renderSuggestions(); }, 120));

  // Backups
  $("#bk-create").addEventListener("click", createSnapshotUI);
  $("#bk-refresh").addEventListener("click", loadSnapshots);
  $("#sc-save").addEventListener("click", saveSchedule);
  $("#search").addEventListener("input", (e) => { state.filter = e.target.value; renderContainers(state.containers); });
  $("#auto").addEventListener("change", (e) => setAutoRefresh(e.target.checked));
  $("#fs-container").addEventListener("change", (e) => { state.files = { name: e.target.value, path: "/" }; loadDir(); });
  $("#fs-up").addEventListener("click", () => {
    const p = state.files.path.replace(/\/[^/]*$/, "") || "/";
    state.files.path = p; loadDir();
  });
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());

  refresh().catch(showError);
  setAutoRefresh(true);
}

function showError(err) {
  $("#containers").innerHTML = `<tr><td colspan="8" class="muted">Could not load data: ${escapeHtml(err.message)}. Try demo mode (DOCKER_MCP_PANEL_DEMO=true).</td></tr>`;
}

init();
