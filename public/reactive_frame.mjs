// The reactive receiver: a <turbo-frame> that reloads and morphs itself when a
// trigger fires. Every reload-based route shares it. A trigger (a local PGlite
// live query on the host, the service worker in the slice) calls requestReload();
// the frame re-fetches its reload-url, morphs the diff in place, and flashes the
// cells whose value changed.
//
// Reloads are debounced (a burst — the initial Electric snapshot streaming in, a
// column apply landing many rows — collapses into one) and serialized (otherwise
// overlapping Turbo frame navigations cancel each other). A reload is held back
// while a cell editor is open so it can't wipe the input; flush() runs the held
// reload the moment the edit closes.

import { Idiomorph } from "https://cdn.jsdelivr.net/npm/idiomorph@0.7.4/+esm";
import { snapshotCells, flashChanged, morphOptions } from "/blink.mjs";

// frame: the <turbo-frame> with data-reload-url. Options:
//   classify(key)  -> "local" | "remote", colours the flash (omit to skip flashing)
//   isEditing()    -> true while a cell editor is open (defer reloads)
//   onRender(ms, origin) -> after each reload; origin is the { local, remote } flash tally
//   debounceMs     -> collapse a burst of fires into one reload
// Returns { requestReload, flush }.
export function mountReactiveFrame(frame, { classify, isEditing = () => false, onRender, debounceMs = 0 } = {}) {
  let pendingSnapshot = null;
  let reloadStartedAt = 0;
  let reloadPending = false;
  let pumping = false;
  let debounceTimer = null;
  let pausedResume = null; // a render held mid-flight because a cell editor was open

  frame.addEventListener("turbo:before-frame-render", (event) => {
    // Morph in place rather than replace, so scroll position survives and the
    // flash diff has stable nodes to compare against. Turbo reads detail.render
    // even on a paused render, so the held render (below) morphs too.
    event.detail.render = (current, next) => Idiomorph.morph(current, next.innerHTML, morphOptions);

    // A reload's response arrived while an editor is open. preventDefault() makes
    // Turbo PAUSE the render (not skip it) until detail.resume() is called; hold
    // that resume and fire it the moment the edit closes (flush). Pausing without
    // ever resuming would wedge the frame: Turbo leaves view.renderPromise pending
    // and every later reload awaits it forever.
    if (isEditing()) { event.preventDefault(); pausedResume = event.detail.resume; return; }
    pendingSnapshot = classify ? snapshotCells(frame) : null;
  });

  frame.addEventListener("turbo:frame-render", () => {
    const ms = Math.round(performance.now() - reloadStartedAt);
    const origin = pendingSnapshot ? flashChanged(frame, pendingSnapshot, classify) : null;
    pendingSnapshot = null;
    onRender?.(ms, origin);
  });

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (reloadPending && !isEditing()) {
        reloadPending = false;
        reloadStartedAt = performance.now(); // measure the reload itself (fetch + morph)
        const rendered = new Promise((resolve) =>
          frame.addEventListener("turbo:frame-render", resolve, { once: true })
        );
        // Setting src the first time kicks the fetch; reload() re-runs it after.
        if (frame.src) frame.reload();
        else frame.src = frame.dataset.reloadUrl;
        // Bound the wait so a dropped or cancelled render can't wedge the pump.
        await Promise.race([rendered, new Promise((r) => setTimeout(r, 6000))]);
      }
    } finally {
      pumping = false;
    }
  }

  const requestReload = () => {
    reloadPending = true;
    if (!debounceMs) return pump();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(pump, debounceMs);
  };

  // Called when a cell editor closes: first resume a render that was held mid-
  // flight (morphing in what already arrived), then pump any reload queued while
  // the editor was open.
  const flush = () => {
    if (pausedResume) {
      const resume = pausedResume;
      pausedResume = null;
      pendingSnapshot = classify ? snapshotCells(frame) : null;
      reloadStartedAt = performance.now();
      resume(); // completes the paused render -> turbo:frame-render -> flash + onRender
    }
    return pump();
  };

  return { requestReload, flush };
}
