// Reviewer-facing support notice. Two things in one slim, dismissible bar:
//   1. a note that the demo wants desktop Chrome/Edge (Safari and mobile may
//      hang, the slice's service worker and the heavy Wasm boot are the cause);
//   2. an escape hatch for the classic "I'm staring at a stale cached build"
//      trap, since the slice's service worker caches aggressively, a one-click
//      Reset that unregisters workers, clears caches, and reloads.
//
// Soft on purpose: it warns, it never blocks. Dismissed per browser session.
//
// NOTE: this file is intentionally duplicated at pwa/public/support-banner.mjs
// so the slice's *loader* screen (served by Caddy before the in-VM Rails takes
// over) shows it too. Keep the two copies identical.

const DISMISS_KEY = "support-banner-dismissed";

const dismissed = () => {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
};

const remember = () => {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private mode: just don't persist */
  }
};

// navigator.userAgentData exists only in Chromium browsers, so it doubles as a
// "this is Chromium" probe; .mobile flags phones/tablets.
function detect() {
  const ua = navigator.userAgentData;
  const chromium = !!ua;
  const mobile = ua ? ua.mobile : /Mobi|Android|iP(hone|ad|od)/i.test(navigator.userAgent);
  return { supported: chromium && !mobile, mobile };
}

async function resetApp(button) {
  button.disabled = true;
  button.textContent = "Resetting…";
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } finally {
    location.reload();
  }
}

function render() {
  if (dismissed() || document.getElementById("support-banner")) return;

  const { supported, mobile } = detect();
  const warning = supported
    ? ""
    : mobile
      ? "Mobile browsers aren't supported and will likely hang. "
      : "Built for desktop Chrome or Edge; Safari and Firefox may hang or fail. ";

  const bar = document.createElement("div");
  bar.id = "support-banner";
  bar.setAttribute("role", "note");
  bar.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
    "display:flex", "align-items:center", "gap:.75rem", "padding:.5rem .9rem",
    "font:500 13px/1.45 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    "color:#0f172a", `background:${supported ? "#fef9c3" : "#fee2e2"}`,
    "border-bottom:1px solid rgba(0,0,0,.08)", "box-shadow:0 1px 3px rgba(0,0,0,.06)",
  ].join(";");

  const message = document.createElement("span");
  message.style.cssText = "flex:1;min-width:0";
  message.innerHTML =
    (warning ? `<strong>⚠ ${warning}</strong>` : "") +
    "If the app looks stuck on an old build, open a private window or reset.";

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset (clear cache)";
  reset.style.cssText =
    "flex:none;cursor:pointer;border:1px solid rgba(0,0,0,.25);background:#fff;" +
    "border-radius:6px;padding:.25rem .6rem;font:inherit;font-weight:600";
  reset.addEventListener("click", () => resetApp(reset));

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Dismiss");
  close.style.cssText =
    "flex:none;cursor:pointer;border:0;background:transparent;font:inherit;" +
    "font-size:15px;color:inherit;opacity:.6;padding:.1rem .35rem";
  close.addEventListener("click", () => {
    remember();
    bar.remove();
  });

  bar.append(message, reset, close);
  (document.body || document.documentElement).prepend(bar);
}

if (document.readyState === "loading") {
  addEventListener("DOMContentLoaded", render);
} else {
  render();
}
