// The public entry. Auto-installs the service worker (which boots PGlite +
// Electric + the Rails VM), shows a normal loading spinner with friendly
// status, then navigates straight into the app — no manual "Launch" step.
// A returning visitor whose worker is already in control skips all of this:
// "/" is served from the in-VM Rails directly, so they never see this page.

const statusEl = document.getElementById("status");
const spinnerEl = document.getElementById("spinner");
const APP_URL = "/sheets/1";

// Map the worker's technical boot steps to calm, product-y phrasing.
const friendly = (step) => {
  const s = (step || "").toLowerCase();
  if (/pglite|electric|shape|sync|replica|database/.test(s)) return "Syncing your data…";
  if (/webassembly|instantiat|module|loading/.test(s)) return "Starting the app…";
  if (/rails|initializ|prepar/.test(s)) return "Almost ready…";
  return "Loading…";
};

const setStatus = (text, isError = false) => {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
};

const fail = (message) => {
  setStatus(message, true);
  spinnerEl.style.borderTopColor = "#dc2626";
  spinnerEl.style.animationPlayState = "paused";
};

async function start() {
  if (!("serviceWorker" in navigator)) {
    return fail("This browser doesn't support the features this demo needs.");
  }

  // Already installed → the worker serves the app; go straight in.
  if (navigator.serviceWorker.controller) {
    return location.replace(APP_URL);
  }

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "progress" && event.data.step) {
      setStatus(friendly(event.data.step));
    }
  });

  try {
    setStatus("Starting the app…");
    // updateViaCache: "none" so the update check bypasses the HTTP cache for
    // the worker AND its static imports (vendor/wasmify-rails, database.js).
    // The default ("imports") revalidates only rails.sw.js, so a new worker
    // could still pull stale imported modules from cache after a deploy.
    await navigator.serviceWorker.register("/rails.sw.js", { scope: "/", type: "module", updateViaCache: "none" });
    // Resolves once the worker has booted the DB + Rails VM and activated.
    await navigator.serviceWorker.ready;
    setStatus("Ready");
    location.replace(APP_URL);
  } catch (error) {
    fail("Couldn't start the app: " + error.message);
  }
}

start();
