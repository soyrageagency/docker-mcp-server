import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = "assets/screenshots"; mkdirSync(OUT, { recursive: true });
const B = "http://127.0.0.1:4611";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2, colorScheme: "dark" });
const page = await ctx.newPage();
await page.goto(B, { waitUntil: "networkidle" });
await page.waitForSelector("#containers tr");
await page.click('[data-auto="api"]'); await page.click('[data-auto="backup"]'); await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/01-dashboard.png` });
console.log("01");

// logs (scroll fix visual)
await page.click('[data-logs="api"]'); await page.waitForSelector("#drawer:not(.hidden)"); await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-logs.png` }); await page.click('#drawer-close'); console.log("02");

// terminal with suggestions
await page.click('.tab[data-tab="terminal"]'); await page.waitForTimeout(200);
await page.fill('#term-input', 'docker logs'); await page.dispatchEvent('#term-input','input'); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/08-terminal.png` }); console.log("08");

// backups
await page.click('.tab[data-tab="backups"]'); await page.waitForSelector("#bk-list tr"); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/09-backups.png` }); console.log("09");

// system
await page.click('.tab[data-tab="system"]'); await page.waitForSelector("#net-list tr"); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/10-system.png` }); console.log("10");

await browser.close();
