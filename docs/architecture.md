# Client-side scopes: architecture

Skip the client state layer, keep Rails. A slice of the database lives on the
device as a real queryable Postgres (PGlite), kept current from the server.
Reads and aggregates run locally at memory speed; writes go to normal Rails
controllers. The end state, which this POC de-risks piece by piece, is the app
itself running in the browser via `wasmify-rails`: same models, same services,
same views, with PGlite behind the Active Record adapter and the optimistic
write being the same `Cells::BulkUpdate` run locally against the replica.

## The four runtime pieces

| Piece | What | State |
|-------|------|-------|
| Ruby-on-Wasm | ruby.wasm (`rbwasm` build); `wasmify-rails` 0.4.1 packs the full app and boots it in a service worker | exists |
| Client DB | PGlite 0.4.6: Postgres in Wasm, live-query support | exists |
| Sync | ElectricSQL: read-path, WAL-sourced Shapes into PGlite via `pglite-sync` | exists |
| Reactive view | **Live regions**: an ERB partial bound to the SQL it depends on, re-rendered by ActionView in the tab on a PGlite live-query change | glue we built |

## The design: named scope → authorized Electric Shape

The slice is the trust boundary, decided once and read across three layers:

1. **Domain**: the scope is a real ActiveRecord scope (`Cell.for_sheet`). Named
   and server-defined. The client subscribes by name, never by an arbitrary
   query.
2. **Application**: a model declares the slice with `client_scope`
   (`ClientScopable`), reusing that scope. The Electric filter, the policy
   subject, and the param coercion are *derived* from it: the filter is read
   back from the relation, so it cannot drift. `SheetPolicy` authorizes the
   subscriber and guards both reads (`:sync`) and writes (`:update`).
3. **Infrastructure**: `Electric::ShapeDefinition` renders the Shape's
   `where`/`columns` from the scope's declared conditions, an explicit
   reviewable artifact. `Electric::Gateway` produces the config the browser
   hands to `pglite-sync` and is the seam where production signs and proxies
   the request. A spec pins that the declared filter and the server relation
   describe the same slice.

### Why Electric, not after_commit

Electric reads Postgres logical replication (the WAL), so it captures every
committed change including the `update_all` our bulk path uses. An
`after_commit` broadcast would silently miss bulk writes and the replica would
diverge. Electric is read-path only, which structurally enforces "reads local,
writes server": it physically cannot sync a write upward.

## Live regions: the live query is the dependency graph

A reactive system needs to know *when* data changed, *which* fragments depend on
it, and *how* to patch. We get the first two from the database: a `LiveRegion`
binds an ERB partial to the query it observes, and a PGlite live query on that
query tells us precisely when that fragment is stale. The query is an
`ApplicationQuery` that declares its observable relation; the SQL the browser
watches is derived from that relation (`to_sql`), never written alongside it, so
the server render and the browser's live query cannot drift. Declared and named,
like `ClientScope`:

```ruby
class Cells::ColumnAggregates < ApplicationQuery
  observable_by :sums   # #watch_sql is sums.to_sql, derived from the relation
  def sums = cells.group(:col).order(:col).select("col, SUM(value) AS total")
end

LiveRegion.register :totals,
  partial: "sheets/totals",
  query:   ->(sheet) { Cells::ColumnAggregates.new(sheet) },
  locals:  ->(sheet) { {sheet:, sums: Cells::ColumnAggregates.new(sheet).by_column, ...} }
```

The page is thin: each region element carries its watch SQL; the service worker
runs the live query; when the result changes it names the region on a
`BroadcastChannel`; the page re-fetches just that fragment, rendered by
ActionView in the tab with no network, and Idiomorph patches it. PGlite's
`live.query` re-fires on any change to the tables it touches, so the worker
keeps the last result per region and broadcasts only on a real difference.

**Update blinks** flash changed cells yellow if this user initiated the change,
green otherwise. Both arrive through Electric, so the client marks cells it just
edited with a short TTL and treats everything else as remote.

**Herb is the future patch step.** Today the patch is re-render-and-morph
(Idiomorph). Herb v0.10.1 ships the parser, AST, and `Herb::Engine` (runs in
ruby.wasm); its reactive slot-diffing renderer is not built yet. A server-side
spike already swaps the ERB engine (Erubi → Herb) under ActionView behind
`REACTIONVIEW_ERB=1`, byte-identical output, suite green. When slot diffing
ships, swap the morph for slot diffs; the live-region wiring above does not
change.

