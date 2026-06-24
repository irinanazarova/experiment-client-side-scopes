// Client-side scopes — the browser half of the precise route, in two modes.
// The grid is one Turbo Frame (app/views/sheets/_grid_frame.html.erb); both
// modes keep its parts in sync from the local replica.
//
// Standalone (host :3000, Phase A): this page owns a PGlite replica synced by
// Electric; per-fragment live queries drive JS renderers that mirror the server
// partials and morph the frame's parts in place (zero network). Writes apply
// optimistically here, POST to Rails, reconcile.
//
// Slice (served by Rails-in-the-browser, Phase C): the replica lives in the
// service worker, where the in-VM Rails reads it. A change-signal broadcast
// reloads the frame (mountGridFrameViaWorker -> the shared reactive frame); the
// in-tab Rails renders it from the replica and we morph the diff in. The
// optimistic write runs in the worker as real application code (Cells::BulkUpdate).

import { Idiomorph } from "https://cdn.jsdelivr.net/npm/idiomorph@0.7.4/+esm";
import { mountFlowPanel, flowEmitter } from "/flow.mjs";
import { snapshotCells, flashChanged, morphOptions } from "/blink.mjs";

const flow = flowEmitter();
const app = document.getElementById("sheet-app");
const cfg = app.dataset;
const SHEET = Number(cfg.sheetId);
const ROW_COUNT = Number(cfg.rowCount);
const COL_COUNT = Number(cfg.colCount);
const ROW_LIMIT = Number(cfg.rowLimit); // rendered window; a real sheet virtualizes the rest

