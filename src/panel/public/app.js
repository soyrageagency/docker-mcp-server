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

/** Render the top stat cards from the system summary. */
function renderStats(sys) {
  const cards = [
    { k: "Running", v: `${sys.containersRunning}` },
    { k: "Containers", v: `${sys.containersTotal}` },
    { k: "Images", v: `${sys.images}` },
    { k: "vCPUs", v: `${sys.cpus}` },
    { k: "Memory", v: bytes(sys.memoryBytes) },
  ];
  $("#stats").innerHTML = cards
    .map((c) => `<div class="stat"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`)
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
      return `
        <tr>
          <td><span class="dot ${cls}">${escapeHtml(c.state)}</span></td>
          <td class="name clickable" data-logs="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
          <td class="mono">${escapeHtml(c.image)}</td>
          <td class="muted">${escapeHtml(c.status)}</td>
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

/** Load everything. */
async function refresh() {
  const [sys, containers, images] = await Promise.all([
    api("/api/system"),
    api("/api/containers"),
    api("/api/images"),
  ]);
  renderStats(sys);
  renderContainers(containers);
  renderImages(images);
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
  $("#containers").innerHTML = `<tr><td colspan="6" class="muted">Could not load data: ${escapeHtml(err.message)}. Try demo mode (DOCKER_MCP_PANEL_DEMO=true).</td></tr>`;
}

init();
