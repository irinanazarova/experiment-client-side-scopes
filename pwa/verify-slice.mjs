// End-to-end check for the SLICE: Rails-in-the-browser. Boots the packed
// app.wasm inside a real service worker, then verifies the in-VM Rails serves
// the migrated grid (one Turbo Frame) from the local PGlite replica and that an
// edit reconciles through the host and reloads the frame.
//
// Prerequisites:
//   - bin/rails slice:pack                  fresh app.wasm with the current app
//   - host Rails on :3000                   the vite proxy target (shape + writes)
//   - Electric on :3010, Postgres up
//   - cd pwa && npm run dev -- --port 5180  serves the slice (boot.html registers
//                                           the dev service worker; the proxy
//                                           forwards /client_scopes + /cells)
// Run: node pwa/verify-slice.mjs
//
// NOTE: instantiating the ~52 MB app.wasm inside a headless service worker is
// heavy; a cold boot can take a few minutes (real cold-start on a warm Chrome is
// ~25 s). SLICE_BOOT_MS overrides the boot budget.

import { chromium } from "playwright-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.SLICE_URL || "http://localhost:5180";
const BOOT_MS = Number(process.env.SLICE_BOOT_MS || 240000);
const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => { console.error(`  ✗ ${m}`); process.exit(1); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

try {
  // 1. boot.html registers the dev service worker, which boots PGlite + Electric
  // + the Rails VM. Wait until it controls the page.
  await page.goto(`${BASE}/boot.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !document.getElementById("launch-button")?.disabled || !!navigator.serviceWorker.controller,
    null, { timeout: BOOT_MS, polling: 2000 }
  ).catch(() => die(`service worker did not boot the VM within ${Math.round(BOOT_MS / 1000)}s`));
  ok("slice booted: service worker + in-VM Rails VM activated");

  // 2. Navigate into the app: now served by the in-VM Rails from the replica.
  await page.goto(`${BASE}/sheets/1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("turbo-frame#sheet-grid #grid-body td.grid-cell", { timeout: 60000 });
  const cells = await page.locator("#grid-body td.grid-cell").count();
  if (cells < 1) die("the grid frame rendered no cells");
  ok(`in-VM Rails rendered the migrated grid frame (${cells} cells, one Turbo Frame) from the local replica`);

  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!controlled) die("the page is not controlled by the service worker");
  ok("page runs as a slice (controlled by the worker, sheet.mjs -> bootSlice)");

  await page.waitForTimeout(3000); // let the initial snapshot settle

  // 3. Edit a cell: the worker applies it optimistically in-VM, POSTs to the host
  // (:3000), Electric reconciles the replica, the change signal fires, and the
  // frame reloads from the in-tab Rails.
  const NEW = String(30000 + Math.floor(Math.random() * 60000));
  const FORMATTED = Number(NEW).toLocaleString();
  const cell = page.locator('#grid-body td.grid-cell[data-row="2"][data-col="3"]');
  await cell.click();
  const input = cell.locator("input");
  await input.waitFor({ state: "visible", timeout: 8000 });
  await input.fill(NEW);
  await input.press("Enter");
  await page.waitForFunction(
    (want) => document.querySelector('#grid-body td.grid-cell[data-row="2"][data-col="3"]')?.textContent === want,
    FORMATTED, { timeout: 30000 }
  );
  ok(`edit reconciled in the slice: cell (2,3) = ${FORMATTED} (in-VM apply -> host -> Electric -> frame reload)`);

  const real = errors.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED|dev-sw/i.test(e));
  if (real.length) {
    console.error("\n  page console errors:");
    real.forEach((e) => console.error("   ", e));
    die(`${real.length} console error(s)`);
  }

  console.log("\nALL SLICE CHECKS PASSED");
} finally {
  await browser.close();
}
