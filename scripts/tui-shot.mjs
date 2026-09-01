/**
 * Render the terminal UI to PNG screenshots for documentation.
 *
 * Captures the TUI's ANSI output (via its non-interactive --frame/--splash
 * modes), converts the SGR colours to HTML, frames it as a terminal window
 * and screenshots it with Playwright.
 *
 * Crafted by SoyRage Agency — https://soyrage.es/
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const FG = { 30:"#1b1f27",31:"#f0625b",32:"#3ad07f",33:"#f5b942",34:"#3b82f6",35:"#c678dd",36:"#56c8d8",37:"#e6ebf3",90:"#8a95a8",94:"#6cb6ff",96:"#5ad3e6" };
const C256 = { 39:"#3b9ef0", 24:"#17415f" };
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));

/** Minimal ANSI (SGR) -> HTML converter for the codes the TUI uses. */
function convert(text) {
  let out = "", st = { bold:false, dim:false, inv:false, fg:null, bg:null };
  const open = () => {
    let fg = st.fg, bg = st.bg;
    if (st.inv) { const t = fg || "#e6ebf3"; fg = bg || "#0d1017"; bg = t; }
    const s = [];
    if (fg) s.push(`color:${fg}`);
    if (bg) s.push(`background:${bg}`);
    if (st.bold) s.push("font-weight:700");
    if (st.dim) s.push("opacity:.62");
    return `<span style="${s.join(";")}">`;
  };
  for (const line of text.split("\n")) {
    let i = 0, cur = "";
    const flush = (txt) => { if (txt) cur += open() + esc(txt) + "</span>"; };
    while (i < line.length) {
      if (line[i] === "\x1b") {
        const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
        if (m) {
          const codes = m[1].split(";").map(Number);
          for (let k = 0; k < codes.length; k++) {
            const c = codes[k];
            if (c === 0) st = { bold:false,dim:false,inv:false,fg:null,bg:null };
            else if (c === 1) st.bold = true;
            else if (c === 2) st.dim = true;
            else if (c === 22) { st.bold = false; st.dim = false; }
            else if (c === 7) st.inv = true;
            else if (c === 27) st.inv = false;
            else if (c === 38 && codes[k+1] === 5) { st.fg = C256[codes[k+2]] || "#e6ebf3"; k += 2; }
            else if (c === 48 && codes[k+1] === 5) { st.bg = C256[codes[k+2]] || null; k += 2; }
            else if (FG[c]) st.fg = FG[c];
            else if (c === 39) st.fg = null;
            else if (c === 49) st.bg = null;
          }
          i += m[0].length; continue;
        }
        // Non-SGR CSI (cursor moves, erases...): skip it, it has no visual
        // equivalent here. Without this the scanner never advances and loops.
        const csi = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
        if (csi) { i += csi[0].length; continue; }
        i += 1; continue;
      }
      let j = line.indexOf("\x1b", i); if (j === -1) j = line.length;
      flush(line.slice(i, j)); i = j;
    }
    out += cur + "\n";
  }
  return out;
}

function page(ansi) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#05070c;font-family:'JetBrains Mono','Cascadia Code',Consolas,monospace}
    .term{position:relative;margin:26px;padding:22px 24px 30px;background:#0d1017;border:1px solid #232c3d;border-radius:12px;
          box-shadow:0 24px 60px rgba(0,0,0,.5);width:max-content}
    .barw{display:flex;gap:8px;margin-bottom:16px}
    .barw i{width:12px;height:12px;border-radius:50%}
    pre{margin:0;font-size:13px;line-height:1.38;color:#e6ebf3;white-space:pre}
  </style></head><body>
    <div class="term">
      <div class="barw"><i style="background:#f0625b"></i><i style="background:#f5b942"></i><i style="background:#3ad07f"></i></div>
      <pre>${convert(ansi)}</pre>
    </div>
  </body></html>`;
}

async function shoot(browser, ansi, out) {
  const htmlPath = resolve("assets/screenshots/_tmp.html");
  writeFileSync(htmlPath, page(ansi));
  const p = await browser.newPage({ deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  const el = await p.$(".term");
  await el.screenshot({ path: out });
  await p.close();
  console.log(`saved ${out}`);
}

mkdirSync("assets/screenshots", { recursive: true });
const env = { ...process.env, DOCKER_MCP_PANEL_DEMO: "true", FORCE_COLOR: "3" };
// The TUI repaints in place: its output can hold several full frames separated
// by a cursor-home escape. Keep only the last one, which is the settled view.
const lastFrame = (out) => {
  // The app paints a live frame (cursor-home ... erase-below) before the
  // snapshot is written, so keep only what follows the last erase.
  const i = out.lastIndexOf("\x1b[J");
  return (i === -1 ? out : out.slice(i + 3)).replace(/^(?:\x1b\[[0-9;]*[A-Za-z])+/, "");
};
const run = (args) => execSync(`node dist/tui/index.js ${args}`, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const frame = lastFrame(run("--frame"));
const splash = lastFrame(run("--splash"));
const aiFrame = lastFrame(run("--frame --msg"));

const browser = await chromium.launch();
await shoot(browser, splash, "assets/screenshots/05-tui-welcome.png");
await shoot(browser, frame, "assets/screenshots/04-tui.png");
await shoot(browser, aiFrame, "assets/screenshots/06-tui-ai.png");
await browser.close();
rmSync("assets/screenshots/_tmp.html", { force: true });
