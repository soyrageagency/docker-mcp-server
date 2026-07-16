import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = "assets/screenshots";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, colorScheme: "dark" });
const page = await ctx.newPage();

// 1) Dashboard (monitoring)
await page.goto("http://127.0.0.1:4611", { waitUntil: "networkidle" });
await page.waitForSelector("#containers tr");
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/01-dashboard.png` });
console.log("01-dashboard.png");

// 2) Logs drawer
await page.click('[data-logs="api"]');
await page.waitForSelector("#drawer:not(.hidden)");
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-logs.png` });
console.log("02-logs.png");

// 3) Read-only variant
const ro = await ctx.newPage();
await ro.setViewportSize({ width: 1440, height: 720 });
await ro.goto("http://127.0.0.1:4612", { waitUntil: "networkidle" });
await ro.waitForSelector("#containers tr");
await ro.waitForTimeout(500);
await ro.screenshot({ path: `${OUT}/03-readonly.png` });
console.log("03-readonly.png");

await browser.close();
