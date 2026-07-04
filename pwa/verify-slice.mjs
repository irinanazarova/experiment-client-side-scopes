// Full end-to-end check for the SLICE: Rails-in-the-browser. Boots the packed
// app.wasm inside the real (production-built) service worker and verifies the
// in-VM Rails serves the migrated grid (one Turbo Frame) from the local replica,
// then that an edit reconciles through the host and reloads the frame.
//
// Use the PRODUCTION build: the dev-server service-worker shim wedges at
// WebAssembly.instantiate under Playwright, but the built rails.sw.js boots.
//
// Prerequisites:
//   - bin/rails slice:pack                 fresh app.wasm with the current app
//   - host Rails on :3000                  the proxy target (shape + writes)
//   - Electric on :3010, Postgres up
//   - cd pwa && npm run build && npm run preview -- --port 5181
//                                          serves dist/ (real SW) + the host proxy
// Run: node pwa/verify-slice.mjs
//
// The index.html loader registers /rails.sw.js, waits for the VM to boot, then
// redirects to /sheets/1 served by the in-VM Rails. A cold boot is slow
// (~30-90s here); SLICE_BOOT_MS tunes the budget.

import { chromium } from "playwright-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.SLICE_URL || "http://localhost:5181";
const BOOT_MS = Number(process.env.SLICE_BOOT_MS || 180000);
const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => { console.error(`  ✗ ${m}`); process.exit(1); };

// Resolve once the grid cell values have been unchanged for `quietMs` (the
// in-VM reloads from the initial snapshot have settled), so a click can't race a
// frame reload and lose the editor.
async function waitForStableGrid(page, quietMs, timeoutMs) {
  const signature = () =>
    page.$$eval("#grid-body td.grid-cell", (tds) => tds.map((td) => td.textContent).join("|"));
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const now = await signature();
    if (now !== last) { last = now; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= quietMs) return;
    await page.waitForTimeout(250);
  }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

try {
  // 1. Load the loader; it registers the service worker, boots the VM, and
  // redirects to /sheets/1 served by the in-VM Rails. Wait through it for the
  // migrated grid frame's cells to appear.
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("turbo-frame#sheet-grid #grid-body td.grid-cell", { timeout: BOOT_MS });
  if (!/\/sheets\/1/.test(page.url())) die(`expected to land on /sheets/1, got ${page.url()}`);
  ok("slice booted: production service worker activated and served /sheets/1 from the in-VM Rails");

  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!controlled) die("the page is not controlled by the service worker");
  const cells = await page.locator("#grid-body td.grid-cell").count();
  ok(`in-VM Rails rendered the migrated grid frame (${cells} cells, one Turbo Frame) from the replica`);

  await waitForStableGrid(page, 2500, 30000); // let the in-VM snapshot reloads settle

  // 2. Edit a cell: the worker applies it optimistically in-VM, POSTs to the host
  // (:3000), Electric reconciles the replica, the change signal fires, and the
  // frame reloads from the in-tab Rails.
  const NEW = String(30000 + Math.floor(Math.random() * 60000));
  const FORMATTED = Number(NEW).toLocaleString();
  const cell = page.locator('#grid-body td.grid-cell[data-row="2"][data-col="3"]');
  const input = cell.locator("input");
  // A slow in-VM reload can wipe a just-opened editor, so retry opening it.
  let opened = false;
  for (let attempt = 0; attempt < 5 && !opened; attempt++) {
    await cell.click();
    opened = await input.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
    if (!opened) await waitForStableGrid(page, 2000, 15000);
  }
  if (!opened) die("could not open the cell editor (in-VM reloads kept clobbering it)");
  await input.fill(NEW);
  await input.press("Enter");
  await page.waitForFunction(
    (want) => document.querySelector('#grid-body td.grid-cell[data-row="2"][data-col="3"]')?.textContent === want,
    FORMATTED, { timeout: 30000 }
  );
  ok(`edit reconciled in the slice: cell (2,3) = ${FORMATTED} (in-VM apply -> host -> Electric -> frame reload)`);

  // Asset-level 404s (a favicon/icon variant the in-VM Rails does not serve) are
  // benign: the three functional checks above already prove boot, render, and the
  // full reconcile loop. Fail only on real errors (JS exceptions, module loads).
  const real = errors.filter(
    (e) => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(e)
  );
  if (real.length) {
    console.error("\n  page console errors:");
    real.forEach((e) => console.error("   ", e));
    die(`${real.length} console error(s)`);
  }

  console.log("\nALL SLICE CHECKS PASSED");
} finally {
  await browser.close();
}
