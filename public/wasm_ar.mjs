// Phase B+: the real activerecord gem, packed into ruby.wasm, executing a
// query against the PGlite replica through a pure-Ruby connection adapter.

import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.4.6/dist/index.js";
import { electricSync } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite-sync@0.5.6/+esm";
// Must match the ruby_wasm gem (2.9.4) that built ruby-app.wasm, or the JS glue
// and the packed `js` gem disagree (FinalizationRegistry error).
import { DefaultRubyVM } from "https://cdn.jsdelivr.net/npm/@ruby/wasm-wasi@2.9.4-2026-05-29-a/dist/browser/+esm";

const app = document.getElementById("ar-app");
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

// Staged so we can see exactly how far the real gem gets in the VM. Each stage
// logs; failures are caught and reported rather than aborting the whole run.
const RUBY = String.raw`
require "js"

# WASI has no sockets. activesupport's JSON encoder pulls in ipaddr, which
# requires "socket" and uses a few of its constants. Stub both so the real gem
# loads unchanged.
module Socket
  AF_INET = 2
  AF_INET6 = 30
  AF_UNSPEC = 0
end unless defined?(Socket)

module ::Kernel
  alias_method :__orig_require, :require
  def require(name)
    return true if name.to_s == "socket"
    return true if name.to_s == "pglite_adapter" # registered-adapter autoload no-op
    __orig_require(name)
  end
end

def log(msg)
  el = JS.global[:document].getElementById("ar-log")
  el[:textContent] = el[:textContent].to_s + msg + "\n"
end

# ScriptError too: an abstract-method NotImplementedError should report as a
# failed stage, like any other miss, instead of aborting the whole run.
def stage(name)
  log "• #{name}…"
  yield
rescue ScriptError, StandardError => e
  log "  ✗ #{e.class}: #{e.message}"
  log "    #{e.backtrace.first(3).join("\n    ")}" if e.backtrace
  nil
end

# Stage 1: load the real gem.
stage("require active_record") do
  require "active_record"
  log "  ✓ ActiveRecord #{ActiveRecord::VERSION::STRING} loaded in the VM"
end

# Stage 2: a pure-Ruby connection adapter that bridges to PGlite.
stage("define PgliteAdapter") do
  require "active_record/connection_adapters/abstract_adapter"

  module ActiveRecord
    module ConnectionAdapters
      class PgliteAdapter < AbstractAdapter
        ADAPTER_NAME = "PGlite"

        # PGlite is real Postgres, so reuse Postgres SQL generation + quoting.
        def initialize(config = {})
          super(config) # config hash path
          @raw_connection = JS.global[:pglite]
        end

        def arel_visitor = Arel::Visitors::PostgreSQL.new(self)
        def build_statement_pool = nil
        def active? = true
        def reconnect = true
        def disconnect! = nil
        def connect = true

        def quote_column_name(name) = %("#{name.to_s.gsub('"', '""')}")
        def quote_table_name(name) = quote_column_name(name)

        # 8.1 quotes identifiers through the adapter *class* in some paths
        # (e.g. grouped calculations).
        class << self
          def quote_column_name(name) = %("#{name.to_s.gsub('"', '""')}")
          def quote_table_name(name) = quote_column_name(name)
        end

        # The method AR's query path calls. Hand SQL to PGlite, await across the
        # bridge, return an ActiveRecord::Result.
        def internal_exec_query(sql, name = "SQL", binds = [], prepare: false, async: false, allow_retry: false)
          result = JS.global[:pglite].query(sql.to_s).await
          js_rows = result[:rows]
          js_fields = result[:fields]
          cols = (0...js_fields[:length].to_i).map { |i| js_fields[i][:name].to_s }
          rows = (0...js_rows[:length].to_i).map do |i|
            r = js_rows[i]
            cols.map { |c| v = r[c.to_sym]; v.nil? ? nil : v.to_s }
          end
          ActiveRecord::Result.new(cols, rows)
        end
        alias_method :exec_query, :internal_exec_query

        # Hardcoded schema for cells (we know it), so the model needs no
        # Postgres-specific introspection. 8.1 Column signature:
        # (name, cast_type, default, sql_type_metadata, null, ...).
        def columns(table_name, *)
          meta = ->(sql_type, type) { SqlTypeMetadata.new(sql_type: sql_type, type: type) }
          int = ActiveRecord::Type::Integer.new
          dec = ActiveRecord::Type::Decimal.new
          str = ActiveRecord::Type::String.new
          [
            Column.new("id", int, nil, meta.("bigint", :integer), false),
            Column.new("sheet_id", int, nil, meta.("bigint", :integer)),
            Column.new("row", int, nil, meta.("integer", :integer)),
            Column.new("col", int, nil, meta.("integer", :integer)),
            Column.new("value", dec, nil, meta.("numeric", :decimal)),
            Column.new("formula", str, nil, meta.("text", :string)),
          ]
        end

        def primary_keys(table_name) = ["id"]

        # The schema cache probes for table existence before reading columns.
        def data_source_exists?(name) = name.to_s == "cells"
        alias_method :table_exists?, :data_source_exists?
      end
    end
  end
  log "  ✓ adapter defined"
end

adapter = nil
stage("instantiate adapter") do
  # prepared_statements: false makes to_sql_and_binds inline bind values as
  # quoted literals; our bridge hands PGlite a plain SQL string, no params.
  adapter = ActiveRecord::ConnectionAdapters::PgliteAdapter.new(prepared_statements: false)
  log "  ✓ #{adapter.adapter_name} adapter ready"
end

# Stage 3: run the AR-generated aggregate SQL through AR's query interface.
ds = JS.global[:document].getElementById("ar-app")[:dataset]
stage("adapter.exec_query(sums_sql)") do
  res = adapter.exec_query(ds[:sumsSql].to_s)
  total = res.rows.sum { |row| row[1].to_f }
  log "  ✓ ActiveRecord::Result with #{res.rows.length} rows from PGlite"
  JS.global[:document].getElementById("ar-result")[:textContent] =
    "Σ all cells (ActiveRecord in Wasm): #{total.round(2)}"
  JS.global[:rubyArTotal] = total
end

# Stage 4: Arel (AR's real SQL builder) composes the aggregate query in the VM,
# the adapter's Postgres visitor renders it, the adapter executes it on PGlite.
# This drives the visitor directly, below the connection pool; stage 5 then
# makes the pool itself Wasm-safe so stage 6 can use the full model API.
stage("Arel builds the query in the VM, adapter runs it") do
  t = Arel::Table.new(:cells)
  manager = t.where(t[:sheet_id].eq(1)).group(t[:col]).order(t[:col])
                .project(t[:col], Arel.sql("SUM(value) AS total"))
  visitor = Arel::Visitors::PostgreSQL.new(adapter)
  sql = visitor.accept(manager.ast, Arel::Collectors::SQLString.new).value
  log "  ✓ Arel SQL in VM: #{sql[0, 72]}…"

  res = adapter.exec_query(sql)
  total = res.rows.sum { |r| r[1].to_f }
  log "  ✓ adapter executed Arel SQL: #{res.rows.length} groups, Σ=#{total.round(2)}"
  JS.global[:document].getElementById("ar-result")[:textContent] =
    "Σ all cells (Arel + ActiveRecord adapter in Wasm): #{total.round(2)}"
  JS.global[:rubyArTotal] = total
end

# Stage 5: a threadless connection pool. AR's real ConnectionPool parks
# checkout waiters on concurrent-ruby condition variables that only another
# thread can signal; single-threaded Wasm has no other thread, so checkout
# deadlocks. This pool holds exactly one connection and yields it with no
# leasing and no locks. Schema reflection routes through the same pool, so the
# adapter's hardcoded columns serve the model layer too.
stage("install threadless pool + Cell model") do
  class ThreadlessPool
    attr_reader :schema_reflection

    def initialize(connection)
      @connection = connection
      @schema_reflection = ActiveRecord::ConnectionAdapters::SchemaReflection.new(nil)
    end

    def with_connection(*, **) = yield(@connection)
    def lease_connection = @connection
    def active_connection? = @connection
    def release_connection(*) = nil
    def connected? = true
    def dirties_query_cache = true
    def async_executor = nil

    def schema_cache
      ActiveRecord::ConnectionAdapters::BoundSchemaReflection.new(@schema_reflection, self)
    end

    def db_config
      @db_config ||= Struct.new(:name, :adapter, :adapter_class)
        .new("primary", "pglite", ActiveRecord::ConnectionAdapters::PgliteAdapter)
    end
  end

  POOL = ThreadlessPool.new(adapter)
  ActiveRecord::Base.define_singleton_method(:connection_pool) { POOL }

  class Cell < ActiveRecord::Base; end
  log "  ✓ pool installed, Cell model defined"
end

# Stage 6: the payoff. The exact query the server runs in
# Cells::ColumnAggregates#by_column, written as you would write it in app
# code, going through model -> relation -> pool -> adapter -> PGlite.
stage("Cell.where(sheet_id: 1).group(:col).sum(:value) through the pool") do
  sums = Cell.where(sheet_id: 1).group(:col).sum(:value)
  total = sums.values.sum(&:to_f)
  log "  ✓ full model API: #{sums.size} groups through the pool, Σ=#{total.round(2)}"
  JS.global[:document].getElementById("ar-result")[:textContent] =
    "Σ all cells (Cell.where(...).group(:col).sum(:value) in Wasm): #{total.round(2)}"
  JS.global[:rubyArTotal] = total
end

log "done"
JS.global[:rubyArTotal] || 0
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

  const jsGrandTotal = async () =>
    Number((await pg.query(cfg.grandTotalSql)).rows[0]?.total ?? 0);

  // Wait until the initial sync has delivered rows before comparing.
  let jsTotal = 0;
  for (let i = 0; i < 40; i++) {
    jsTotal = await jsGrandTotal();
    if (jsTotal > 0) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  document.getElementById("js-result").textContent = `Σ all cells (computed in JS): ${fmt(jsTotal)}`;

  globalThis.pglite = pg;
  setStatus("Downloading ruby.wasm with activerecord packed (large)…", "text-amber-600");
  const mod = await WebAssembly.compile(await (await fetch("/ruby-app.wasm")).arrayBuffer());
  const { vm } = await DefaultRubyVM(mod, { args: ["ruby.wasm", "-EUTF-8", "-e_=0", "-W0"] });

  // The replica stays live (Electric streams; the server simulator ticks ~1/s),
  // so bracket the AR read between two JS reads. If the AR total lands inside
  // that envelope, both queried the same replica and any delta is a tick that
  // arrived between reads, not an adapter bug.
  setStatus("Running ActiveRecord in the VM…", "text-amber-600");
  const jsBefore = await jsGrandTotal();
  const arTotal = Number((await vm.evalAsync(RUBY)).toString());
  const jsAfter = await jsGrandTotal();
  document.getElementById("js-result").textContent = `Σ all cells (computed in JS): ${fmt(jsAfter)}`;

  const lo = Math.min(jsBefore, jsAfter) - 0.01;
  const hi = Math.max(jsBefore, jsAfter) + 0.01;
  const match = arTotal >= lo && arTotal <= hi;
  setStatus(
    match
      ? "Real ActiveRecord executed in the browser against PGlite and matched JS."
      : `ActiveRecord ran. total=${fmt(arTotal)} vs JS envelope [${fmt(lo)}, ${fmt(hi)}] (see log)`,
    match ? "text-green-600" : "text-amber-700"
  );
}

boot().catch((e) => {
  console.error("[wasm_ar] boot failed", e);
  setStatus(`Boot failed: ${e.message}`, "text-red-600");
});
