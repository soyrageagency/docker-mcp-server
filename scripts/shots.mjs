import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = "assets/screenshots"; mkdirSync(OUT, { recursive: true });
const B = "http://127.0.0.1:4611";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2, colorScheme: "light" });
const page = await ctx.newPage();
await page.goto(B, { waitUntil: "networkidle" });
await page.waitForSelector("#containers tr");
await page.click('[data-auto="api"]'); await page.click('[data-auto="backup"]'); await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/01-dashboard.png` }); console.log("01");

await page.click('[data-logs="api"]'); await page.waitForSelector("#drawer:not(.hidden)"); await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-logs.png` }); await page.click('#drawer-close'); console.log("02");

await page.click('.tab[data-tab="terminal"]'); await page.waitForTimeout(200);
await page.fill('#term-input', 'docker logs'); await page.dispatchEvent('#term-input','input'); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/08-terminal.png` }); console.log("08");

await page.click('.tab[data-tab="files"]'); await page.waitForSelector("#fs-list tr"); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/06-files.png` }); console.log("06");

// File editor — open a text file to show the light-surfaced editor.
const fileRow = await page.$('#fs-list [data-name="entrypoint.sh"]');
if (fileRow) {
  await fileRow.click();
  await page.waitForSelector('.editor', { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/11-editor.png` }); console.log("11");
}

await page.click('.tab[data-tab="backups"]'); await page.waitForSelector("#bk-list tr"); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/09-backups.png` }); console.log("09");

await page.click('.tab[data-tab="system"]'); await page.waitForSelector("#net-list tr"); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/10-system.png` }); console.log("10");

await page.click('.tab[data-tab="alerts"]'); await page.waitForSelector("#alerts-list .alert, #alerts-list .ok"); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/07-alerts.png` }); console.log("07");

// read-only variant
const ro = await ctx.newPage();
await ro.setViewportSize({ width: 1440, height: 720 });
await ro.goto("http://127.0.0.1:4612", { waitUntil: "networkidle" });
await ro.waitForSelector("#containers tr"); await ro.waitForTimeout(400);
await ro.screenshot({ path: `${OUT}/03-readonly.png` }); console.log("03");

await browser.close();
