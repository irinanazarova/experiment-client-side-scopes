# Client-side scopes: POC architecture

Skip the client state layer, keep Rails. A slice of the database lives on the
device as a real queryable Postgres (PGlite), kept current from the server.
Reads/aggregates run locally at memory speed; writes go to normal Rails
controllers. See the proposal gist for the full pitch.

## The demo this POC drives at

A spreadsheet of ~50k cells. Select a column, hit "×1.1". Every dependent
aggregate (column sums, grand total) resettles instantly with no spinner and no
network, while a second browser shows the authoritative values stream in a beat
later through Electric. One gesture shows: instant local SQL compute, server
write-authority, optimistic reconciliation, multi-client sync.

## The target: a slice of Rails on the device

The end state this POC de-risks, piece by piece: the app itself runs in the
browser via `wasmify-rails`, with a Hotwire UI rendered in the VM and PGlite as
the local database behind the Active Record adapter. Same models, same
services, same views; the slice you boot is the slice your `ClientScope`
authorizes. The optimistic write then stops being duplicated JS math and
becomes the same application code (`Cells::BulkUpdate`) run locally against
the replica, with the server's authoritative run reconciling through Electric.
Phase C (`pwa/`, see Status) is that slice running: Rails serves and renders
the spreadsheet in the tab (ActionView fragments morph in on replica
changes), and the optimistic write is the in-VM `Cells::BulkUpdate`. The
host-mode demo loop keeps JS stand-ins for the same contracts.

## The four runtime pieces

| Piece | What | State |
|-------|------|-------|
| Ruby-on-Wasm | ruby.wasm (`rbwasm` build); `wasmify-rails` 0.4.1 packs the full app and boots it in a service worker (Phase C) | exists |
| Client DB | PGlite 0.4.6: Postgres in Wasm, live-query support | exists |
| Sync (change stream) | ElectricSQL: read-path, WAL-sourced Shapes -> `pglite-sync` into PGlite | exists |
| Reactive view | Named **live regions**: an ERB partial bound to the SQL it depends on. A PGlite live query drives it; the slice re-renders the region with ActionView in the tab and morphs it (host mode uses a JS stand-in). `Herb`/ReActionView slot-diffing is the future swap-in for the morph step | **glue we built** |

### Why Electric (and not after_commit)

Electric reads Postgres logical replication (the WAL), so it captures **every**
committed change including the `update_all` our bulk path uses. An
`after_commit` broadcast would silently miss bulk writes and the replica would
diverge. Electric is also read-path only, which structurally enforces the
"reads local, writes server" rule: it physically cannot sync a write upward.

### Reactive views: live regions (the live query is the dependency graph)

A reactive system needs to know *when* data changed, *which* fragments depend
on it, and *how* to patch. LiveView/ReActionView spend their machinery on the
middle one (tracking which template slot reads which assign). We get it from
the database: a `LiveRegion` binds an ERB partial to the SQL it depends on, and
a PGlite live query on that SQL tells us precisely when that fragment is stale.
Declared and named, like `ClientScope`:

```ruby
LiveRegion.register :totals,
  partial: "sheets/totals",
  watch:   ->(sheet) { Cells::ColumnAggregates.new(sheet).sums_sql },
  locals:  ->(sheet) { {sheet:, sums: Cells::ColumnAggregates.new(sheet).by_column, ...} }
```

The slice page is then thin: each region element carries its watch SQL; the
service worker runs the live query; when the result changes it names the region
on a `BroadcastChannel`; the page re-fetches just that fragment (rendered by
**ActionView in the tab**, no network) and Idiomorph patches it. Verified: an
edit inside the visible window re-renders stats + Σ row + grid body; an edit
*outside* the window re-renders only the aggregates and leaves the grid body
untouched, because its result set did not change.

One honest detail: PGlite's `live.query` re-runs on any change to the tables it
touches, not only when its own result changes, so the worker keeps the last
result per region and broadcasts only on a real difference. That restores the
"fires exactly when this slice changed" behavior the design wants.

#### Update blinks (origin, not magic)

Each re-render diffs the visible cells against a pre-render snapshot and flashes
the ones that changed: **yellow** if this user initiated the change, **green**
otherwise (a server tick, another client). Both arrive at the replica through
Electric, so the client can't tell origin from the data; instead it marks the
cells it just edited with a short TTL (covering the optimistic apply and the
Electric echo) and treats everything else as remote. A render that changes many
cells at once is the initial snapshot streaming in, not a per-cell update, so it
is skipped. The `cells:simulate` rake task drives the green side: every two
seconds it sets a random 5-cell section through `Cells::BulkUpdate` (the
simulator is just another authorized caller of the write authority), committed
so Electric carries it to every replica.

