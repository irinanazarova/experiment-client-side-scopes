// Live regions, the browser half. Each [data-live-region] element carries the
// SQL it depends on (data-watch). We hand those queries to whoever owns the
// replica, register them as PGlite live queries, and when one fires we
// re-fetch just that region (rendered by the in-VM Rails) and morph its node.
//
// The live query is the dependency graph: a region re-renders exactly when its
// result set changes, and no other region moves. An edit outside the visible
// window resettles the aggregates while the grid body stays put.

import { Idiomorph } from "https://cdn.jsdelivr.net/npm/idiomorph@0.7.4/+esm";
import { snapshotCells, flashChanged, morphOptions } from "/blink.mjs";

export const REGION_CHANNEL = "cells-region";

const regionsInDom = () =>
  [...document.querySelectorAll("[data-live-region]")].map((el) => ({
    name: el.dataset.liveRegion,
    sheetId: el.dataset.sheetId,
    watch: el.dataset.watch,
    el,
  }));

// Slice mode: the replica lives in the service worker. Send it the watch
// queries; it broadcasts a region name when one fires; we re-fetch + morph.
// Returns false if there is no controlling worker (caller falls back).
export function mountLiveRegionsViaWorker({ onRender, classify } = {}) {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return false;

  const regions = regionsInDom();
  const byName = Object.fromEntries(regions.map((r) => [r.name, r]));

  worker.postMessage({
    type: "watch-regions",
    regions: regions.map(({ name, watch }) => ({ name, watch })),
  });

  // ONE render at a time, globally. Every render is a request into the
  // single-threaded in-VM Rails; firing the three regions (rows + stats + Σ)
  // concurrently on each change made the VM juggle three ActionView renders at
  // once through asyncify, tripling peak allocation and, under sustained server
  // activity, growing its heap until it trapped. So we serialize: a broadcast
  // only marks its region dirty, and a single pump renders dirty regions one by
  // one, coalescing repeats (a Set dedups), until none remain.
  const dirty = new Set();
  let pumping = false;
  let failures = 0;

  const renderOne = async (region) => {
    const t0 = performance.now();
    const res = await fetch(`/sheets/${region.sheetId}/regions/${region.name}`);
    if (!res.ok) throw new Error(`region ${region.name} → ${res.status}`);
    const html = await res.text();
    const before = classify ? snapshotCells(region.el) : null;
    Idiomorph.morph(region.el, html, morphOptions);
    const origin = before ? flashChanged(region.el, before, classify) : null;
    onRender?.(region.name, Math.round(performance.now() - t0), origin);
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (dirty.size) {
        const name = dirty.values().next().value;
        dirty.delete(name);
        const region = byName[name];
        if (!region) continue;
        try {
          await renderOne(region);
          failures = 0;
        } catch (e) {
          // A failed fetch means the in-VM Rails is unresponsive (most likely
          // it trapped). Don't let it throw uncaught; after a short run of
          // failures, ask the worker to rebuild the VM so the app self-heals
          // instead of freezing for good.
          console.warn("[live] region render failed:", name, e);
          if (++failures >= 6) {
            failures = 0;
            dirty.clear();
            navigator.serviceWorker.controller?.postMessage({ type: "reload-rails" });
            break;
          }
        }
      }
    } finally {
      pumping = false;
    }
  };

  new BroadcastChannel(REGION_CHANNEL).onmessage = (e) => {
    const name = e.data?.name;
    if (byName[name]) {
      dirty.add(name);
      pump();
    }
  };

  // --- Watcher liveness ------------------------------------------------------
  // The live-query watchers run in the service worker's memory. The browser
  // evicts an idle worker and drops them; after that nothing re-renders until we
  // re-announce. Heartbeat the worker — if it can't confirm it is watching, show
  // a hint + a Resume button that re-announces the regions (the worker re-syncs
  // the replica and re-registers the queries). The ping itself also nudges the
  // worker awake, so an active tab tends to stay live.
  const announce = () =>
    navigator.serviceWorker?.controller?.postMessage({
      type: "watch-regions",
      regions: regions.map(({ name, watch }) => ({ name, watch })),
    });

  const isWatching = () =>
    new Promise((resolve) => {
      const sw = navigator.serviceWorker?.controller;
      if (!sw) return resolve(false);
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 3000); // no reply -> evicted (or busy)
      ch.port1.onmessage = (ev) => { clearTimeout(timer); resolve(!!ev.data?.watching); };
      try { sw.postMessage({ type: "ping-watchers" }, [ch.port2]); }
      catch { clearTimeout(timer); resolve(false); }
    });

  const banner = makeWakeBanner();
  let reconnecting = false;
  banner.onResume(async () => {
    reconnecting = true;
    banner.reconnecting();
    announce(); // worker re-syncs the replica + re-registers the live queries
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await isWatching()) { reconnecting = false; return banner.hide(); }
    }
    reconnecting = false;
    banner.failed();
  });

  let misses = 0;
  setInterval(async () => {
    if (reconnecting) return; // don't fight an in-progress wake
    if (await isWatching()) { misses = 0; banner.hide(); }
    else if (++misses >= 2) banner.down(); // two misses (~20s) so a busy render isn't a false alarm
  }, 10000);

  return true;
}

// A small fixed toast: "Live updates paused — Resume". Created hidden; shown
// only when the worker can't confirm its watchers are alive.
function makeWakeBanner() {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;display:none;" +
    "align-items:center;gap:.75rem;padding:.55rem .9rem;background:#0f172a;color:#fff;border-radius:10px;" +
    "box-shadow:0 12px 32px -10px rgba(15,23,42,.55);font:500 .84rem ui-sans-serif,system-ui,sans-serif;";
  const dot = document.createElement("span");
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#f59e0b;flex:none;";
  const text = document.createElement("span");
  const btn = document.createElement("button");
  btn.style.cssText =
    "padding:.32rem .8rem;border:0;border-radius:7px;background:#6366f1;color:#fff;font-weight:600;font-size:.82rem;cursor:pointer;";
  el.append(dot, text, btn);
  document.body.appendChild(el);

  const set = (msg, label, disabled, color) => {
    text.textContent = msg;
    btn.textContent = label;
    btn.disabled = disabled;
    dot.style.background = color;
    el.style.display = "flex";
  };
  return {
    onResume(fn) { btn.addEventListener("click", () => { if (!btn.disabled) fn(); }); },
    down() { set("Live updates paused — the app went to sleep.", "Resume", false, "#f59e0b"); },
    reconnecting() { set("Reconnecting…", "…", true, "#6366f1"); },
    failed() { set("Couldn't reconnect.", "Try again", false, "#ef4444"); },
    hide() { el.style.display = "none"; },
  };
}

// Standalone mode: the page owns the PGlite instance. Register each region's
// watch query directly and re-render in JS-free fashion by fetching the
// (host-rendered) fragment. Used only when the caller opts in; the host demo
// keeps its richer JS renderers, so this is mainly for symmetry/testing.
export function mountLiveRegionsViaPg(pg, { onRender } = {}) {
  for (const region of regionsInDom()) {
    let first = true;
    pg.live.query(region.watch, [], async () => {
      if (first) { first = false; return; }
      const t0 = performance.now();
      const html = await fetch(`/sheets/${region.sheetId}/regions/${region.name}`).then((r) => r.text());
      Idiomorph.morph(region.el, html, { morphStyle: "innerHTML" });
      onRender?.(region.name, Math.round(performance.now() - t0));
    });
  }
}
