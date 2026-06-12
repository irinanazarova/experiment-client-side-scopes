# Client-side scopes (POC)

Skip the client state layer, keep Rails. A slice of the database lives on the
device as a real, queryable Postgres (PGlite), kept current from the server by
ElectricSQL. Reads and aggregates run locally at memory speed; writes go to
normal Rails controllers, which stay the sole write authority.

Demo domain: a 50,000-cell spreadsheet. Edit a whole column, watch every
aggregate resettle instantly with no network, while the server stays
authoritative and other clients converge on their own.

See [`docs/architecture.md`](docs/architecture.md) for the architecture and the
layered design. This README is how to run it and verify it.

## Where things live (a map for reviewers)

There are **two distinct "slices"** in this project; here is exactly where each
is defined.

### 1. The data slice, the client-side *scope* (which rows/columns reach the browser)

This is the named scope the project is about: a client subscribes by **name**,
never by an arbitrary query, and the Electric filter is *derived* from a real
server-side Active Record scope so the two cannot drift.

| Concern | File |
|---|---|
| The declaration (start here) | [`app/models/cell.rb`](app/models/cell.rb) — `client_scope :sheet_cells, ->(sheet_id) { for_sheet(sheet_id) }, ship: %i[row col value formula]` |
| The macro that derives the rest | [`app/models/concerns/client_scopable.rb`](app/models/concerns/client_scopable.rb) |
| The registry + the single shape-building seam | [`app/scopes/client_scope.rb`](app/scopes/client_scope.rb) (`Definition#shape_definition`) |
| The Electric Shape filter it renders | [`app/infrastructure/electric/shape_definition.rb`](app/infrastructure/electric/shape_definition.rb) |
| Who is allowed to subscribe | [`app/policies/sheet_policy.rb`](app/policies/sheet_policy.rb) (`sync?`) |

The declaration reads like a `scope` plus one security rider. **`ship:` (the
payload columns) is the only explicit choice** — it's the data that leaves the
server, the reviewable trust surface. Everything else is derived from the scope:
the params (the lambda's own arguments), the `where` (read back from the
relation, so it can't drift), the policy subject (`:sheet`, from the `sheet_id`
filter), the authorization rule (`:sync?`, with a boot-time failure if it's
missing), and the primary key + foreign key (always shipped, since you can't
replicate without them).

### 2. The code slice, the part of *Rails* that runs in Wasm (what gets packed into `app.wasm`)

| Concern | File |
|---|---|
| Which app dirs + which gems compile into `app.wasm` | [`config/wasmify.yml`](config/wasmify.yml) — `pack_directories`, `exclude_gems` |
| Which gems are in the in-browser bundle | [`Gemfile`](Gemfile) — the `group: [:default, :wasm]` / `group :wasm` markers |
| The service worker that boots the packed Rails in the tab | [`pwa/rails.sw.js`](pwa/rails.sw.js) |
| The in-browser DB the packed Rails reads | PGlite, synced by Electric (see slice notes below) |

### The rest of `app/`, by layer

```
app/
  models/            Cell, Sheet, Cells::Region/Transform (value objects)   ← Domain
  queries/cells/     ColumnAggregates, SheetStats, GridWindow (server value + client SQL, paired)
  scopes/            ClientScope registry                                    ← Application
  live_regions/      LiveRegion (named reactive view fragments)
  services/cells/    BulkUpdate (the write authority), RandomTick
  policies/          SheetPolicy
  infrastructure/    electric/* (Shape, Gateway, Proxy, Config), wasm/HeapReclaimer  ← Infrastructure
  controllers/       thin; params → value objects, authorize, delegate       ← Presentation
  views/sheets/      _grid, _rows, _stats, _totals partials (one set, host + slice)
public/*.mjs         the browser loop (sheet/wasm/wasm_ar/live/flow/blink), baked into app.wasm
```

The three run modes: **standalone** (`/sheets/1`, server Rails + browser
PGlite), **the bridge** (`/wasm`, `/wasm_ar`, ruby.wasm + in-VM ActiveRecord),
and **the slice** (`pwa/`, the whole app packed into `app.wasm`, served from a
service worker). The same `app/` serves all three.

