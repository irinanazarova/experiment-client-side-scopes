// Coarse local-first, the browser half. The whole grid is ONE Turbo Frame. The
// page owns a PGlite replica (synced by Electric) and watches a single change
// signal — Cells::ChangeSignal, one cheap aggregate over the whole relation.
// When that signal moves (this tab's write, another tab, or a server tick), we
// reload the frame. Turbo fetches the frame's reload URL and morphs it in.
//
// This is the "as simple as Hotwire" receiver: no per-fragment live regions, no
// optimistic JS rendering. A write goes to Rails; once Electric reconciles the
// replica, the signal fires and the frame reloads. On the host the reload reads
// server Postgres (a round trip); in the slice build the same frame reloads
// from the in-tab Rails reading the local replica (zero network). Same code.

import { mountReactiveFrame } from "/reactive_frame.mjs";

const app = document.getElementById("sheet-app");
const cfg = app.dataset;
const SHEET = Number(cfg.sheetId);
const ROW_COUNT = Number(cfg.rowCount);
const ROW_LIMIT = Number(cfg.rowLimit);

const frame = document.getElementById("sheet-grid");
const $ = (id) => document.getElementById(id);
const setStatus = (m, c = "text-gray-500") => {
  const el = $("status");
  el.textContent = m;
  el.className = `text-sm mt-1 ${c}`;
};

// Cell-change origin, same contract as the precise demo: a cell this user just
// wrote blinks yellow, anything else (a server tick, another tab) blinks green.
// We mark a cell local on write with a TTL that outlasts the whole round trip
// (write -> host commit -> Electric reconcile -> frame reload).
const localCells = new Map(); // "row-col" -> expiry (ms)
const LOCAL_TTL = 12000;
const markLocal = (col, rowFrom, rowTo) => {
  const expiry = Date.now() + LOCAL_TTL;
  for (let r = Math.max(1, rowFrom); r <= Math.min(ROW_LIMIT, rowTo); r++) {
    localCells.set(`${r}-${col}`, expiry);
  }
};
const classify = (key) => {
  const expiry = localCells.get(key);
  return expiry && expiry > Date.now() ? "local" : "remote";
};

let editing = false; // a cell editor is open; a reload must not clobber it

// The receiver: one Turbo Frame, reloaded + morphed when the trigger fires. The
// readout names the cost and whose change it was (the flash origin tells them
// apart). Debounced because the initial snapshot streams in and a column apply
// lands many rows at once.
const reactor = mountReactiveFrame(frame, {
  classify,
  isEditing: () => editing,
  debounceMs: 250,
  onRender: (ms, origin) => {
    const tally = (origin?.local ?? 0) + (origin?.remote ?? 0);
    $("timing").textContent = tally
      ? `signal fired → frame reloaded in ${ms} ms (${origin.local ? "your edit" : "server change"})`
      : `frame reloaded in ${ms} ms`;
  },
});

async function boot() {
  wireServerActivity();
  wireApply();
  wireCellEdit();

  const { bootReplica } = await import("/replica.mjs");
  const pg = await bootReplica(cfg, (m) => setStatus(m, "text-amber-600"));

  // The single coarse watcher. The first callback is the initial snapshot of the
  // signal row; every callback after it means a cell changed, so reload.
  let first = true;
  pg.live.query(frame.dataset.signalSql, [], () => {
    if (first) {
      first = false;
      setStatus("Live. The whole grid is one Turbo Frame; any cell change reloads it.", "text-green-600");
      return;
    }
    reactor.requestReload();
  });
}

// One write path: a cell edit or a column apply. Coarse mode has no optimistic
// render — the write goes to the authority and the frame reloads once Electric
// reconciles, so we just POST and mark the touched cells local for the flash.
async function write({ col, operation, operand, rowFrom, rowTo }) {
  markLocal(col, rowFrom, rowTo);
  setStatus("Writing to Rails… the frame reloads once Electric reconciles.", "text-indigo-600");
  const body = new URLSearchParams({
    sheet_id: String(SHEET), row_from: String(rowFrom), row_to: String(rowTo),
    col_from: String(col), col_to: String(col), operation, operand: String(operand),
  });
  try {
    const res = await fetch(cfg.bulkUrl, {
      method: "POST",
      headers: { "X-CSRF-Token": cfg.csrf, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setStatus(`Server rejected (${res.status}): ${j.error ?? "error"}.`, "text-red-600");
    }
  } catch (e) {
    setStatus(`Network error: ${e.message}`, "text-red-600");
  }
}

function wireApply() {
  const btn = $("apply-btn");
  btn.disabled = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await write({
        col: parseInt($("op-col").value, 10),
        operation: $("op-kind").value,
        operand: parseFloat($("op-operand").value),
        rowFrom: 1, rowTo: ROW_COUNT,
      });
    } finally {
      btn.disabled = false;
    }
  });
}

// Click a cell -> inline editor -> set that one cell. Delegated on #sheet-app so
// it survives every frame reload.
function wireCellEdit() {
  app.addEventListener("click", (e) => {
    const td = e.target.closest(".grid-cell");
    if (!td || editing) return;
    editing = true;

    const row = Number(td.dataset.row);
    const col = Number(td.dataset.col);
    const original = td.textContent;
    const input = document.createElement("input");
    input.type = "number";
    input.value = original.replace(/,/g, "");
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();

    // Closing the editor replaces the cell's content, which removes the focused
    // input and fires its blur handler. Guard so Enter (or Escape) doesn't then
    // re-enter through that blur and fire a second write — or, after a cancel,
    // commit the cell at all. Closing also flushes any reload held while open.
    let done = false;
    const close = () => { editing = false; reactor.flush(); };
    const cancel = () => {
      if (done) return;
      done = true;
      td.textContent = original;
      close();
    };
    const commit = async () => {
      if (done) return;
      const val = parseFloat(input.value);
      if (Number.isNaN(val)) return cancel();
      done = true;
      td.textContent = original; // restore until the authoritative reload lands
      close();
      await write({ col, operation: "set", operand: val, rowFrom: row, rowTo: row });
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  });
}

// "Server activity": post one tick every couple of seconds. Each commits
// server-side and streams to every replica, so it lands as a green flash on
// the next reload.
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
    render();
    fetch(cfg.ticksUrl, {
      method: "POST",
      headers: { "X-CSRF-Token": cfg.csrf, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ sheet_id: String(SHEET) }),
    }).catch(() => {});
  };
  const stop = () => { clearInterval(timer); timer = null; render(); };
  const start = () => { sent = 0; timer = setInterval(tick, TICK_INTERVAL_MS); tick(); };

  btn.addEventListener("click", () => (timer ? stop() : start()));
  addEventListener("beforeunload", stop);
  render();
}

boot().catch((e) => {
  console.error("[coarse] boot failed", e);
  setStatus(`Boot failed: ${e.message}`, "text-red-600");
});
