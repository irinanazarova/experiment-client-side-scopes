// Phase B: real CRuby (ruby.wasm) in the browser, querying the same local
// PGlite replica through a Pglite::Connection seam. Proves the ruby.wasm <->
// PGlite async bridge that a full Active Record -> PGlite adapter sits on.

import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.4.6/dist/index.js";
import { electricSync } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite-sync@0.5.6/+esm";
import { DefaultRubyVM } from "https://cdn.jsdelivr.net/npm/@ruby/wasm-wasi@2.7.1/dist/browser/+esm";

const app = document.getElementById("wasm-app");
const cfg = app.dataset;
const setStatus = (m, c = "text-gray-500") => {
  const el = document.getElementById("status");
  el.textContent = m;
  el.className = `text-sm mt-1 ${c}`;
};
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

// Electric's shape sync long-polls in the background; when it's torn down the
// in-flight fetch aborts and surfaces as an unhandled rejection. Harmless
// teardown noise, so swallow just the abort case.
addEventListener("unhandledrejection", (event) => {
  const reason = String(event.reason?.message ?? event.reason ?? "");
  if (/abort/i.test(reason)) event.preventDefault();
});

// The Ruby program. Note: hand SQL to PGlite, await the JS promise across the
// bridge, marshal rows to Ruby via JSON. exec_query is exactly the method an
// Active Record connection adapter implements.
// The prebuilt ruby.wasm ships without the json stdlib, so the connection
// seam marshals JS result rows to Ruby Hashes directly over the interop
// bridge (which is what an Active Record adapter would do anyway).
const RUBY = String.raw`
require "js"

module Pglite
  class Connection
    def initialize(handle) = @handle = handle

    # The method an Active Record connection adapter implements: hand SQL to
    # PGlite, await the JS promise across the bridge, marshal rows to Ruby.
    def exec_query(sql, *columns)
      result = @handle.query(sql).await
      js_rows = result[:rows]
      n = js_rows[:length].to_i
      (0...n).map do |i|
        js_row = js_rows[i]
        columns.each_with_object({}) { |c, h| h[c] = js_row[c.to_sym].to_s.to_f }
      end
    end
  end
end

def log(msg)
  el = JS.global[:document].getElementById("ruby-log")
  el[:textContent] = el[:textContent].to_s + msg + "\n"
end

conn = Pglite::Connection.new(JS.global[:pglite])
ds   = JS.global[:document].getElementById("wasm-app")[:dataset]

log "Ruby #{RUBY_VERSION} running in the browser (ruby.wasm)"

grand_rows = conn.exec_query(ds[:grandTotalSql].to_s, "total")
total = grand_rows[0]["total"]
log "exec_query(grandTotalSql) -> #{grand_rows.inspect}"

col_rows = conn.exec_query(ds[:sumsSql].to_s, "col", "total")
ruby_resum = col_rows.sum { |r| r["total"] }
log "Ruby re-summed #{col_rows.length} column totals = #{ruby_resum.round(2)} (cross-check)"

JS.global[:document].getElementById("ruby-result")[:textContent] =
  "Σ all cells (computed in Ruby): #{total.round(2)}"

total
`;

async function boot() {
  setStatus("Starting PGlite replica…", "text-amber-600");
  const pg = await PGlite.create({ extensions: { electric: electricSync() } });
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS cells (
      id bigint PRIMARY KEY, sheet_id bigint, row integer,
      col integer, value numeric, formula text
    );
  `);

  const shape = await fetch(cfg.scopeUrl, { headers: { Accept: "application/json" } }).then((r) => r.json());
  setStatus("Syncing slice from Electric…", "text-amber-600");
  await pg.electric.syncShapeToTable({
    shape: { url: shape.url, params: shape.params },
    table: "cells",
    primaryKey: ["id"],
    shapeKey: "cells",
  });

  // The replica stays live (Electric keeps streaming; the server simulator
  // ticks ~once a second), so always read the JS grand total fresh.
  const jsGrandTotal = async () =>
    Number((await pg.query(cfg.grandTotalSql)).rows[0]?.total ?? 0);

  // Wait until the initial sync has delivered rows before bothering to compare.
  let jsTotal = 0;
  for (let i = 0; i < 40; i++) {
    jsTotal = await jsGrandTotal();
    if (jsTotal > 0) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  document.getElementById("js-result").textContent = `Σ all cells (computed in JS): ${fmt(jsTotal)}`;

  // Expose the replica to the Ruby VM and boot ruby.wasm. -W0 quiets CRuby's
  // boot-time warnings, matching how the slice VM is launched.
  globalThis.pglite = pg;
  setStatus("Downloading + booting ruby.wasm (CRuby)…", "text-amber-600");
  const mod = await WebAssembly.compile(
    await (await fetch("https://cdn.jsdelivr.net/npm/@ruby/3.4-wasm-wasi@2.7.1/dist/ruby.wasm")).arrayBuffer()
  );
  const { vm } = await DefaultRubyVM(mod, { args: ["ruby.wasm", "-EUTF-8", "-e_=0", "-W0"] });

  // Booting is the slow part, so do it before sampling. Then bracket the Ruby
  // read between two JS reads: if Ruby lands inside that envelope, both engines
  // saw the same replica and any delta is just a simulator tick that arrived
  // between the reads, not a bridge bug. (The old code read JS seconds before
  // Ruby, so a few ticks always made them disagree.)
  setStatus("Running Ruby against the local replica…", "text-amber-600");
  const jsBefore = await jsGrandTotal();
  const rubyTotal = Number((await vm.evalAsync(RUBY)).toString());
  const jsAfter = await jsGrandTotal();
  document.getElementById("js-result").textContent = `Σ all cells (computed in JS): ${fmt(jsAfter)}`;

  const lo = Math.min(jsBefore, jsAfter) - 0.01;
  const hi = Math.max(jsBefore, jsAfter) + 0.01;
  const match = rubyTotal >= lo && rubyTotal <= hi;
  setStatus(
    match
      ? "Bridge proven: Ruby in the browser queried the local PGlite replica and matched JS."
      : `Mismatch: ruby=${fmt(rubyTotal)} outside JS envelope [${fmt(lo)}, ${fmt(hi)}]`,
    match ? "text-green-600" : "text-red-600"
  );
}

boot().catch((e) => {
  console.error("[wasm] boot failed", e);
  setStatus(`Boot failed: ${e.message}`, "text-red-600");
});
