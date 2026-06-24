// The public entry. Auto-installs the service worker (which boots PGlite +
// Electric + the Rails VM) and shows a milestone loader: named steps, a
// determinate bar, and a remaining-time estimate. None of the phases report
// per-byte progress (app.wasm keeps Chrome's code cache instead of streaming,
// and Electric sync has no incremental signal), so every phase shows a typical
// duration that self-corrects as observed durations replace the estimates (see
// progress.js). A returning visitor whose worker already controls the origin
// skips all of this: "/" is served from the in-VM Rails directly.

import { MILESTONES, stepMilestone, makeProgress } from "/progress.js";

const APP_URL = "/sheets/1";
const leadEl = document.getElementById("lead");
const etaEl = document.getElementById("eta");
const barEl = document.querySelector(".bar > i");
const retryEl = document.getElementById("retry");
const rowEl = (i) => document.getElementById("m-" + MILESTONES[i].id);
const detEl = (i) => document.getElementById("d-" + MILESTONES[i].id);

let bootStart = 0;
let progress = null;
let timer = null;

const render = () => {
  try {
    const now = Date.now() - bootStart;
    const cur = progress.current;

    if (barEl) barEl.style.width = (progress.barFraction(now) * 100).toFixed(1) + "%";

    const rem = progress.remainingSeconds(now);
    if (etaEl) etaEl.textContent = rem <= 1.3 ? "almost there…" : "about " + Math.round(rem) + "s left";

    // Per-step rows: done shows actual time, active shows the live estimate,
    // pending shows the typical estimate.
    for (let i = 0; i < MILESTONES.length; i++) {
      const li = rowEl(i);
      const det = detEl(i);
      if (!li) continue;
      if (i < cur) {
        li.className = "done";
        if (det) det.textContent = Math.max(1, Math.round(progress.estDur(i))) + "s";
      } else if (i === cur) {
        li.className = "active";
        if (det) det.textContent = "~" + Math.max(1, Math.round(progress.remainingOf(i, now))) + "s";
      } else {
        li.className = "";
        if (det) det.textContent = "~" + MILESTONES[i].est + "s";
      }
    }
  } catch {
    /* the estimate is cosmetic; never let it block boot */
  }
};

const finish = () => {
  if (timer) clearInterval(timer);
  if (barEl) barEl.style.width = "100%";
  for (let i = 0; i < MILESTONES.length; i++) {
    const li = rowEl(i);
    if (li) li.className = "done";
    const det = detEl(i);
    if (det && i >= progress.current) det.textContent = "";
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
  progress = makeProgress();
  timer = setInterval(render, 250);
  render();

  navigator.serviceWorker.addEventListener("message", (event) => {
    const d = event.data;
    if (!d || d.type !== "progress") return;
    progress.enter(stepMilestone(d.step), Date.now() - bootStart);
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
