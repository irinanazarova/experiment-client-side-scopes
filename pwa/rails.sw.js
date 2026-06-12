// The service worker that runs the Rails slice. Boot: PGlite + Electric sync
// (database.js), then the app.wasm Rails VM. Serve: same-origin requests are
// dispatched into the in-VM Rails through the Rack handler; everything the
// app reads comes from the local replica through the pglite adapter.
import {
  initRailsVM,
  Progress,
  registerPGliteWasmInterface,
  RackHandler,
} from "./vendor/wasmify-rails/index.js";

import { setupPGliteDatabase } from "./database.js";

// Build stamp (injected by Vite). Its only job is to change this file's bytes
// on every deploy so the browser detects a worker update and re-installs.
const SW_BUILD = typeof __SW_BUILD__ === "undefined" ? "dev" : __SW_BUILD__;
console.log("[rails-web] service worker build", SW_BUILD);

let db = null;

const initDB = async (progress) => {
  if (db) return db;

  progress?.updateStep("Starting PGlite + Electric sync...");
  db = await setupPGliteDatabase(progress);
  progress?.updateStep("PGlite replica live.");

  return db;
};

let vm = null;

const initVM = async (progress, opts = {}) => {
  if (vm) return vm;

  if (!db) {
    await initDB(progress);
  }

  // Exposes self.pglite4rails.query(sql, params); the name matches
  // js_interface in config/database.yml (wasm).
  registerPGliteWasmInterface(self, db);

  let redirectConsole = true;

  vm = await initRailsVM("/app.wasm", {
    database: { adapter: "pglite" },
    // PGlite returns Promises; the adapter awaits across the JS bridge, so
    // both boot and requests must run in async (asyncify) mode.
    async: true,
    // WASI starts with an empty environment; anyway_config (and friends)
    // expect at least PATH and HOME to exist.
    env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/rails"],
    progressCallback: (step) => {
      progress?.updateStep(step);
    },
    outputCallback: (output) => {
      if (!redirectConsole) return;
      progress?.notify(output);
    },
    ...opts,
  });

  // No DatabaseTasks.prepare_all here (that is the SQLite path): the schema
  // is created in database.js and Electric streams the authoritative rows.

  redirectConsole = false;

  return vm;
};

const resetVM = () => {
  vm = null;
};

const installApp = async () => {
  const progress = new Progress();
  await progress.attach(self);

  await initDB(progress);
  await initVM(progress);
};

self.addEventListener("activate", (event) => {
  console.log("[rails-web] Activate Service Worker");
  event.waitUntil((async () => {
    // A fresh worker means a fresh app.wasm. The RackHandler response cache
    // ("rails-wasm") pins anything the in-VM Rails serves with a long max-age,
    // which includes the /public JS modules (sheet.mjs, flow.mjs, ...). Without
    // dropping it, an installed client ships new HTML but stale JS across a
    // deploy (e.g. the new reject button next to the old flow diagram). Clear
    // it so each deploy actually reaches installed clients.
    await caches.delete("rails-wasm").catch(() => {});
    // Take control of open clients immediately so the loader page can navigate
    // straight into the app the moment boot finishes (no reload needed).
    await self.clients.claim();
  })());
});

self.addEventListener("install", (event) => {
  console.log("[rails-web] Install Service Worker");
  event.waitUntil(installApp().then(() => self.skipWaiting()));
});

// async: each request runs via proc.callAsync so the adapter's awaits resolve.
const rackHandler = new RackHandler(initVM, { assumeSSL: true, async: true });