The patch step is still re-render-and-morph (Idiomorph, ~3 KB, the pattern
Hotwire trusts). Herb v0.10.1 ships the parser + AST + `Herb::Engine` (renders
ERB to a string, runs in ruby.wasm today); its reactive slot-diffing renderer,
the ReActionView direction, is not built yet. When it ships, swap the morph for
slot diffs; the live-region wiring above does not change.

#### Herb engine spike (server-side, done)

The first rung toward that is swapping the ERB *engine* (Erubi → Herb) under
ActionView, with the templates and everything above unchanged. `reactionview`
makes this a one-flag change: its handler subclasses ActionView's ERB handler
and compiles through `Herb::Engine` only when `intercept_erb` is on, else
falls back to Erubi. Wired behind `REACTIONVIEW_ERB=1` (off by default; see
`config/initializers/reactionview.rb`) and verified: the full suite passes
under Herb, and every region fragment renders **byte-identical** to Erubi
(the only raw difference is Rails' development-only `<!-- BEGIN/END -->`
template annotations, which Herb's handler does not emit). The gem is
server-side only, kept out of the `:wasm` bundle because its native extension
is not cross-compiled to wasi yet, so the in-VM Rails keeps Erubi. Getting
Herb into `app.wasm` (it ships a pure-Ruby/WASM build, and Prism already
proves the parser class compiles for wasm) is the next rung, then the reactive
slot diffs.

## Layered architecture (per layered-rails)

Unidirectional flow, lower layers never depend on higher ones.

```
Presentation   SheetsController, Cells::BulkUpdatesController, ClientScopesController
                 |                         |                          |
Application    (render only)        Cells::BulkUpdate          client_scope macro
                                    SheetPolicy                SheetPolicy
                 |                         |                          |
Domain         Cells::ColumnAggregates   Cell / Sheet              Cell scope
               Cells::Region (VO)        Cells::Transform (VO)     (:for_sheet)
                 |                         |                          |
Infrastructure  Active Record / PGlite adapter            Electric::ShapeDefinition
                                                          Electric::Gateway
```

### The "named client-side scope -> authorized Electric Shape" mapping

Three layers, one boundary (the proposal's "slice == trust boundary, decide once"):

1. **Domain**: the scope is a real ActiveRecord scope (`Cell.for_sheet`). Named,
   server-defined. The client subscribes by name, never by an arbitrary query.
2. **Application**: a model declares the slice with the `client_scope` macro
   (`ClientScopable`), reusing a real AR scope; the Electric filter, the
   policy subject and the param coercion are *derived* from it (the filter is
   read back from the relation, so it cannot drift). `SheetPolicy` authorizes
   the subscriber. The same policy guards reads (`:sync`) and writes
   (`:update`). The `ClientScope` registry is the low-level seam controllers
   and the Electric proxy resolve names against.
3. **Infrastructure**: `Electric::ShapeDefinition` renders the Shape's
   `where`/`columns` from the scope's declared conditions: an explicit,
   reviewable artifact, never parsed out of generated SQL. A spec pins that
   the declared filter and the server relation describe the same slice.
   `Electric::Gateway` produces the config the browser hands to `pglite-sync`,
   and is the seam where production signs/proxies the request.

### The write ladder

POC sits on **point B**: optimistic local write, provisional until Electric
streams the authoritative row back. `Cells::BulkUpdate` enforces the safety
line: one user gesture == one server transaction == one `UPDATE`, never batched
on a cadence, server always the sole authority. Crossing into point C (queued
offline writes + conflict resolution) is a separate proposal.

## Spikes (ordered by risk)

- **Spike 0** — boot: real CRuby boots in-browser via ruby.wasm with `activerecord` packed in (`rbwasm` build); the wasm Gemfile is Wasm-clean.
- **Spike 1 (crux)** — AR -> PGlite connection adapter over the ruby.wasm <-> PGlite
  async bridge. Proven when `Cells::ColumnAggregates#by_column` (a `GROUP BY col
  SUM`) returns from PGlite, not just a trivial `SELECT *`.
- **Spike 2** — reactivity: PGlite live-query -> re-render -> Idiomorph patch
  (`Herb::Compiler` becomes the renderer once its fragment diffing ships, see
  above). A row inserted into PGlite updates the aggregate panel, no reload.
- **Spike 3** — instant local reads: filter/sort re-runs the AR query against PGlite.
- **Spike 4** — write loop (point B): `Cells::BulkUpdate` runs the transaction;
  authoritative rows return through Electric + `pglite-sync`; UI reconciles.

## Known unknowns (POC proves the loop, not these)

- ruby.wasm <-> PGlite async boundary (PGlite returns Promises; the AR adapter
  must `await` across the bridge inside a sync-looking `execute`). Spike 1 risk.
- Initial replica seeding (Electric Shapes do snapshot + live tail).
- Re-converging when a scope definition changes.
- Eviction / bounded local storage; viewport virtualization for true large scale.
- Auth + session lifecycle: replica on logout / token expiry / permission change.
- Multi-tab coherence; observability (is the replica converged?).
- Binary size + cold start: first paint is server-rendered HTML, then hydrate.
- Full-Rails-in-Wasm vs PGlite-plus-thin-sync (the demo loop runs the latter
  today; the `/wasm_ar` adapter bridge is the step toward the former).

## Status: built and verified

All five spikes run locally and were verified in a real browser (see the
[README](../README.md) for how to reproduce each).

- **Spike 0–4 (the loop)** — `/sheets/1`: PGlite boots in-browser, Electric
  syncs the 50k-cell slice, aggregates compute locally (~18 ms, no network),
  a bulk edit applies optimistically, posts to Rails (one transaction, 2,500
  cells), and Electric reconciles the replica. Verified: local total matches
  server authority before and after.
- **Server → client push** — a write from another client/admin streams through
  the WAL to the browser with no user action and no refresh.
- **Rollback on rejection** — when the server rejects a write (403/422), the
  optimistic local change rolls back and the replica stays equal to the
  (unchanged) server. No divergence. This is the safety property that makes
  point B honest.
- **Spike 1 bridge (Phase B)** — `/wasm`: real CRuby (ruby.wasm) runs in the
  browser, queries the same PGlite replica through a `Pglite::Connection` seam
  (the shape of the Active Record adapter), and its computed total matches JS.
  Clears the #1 known unknown: the ruby.wasm ↔ PGlite async boundary.
- **Real ActiveRecord in the VM (Phase B+)** — `/wasm_ar`: the actual
  `activerecord` 8.1.3 gem, packed into ruby.wasm via `rbwasm build`, runs in
  the browser. A pure-Ruby `ActiveRecord::ConnectionAdapters::PgliteAdapter`
  (Postgres Arel visitor + quoting, `internal_exec_query` over the JS bridge)
  executes against PGlite and returns a real `ActiveRecord::Result`. Arel
  composes the aggregate query in the VM and the adapter runs it; total matches
  JS (24,959,219.98). Not a JS port: one ActiveRecord, relocated.
  - Build recipe (`wasm_build/`): pin `minitest ~> 5.25` (drops the prism C ext),
    `json 2.7.6` (newer json's C ext clashes with the wasi cross-compiler), and
    include `gem "js"` (the JS runtime requires it). At runtime, stub `socket`
    (WASI has none; `ipaddr` needs a few constants).
  - **Pool-managed model API (threadless pool):** the staged run ends with
    `Cell.where(sheet_id: 1).group(:col).sum(:value)` going through
    model -> relation -> pool -> adapter -> PGlite and matching JS. AR's own
    `ConnectionPool` parks checkout waiters on condition variables that only
    another thread can signal, so it deadlocks in single-threaded Wasm. The VM
    installs a threadless replacement instead: one connection, yielded with no
    leasing and no locks, with schema reflection routed through the same pool
    so the adapter's hardcoded columns serve the model layer.

- **The Rails slice in the browser (Phase C)** — `pwa/`: the whole app,
  packed by `wasmify-rails` into `app.wasm` (~52 MB stripped, ~9 MB brotli on
  the wire), boots inside a service worker in ~10 s and serves same-origin
  requests in the tab. Verified:
  `/sheets/1` renders end to end (router -> `SheetsController` -> Active
  Record through the real connection pool -> the gem's `pglite` adapter ->
  the Electric-synced replica -> ActionView), and `/sheets/1/aggregates`
  from the in-browser Rails returns the identical JSON to the host Rails
  reading server Postgres. One codebase, one action, two databases.
  - Integration notes (`config/wasmify.yml` documents each): exclude the
    native-ext gems whose default-gem versions are baked into ruby.wasm
    (json, erb, prism, ...); keep `bigdecimal` (bundled gem in Ruby 3.4,
    nothing baked to fall back to, and its ext compiles under wasi); pin
    `minitest ~> 5.25` (6.x pulls prism's C ext); give WASI an env with
    `PATH`/`HOME` (anyway_config reads them); patch `PGlite::Result#ntuples`
    (wasmify-rails 0.4.1 predates Rails 8.1's instrumentation; see
    `config/initializers/pglite_rails81_compat.rb`).
  - The write ladder holds in this mode too, structurally: the service
    worker serves reads from the in-VM Rails and passes every non-GET
    request through to the host write authority. Verified: a column edit
    lands on the host as one transaction, the replica converges on the
    authoritative rows through Electric, and a host-rejected write rolls
    back with no divergence. The slice's cross-session CSRF token is handled
    with `null_session` on the JSON write endpoint, so the policy check
    inside `Cells::BulkUpdate` stays the gate (a request spec pins this
    contract).
  - **Hotwire over one replica (the c2 rung), verified:** the page owns no
    database; the worker's PGlite is the single replica. A live query in the
    worker broadcasts changes; the page fetches the grid fragment, rendered
    by **ActionView running in the tab** (~600 ms for stats + Σ row + Max
    column + 50×20 cells, no network), and Idiomorph patches the DOM. The
    optimistic write is application code: the worker dispatches the same
    POST into the in-VM Rails (`Cells::BulkUpdate` against the replica)
    before forwarding it to the host, and restores its snapshot if the host
    rejects. The aggregates panel (max/min/avg/median, `PERCENTILE_CONT`
    runs on PGlite as on the server) and the per-row Max column resettle on
    every edit. One ERB partial (`sheets/_grid`) renders the host first
    paint, the slice first paint, and every slice re-render.

- **Deployed and verified in the cloud (Fly.io).** Apps: Rails (public),
  Electric (`ELECTRIC_SECRET`-gated), Postgres (`wal_level=logical`), and the
  slice (Caddy serving the PWA). The standalone loop runs at
  client-side-scopes.fly.dev: the browser hits the cloud Rails, the replica
  syncs through the authorizing proxy (verified: the shape URL is same-origin
  `/electric/v1/shape`, the raw Electric URL is never exposed), local
  aggregates compute, and a column edit reaches the host authority (one
  transaction) and reconciles back through Electric. ~0.5s authority hop vs
  ~12ms local apply.
- **The slice runs in the cloud too (Rails in the browser, publicly).**
  client-side-scopes-slice.fly.dev: Caddy serves the built PWA + `app.wasm`
  and proxies the API paths to the host, so the service worker owns its origin
  and serves `/sheets/1` from the in-VM Rails. Verified end to end on the
  public URL: SW boots the 125 MB module, the replica syncs via the host
  proxy, each live region re-renders with ActionView in the tab, and a write
  reaches the host authority (one transaction) and reconciles into the
  in-tab replica.

Independently reviewed by sub-agents: layered architecture (verdict: sound) and
correctness/security (trust boundary sound in shape; the divergence-on-rejection
bug they found is fixed and verified).

## Hardening before production (not POC blockers)

- **Local POC runs Electric open (`ELECTRIC_INSECURE=true`) and the browser
  hits it directly.** Rails authorizes *issuing* the shape config, but a
  dishonest client could alter the returned `where`/`columns` and call
  Electric itself. The production posture is **implemented and used in the
  cloud deploy**: set `ELECTRIC_PROXIED=true` and `ELECTRIC_SECRET`, and the
  browser polls `Electric::ProxiesController` same-origin instead. The proxy
  re-authorizes on every poll, re-derives the shape from the registered
  scope (a spec pins that client-supplied `table`/`columns`/`where` are
  ignored), and signs upstream to a private Electric. `Electric::Gateway`
  picks the posture; the client code is identical in both.
- **`SheetPolicy` is a permissive stub and `current_user` is `nil`.** Real
  auth must populate the user and implement `sync?`/`update?` before any
  multi-tenant deploy.
- **`ShapeDefinition` renders only column = integer equality** (optionally
  AND-ed) and fails loudly on anything else. Richer scopes (ranges, IN-lists)
  need the renderer extended; every widening is a trust-boundary change and
  should be reviewed as one.
- **`update_all` bypasses model `numericality`**; the `Transform` finite guard
  covers the operand, full per-cell validation on bulk writes is future work.
- Open known unknowns still stand: initial-seed cost, eviction, multi-tab
  coherence, replica observability, cold start (app.wasm is ~52 MB, ~9 MB
  brotli), and
  the in-tab render cost (~600 ms per fragment vs ~8 ms for the JS stand-in;
  Herb-style fragment diffing or partial-scoped renders are the lever).

## Running it

```bash
docker compose up -d            # Postgres (wal_level=logical) + Electric
bin/rails db:prepare db:seed
bin/rails server                # http://localhost:3000/sheets/1
```