## Prerequisites

- Ruby 3.4.x, Rails 8.1 (already set up here)
- Docker (for Postgres + Electric)
- A Chromium-based browser

## Run it

```bash
docker compose up -d                         # Postgres (wal_level=logical) + Electric on :3010
bin/rails db:prepare db:seed                 # creates schema + ~50k cells
bin/rails server                             # http://localhost:3000
```

Open `http://localhost:3000/sheets/1`.

## What to test, and what you should see

### 1. The spreadsheet + local aggregates (reads are local and instant)
Open `/sheets/1`. The first paint is server-rendered with real data; after a
moment the status line turns green: *"Replica live. Stats, Max column and Σ
row are computed locally by PGlite."* You see the stats header (Max / Min /
Average / Median in large type; the median is a real `PERCENTILE_CONT`
ordered-set aggregate), a sticky green **Max** column with each row's
maximum, and the indigo **Σ** totals row. All of it aggregates the full
50,000 cells and is computed by PGlite **in your browser**. Open
DevTools -> Network: there is no request per aggregate.

### 1b. The live data-flow trace
Under the controls is a **Live data flow** panel: five nodes (Edit → PGlite
replica → Rails authority → Electric WAL → Render). Each gesture lights the
hops it travels, color-coded (green = local/no network, indigo = crossed the
wire to the authority, amber = Electric reconciling) with per-hop timing, plus
a rolling event log. It makes the "reads local, writes to the authority,
reconcile via Electric" loop visible while you use it, and works in both
standalone and slice modes (the in-browser Rails service worker emits the
same events).

### 1c. Live updates, colour-coded by origin
Edits blink so you can see where each change came from. A change **you** make
blinks **yellow**; a change that arrives from elsewhere (the server, another
client) blinks **green**. The client decides the colour by whether it
initiated the change, so the two directions of the sync loop are visually
distinct.

To see server-originated (green) updates, click **Start server activity** in
the toolbar. While on, the page posts one tick every two seconds to
`POST /cells/ticks`; the server sets a random 5-cell vertical section in the
always-on-screen window (rows 1–25, cols 1–10) to a new random value, through
the same `Cells::BulkUpdate` write authority, commits, and Electric streams it
to every replica, so a small cluster of ~5 green flashes lands here and in any
other open tab. Edit a column and watch those blink yellow. (No console needed;
the same tick is also available headless as `bin/rails cells:simulate`.)

### 2a. Edit one cell (per-cell write)
Click any cell, type a number, press Enter. The cell and its column's Σ update
instantly (no network); the write posts to Rails; Electric reconciles. Verify:
```bash
bin/rails runner 'puts Cell.find_by(sheet_id:1, row:1, col:1).value'
```

### 2b. Optimistic bulk write + reconcile (the core loop)
Set Column = 3, Operation = multiply, Operand = 2, click **Apply to whole
column**.
- The whole column and its Σ update in **~15-20 ms with no network**
  (see the timing text).
- The status line shows *"Server updated 2500 cells. Electric reconciling
  replica..."*. The write went to Rails as one transaction; Electric streams the
  authoritative rows back; the local value settles on the server's.
- Verify they agree:
  ```bash
  bin/rails runner 'puts Cells::ColumnAggregates.new(Sheet.first).by_column[3]'
  ```
  matches the col-3 sum on screen.

### 3. Server -> client push (multi-client, no refresh)
With `/sheets/1` open and untouched, run a write as if from another client:
```bash
bin/rails runner '
  region = Cells::Region.new(sheet_id: 1, row_from: 1, row_to: 2500, col_from: 10, col_to: 10)
  transform = Cells::Transform.new(operation: :add, operand: "1000")
  Cells::BulkUpdate.new(user: nil, region:, transform:).call'
```
Within a few seconds the browser's col-10 sum jumps by 2,500,000 on its own.
That is the WAL -> Electric -> PGlite -> live query -> morph path, no user action.

