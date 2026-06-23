// Headless check for the precise route (/sheets/:id) after the Turbo Frame
// migration. Standalone/host mode: the page owns a PGlite replica and renders
// locally. Verifies the grid is one Turbo Frame, an optimistic edit reconciles,
// a morph preserves untouched cell nodes, and a server tick flashes a change.
// Run: node pwa/verify-precise.mjs   (Rails on :3017, Postgres + Electric up)

import { chromium } from "playwright-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.URL || "http://localhost:3017/sheets/1";
const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => { console.error(`  ✗ ${m}`); process.exit(1); };

// Resolve once the grid cell VALUES have not changed for `quietMs` (the initial
// snapshot has finished streaming). Compares text content only, so the transient
// flash classes the renderer adds don't read as churn.
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
  die("grid never stabilized (snapshot kept streaming)");
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // 1. The grid is one Turbo Frame, and the replica goes live.
  if (!(await page.locator('turbo-frame#sheet-grid').count())) die("no #sheet-grid turbo-frame");
  ok("grid is a single turbo-frame (#sheet-grid)");

  await page.waitForFunction(
    () => document.getElementById("status")?.textContent?.includes("Replica live"),
    null, { timeout: 45000 }
  );
  ok("replica live (stats, Σ row computed locally by PGlite)");

  // Let the initial Electric snapshot finish streaming before driving the UI.
  await waitForStableGrid(page, 2000, 40000);
  ok("initial snapshot settled (grid stable)");

  // 2. Tag an untouched grid-body cell node with a JS property (not a DOM
  // attribute, which a morph would strip) so we can prove morph keeps the node.
  await page.evaluate(() => {
    document.querySelector('#grid-body td.grid-cell[data-row="1"][data-col="1"]').__probe = true;
  });

  // 3. Optimistic edit of a different cell: it shows immediately, then reconciles.
  const NEW = String(40000 + Math.floor(Math.random() * 50000));
  const FORMATTED = Number(NEW).toLocaleString();
  const cell = page.locator('#grid-body td.grid-cell[data-row="3"][data-col="5"]');
  await cell.click();
  const input = cell.locator("input");
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.fill(NEW);
  await input.press("Enter");
  await page.waitForFunction(
    (want) => document.querySelector('#grid-body td.grid-cell[data-row="3"][data-col="5"]')?.textContent === want,
    FORMATTED, { timeout: 25000 }
  );
  ok(`edit applied and reconciled: cell (3,5) = ${FORMATTED}`);

  // 4. The tagged node is the same object: the grid body morphed, it was not
  // replaced wholesale (a full innerHTML swap would drop the JS property).
  const kept = await page.evaluate(() =>
    document.querySelector('#grid-body td.grid-cell[data-row="1"][data-col="1"]')?.__probe === true
  );
  if (!kept) die("untouched cell node was replaced (a morph would have kept it)");
  ok("morph preserved the untouched cell node (no wholesale repaint)");

  // 5. Server activity: a remote change flashes green and updates the grid.
  const before = await page.locator("#grid-body").innerHTML();
  await page.locator("#server-activity-btn").click();
  await page.waitForFunction(
    (prev) => document.getElementById("grid-body")?.innerHTML !== prev,
    before, { timeout: 25000 }
  );
  ok("server tick streamed in and updated the grid (remote change)");

  if (errors.length) {
    console.error("\n  page console errors:");
    errors.forEach((e) => console.error("   ", e));
    die(`${errors.length} console error(s)`);
  }

  console.log("\nALL PRECISE CHECKS PASSED");
} finally {
  await browser.close();
}
