/**
 * Deep end-to-end test harness for Docker MCP Server.
 *
 * Exercises the panel REST API (demo, read-only, metrics-off), the Prometheus
 * exporter, the MCP server (full / read-only / exec), the TUI snapshot modes
 * and the installer. Prints a PASS/FAIL report and exits non-zero on failure.
 *
 * Usage: node scripts/deep-test.mjs   (a demo panel must be running on :4600)
 *
 * Crafted by SoyRage Agency — https://soyrage.es/
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
let group = "";
const G = (g) => (group = g);
const ok = (name, cond, detail = "") => { results.push({ group, name, ok: !!cond, detail }); };
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const BASE = "http://127.0.0.1:4600";
async function jget(base, path) { const r = await fetch(base + path); return { status: r.status, body: await r.json().catch(() => null) }; }
async function tget(base, path) { const r = await fetch(base + path); return { status: r.status, text: await r.text() }; }
async function jpost(base, path, body) { const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn a panel instance and wait until it answers. */
async function startPanel(env) {
  const child = spawn("node", ["dist/panel/index.js"], { env: { ...process.env, ...env }, stdio: "ignore" });
  const port = env.DOCKER_MCP_PANEL_PORT;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/meta`); if (r.ok) return child; } catch {}
    await sleep(150);
  }
  throw new Error(`panel on ${port} did not start`);
}

/** Run a batch of JSON-RPC requests against the MCP server, return responses. */
function mcp(env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/index.js"], { env: { ...process.env, DOCKER_MCP_LOG_LEVEL: "error", ...env } });
    let buf = ""; const out = [];
    const timer = setTimeout(() => { child.kill(); resolve(out); }, 8000);
    child.stdout.on("data", (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch {}
      }
      if (out.filter((m) => m.id !== undefined).length >= requests.filter((r) => r.id !== undefined).length) {
        clearTimeout(timer); child.kill(); resolve(out);
      }
    });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

// ===========================================================================
async function main() {
  // ---- 1. Panel API (demo, :4600) --------------------------------------
  G("Panel API (demo)");
  ok("GET / serves HTML", (await tget(BASE, "/")).text.includes("<!doctype html>"));
  const meta = (await jget(BASE, "/api/meta")).body;
  ok("meta author is SoyRage Agency", meta?.author === "SoyRage Agency");
  ok("meta demo=true", meta?.demo === true);
  ok("meta terminal flag present", typeof meta?.terminal === "boolean");

  const snap = (await jget(BASE, "/api/snapshot")).body;
  ok("snapshot has system/containers/images", snap?.system && Array.isArray(snap.containers) && Array.isArray(snap.images));
  eq("snapshot counts consistent (running)", snap.system.containersRunning, snap.containers.filter((c) => c.state === "running").length);
  eq("snapshot counts consistent (total)", snap.system.containersTotal, snap.containers.length);
  ok("containers carry cpu/memory", snap.containers.some((c) => typeof c.cpu === "number"));

  const conts = (await jget(BASE, "/api/containers")).body;
  ok("containers list non-empty", conts.length >= 6);
  const logs = (await jget(BASE, "/api/logs?name=web")).body;
  ok("logs returns text", typeof logs?.logs === "string" && logs.logs.length > 0);
  eq("logs missing name → 400", (await jget(BASE, "/api/logs")).status, 400);

  eq("action invalid → 400", (await jpost(BASE, "/api/action", { name: "web", action: "boom" })).status, 400);
  ok("action restart ok", (await jpost(BASE, "/api/action", { name: "web", action: "restart" })).body?.ok === true);

  // ---- 2. Alerts & auto-restart ----------------------------------------
  G("Alerts & auto-restart");
  const alerts = (await jget(BASE, "/api/alerts")).body;
  ok("alerts returns array", Array.isArray(alerts?.alerts));
  const ar1 = (await jpost(BASE, "/api/autorestart", { name: "redis", enabled: true })).body;
  ok("autorestart enable persists", ar1?.enabled?.includes("redis"));
  const ar2 = (await jpost(BASE, "/api/autorestart", { name: "redis", enabled: false })).body;
  ok("autorestart disable persists", !ar2?.enabled?.includes("redis"));

  // ---- 3. File explorer (incl. path-traversal guard) -------------------
  G("File explorer");
  const files = (await jget(BASE, "/api/files?name=api&path=/")).body;
  ok("files lists root entries", files?.entries?.length > 0);
  const app = (await jget(BASE, "/api/files?name=api&path=/app")).body;
  ok("files navigates into /app", app?.entries?.some((e) => e.name === "server.js"));
  const trav = (await jget(BASE, "/api/files?name=api&path=/../../etc")).body;
  ok("path traversal normalised (no crash)", trav && typeof trav.path === "string" && trav.path.startsWith("/"));
  const file = (await jget(BASE, "/api/file?name=api&path=/app/package.json")).body;
  ok("file read returns content", typeof file?.content === "string" && file.content.includes("name"));
  eq("file missing params → 400", (await jget(BASE, "/api/file?name=api")).status, 400);

  // ---- 3b. File editor & AI copilot ------------------------------------
  G("File editor & AI");
  const wrote = (await jpost(BASE, "/api/file", { name: "api", path: "/app/notes.txt", content: "hello soyrage\n" })).body;
  ok("write file returns bytes", wrote?.bytes > 0 && wrote.path === "/app/notes.txt");
  const readBack = (await jget(BASE, "/api/file?name=api&path=/app/notes.txt")).body;
  ok("edited file reads back", readBack?.content === "hello soyrage\n");
  const listAfter = (await jget(BASE, "/api/files?name=api&path=/app")).body;
  ok("new file appears in listing", listAfter?.entries?.some((e) => e.name === "notes.txt"));
  eq("write missing fields → 400", (await jpost(BASE, "/api/file", { name: "api" })).status, 400);
  const aiCmd = (await jpost(BASE, "/api/ai", { mode: "command", prompt: "why did web crash, show me logs" })).body;
  ok("AI command returns a docker command", /^docker /.test(aiCmd?.command || ""));
  const aiEdit = (await jpost(BASE, "/api/ai", { mode: "edit", prompt: "add a header", context: "echo hi" })).body;
  ok("AI edit returns content", typeof aiEdit?.content === "string" && aiEdit.content.includes("echo hi"));
  eq("AI missing prompt → 400", (await jpost(BASE, "/api/ai", {})).status, 400);

  // ---- 4. Terminal command runner (allow/deny) -------------------------
  G("Terminal runner");
  const rPs = (await jpost(BASE, "/api/run", { command: "docker ps" })).body;
  ok("run 'docker ps' ok", rPs?.code === 0 && rPs.output.includes("CONTAINER"));
  const rRun = (await jpost(BASE, "/api/run", { command: "docker run -it ubuntu" })).body;
  ok("run 'docker run' denied", rRun?.code === 1 && /disabled/i.test(rRun.output));
  const rBad = (await jpost(BASE, "/api/run", { command: "rm -rf /" })).body;
  ok("non-docker command denied", rBad?.code === 1);
  eq("run missing command → 400", (await jpost(BASE, "/api/run", {})).status, 400);

  // ---- 5. Snapshots & schedule -----------------------------------------
  G("Snapshots & backups");
  const before = (await jget(BASE, "/api/backups")).body.snapshots.length;
  const created = (await jpost(BASE, "/api/backup", { container: "api", type: "commit" })).body;
  ok("snapshot created", created?.container === "api" && created.ref.includes("api"));
  const after = (await jget(BASE, "/api/backups")).body.snapshots.length;
  ok("snapshot count grew", after === before + 1);
  const sched = (await jpost(BASE, "/api/schedule", { enabled: true, time: "04:30", containers: ["web", "api"], type: "export", email: "ops@example.com" })).body;
  ok("schedule saved", sched?.enabled === true && sched.time === "04:30" && sched.type === "export");
  ok("schedule rejects bad time", (await jpost(BASE, "/api/schedule", { time: "99:99" })).body.time === "04:30");

  // ---- 6. Inspect / networks / volumes ---------------------------------
  G("Inspect / system");
  const insp = (await jget(BASE, "/api/inspect?name=web")).body;
  ok("inspect returns summary", insp?.name === "web" && Array.isArray(insp.env));
  ok("inspect redacts secrets", insp.env.some((e) => /••••/.test(e)) || insp.env.every((e) => !/API_KEY=\w/.test(e)));
  ok("networks non-empty", (await jget(BASE, "/api/networks")).body.networks.length > 0);
  ok("volumes non-empty", (await jget(BASE, "/api/volumes")).body.volumes.length > 0);

  // ---- 7. Metrics -------------------------------------------------------
  G("Prometheus metrics");
  const m = await tget(BASE, "/metrics");
  eq("metrics 200", m.status, 200);
  ok("metrics has build_info + author", m.text.includes("dockermcp_build_info") && m.text.includes('author="SoyRage Agency"'));
  ok("metrics has per-container gauges", m.text.includes("dockermcp_container_cpu_percent{"));
  ok("metrics valid-ish (HELP/TYPE lines)", (m.text.match(/# TYPE /g) || []).length >= 8);

  // ---- 8. 404 / method guards ------------------------------------------
  G("HTTP guards");
  eq("unknown path → 404", (await tget(BASE, "/nope")).status, 404);
  eq("static traversal blocked", (await tget(BASE, "/../package.json")).status, 404);

  // ---- 9. Read-only panel (:4671) --------------------------------------
  G("Read-only panel");
  const roPanel = await startPanel({ DOCKER_MCP_PANEL_DEMO: "true", DOCKER_MCP_READONLY: "true", DOCKER_MCP_PANEL_PORT: "4671" });
  const RO = "http://127.0.0.1:4671";
  ok("meta readOnly=true", (await jget(RO, "/api/meta")).body.readOnly === true);
  const roAct = await jpost(RO, "/api/action", { name: "web", action: "stop" });
  ok("action blocked in read-only", roAct.status >= 400 || roAct.body?.error);
  const roRun = (await jpost(RO, "/api/run", { command: "docker restart web" })).body;
  ok("write command blocked in read-only", roRun?.code === 1 && /read-only/i.test(roRun.output));
  const roRead = (await jpost(RO, "/api/run", { command: "docker ps" })).body;
  ok("read command allowed in read-only", roRead?.code === 0);
  const roWrite = await jpost(RO, "/api/file", { name: "api", path: "/app/x.txt", content: "x" });
  ok("file save blocked in read-only", roWrite.status >= 400 || roWrite.body?.error);
  roPanel.kill();

  // ---- 10. Metrics-disabled panel (:4672) ------------------------------
  G("Metrics disabled");
  const noMetrics = await startPanel({ DOCKER_MCP_PANEL_DEMO: "true", DOCKER_MCP_PANEL_METRICS: "false", DOCKER_MCP_PANEL_PORT: "4672" });
  eq("metrics 404 when disabled", (await tget("http://127.0.0.1:4672", "/metrics")).status, 404);
  noMetrics.kill();

  // ---- 11. Terminal-disabled panel (:4673) -----------------------------
  G("Terminal disabled");
  const noTerm = await startPanel({ DOCKER_MCP_PANEL_DEMO: "true", DOCKER_MCP_PANEL_TERMINAL: "false", DOCKER_MCP_PANEL_PORT: "4673" });
  eq("run 403 when terminal disabled", (await jpost("http://127.0.0.1:4673", "/api/run", { command: "docker ps" })).status, 403);
  noTerm.kill();

  // ---- 12. MCP server (full / read-only / exec) ------------------------
  G("MCP server");
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const notif = { jsonrpc: "2.0", method: "notifications/initialized" };
  const listReq = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const aboutReq = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "about", arguments: {} } };

  const full = await mcp({}, [init, notif, listReq, aboutReq]);
  const initRes = full.find((m) => m.id === 1);
  ok("MCP initialize returns instructions w/ SoyRage", initRes?.result?.instructions?.includes("SoyRage Agency"));
  const tools = full.find((m) => m.id === 2)?.result?.tools?.map((t) => t.name) || [];
  eq("MCP full tool count = 21", tools.length, 21);
  ok("MCP has lifecycle tools", tools.includes("start_container") && tools.includes("deploy_stack"));
  ok("MCP exec hidden by default", !tools.includes("exec_in_container"));
  const about = full.find((m) => m.id === 3)?.result?.content?.[0]?.text || "";
  ok("about tool shows PayPal", about.includes("paypalme/soyrageagency"));

  const ro = await mcp({ DOCKER_MCP_READONLY: "true" }, [init, notif, listReq]);
  const roTools = ro.find((m) => m.id === 2)?.result?.tools?.map((t) => t.name) || [];
  ok("MCP read-only hides lifecycle", !roTools.includes("start_container") && !roTools.includes("deploy_stack"));
  ok("MCP read-only keeps insight", roTools.includes("list_containers") && roTools.includes("about"));

  const exec = await mcp({ DOCKER_MCP_ALLOW_EXEC: "true" }, [init, notif, listReq]);
  const execTools = exec.find((m) => m.id === 2)?.result?.tools?.map((t) => t.name) || [];
  ok("MCP exec appears when enabled", execTools.includes("exec_in_container"));

  const plug = await mcp({ DOCKER_MCP_DISABLED_PLUGINS: "lifecycle" }, [init, notif, listReq]);
  const plugTools = plug.find((m) => m.id === 2)?.result?.tools?.map((t) => t.name) || [];
  ok("MCP plugin disable removes lifecycle", !plugTools.includes("start_container"));

  // ---- 13. TUI snapshot modes ------------------------------------------
  G("TUI");
  const frame = spawnSync("node", ["dist/tui/index.js", "--frame"], { env: { ...process.env, DOCKER_MCP_PANEL_DEMO: "true" }, encoding: "utf8" });
  ok("TUI --frame renders containers", frame.stdout.includes("Containers") && frame.stdout.includes("web"));
  const splash = spawnSync("node", ["dist/tui/index.js", "--splash"], { env: { ...process.env, DOCKER_MCP_PANEL_DEMO: "true" }, encoding: "utf8" });
  ok("TUI --splash shows welcome + PayPal", splash.stdout.includes("Welcome") && splash.stdout.includes("paypalme"));
  ok("TUI has no emojis", !/[\u{1F000}-\u{1FAFF}]/u.test(frame.stdout + splash.stdout));

  // ---- 14. Installer (print + merge into temp) -------------------------
  G("Installer");
  const printOut = spawnSync("node", ["scripts/install.mjs", "--print"], { encoding: "utf8" }).stdout;
  const printJson = printOut.slice(printOut.indexOf("{"));
  let parsed = null; try { parsed = JSON.parse(printJson); } catch {}
  ok("installer --print emits valid JSON", parsed?.mcpServers?.docker?.command === "node");
  ok("installer path is absolute dist/index.js", /dist[\\/]index\.js$/.test(parsed?.mcpServers?.docker?.args?.[0] || ""));

  const tmp = mkdtempSync(join(tmpdir(), "dmcp-"));
  mkdirSync(join(tmp, "Claude"));
  writeFileSync(join(tmp, "Claude", "claude_desktop_config.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  spawnSync("node", ["scripts/install.mjs"], { env: { ...process.env, APPDATA: tmp, HOME: tmp }, encoding: "utf8" });
  const merged = JSON.parse(readFileSync(join(tmp, "Claude", "claude_desktop_config.json"), "utf8"));
  ok("installer preserves existing servers", merged.mcpServers.other?.command === "x");
  ok("installer adds docker server", merged.mcpServers.docker?.command === "node");

  // ---- Report ----------------------------------------------------------
  report();
}

function report() {
  const groups = [...new Set(results.map((r) => r.group))];
  let pass = 0, fail = 0;
  for (const g of groups) {
    console.log(`\n\x1b[1m${g}\x1b[0m`);
    for (const r of results.filter((x) => x.group === g)) {
      if (r.ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${r.name}`); }
      else { fail++; console.log(`  \x1b[31m✗ ${r.name}\x1b[0m  ${r.detail}`); }
    }
  }
  console.log(`\n\x1b[1mTOTAL:\x1b[0m ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("Harness error:", e); process.exit(2); });