### 4. Rollback on rejection (the safety property: no divergence)
Temporarily make the server reject writes:
```bash
# in app/policies/sheet_policy.rb, set:  def update? = false
```
Reload `/sheets/1`, apply any change to a column. The value flips optimistically
then **rolls back**, and the status shows
*"Server rejected (403)... Rolled back, replica still matches server."* The
replica never diverges from the (unchanged) server. Restore `def update? = true`
afterward.

### 5. Ruby in the browser (Phase B, the AR-adapter bridge)
Open `http://localhost:3000/wasm`. It boots real CRuby (ruby.wasm), which
queries the same PGlite replica through a `Pglite::Connection` seam and computes
the grand total in Ruby. The Ruby panel matches the JS panel, and the status
shows *"Bridge proven..."*. This is the async boundary the full ActiveRecord ->
PGlite adapter sits on.

### 6. Real ActiveRecord in the VM (Phase B+)
Open `http://localhost:3000/wasm_ar`. It downloads a 55 MB ruby.wasm with the
real `activerecord` gem packed in, runs it in the tab, defines a pure-Ruby
`PgliteAdapter`, and climbs a staged ladder: raw `exec_query`, then Arel
composing SQL in the VM, then the payoff stage, the full model API
`Cell.where(sheet_id: 1).group(:col).sum(:value)` running through
model -> relation -> connection pool -> adapter -> PGlite. AR's own pool
deadlocks in single-threaded Wasm (its checkout waits need a second thread to
signal them), so the VM installs a threadless one-connection pool. Every stage
logs in the page; the final Σ matches the JS panel. First load is slow
(downloads + boots the VM); subsequent loads are cached.

To rebuild the wasm (only if you change the packed gems):
```bash
cd wasm_build && bundle exec rbwasm build --ruby-version 3.4 --build-profile full -o ruby-app.wasm
cp ruby-app.wasm ../public/ruby-app.wasm
```

### 7. The Rails slice in the browser (Phase C, wasmify-rails)
The whole app, packed by `wasmify-rails`, boots inside a service worker and
serves pages in the tab: real router, controllers, Active Record over the
`pglite` adapter, ActionView. Reads come from the same Electric-synced
replica.
```bash
bin/rails wasmify:pack            # builds pwa/public/app.wasm (~125 MB; slow the first time)
cd pwa && npm install && npm run dev
```
Open `http://localhost:5173/boot.html` and wait for *"Service Worker Ready"*
(the first boot compiles the module). Then:
- `http://localhost:5173/sheets/1` is the spreadsheet, **served by Rails
  running in your browser**, down to the `cells.count` in the header.
- `http://localhost:5173/sheets/1/aggregates` (in-browser Rails reading the
  replica) returns the same JSON as
  `http://localhost:3000/sheets/1/aggregates` (host Rails reading server
  Postgres). Same action, same query object, two databases.
- Boot problems? `http://localhost:5173/debug.html` runs the identical stack
  in the page and prints every step and the failing backtrace.

