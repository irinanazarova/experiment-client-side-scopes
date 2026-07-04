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
| Reactive view | A stock **morphing `<turbo-frame>`** reloaded when a data-change trigger fires; the trigger is a PGlite live query on a change signal, the re-render runs in ActionView in the tab | glue we built |

## The design: named scope → authorized Electric Shape

The slice is the trust boundary, decided once and read across three layers:

1. **Domain**: the scope is a real ActiveRecord scope (`Cell.for_sheet`). Named
   and server-defined. The client subscribes by name, never by an arbitrary
   query.
2. **Application**: config declares the slice with `ClientScope.define`, off the
   model (the model stays a plain Active Record class), reusing that scope. The
   Electric filter, the policy subject, and the param coercion are *derived* from
   it: the filter is read back from the relation, so it cannot drift. The model
   and policy resolve lazily on first use, so declaring a scope never connects to
   the database at boot (asset precompile and the wasm pack boot without one).
   `SheetPolicy` authorizes the subscriber and guards both reads (`:sync`) and
   writes (`:update`).
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

## The reactive trigger: the live query is the dependency graph

A reactive system needs to know *when* data changed, *which* view depends on it,
and *how* to patch. We get "when" from the database, "which" is the slice the
scope already defines, and "how" is a morph.

**The one new primitive is the trigger.** `DataChange.topic(relation)`
(`app/reactivity/data_change.rb`) derives a transport-neutral stream name from an
Active Record relation, so a writer and a subscriber rendezvous on a string
without the model ever naming a view. Today's Rails skips this layer:
`broadcasts_to` goes straight from a model write to a Turbo Stream over Action
Cable, and `ActiveSupport::Notifications` is instrumentation; neither is a
data-change name you can point any transport at.

**The dependency is derived from data, not from template structure.** A query is
an `ApplicationQuery` that declares its observable relation; the SQL the browser
watches is derived from that relation (`to_sql`), never written alongside it, so
the server render and the browser's live query cannot drift:

```ruby
class Cells::ChangeSignal < ApplicationQuery
  observable_by :signal   # #sql is signal.to_sql, derived from the relation
  # one cheap row that moves whenever any cell in the sheet changes
  def signal = cells.select("COUNT(*) AS n, COALESCE(SUM(value * id), 0) AS checksum")
end
```

**The receiver is a stock morphing `<turbo-frame>`**, not a bespoke view
abstraction. `app/views/sheets/_grid_frame.html.erb` is one frame holding the
whole grid (stats panel + table). The browser runs the change signal as a PGlite
live query; when it fires, the frame reloads, and ActionView's output is morphed
in (Turbo 8 morphing + Idiomorph). Because a morph patches only the cells that
actually changed, a whole-grid re-render is non-destructive: an edit outside the
visible window resettles the aggregates and leaves the grid-body nodes untouched.
That is why per-fragment regions (an earlier `LiveRegion` helper) were removed:
morphing makes them unnecessary.

On the host, the precise route renders each fragment locally in JS from the
replica (zero network); in the slice, the worker's live query fires and the
frame reloads from the in-tab Rails. Same frame, same markup, the data source is
the only difference. PGlite's `live.query` re-fires on any change to the tables
it touches, so the worker keeps the last result and broadcasts only on a real
difference.

**Three strategies share this primitive** (`bin/rails reactive:compare` measures
them): `/sheets/1` (precise local-first), `/sheets/1/coarse` (coarse local-first,
one frame reloaded on the single change signal), and `/sheets/1/hotwire`
(server-push, the same whole-grid morph pushed over Action Cable from the trigger
instead of detected locally).

**Update blinks** flash changed cells yellow if this user initiated the change,
green otherwise. Both arrive through Electric, so the client marks cells it just
edited with a short TTL and treats everything else as remote.

**Herb is the future patch step.** Today the patch is re-render-and-morph
(Idiomorph). Herb v0.10.1 ships the parser, AST, and `Herb::Engine` (runs in
ruby.wasm); its reactive slot-diffing renderer is not built yet. A server-side
spike already swaps the ERB engine (Erubi → Herb) under ActionView behind
`REACTIONVIEW_ERB=1`, byte-identical output, suite green. When slot diffing
ships, swap the morph for slot diffs; the frame wiring above does not change.

## Layered architecture

Unidirectional flow, lower layers never depend on higher ones.

```
Presentation   SheetsController, Cells::BulkUpdatesController, ClientScopesController
                 |                         |                          |
Application    (render only)        Cells::BulkUpdate          ClientScope.define (config)
                                    SheetPolicy                SheetPolicy
                 |                         |                          |
Domain         Cells::ColumnAggregates   Cell / Sheet              Cell scope
               Cells::ChangeSignal (Q)   Cells::Transform (VO)     (:for_sheet)
                 |                         |                          |
Infrastructure  Active Record / PGlite adapter            Electric::ShapeDefinition
               DataChange.topic (trigger)                 Electric::Gateway
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
- **Three reactive strategies on one primitive.** `/sheets/1` (precise
  local-first, JS render on the host), `/sheets/1/coarse` (coarse local-first,
  one morphing frame reloaded on a single change signal), and `/sheets/1/hotwire`
  (server-push, the same whole-grid morph over Action Cable). All three watch the
  same `Cells::ChangeSignal`; `bin/rails reactive:compare` measures them.
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
  `Cells::BulkUpdate`, restored on host rejection. The full end-to-end now
  passes headless against the production build (`pwa/verify-slice.mjs`): the
  production service worker boots, renders `/sheets/1` from in-VM Rails, and an
  edit reconciles. The earlier boot wedge was the Vite dev-server SW shim under
  Playwright, never the wasm module.
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
  replica observability, cold start, and in-tab render cost (a whole-grid
  ActionView render in the VM costs far more than the ~8 ms JS stand-in;
  morphing already keeps the DOM patch minimal, and Herb-style slot diffing is
  the lever for the render itself).

### Boot-time constraints the slice surfaced

- **No database at boot.** `slice:pack` precompiles assets and the wasm pack
  boots Rails with no Postgres reachable. `ClientScope.define` therefore resolves
  the model, reflection, and policy lazily on first use; declaring a scope at
  config time never opens a connection.
- **Action Cable is excluded in wasm.** The `hotwire` strategy's channels
  eager-load `ApplicationCable`, which has no `action_cable` in the wasm build.
  `config/application.rb` ignores `app/channels` from the autoloader when
  `RAILS_ENV=wasm`, so the slice boots without the server-push path.

## Run it

Server-side (Rails on the server, browser keeps a PGlite replica):

```bash
docker compose up -d            # Postgres (wal_level=logical) + Electric
bin/rails db:prepare db:seed
bin/rails server                # http://localhost:3000/sheets/1
```

The slice (Rails in the browser):

```bash
bin/rails slice:pack            # pack app.wasm — never wasmify:pack (leaks secrets)
cd pwa && npm install && npm run dev   # http://localhost:5173, then open /boot.html
```

Both run the same codebase. See the [README](../README.md) for the live URLs
(`client-side-scopes.fly.dev/sheets/1` server-side and
`client-side-scopes-slice.fly.dev` in-browser) and the verify scripts.
