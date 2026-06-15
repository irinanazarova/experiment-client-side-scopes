// The public entry. Auto-installs the service worker (which boots PGlite +
// Electric + the Rails VM) and shows a milestone loader: named steps, a
// determinate bar, and a remaining-time estimate. The two long, variable
// phases (syncing the cells, downloading the app) report *real* progress from
// the worker, so the estimate self-corrects instead of guessing; the short
// phases fall back to a typical duration. A returning visitor whose worker
// already controls the origin skips all of this — "/" is served from the in-VM
// Rails directly.

const APP_URL = "/sheets/1";
const leadEl = document.getElementById("lead");
const etaEl = document.getElementById("eta");
const barEl = document.querySelector(".bar > i");
const retryEl = document.getElementById("retry");

// User-facing milestones, in order. `est` is the typical duration (s); `real`
// marks the two phases the worker reports actual progress for, with `fmt`
// turning that 0..1 fraction into a human detail.
const M = [
  { id: "engine", est: 3, real: false },
  { id: "data", est: 8, real: false }, // Electric sync; no usable incremental signal (see database.js)
  { id: "app", est: 6, real: true, fmt: (f) => `${(f * 9).toFixed(1)} / 9 MB` },
  { id: "rails", est: 3, real: false },
];
const rowEl = (i) => document.getElementById("m-" + M[i].id);
const detEl = (i) => document.getElementById("d-" + M[i].id);

// Which milestone a worker step message belongs to (specific → general).
const stepMilestone = (step) => {
  const s = (step || "").toLowerCase();
  if (/instantiat|initializ/.test(s)) return 3;
  if (/loading|webassembly|replica live/.test(s)) return 2;
  if (/syncing slice/.test(s)) return 1;
  if (/starting pglite|fetching|shape|pglite/.test(s)) return 0;
  return null;
};

let bootStart = 0;
let cur = 0;
let lastFrac = 0;
let timer = null;
const startMs = new Array(M.length).fill(null);
const doneMs = new Array(M.length).fill(null);
const frac = new Array(M.length).fill(0);

const estDur = (i) =>
  doneMs[i] != null && startMs[i] != null ? (doneMs[i] - startMs[i]) / 1000 : M[i].est;
const elapsedIn = (i, now) => (startMs[i] != null ? Math.max(0, (now - startMs[i]) / 1000) : 0);

const enter = (m, t) => {
  if (m == null || m < cur) return;
  for (let i = cur; i < m; i++) {
    if (doneMs[i] == null) doneMs[i] = t;
    if (startMs[i + 1] == null) startMs[i + 1] = t;
  }
  if (m !== cur) {
    cur = m;
    if (startMs[m] == null) startMs[m] = t;
  }
};

// Seconds left in milestone i. Real phases project from observed progress (so a
// stall grows the estimate instead of freezing at a wrong number); others count
// down their typical duration.
const remainingOf = (i, now) => {
  const e = elapsedIn(i, now);
  if (M[i].real) {
    const f = frac[i];
    if (f > 0.04 && e > 0.3) return Math.max(0, e / f - e);
    return M[i].est * (1 - Math.min(f, 0.95));
  }
  // No real signal: decay toward 0 but never hit it (so a slow phase keeps a
  // shrinking estimate instead of freezing at the wrong number).
  return M[i].est * Math.exp(-e / M[i].est);
};

const render = () => {
  try {
    const now = Date.now() - bootStart;

    // Determinate bar: weight phases by their (estimated or actual) duration,
    // and inside the active phase track real progress where we have it.
    let total = 0;
    let done = 0;
    for (let i = 0; i < M.length; i++) {
      const d = estDur(i);
      total += d;
      if (i < cur) done += d;
      else if (i === cur) {
        done += M[i].real
          ? d * Math.min(frac[i], 0.98)
          : d * (1 - Math.exp(-elapsedIn(i, now) / d)); // asymptotic creep, never freezes
      }
    }
    let f = total > 0 ? done / total : 0;
    f = Math.max(lastFrac, Math.min(f, 0.985)); // monotonic; never 100% until ready
    lastFrac = f;
    if (barEl) barEl.style.width = (f * 100).toFixed(1) + "%";

    // Remaining = the active phase's projection + the typical cost of what's left.
    let rem = remainingOf(cur, now);
    for (let i = cur + 1; i < M.length; i++) rem += M[i].est;
    if (etaEl) etaEl.textContent = rem <= 1.3 ? "almost there…" : "about " + Math.round(rem) + "s left";

    // Per-step rows: done shows actual time, active shows live detail/estimate,
    // pending shows the typical estimate.
    for (let i = 0; i < M.length; i++) {
      const li = rowEl(i);
      const det = detEl(i);
      if (!li) continue;
      if (i < cur) {
        li.className = "done";
        if (det) det.textContent = doneMs[i] != null && startMs[i] != null ? Math.max(1, Math.round(estDur(i))) + "s" : "";
      } else if (i === cur) {
        li.className = "active";
        if (det) {
          det.textContent =
            M[i].real && frac[i] > 0
              ? M[i].fmt(Math.min(frac[i], 1))
              : "~" + Math.max(1, Math.round(remainingOf(i, now))) + "s";
        }
      } else {
        li.className = "";
        if (det) det.textContent = "~" + M[i].est + "s";
      }
    }
  } catch {
    /* the estimate is cosmetic; never let it block boot */
  }
};

const finish = () => {
  if (timer) clearInterval(timer);
  if (barEl) barEl.style.width = "100%";
  for (let i = 0; i < M.length; i++) {
    const li = rowEl(i);
    if (li) li.className = "done";
    const det = detEl(i);
    if (det && i >= cur) det.textContent = "";
  }
  if (etaEl) etaEl.textContent = "";
};

const failNow = (msg) => {
  if (timer) clearInterval(timer);
  if (leadEl) {
    leadEl.textContent = msg;
    leadEl.classList.add("error");
  }
  if (etaEl) etaEl.textContent = "";
  if (retryEl) {
    retryEl.style.display = "inline-block";
    retryEl.onclick = () => location.reload();
  }
};

async function start() {
  if (!("serviceWorker" in navigator)) {
    return failNow("This browser doesn't support the features this demo needs.");
  }

  // Already installed → the worker serves the app; go straight in.
  if (navigator.serviceWorker.controller) {
    return location.replace(APP_URL);
  }

  bootStart = Date.now();
  startMs[0] = 0;
  timer = setInterval(render, 250);
  render();

  navigator.serviceWorker.addEventListener("message", (event) => {
    const d = event.data;
    if (!d || d.type !== "progress") return;
    const t = Date.now() - bootStart;
    enter(stepMilestone(d.step), t);
    if (typeof d.value === "number" && M[cur] && M[cur].real) frac[cur] = d.value;
    render();
  });

  try {
    // updateViaCache: "none" so the update check bypasses the HTTP cache for the
    // worker AND its static imports, so a new worker can't pull stale modules.
    await navigator.serviceWorker.register("/rails.sw.js", { scope: "/", type: "module", updateViaCache: "none" });
    // Resolves once the worker has booted the DB + Rails VM and activated.
    await navigator.serviceWorker.ready;
    finish();
    location.replace(APP_URL);
  } catch (error) {
    failNow("Couldn't start the app: " + error.message);
  }
}

start();