const $ = (id) => document.getElementById(id);
const setStatus = (m, c = "text-gray-500") => {
  const el = $("status");
  el.textContent = m;
  el.className = `text-sm mt-1 ${c}`;
};
const fmt = (n) => (n === null || n === undefined ? "" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const morph = (el, html) => Idiomorph.morph(el, html, morphOptions);

let editing = false; // a cell editor is open; renderers must not clobber it

// Cell-change origin: a change the user just made blinks yellow, anything that
// arrives otherwise (a server tick, another client) blinks green. We mark the
// cells the user touched with a TTL that must outlast the whole round trip:
// optimistic apply -> host commit -> Electric reconcile echo re-render. If it
// expires first, the echo of your own edit re-colours green ("a change from
// elsewhere"), which is what made an edited column flash green when reconciles
// were slow. Sized well above the reconcile time (sub-second once healthy) so a
// slow round trip can't mis-colour your edit; it still expires eventually, so a
// genuine later server change to the same cell does blink green.
const localCells = new Map(); // "row-col" -> expiry (ms)
const LOCAL_TTL = 12000;
const markLocal = (col, rowFrom, rowTo) => {
  const expiry = Date.now() + LOCAL_TTL;
  const lo = Math.max(1, rowFrom);
  const hi = Math.min(ROW_LIMIT, rowTo);
  for (let r = lo; r <= hi; r++) localCells.set(`${r}-${col}`, expiry);
};
const classify = (key) => {
  const expiry = localCells.get(key);
  return expiry && expiry > Date.now() ? "local" : "remote";
};

// Route a grid re-render onto the right flow diagram by the origin of the cells
// that actually changed. `origin` is the { local, remote } tally from
// flashChanged. A change the user made completes the write loop (and its local
// sub-path); a change from elsewhere is a server push. A render that flashed
// nothing (an editor repaint, formatting-only change) falls back to the loop.
function routeGridRender(origin, ms) {
  const remote = origin?.remote ?? 0;
  const local = origin?.local ?? 0;
  if (remote > 0) {
    flow.step("server", "remote", {flows: ["push"], note: "a change from elsewhere"});
    flow.step("replica", "remote", {flows: ["push"], note: "Electric synced it"});
    flow.step("render", "remote", {flows: ["push"], ms, note: `rendered ${remote} pushed cell(s)`});
  }
  if (local > 0 || remote === 0) {
    flow.step("wal", "reconcile", {flows: ["loop"], note: "replica reconciled"});
    flow.step("render", "local", {flows: ["loop", "local"], ms, note: "ActionView rendered the grid"});
  }
}

// Auto-apply service-worker updates. The worker caches the booted app.wasm VM
// in memory, so a redeploy only reaches a tab once a fresh worker installs and
// claims it (skipWaiting + clients.claim in the SW). When that happens, reload
// onto the new worker so page logic (e.g. the frame reload) can't go stale.
// Guarded against reload loops and the first-install claim.
if (navigator.serviceWorker?.controller) {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

async function boot() {
  // Wire the toggles FIRST, so a problem mounting the flow panel can never
  // leave a button without its click handler.
  wireServerActivity();
  wireRejectToggle();
  const panel = $("flow-panel");
  if (panel) {
    try { mountFlowPanel(panel); }
    catch (e) { console.error("[flow] panel mount failed (non-fatal)", e); }
  }
  if (navigator.serviceWorker?.controller) return bootSlice();
  return bootStandalone();
}

// The "Server activity" toggle: while on, post one tick every two seconds to
// the host, which sets a small 5-cell section (Cells::RandomTick). The write
// commits and Electric streams it to every replica, so it lands as a cluster of
// green blinks on this and every other open client. Ticks are never marked
// local, so even the tab that drives them sees green: it is server activity,
// not your edit.
const TICK_INTERVAL_MS = 2000;
function wireServerActivity() {
  const btn = $("server-activity-btn");
  if (!btn) return;
  const label = btn.querySelector(".label");
  let timer = null;
  let sent = 0;

  const render = () => {
    btn.classList.toggle("active", !!timer);
    btn.setAttribute("aria-checked", timer ? "true" : "false");
    label.textContent = timer ? `Server activity: on · ${sent} sent` : "Server activity: off";
  };
  const tick = () => {
    sent++;
    render(); // the live counter makes it obvious the toggle is actually running
    fetch(cfg.ticksUrl, {
      method: "POST",
      headers: {"X-CSRF-Token": cfg.csrf, "Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({sheet_id: String(SHEET)}),
    }).catch(() => {});
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
    render();
  };
  const start = () => {
    sent = 0;
    timer = setInterval(tick, TICK_INTERVAL_MS);
    tick();
  };

  btn.addEventListener("click", () => (timer ? stop() : start()));
  addEventListener("beforeunload", stop);
  render();
}

// The "Server rejects writes" toggle: while on, each write carries reject=1.
// Only the host authority honors it (the in-VM optimistic apply runs in the
// wasm env and ignores the flag), so you watch your edit apply optimistically
// and then snap back when the authority refuses it. It makes the loop's final,
// normally-invisible reconcile step visible: the replica never diverges from
// the server. (In the happy path the authority agrees, so that render lands the
// same values and you see nothing — this forces the disagreement.)
let rejectWrites = false;
function wireRejectToggle() {
  const btn = $("reject-btn");
  if (!btn) return;
  const label = btn.querySelector(".label");
  const render = () => {
    btn.classList.toggle("active", rejectWrites);
    btn.setAttribute("aria-checked", rejectWrites ? "true" : "false");
    label.textContent = rejectWrites ? "Server rejects writes: on" : "Server rejects writes: off";
  };
  btn.addEventListener("click", () => { rejectWrites = !rejectWrites; render(); });
  render();
}

// ---------------------------------------------------------------------------
// Slice mode: thin page over the worker's replica + in-tab ActionView. The
// worker watches the change signal and the grid frame reloads + morphs (the
// shared reactive frame, fed by the worker instead of a local live query).
// ---------------------------------------------------------------------------
async function bootSlice() {
  flow.mode("slice — Rails in the browser");
  const frame = document.getElementById("sheet-grid");
  const { mountGridFrameViaWorker } = await import("/slice_frame.mjs");

  // One frame, one signal: the worker watches the change signal and we reload the
  // frame (in-tab Rails renders it from the replica) and morph the diff in. The
  // origin tally drives the flow trace (your edit lights the loop, a change from
  // elsewhere lights the push path).
  const reactor = mountGridFrameViaWorker(frame, {
    classify,
    isEditing: () => editing,
    onRender: (ms, origin) => {
      $("timing").textContent = `ActionView re-render in-tab: ${ms} ms (no network)`;
      routeGridRender(origin, ms);
    },
  });

  wireBulkEdit(null);
  wireCellEdit(null, () => reactor?.flush()); // flush a reload deferred during the edit
  setStatus("Live. The grid is rendered by ActionView in this tab, from the local replica.", "text-green-600");
}

// ---------------------------------------------------------------------------
// Standalone mode (Phase A): page-owned replica, JS renderers.
// ---------------------------------------------------------------------------
async function bootStandalone() {
  flow.mode("standalone — page-owned replica");
  setStatus("Starting PGlite (Postgres in your browser)…", "text-amber-600");
  const [{ PGlite }, { live }, { electricSync }] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.4.6/dist/index.js"),
    import("https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.4.6/dist/live/index.js"),
    import("https://cdn.jsdelivr.net/npm/@electric-sql/pglite-sync@0.5.6/+esm"),
  ]);

  const pg = await PGlite.create({ extensions: { live, electric: electricSync() } });
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS cells (
      id bigint PRIMARY KEY, sheet_id bigint, row integer,
      col integer, value numeric, formula text
    );
  `);

  setStatus("Fetching authorized shape from Rails…", "text-amber-600");
  const shape = await fetch(cfg.scopeUrl, { headers: { Accept: "application/json" } }).then((r) => r.json());

  setStatus("Syncing slice from Electric…", "text-amber-600");
  await pg.electric.syncShapeToTable({
    shape: { url: shape.url, params: shape.params },
    table: "cells",
    primaryKey: ["id"],
    shapeKey: "cells",
  });

  wireLiveQueries(pg);
  wireBulkEdit(pg);
  wireCellEdit(pg, null);
}

// Live queries drive the page: PGlite re-runs them whenever cells change
// (local edit, column op, or a server push via Electric) and the renderers
// patch the DOM. Markup mirrors app/views/sheets/_grid.html.erb.
function wireLiveQueries(pg) {
  let first = true;
  let stats = {}; // latest header stats; the Σ row's Max cell reads stats.max

  const renderStats = () => {
    for (const key of ["max", "min", "average", "median"]) {
      const el = $(`stat-${key}`);
      if (el) el.textContent = fmt(stats[key]);
    }
  };

  let sums = {};
  const renderTotals = () => {
    if (!Object.keys(sums).length) return; // keep the server-rendered row until sums arrive
    let cells = `<td class="ss-corner">Σ</td><td class="ss-rowmax">${fmt(stats.max)}</td>`;
    for (let c = 1; c <= COL_COUNT; c++) cells += `<td>${fmt(sums[c])}</td>`;
    morph($("grid-totals"), `<tr class="ss-totals">${cells}</tr>`);
  };

  // Header stats — max/min/avg/median over all cells, computed locally.
  pg.live.query(cfg.statsSql, [], (res) => {
    const r = res.rows[0] ?? {};
    stats = { max: r.max, min: r.min, average: r.avg, median: r.median };
    renderStats();
    renderTotals();
  });

  // Σ totals row — the AR-generated per-column sum SQL, run locally.
  pg.live.query(cfg.sumsSql, [], (res) => {
    sums = {};
    res.rows.forEach((r) => (sums[r.col] = r.total));
    renderTotals();
    if (first && res.rows.length) {
      first = false;
      setStatus("Replica live. Stats, Max column and Σ row are computed locally by PGlite.", "text-green-600");
    }
    // The render node is lit by the grid query below, which knows the origin
    // (local edit vs server push) of the cells that changed.
  });

  // The visible grid window, with the per-row Max computed in the renderer.
  let gridFirst = true; // skip routing the initial snapshot (every cell "changes")
  pg.live.query(
    `SELECT row, col, value FROM cells WHERE sheet_id = $1 AND row <= $2 ORDER BY row, col`,
    [SHEET, ROW_LIMIT],
    (res) => {
      if (editing) return; // never clobber an open editor; next change repaints
      const grid = {};
      res.rows.forEach((r) => {
        (grid[r.row] ||= {})[r.col] = r.value;
      });
      let body = "";
      for (let r = 1; r <= ROW_LIMIT; r++) {
        let max = null;
        let tds = "";
        for (let c = 1; c <= COL_COUNT; c++) {
          const v = grid[r]?.[c];
          if (v !== null && v !== undefined && (max === null || Number(v) > max)) max = Number(v);
          tds += `<td class="ss-cell grid-cell" data-row="${r}" data-col="${c}">${fmt(v)}</td>`;
        }
        body += `<tr><td class="ss-rownum">${r}</td><td class="ss-rowmax">${fmt(max)}</td>${tds}</tr>`;
      }
      const gridEl = $("grid-body");
      const before = snapshotCells(gridEl);
      morph(gridEl, body);
      const origin = flashChanged(gridEl, before, classify);
      if (gridFirst) gridFirst = false;
      else routeGridRender(origin);
    }
  );
}

// One safe write path, shared by the column button and single-cell edits.
// Standalone: optimistic local write here, POST to Rails, roll back on
// rejection. Slice: the worker owns optimism (it runs Cells::BulkUpdate
// in-VM and rolls back the replica itself); this just POSTs and reports.
async function applyBulk(pg, { col, operation, operand, rowFrom, rowTo }) {
  // A user edit lights the full write loop and its instant local sub-path. The
  // render node is lit later, by the renderer, once the replica change repaints.
  const LOOP = {flows: ["loop", "local"]};
  flow.reset();
  flow.step("edit", "local", {...LOOP, note: `${operation} col ${col}`});
  markLocal(col, rowFrom, rowTo); // these cells should blink yellow, not green
  let snapshot = [];
  if (pg) {
    const rowFilter = `sheet_id = $1 AND col = $2 AND row BETWEEN $3 AND $4`;
    const rowBinds = [SHEET, col, rowFrom, rowTo];
    const expr =
      operation === "multiply" ? `value = COALESCE(value,0) * $1`
      : operation === "add" ? `value = COALESCE(value,0) + $1`
      : `value = $1`;

    snapshot = (await pg.query(`SELECT id, value FROM cells WHERE ${rowFilter}`, rowBinds)).rows;

    const t0 = performance.now();
    await pg.query(
      `UPDATE cells SET ${expr} WHERE ${rowFilter.replace(/\$(\d)/g, (_, n) => `$${+n + 1}`)}`,
      [operand, ...rowBinds]
    );
    const ms = +(performance.now() - t0).toFixed(1);
    $("timing").textContent = `local apply + aggregates recompute: ${ms} ms (no network)`;
    flow.step("replica", "local", {...LOOP, ms, note: "optimistic apply, no network"});
  } else {
    // Slice mode: the service worker owns the optimistic in-VM apply and
    // emits its own replica/authority steps.
    flow.step("replica", "local", {...LOOP, note: "optimistic apply in the worker"});
  }

  const body = new URLSearchParams({
    sheet_id: String(SHEET), row_from: String(rowFrom), row_to: String(rowTo),
    col_from: String(col), col_to: String(col), operation, operand: String(operand),
  });
  if (rejectWrites) body.set("reject", "1"); // the host authority refuses; replica rolls back

  let resp;
  const tNet = performance.now();
  try {
    resp = await fetch(cfg.bulkUrl, {
      method: "POST",
      headers: { "X-CSRF-Token": cfg.csrf, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
  } catch (e) {
    if (pg) await rollback(pg, snapshot);
    flow.step("authority", "error", {note: "network error, rolled back"});
    setStatus(`Network error, rolled back: ${e.message}`, "text-red-600");
    return;
  }
  const netMs = Math.round(performance.now() - tNet);

  if (resp.ok) {
    const j = await resp.json().catch(() => ({}));
    flow.step("authority", "network", {ms: netMs, note: `host committed ${j.updated ?? "?"} cells (1 txn)`});
    flow.step("wal", "reconcile", {note: "Electric streaming authoritative rows"});
    setStatus(`Server updated ${j.updated ?? "?"} cells. Electric reconciling replica…`, "text-indigo-600");
  } else {
    const j = await resp.json().catch(() => ({}));
    if (pg) await rollback(pg, snapshot);
    flow.step("authority", "error", {ms: netMs, note: `rejected (${resp.status}), rolled back`});
    setStatus(`Server rejected (${resp.status}): ${j.error ?? "error"}. Rolled back, replica still matches server.`, "text-red-600");
  }
}

async function rollback(pg, snapshot) {
  if (!snapshot.length) return;
  const ids = snapshot.map((r) => r.id);
  const values = snapshot.map((r) => (r.value === null ? null : String(r.value)));
  await pg.query(
    `UPDATE cells AS c SET value = d.value
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::numeric[]) AS value) d
      WHERE c.id = d.id`,
    [ids, values]
  );
}

function wireBulkEdit(pg) {
  const btn = $("apply-btn");
  btn.disabled = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await applyBulk(pg, {
        col: parseInt($("op-col").value, 10),
        operation: $("op-kind").value,
        operand: parseFloat($("op-operand").value),
        rowFrom: 1,
        rowTo: ROW_COUNT,
      });
    } finally {
      btn.disabled = false; // never leave the button stuck, even on error
    }
  });
}

// Click a cell -> inline editor -> set that one cell through the same write
// path. Event delegation on #sheet-live survives fragment morphs.
function wireCellEdit(pg, afterCommit) {
  $("sheet-live").addEventListener("click", (e) => {
    const td = e.target.closest(".grid-cell");
    if (!td || editing) return;
    editing = true;

    const row = Number(td.dataset.row);
    const col = Number(td.dataset.col);
    const original = td.textContent;
    const input = document.createElement("input");
    input.type = "number";
    input.value = original.replace(/,/g, "");
    input.className = "w-20 text-right border border-indigo-400 rounded px-1";
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();

    // Closing the editor replaces the cell's content, which removes the focused
    // input and fires its blur handler. Guard so Enter (or Escape) doesn't then
    // re-enter through that blur and fire a second write — or, after a cancel,
    // commit the cell at all.
    let done = false;
    const cancel = () => {
      if (done) return;
      done = true;
      td.textContent = original;
      editing = false;
      afterCommit?.();
    };
    const commit = async () => {
      if (done) return;
      const val = parseFloat(input.value);
      if (Number.isNaN(val)) return cancel();
      done = true;
      td.textContent = fmt(val); // optimistic display; the replica repaints on change
      editing = false;
      await applyBulk(pg, { col, operation: "set", operand: val, rowFrom: row, rowTo: row });
      afterCommit?.();
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  });
}

boot().catch((e) => {
  console.error("[sheet] boot failed", e);
  setStatus(`Boot failed: ${e.message}`, "text-red-600");
});