// Optimism as application code: the same write request is dispatched into the
// in-VM Rails first, so Cells::BulkUpdate (authorize -> one UPDATE) runs
// locally against the replica, then forwarded to the host, the write
// authority. If the host rejects or the network fails, the snapshot is
// restored: the replica never diverges from the server. One gesture, one
// server transaction; the local run is the preview, the server run is the truth.
//
// The flow-trace diagram is driven entirely from the page (sheet.mjs owns the
// write-loop steps; the renderers own the render step), so the worker stays out
// of it: emitting here too would double-light nodes and race the page's
// flow.reset() across the BroadcastChannel.
async function optimisticWrite(request) {
  const body = await request.clone().text();
  const params = new URLSearchParams(body);

  // Snapshot the affected cells now (quick SELECT), for rollback.
  let snapshot = [];
  try {
    snapshot = (
      await db.query(
        `SELECT id, value FROM cells
          WHERE sheet_id = $1 AND row BETWEEN $2 AND $3 AND col BETWEEN $4 AND $5`,
        [
          params.get("sheet_id"),
          params.get("row_from"), params.get("row_to"),
          params.get("col_from"), params.get("col_to"),
        ]
      )
    ).rows;
  } catch (e) {
    console.warn("[rails-web] snapshot failed:", e);
  }

  // The optimistic in-VM apply (Cells::BulkUpdate on the replica) runs in the
  // background. It competes with region renders for the single-threaded VM, so
  // we must NOT make the user's write wait on it — otherwise the button stays
  // disabled while the render queue drains. We await it only to roll back.
  const localReq = new Request(request.url, { method: request.method, headers: request.headers, body });
  const applied = rackHandler.handle(localReq)
    .catch((e) => console.warn("[rails-web] optimistic apply failed; the authority still gets the write:", e));

  // Forward to the host (the write authority) and return as soon as it answers.
  let hostResp;
  try {
    hostResp = await fetch(request);
  } catch (e) {
    await applied.catch(() => {});
    await restoreSnapshot(snapshot);
    return new Response(JSON.stringify({ error: `network: ${e.message}` }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!hostResp.ok) {
    await applied.catch(() => {}); // let the optimistic apply land before undoing it
    await restoreSnapshot(snapshot);
  }
  return hostResp;
}

async function restoreSnapshot(snapshot) {
  if (!db || !snapshot.length) return;
  await db.query(
    `UPDATE cells AS c SET value = d.value
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::numeric[]) AS value) d
      WHERE c.id = d.id`,
    [snapshot.map((r) => r.id), snapshot.map((r) => (r.value === null ? null : String(r.value)))]
  );
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Cross-origin traffic (CDN modules on Rails-rendered pages, the Electric
  // stream) goes straight to the network.
  if (url.origin !== self.location.origin) return;

  // The write ladder, enforced structurally: reads are served locally, writes
  // go to the wire. Anything non-GET reaches the host write authority (Vite
  // proxies /cells in dev; in production the PWA shares the host origin).
  // The slice's own write endpoint additionally applies the change to the
  // local replica first, as real application code, while the wire round-trips
  // (see optimisticWrite); Electric then reconciles onto the authoritative rows.
  if (event.request.method !== "GET" && event.request.method !== "HEAD") {
    if (url.pathname === "/cells/bulk_updates") {
      return event.respondWith(optimisticWrite(event.request));
    }
    return;
  }

  // Boot machinery and the wasm module come from the Vite server.
  const bootResources = [
    "/boot",
    "/boot.js",
    "/boot.html",
    "/rails.sw.js",
    "/app.wasm",
    "/database.js",
    "/debug.html",
    "/debug.js",
  ];
  if (bootResources.find((r) => url.pathname.endsWith(r))) return;

  const viteResources = ["node_modules", "@vite", "/@fs/", "vendor/wasmify-rails"];
  if (viteResources.find((r) => event.request.url.includes(r))) return;

  event.respondWith(rackHandler.handle(event.request));
});

self.addEventListener("message", async (event) => {
  console.log("[rails-web] Received worker message:", event.data);

  if (event.data.type === "reload-rails") {
    const progress = new Progress();
    await progress.attach(self);

    progress.updateStep("Reloading Rails application...");

    resetVM();
    await initVM(progress, { debug: event.data.debug });
  }

  if (event.data.type === "watch-regions") {
    await watchRegions(event.data.regions);
  }
});

// The dependency graph, made literal. PGlite's live.query re-runs on any
// change to the tables it touches, not only when its own result changes, so
// we close the gap: keep the last result per region and broadcast only when
// the new one differs. The effect is what we want, a region re-renders
// exactly when its slice of the data changed: an edit outside the visible
// window leaves the rows region's result identical, so it stays silent, while
// the aggregate regions (whose result moved) fire.
const regionChannel = new BroadcastChannel("cells-region");
let regionsWatched = false;

async function watchRegions(regions) {
  if (regionsWatched) return; // idempotent: the page may re-announce on reload
  if (!db) await initDB();
  regionsWatched = true;

  for (const { name, watch } of regions) {
    let last; // undefined until the first (baseline) fire
    await db.live.query(watch, [], (result) => {
      const signature = JSON.stringify(result.rows);
      if (signature === last) return; // table changed, this result did not
      const baseline = last === undefined;
      last = signature;
      if (!baseline) regionChannel.postMessage({ name }); // first paint is already rendered
    });
  }
}
