// The slice's reactive bridge. In the slice build the PGlite replica lives in
// the service worker; the in-tab Rails renders the grid frame from it. We hand
// the worker the frame's change signal (one cheap query over the relation), and
// when the worker says the signal moved, we reload the frame: Turbo fetches it
// from the in-tab Rails and we morph the diff in. One frame, one signal, no
// per-region machinery.
//
// Plus a liveness banner: the watchers run in the worker's memory, so an evicted
// worker drops them and nothing re-renders until we re-announce. We heartbeat
// the worker and, if it can't confirm it is watching, show a Resume button.

import { mountReactiveFrame } from "/reactive_frame.mjs";

export const REGION_CHANNEL = "cells-region";

// Watch the grid frame's change signal in the worker and reload the frame when
// it fires. The reload + morph + flash is the shared reactive frame; the worker
// is just the trigger source here. `classify`/`isEditing`/`onRender` pass
// through. Returns the reactor, or false if there is no controlling worker.
export function mountGridFrameViaWorker(frame, { classify, onRender, isEditing } = {}) {
  if (!navigator.serviceWorker?.controller) return false;

  const announce = () =>
    navigator.serviceWorker?.controller?.postMessage({
      type: "watch-regions",
      regions: [{ name: "grid", watch: frame.dataset.signalSql }],
    });
  announce();

  const reactor = mountReactiveFrame(frame, { classify, isEditing, onRender, debounceMs: 250 });
  new BroadcastChannel(REGION_CHANNEL).onmessage = (e) => {
    if (e.data?.name === "grid") reactor.requestReload();
  };

  mountWatcherLiveness(announce);
  return reactor;
}

// --- Watcher liveness --------------------------------------------------------
// The browser evicts an idle worker and drops its live-query watchers. Heartbeat
// it; if it can't confirm it is watching, show a hint + a Resume button that
// re-announces (the worker re-syncs the replica and re-registers the queries).
function mountWatcherLiveness(announce) {
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
    announce(); // worker re-syncs the replica + re-registers the live query
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
}

// A small fixed toast: "Live updates paused — Resume". Created hidden; shown only
// when the worker can't confirm its watchers are alive.
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
