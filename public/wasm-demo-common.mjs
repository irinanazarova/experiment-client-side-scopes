// Shared helpers for the two ruby.wasm demo pages (wasm.mjs, wasm_ar.mjs).
// Both boot a PGlite replica synced from Electric, run Ruby against it, and
// compare totals; only the VM build and the on-page copy differ.

export const fmt = (n) =>
  Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

// Writes to the shared #status element present on both demo pages.
export const setStatus = (m, c = "text-gray-500") => {
  const el = document.getElementById("status");
  el.textContent = m;
  el.className = `text-sm mt-1 ${c}`;
};

// Electric's shape sync long-polls in the background; tearing it down aborts
// the in-flight fetch, which rejects with an AbortError. That's harmless
// teardown noise, so swallow exactly that and let every other rejection
// through (matching on the error name, not a substring of its message).
export const silenceAbortRejections = () => {
  addEventListener("unhandledrejection", (event) => {
    if (event.reason?.name === "AbortError") event.preventDefault();
  });
};

// The replica stays live (Electric keeps streaming and the server simulator
// ticks ~once a second), so the grand total has to be read fresh every time.
export const grandTotalReader = (pg, sql) => async () =>
  Number((await pg.query(sql)).rows[0]?.total ?? 0);

// Booting the VM is the slow part, so the Ruby/AR read is bracketed between two
// JS reads. If the Ruby total lands inside [min, max] of those two, both
// engines saw the same replica and any delta is just a simulator tick that
// arrived between reads, not a bridge bug. Returns the envelope and the verdict.
export const withinEnvelope = (jsBefore, jsAfter, value, tol = 0.01) => {
  const lo = Math.min(jsBefore, jsAfter) - tol;
  const hi = Math.max(jsBefore, jsAfter) + tol;
  return { lo, hi, match: value >= lo && value <= hi };
};
