// The page-owned PGlite replica, synced by Electric. Boots Postgres in the
// browser, asks Rails for the authorized shape (a named client scope, never a
// client-chosen query), and streams that slice into a local `cells` table.
// Shared by the reactive demos so the boot is written once.
//
// Returns the PGlite instance. The caller registers live queries on it: in the
// precise demo, one per fragment; in the coarse demo, a single change signal.

const PGLITE = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.4.6/dist/index.js";
const PGLITE_LIVE = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.4.6/dist/live/index.js";
const PGLITE_SYNC = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite-sync@0.5.6/+esm";

export async function bootReplica(cfg, onStatus = () => {}) {
  onStatus("Starting PGlite (Postgres in your browser)…");
  const [{ PGlite }, { live }, { electricSync }] = await Promise.all([
    import(PGLITE),
    import(PGLITE_LIVE),
    import(PGLITE_SYNC),
  ]);

  const pg = await PGlite.create({ extensions: { live, electric: electricSync() } });
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS cells (
      id bigint PRIMARY KEY, sheet_id bigint, row integer,
      col integer, value numeric, formula text
    );
  `);

  onStatus("Fetching authorized shape from Rails…");
  // Surface an authorization failure clearly: a 403 (the scope is not syncable)
  // would otherwise throw an opaque JSON-parse error on the HTML error body, or
  // feed a malformed shape into syncShapeToTable.
  const res = await fetch(cfg.scopeUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`shape fetch failed: ${res.status} ${res.statusText}`);
  const shape = await res.json();

  onStatus("Syncing slice from Electric…");
  await pg.electric.syncShapeToTable({
    shape: { url: shape.url, params: shape.params },
    table: "cells",
    primaryKey: ["id"],
    shapeKey: "cells",
  });

  return pg;
}
