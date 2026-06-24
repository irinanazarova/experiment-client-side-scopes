// The local database behind the in-browser Rails: PGlite (real Postgres in
// Wasm) with the cells slice streamed in by Electric. This replaces the
// template's SQLite setup and mirrors the bootstrap in public/sheet.mjs: the
// browser never invents schema or data; it asks Rails for an authorized shape
// and replicates it.
import { PGlite } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";
import { electricSync } from "@electric-sql/pglite-sync";
import { waitForSnapshot } from "./snapshot.js";

const SHEET_ID = 1;

export const setupPGliteDatabase = async (progress) => {
  const db = await PGlite.create({ extensions: { live, electric: electricSync() } });

  // The slice schema. cells carries exactly the shape's column allow-list.
  // The sheets row is static demo bootstrap: cells is the only client scope
  // so far, and the in-VM Sheet.find needs its parent row.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS cells (
      id bigint PRIMARY KEY, sheet_id bigint, row integer,
      col integer, value numeric, formula text
    );
    CREATE TABLE IF NOT EXISTS sheets (
      id bigint PRIMARY KEY, name text, row_count integer, col_count integer,
      created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
    );
    INSERT INTO sheets (id, name, row_count, col_count)
      VALUES (${SHEET_ID}, 'Demo budget', 2500, 20)
      ON CONFLICT (id) DO NOTHING;
  `);

  // This fetch runs from the service worker itself, so it bypasses the fetch
  // handler and reaches the host Rails through the Vite dev proxy.
  progress?.updateStep("Fetching authorized shape from Rails...");
  const shapeRes = await fetch(`/client_scopes/sheet_cells?sheet_id=${SHEET_ID}`, {
    headers: { Accept: "application/json" },
  });
  // Surface an authorization/host failure clearly rather than parsing an HTML
  // error body as JSON or feeding a malformed shape into syncShapeToTable.
  if (!shapeRes.ok) throw new Error(`shape fetch failed: ${shapeRes.status}`);
  const shape = await shapeRes.json();

  // Stream the slice in. PGlite is single-threaded, so a count(*) poller would
  // just queue behind the ingestion (no usable incremental signal), and
  // pglite-sync only exposes an "initial sync done" callback — so the loader
  // shows a smooth estimate for this phase rather than a live row count.
  progress?.updateStep("Syncing slice from Electric...");
  await db.electric.syncShapeToTable({
    shape: { url: shape.url, params: shape.params },
    table: "cells",
    primaryKey: ["id"],
    shapeKey: "cells",
  });

  // Wait for the initial snapshot so the first in-VM request sees data.
  try {
    await waitForSnapshot({
      count: async () => (await db.query("SELECT count(*)::int AS n FROM cells")).rows[0].n,
    });
  } catch (error) {
    // A stalled initial sync should be visible, but not fail the boot: the
    // reactive path still fills the grid as Electric catches up.
    progress?.updateStep("Initial sync is slow; continuing as cells arrive…");
    console.warn("[rails-web]", error.message);
  }

  // Per-region change signals are set up on demand from the page's declared
  // live regions (see rails.sw.js watchRegions); nothing global to wire here.
  return db;
};