In this mode the page is thin Hotwire over one replica (the worker's),
composed of **live regions**: the stats panel, the Σ row, and the grid body
are each an ERB partial bound to the SQL it depends on. The worker runs that
SQL as a PGlite live query and, when its result changes, names the region;
the page re-fetches just that fragment (**rendered by ActionView in the tab**,
no network) and morphs it. So an edit inside the visible window resettles all
three regions, while an edit *outside* it resettles only the aggregates and
leaves the grid body untouched, the live query is the dependency graph.

The optimistic write is application code: the worker dispatches the same POST
into the in-VM Rails first, so `Cells::BulkUpdate` runs locally against the
replica, then forwards it to host Rails, the write authority, as one
transaction. Electric reconciles onto the authoritative rows; a rejected
write (422) restores the snapshot and the replica never diverges.

## Tests

RSpec + factory_bot + test-prof. Authorization uses Action Policy (and its RSpec
DSL for the policy specs).

```bash
bin/rails db:test:prepare     # one-time, loads schema into the test DB
bundle exec rspec             # ~55 examples, all green
bundle exec standardrb        # lint (Standard)
```

The suite is mostly fast isolated unit/specification tests on the domain layer.
The load-bearing ones: the SQL-injection guard on `Cells::Transform`, the
fail-loud `Electric::ShapeDefinition`, the `ClientScope` invariant (the declared
Electric filter matches the server relation), and the `Cells::BulkUpdate`
specification test (authorize → update → result, no controller).

## Cloud deploy (Fly.io)

Live:
- **Standalone** (server Rails + browser PGlite): https://client-side-scopes.fly.dev/sheets/1
- **The slice — Rails in the browser**: https://client-side-scopes-slice.fly.dev
  Just open it: a loading screen installs the in-browser Rails and drops you
  into the app (no launch step). The first visit downloads the ~125 MB
  `app.wasm`; after that it opens instantly (the service worker serves `/`
  from the in-VM Rails). `/boot.html` is a diagnostics launcher.

Four apps: `client-side-scopes` (Rails, public), `client-side-scopes-slice`
(Caddy serving the built PWA + `app.wasm`, proxying the API paths to the host),
`client-side-scopes-electric` (Electric, secret-gated), and
`client-side-scopes-db` (Postgres, `wal_level=logical`).

The slice has its own origin so its service worker can own `/sheets/*` and
serve them from the in-VM Rails; Caddy proxies `/client_scopes`, `/cells` and
`/electric` to the host Rails so the browser stays same-origin (the production
equivalent of the Vite dev proxy). Build + deploy:

```bash
cd pwa && npm run build                       # dist/ incl. app.wasm
cp -r pwa/dist infra/slice/dist               # into the Caddy build context
fly deploy -c infra/slice/fly.toml            # from infra/slice
```

The host stack: In the cloud the
browser never talks to Electric: shapes long-poll same-origin through the
authorizing proxy (`Electric::ProxiesController`), which re-authorizes each
poll, derives the shape server-side and signs upstream. Locally nothing
changes (`ELECTRIC_PROXIED` defaults to false; the browser hits the open
Electric directly).

```bash
fly deploy                                     # Rails (release runs db:prepare)
fly deploy -c infra/electric/fly.toml          # Electric (private, image-based)
fly ssh console -a client-side-scopes -C "./bin/rails db:seed"   # once
```

Secrets: Rails needs `RAILS_MASTER_KEY`, `DATABASE_URL`, `ELECTRIC_URL`,
`ELECTRIC_PROXIED=true`, `ELECTRIC_SECRET`; Electric needs `DATABASE_URL`,
the same `ELECTRIC_SECRET`, and `ELECTRIC_DATABASE_USE_IPV6=true`.

To make the cloud demo feel alive, click **Start server activity** in the UI:
it drives one server tick a second (`POST /cells/ticks`) and every open tab
sees the green blinks. No console, and nothing runs server-side when no one is
watching. (`bin/rails cells:simulate` is still there for a headless writer.)

Notes from deploying this on Fly (each cost a debugging cycle):
- **Electric `DATABASE_URL` must resolve over IPv6.** Erlang's resolver does
  not handle Fly's `.internal`/`.flycast` names the way the Ruby `pg` driver
  does; set `ELECTRIC_DATABASE_USE_IPV6=true` and use the `.internal` host.
- **Electric is public but gated by `ELECTRIC_SECRET`** (its documented
  model). It binds IPv4 only, so Fly's private flycast/6PN routing cannot
  reach it; the browser never touches it (the Rails proxy holds the secret).
- **Thrust binds a privileged port by default.** The image runs as non-root,
  so set `HTTP_PORT=8080` and `internal_port = 8080`.
- **Give Postgres enough memory for Electric's initial snapshot.** Electric's
  first replication of the 50k-cell shape OOM'd the default 256MB PG; this
  deploy runs the DB at 1GB (`fly machine update <id> --vm-memory 1024`).

## Status and caveats

This is a POC. The loop is real and verified; the production-hardening items
(proxy Electric, real auth, full per-cell validation on bulk writes) are listed
in `docs/architecture.md` under "Hardening before production." It is built to
demonstrate the thesis, not to deploy.
