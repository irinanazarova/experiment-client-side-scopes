// Verifies the SLICE's in-VM Rails: boots the packed app.wasm in a page's main
// thread (slice-vm-test.html) and dispatches requests into it through the same
// wasmify-rails RackHandler the service worker uses. This checks the thing the
// migration actually changed — the in-VM Rails rendering the one-Turbo-Frame
// grid from the local replica — without the SW context that wedges at
// WebAssembly.instantiate under Playwright (see verify-slice.mjs).
//
// Prerequisites: bin/rails slice:pack (fresh app.wasm), host on :3000, Electric
// on :3010, Postgres up, cd pwa && npm run dev -- --port 5180.
// Run: node pwa/verify-slice-vm.mjs

import { chromium } from "playwright-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.SLICE_URL || "http://localhost:5180";
const BOOT_MS = Number(process.env.SLICE_BOOT_MS || 300000);
const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => { console.error(`  ✗ ${m}`); process.exit(1); };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.error("   [pageerror]", String(e).slice(0, 200)));

try {
  await page.goto(`${BASE}/slice-vm-test.html`, { waitUntil: "domcontentloaded" });

  // Boot: PGlite + Electric sync + initRailsVM (instantiates app.wasm). Heavy,
  // so wait generously.
  await page.waitForFunction(() => window.__status && window.__status !== "booting", null, {
    timeout: BOOT_MS, polling: 2000,
  });
  const status = await page.evaluate(() => window.__status);
  if (status !== "ready") die(`in-VM boot failed: ${status}`);
  ok("in-VM Rails booted in the main thread (PGlite replica + app.wasm)");

  // 1. The in-VM Rails serves /sheets/1 as the migrated single Turbo Frame.
  const show = await page.evaluate(() => window.__dispatch("/sheets/1"));
  if (show.status !== 200) die(`GET /sheets/1 -> ${show.status}`);
  if (!/<turbo-frame id="sheet-grid"/.test(show.body)) die("no migrated grid frame in /sheets/1");
  if (/data-live-region|live_region/.test(show.body)) die("found removed live_region markup");
  const cells = (show.body.match(/grid-cell/g) || []).length;
  if (cells < 1) die("the in-VM grid rendered no cells from the replica");
  ok(`in-VM Rails rendered the migrated grid frame for /sheets/1 (${cells} grid-cell refs) from the replica`);

  // 2. The frame reload endpoint (the slice's reactive path target) renders the
  // frame alone in-VM.
  const grid = await page.evaluate(() => window.__dispatch("/sheets/1/grid"));
  if (grid.status !== 200) die(`GET /sheets/1/grid -> ${grid.status}`);
  if (!/<turbo-frame id="sheet-grid"/.test(grid.body)) die("/sheets/1/grid did not render the frame");
  if (/<html/.test(grid.body)) die("/sheets/1/grid leaked the layout (should be frame-only)");
  ok("in-VM frame reload endpoint /sheets/1/grid renders the frame alone (no layout)");

  // 3. The change-signal SQL is present (drives the slice reactor).
  if (!/data-signal-sql=/.test(show.body)) die("no data-signal-sql on the frame");
  ok("the frame carries its change-signal SQL (the slice reactor's trigger)");

  console.log("\nALL IN-VM SLICE CHECKS PASSED");
} finally {
  await browser.close();
}
