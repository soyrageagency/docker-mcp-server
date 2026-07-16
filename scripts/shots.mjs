import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.SHOT_BASE || "http://127.0.0.1:4611";
const OUT = "assets/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await ctx.newPage();

// 1) Dashboard
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("#containers tr");
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/01-dashboard.png` });
console.log("saved 01-dashboard.png");

// 2) Logs drawer open
await page.click('[data-logs="api"]');
await page.waitForSelector("#drawer:not(.hidden)");
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-logs.png` });
console.log("saved 02-logs.png");

await browser.close();