## Layered architecture

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

### The write ladder

POC sits on **point B**: optimistic local write, provisional until Electric
streams the authoritative row back. `Cells::BulkUpdate` enforces the safety
line: one user gesture is one server transaction is one `UPDATE`, never batched
on a cadence, server always the sole authority. Point C (queued offline writes
plus conflict resolution) is a separate proposal.

## Status: built and verified

All verified in a real browser; the [README](../README.md) shows how to
reproduce each.

- **The loop** (`/sheets/1`): PGlite boots in-browser, Electric syncs the
  50k-cell slice, aggregates compute locally (~18 ms, no network), a bulk edit
  applies optimistically, posts to Rails as one transaction (2,500 cells), and
  Electric reconciles. Local total matches server authority before and after.
- **Server → client push**: a write from another client streams through the WAL
  to the browser with no user action and no refresh.
- **Rollback on rejection**: a rejected write (403/422) rolls back the
  optimistic change; the replica stays equal to the unchanged server. This is
  the safety property that makes point B honest.
- **Real ActiveRecord in the VM** (`/wasm_ar`): the actual `activerecord` 8.1.3
  gem, packed via `rbwasm build`, runs in the browser. A pure-Ruby
  `PgliteAdapter` (Arel visitor, quoting, `internal_exec_query` over the JS
  bridge) executes against PGlite and returns a real `ActiveRecord::Result`;
  total matches JS. AR's `ConnectionPool` deadlocks single-threaded Wasm, so the
  VM installs a threadless one-connection replacement.
- **The Rails slice in the browser** (`pwa/`): the whole app, packed into
  `app.wasm` (~52 MB stripped, ~9 MB brotli), boots in a service worker (~10 s)
  and serves same-origin requests. `/sheets/1` renders end to end through the
  real connection pool and the `pglite` adapter; `/sheets/1/aggregates` returns
  JSON identical to the host Rails reading server Postgres. One codebase, one
  action, two databases. The worker serves reads from in-VM Rails and forwards
  every non-GET to the host write authority; a write lands as one transaction
  and reconciles back through Electric. The optimistic write is the same in-VM
  `Cells::BulkUpdate`, restored on host rejection.
- **Deployed to Fly.io.** Four apps: Rails (public), Electric
  (`ELECTRIC_SECRET`-gated), Postgres (`wal_level=logical`), and the slice
  (Caddy serving the PWA). Both demos run publicly: the standalone loop at
  client-side-scopes.fly.dev (replica syncs through the authorizing proxy, the
  raw Electric URL is never exposed) and the slice at
  client-side-scopes-slice.fly.dev (the SW owns its origin and serves
  `/sheets/1` from in-VM Rails). See [deploy.md](deploy.md).

Independently reviewed by sub-agents: layered architecture sound; the
divergence-on-rejection bug they found is fixed and verified.

## Hardening before production (not POC blockers)

- **Electric posture.** Local POC runs Electric open (`ELECTRIC_INSECURE=true`)
  and the browser hits it directly. The production posture is implemented and
  used in the cloud deploy: set `ELECTRIC_PROXIED=true` and `ELECTRIC_SECRET`,
  and the browser polls `Electric::ProxiesController` same-origin. The proxy
  re-authorizes on every poll, re-derives the shape from the registered scope
  (a spec pins that client-supplied `table`/`columns`/`where` are ignored), and
  signs upstream to a private Electric.
- **Auth is a stub.** `SheetPolicy` is permissive and `current_user` is `nil`.
  Real auth must populate the user and implement `sync?`/`update?` before any
  multi-tenant deploy.
- **`ShapeDefinition` renders only column = integer equality** (optionally
  AND-ed) and fails loudly on anything else. Richer scopes (ranges, IN-lists)
  need the renderer extended; every widening is a trust-boundary change.
- **`update_all` bypasses model `numericality`.** The `Transform` finite guard
  covers the operand; full per-cell validation on bulk writes is future work.
- **Open known unknowns:** initial-seed cost, eviction, multi-tab coherence,
  replica observability, cold start, and in-tab render cost (~600 ms per
  fragment vs ~8 ms for the JS stand-in; Herb-style fragment diffing is the
  lever).

## Run it

```bash
docker compose up -d            # Postgres (wal_level=logical) + Electric
bin/rails db:prepare db:seed
bin/rails server                # http://localhost:3000/sheets/1
```
