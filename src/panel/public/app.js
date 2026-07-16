/*
 * Docker Panel — front-end logic (vanilla JS, no build step).
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Attribution must remain intact (see LICENSE).
 */

"use strict";

const $ = (sel) => document.querySelector(sel);

let META = { demo: false, readOnly: false };

/** Fetch JSON with a friendly error. */
async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Humanise a byte count. */
function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const e = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / Math.pow(1024, e);
  return `${v.toFixed(e === 0 ? 0 : v >= 100 ? 0 : 1)} ${units[e]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

/** Render the top stat cards from a monitoring snapshot. */
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

/** Map a Docker state to a CSS class. */
function stateClass(state) {
  const s = (state || "").toLowerCase();
  if (s.includes("run")) return "running";
  if (s.includes("exit") || s.includes("dead")) return "exited";
  if (s.includes("pause")) return "paused";
  return "created";
}

/** Render the containers table. */
function renderContainers(list) {
  const disabled = META.readOnly ? "disabled" : "";
  $("#containers").innerHTML = list
    .map((c) => {
      const cls = stateClass(c.state);
      const ports = c.ports.length
        ? `<div class="chips">${c.ports.map((p) => `<span class="chip">${escapeHtml(p)}</span>`).join("")}</div>`
        : '<span class="muted">—</span>';
      const running = c.state === "running";
      const cpu = running ? usageCell(c.cpu ?? 0, `${(c.cpu ?? 0).toFixed(1)}%`, Math.min(100, c.cpu ?? 0)) : '<span class="muted">—</span>';
      const memPct = c.memoryLimit ? ((c.memory ?? 0) / c.memoryLimit) * 100 : 0;
      const mem = running ? usageCell(memPct, bytes(c.memory ?? 0), memPct) : '<span class="muted">—</span>';
      return `
        <tr>
          <td><span class="dot ${cls}">${escapeHtml(c.state)}</span></td>
          <td class="name clickable" data-logs="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
          <td class="mono">${escapeHtml(c.image)}</td>
          <td>${cpu}</td>
          <td>${mem}</td>
          <td>${ports}</td>
          <td>
            <div class="actions">
              <button class="act" title="Start" data-act="start" data-name="${escapeHtml(c.name)}" ${disabled}>▶</button>
              <button class="act" title="Stop" data-act="stop" data-name="${escapeHtml(c.name)}" ${disabled}>■</button>
              <button class="act" title="Restart" data-act="restart" data-name="${escapeHtml(c.name)}" ${disabled}>⟳</button>
            </div>
          </td>
        </tr>`;
    })
    .join("");

  $("#containers").querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => act(btn.dataset.name, btn.dataset.act));
  });
  $("#containers").querySelectorAll("[data-logs]").forEach((cell) => {
    cell.addEventListener("click", () => showLogs(cell.dataset.logs));
  });
}

/** Render the images table. */
function renderImages(list) {
  $("#images").innerHTML = list
    .map(
      (i) => `<tr>
        <td class="name">${escapeHtml(i.tag)}</td>
        <td class="mono">${escapeHtml(i.id)}</td>
        <td class="right mono">${bytes(i.sizeBytes)}</td>
      </tr>`,
    )
    .join("");
}

/** Perform a lifecycle action, then refresh. */
async function act(name, action) {
  try {
    await api("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, action }),
    });
    await refresh();
  } catch (err) {
    alert(`Action failed: ${err.message}`);
  }
}

/** Open the logs drawer for a container. */
async function showLogs(name) {
  $("#drawer-title").textContent = `Logs · ${name}`;
  $("#drawer-body").textContent = "Loading…";
  $("#drawer").classList.remove("hidden");
  $("#scrim").classList.remove("hidden");
  try {
    const { logs } = await api(`/api/logs?name=${encodeURIComponent(name)}`);
    $("#drawer-body").textContent = logs || "(no output)";
  } catch (err) {
    $("#drawer-body").textContent = `Error: ${err.message}`;
  }
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
  $("#scrim").classList.add("hidden");
}

/** A compact usage cell: colored value + a thin meter bar. */
function usageCell(level, label, pct) {
  const tone = level >= 80 ? "hot" : level >= 50 ? "warm" : "cool";
  return `<div class="usage"><span class="mono">${escapeHtml(label)}</span>
    <div class="meter ${tone}"><span style="width:${Math.min(100, pct).toFixed(1)}%"></span></div></div>`;
}

/** Load a full monitoring snapshot and render everything. */
async function refresh() {
  const snap = await api("/api/snapshot");
  renderStats(snap);
  renderContainers(snap.containers);
  renderImages(snap.images);
}

/** Bootstrap. */
async function init() {
  try {
    META = await api("/api/meta");
    if (META.demo) $("#badge-demo").classList.remove("hidden");
    if (META.readOnly) $("#badge-ro").classList.remove("hidden");
    document.title = `Docker Panel · ${META.author || "SoyRage Agency"}`;
  } catch {
    /* meta is best-effort */
  }

  $("#refresh").addEventListener("click", () => refresh().catch(showError));
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());

  refresh().catch(showError);
  // Gentle auto-refresh so the panel feels live.
  setInterval(() => refresh().catch(() => {}), 8000);
}

function showError(err) {
  $("#containers").innerHTML = `<tr><td colspan="7" class="muted">Could not load data: ${escapeHtml(err.message)}. Try demo mode (DOCKER_MCP_PANEL_DEMO=true).</td></tr>`;
}

init();
