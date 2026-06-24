// Headless check for the coarse local-first Turbo-Frame route.
// Boots the page in real Chrome, then verifies the two reactive paths:
//   1. an edit POSTs to Rails, and the frame reloads with the authoritative value
//   2. a server tick streams in and the frame reloads (a remote change)
// Run: node pwa/verify-coarse.mjs   (Rails on :3017, Postgres + Electric up)

import { chromium } from "playwright-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.URL || "http://localhost:3017/sheets/1/coarse";
const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => { console.error(`  ✗ ${m}`); process.exit(1); };

// Resolve once the grid body has not changed for `quietMs` (startup snapshot done).
async function waitForStableGrid(page, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const now = await page.locator("#grid-body").innerHTML();
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

  // 1. Replica boots and the single watcher reports live.
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent?.includes("Live"),
    null, { timeout: 45000 }
  );
  ok("replica live (coarse watcher registered)");

  const frame = page.locator("#sheet-grid");
  if (!(await frame.count())) die("no #sheet-grid turbo-frame on the page");
  ok("grid is a single turbo-frame (#sheet-grid)");

  // Let the initial Electric snapshot finish streaming (it arrives in chunks,
  // each a reload) before driving the UI, so a click can't race a startup morph.
  // Wait until the grid body has been stable for ~2s.
  await waitForStableGrid(page, 2000, 30000);
  ok("initial snapshot settled (grid stable)");

  // 2. Edit a cell -> POST -> frame reloads with the authoritative value. Use a
  // fresh random value so the assertion can't pass on a leftover from a prior run.
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
  ok(`edit reconciled: cell (3,5) reloaded as ${FORMATTED} (write -> Electric -> frame reload)`);

  // 3. The reload reported its signal -> render latency.
  const sawTiming = await page.waitForFunction(
    () => /reloaded in \d+ ms/.test(document.getElementById("timing")?.textContent || ""),
    null, { timeout: 5000 }
  ).then(() => true).catch(() => false);
  const timing = await page.locator("#timing").textContent();
  if (!sawTiming) die(`no reload timing readout (got: ${JSON.stringify(timing)})`);
  ok(`latency readout present: "${timing.trim()}"`);

  // 4. Server activity -> a remote change reloads the frame. Snapshot the body,
  // turn ticks on, wait for the grid to change.
  const before = await page.locator("#grid-body").innerHTML();
  await page.locator("#server-activity-btn").click();
  await page.waitForFunction(
    (prev) => document.getElementById("grid-body")?.innerHTML !== prev,
    before, { timeout: 25000 }
  );
  ok("server tick streamed in and reloaded the frame (remote change)");

  if (errors.length) {
    console.error("\n  page console errors:");
    errors.forEach((e) => console.error("   ", e));
    die(`${errors.length} console error(s)`);
  }

  console.log("\nALL COARSE CHECKS PASSED");
} finally {
  await browser.close();
}
