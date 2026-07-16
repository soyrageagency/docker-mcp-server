import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = "assets/screenshots";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: "dark" });
const page = await ctx.newPage();
const B = "http://127.0.0.1:4611";

// 1) Overview
await page.goto(B, { waitUntil: "networkidle" });
await page.waitForSelector("#containers tr");
// enable auto-restart on a couple so the toggle shows "on"
await page.click('[data-auto="api"]'); await page.waitForTimeout(150);
await page.click('[data-auto="backup"]'); await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/01-dashboard.png` });
console.log("01");

// 2) Logs drawer
await page.click('[data-logs="api"]');
await page.waitForSelector("#drawer:not(.hidden)");
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-logs.png` });
await page.click('#drawer-close');
console.log("02");

// 6) Files tab
await page.click('.tab[data-tab="files"]');
await page.waitForSelector("#fs-list tr");
await page.waitForTimeout(300);
// navigate into /app
const appRow = await page.$('#fs-list [data-name="app"]');
if (appRow) { await appRow.click(); await page.waitForTimeout(300); }
await page.screenshot({ path: `${OUT}/06-files.png` });
console.log("06");

// 7) Alerts tab
await page.click('.tab[data-tab="alerts"]');
await page.waitForSelector("#alerts-list .alert, #alerts-list .ok");
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/07-alerts.png` });
console.log("07");

await browser.close();
