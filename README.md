# Client-side scopes (POC)

An experiment in zero-latency UX on Rails. For true zero latency we want a
database in the browser: edits apply first to a local replica, render almost
instantly (no network), then propagate to the server the normal way; server
changes push back as authoritative. The catch is the client logic, do we have to
re-implement migrations, validations, and domain models in JS? This POC tries
another way: **run Rails itself in the browser** (WebAssembly via `wasmify-rails`),
with a slice of server-side Postgres synced into a client-side PGlite read
replica by ElectricSQL. Reads are local; every write goes to Rails over HTTP, and
the server stays the sole authority.

**It runs two ways, same codebase:**

- **Rails in the browser (local):** https://client-side-scopes-slice.fly.dev
  A loader installs the in-browser Rails and drops you in; the spreadsheet is
  rendered by **Rails running in your tab** over a local Postgres replica.
- **Rails on the server (server-side):** https://client-side-scopes.fly.dev/sheets/1
  The same app served from the server; the browser still keeps a PGlite replica
  for instant local reads.

**The demo:** a 50,000-cell spreadsheet. Hit **Apply to whole column** and the
column and its Σ update in ~15 ms with no network, then the write lands on the
server (one transaction) and Electric reconciles every replica. **Yellow** flashes
are your edits; **green** are changes from the server. Toggle **Server activity**
to watch changes stream in, and **Server rejects writes** to see a rejected write
roll back without the replica ever diverging.

## What it proves

- **One Rails codebase, two databases.** The same controller and query objects
  serve `/sheets/1` from server Postgres and, packed into `app.wasm`, from the
  in-browser PGlite replica. `/sheets/1/aggregates` returns identical JSON either
  way.
- **Reads are local and instant.** Stats, the per-row Max column, and the Σ row
  (including a real `PERCENTILE_CONT` median) are computed by PGlite in the
  browser, no request per aggregate.
- **The server stays the sole write authority.** A write applies optimistically
  in the browser, goes to Rails as one transaction, and Electric streams the
  authoritative rows back. A rejected write rolls back and the replica never
  diverges.

## The primitives

The thesis: reactive, local-first UX needs **one new Rails primitive**, and stock
Hotwire for the rest (see [docs/reactive-rails.md](docs/reactive-rails.md) and
[docs/architecture.md](docs/architecture.md)).

**The data slice, the client-side *scope*** (which rows/columns replicate):

| | |
|---|---|
| Declaration (start here) | [`config/initializers/client_scopes.rb`](config/initializers/client_scopes.rb): `ClientScope.define :sheet_cells, scope: ->(sheet_id){ Cell.for_sheet(sheet_id) }, ship: %i[row col value formula]` |
| The abstraction | [`app/scopes/client_scope.rb`](app/scopes/client_scope.rb) (declared off the model, resolved lazily) |
| The model stays plain AR | [`app/models/cell.rb`](app/models/cell.rb) (`scope :for_sheet`) |
| The Electric filter | [`app/infrastructure/electric/shape_definition.rb`](app/infrastructure/electric/shape_definition.rb) |
| Authorization | [`app/policies/sheet_policy.rb`](app/policies/sheet_policy.rb) (`sync?`) |

It reads like a scope plus one rider: **`ship:`** (the payload columns) is the only
explicit choice; the `where`, the policy subject, the params, and the pk/FK are
derived from the relation. Which slice ships is a sync concern, so it lives in
config, off the domain model.

**The reactive trigger** (the one primitive Rails lacks):

| | |
|---|---|
| The trigger | [`app/reactivity/data_change.rb`](app/reactivity/data_change.rb): `DataChange.topic(relation)` — a transport-neutral "this slice of data changed" name, derived from a relation |
| The observable query | [`app/queries/application_query.rb`](app/queries/application_query.rb): `observable_by :relation` — the watch SQL is derived from an Active Record relation (`to_sql`), never hand-written |
| The receiver | [`app/views/sheets/_grid_frame.html.erb`](app/views/sheets/_grid_frame.html.erb): a **stock morphing `<turbo-frame>`**, reloaded when the trigger fires |

No bespoke view abstraction: the receiver is a Turbo 8 morphing frame, the trigger
is a PGlite live query on the change signal. A whole-grid re-render morphs in only
the diff, so per-fragment regions are unnecessary.

**Three reactive strategies, same primitive, for comparison:**

| Route | Strategy |
|---|---|
| `/sheets/1` | precise local-first (page-owned PGlite + local render) |
| `/sheets/1/coarse` | coarse local-first (one frame, reloaded on one change signal) |
| `/sheets/1/hotwire` | server-push (plain Hotwire over Action Cable, no local DB) |

`bin/rails reactive:compare` prints the render cost of each on the same sheet.

**The code slice** packed into `app.wasm`: [`config/wasmify.yml`](config/wasmify.yml)
(dirs + gem exclusions) and the `:wasm` bundler group in the [`Gemfile`](Gemfile);
booted by [`pwa/rails.sw.js`](pwa/rails.sw.js). The rest of `app/` is plain layered
Rails (`queries/`, `services/`, `scopes/`, `reactivity/`, `policies/`,
`infrastructure/`).

## Run it locally

```bash
docker compose up -d            # Postgres (wal_level=logical) + Electric
bin/rails db:prepare db:seed    # schema + ~50k cells
bin/rails server                # http://localhost:3000/sheets/1
```

The slice (Rails in the browser):

```bash
bin/rails slice:pack            # pack app.wasm (~52 MB; reuses tmp/wasmify/ruby.wasm) — never wasmify:pack (leaks secrets)
cd pwa && npm install && npm run dev   # http://localhost:5173, then open /boot.html
```

## Tests

```bash
bin/ci                          # the full gate: audits, standardrb, rspec, slice unit tests
# or piecemeal:
bundle exec rspec               # 81 examples
bundle exec standardrb
npm --prefix pwa test           # slice pure-logic unit tests (node:test)
```

Headless browser checks (need the server + Electric up):

```bash
node pwa/verify-precise.mjs     # the precise route: edit reconciles, a morph keeps untouched nodes
node pwa/verify-coarse.mjs      # the coarse route: edit reconciles through Electric, frame reloads
node pwa/verify-slice-vm.mjs    # the in-VM Rails renders the migrated grid (main-thread boot)
node pwa/verify-slice.mjs       # the FULL slice: production SW boots, renders, an edit reconciles
```

The full slice e2e uses the production build (`npm run build` + `npm run preview`);
see [docs/verify.md](docs/verify.md) for the exact recipe.

## More

- **[docs/architecture.md](docs/architecture.md)** — the design and the layers.
- **[docs/reactive-rails.md](docs/reactive-rails.md)** — the primitive proposal (local note).
- **[docs/verify.md](docs/verify.md)** — step-by-step: what to test and what you should see.
- **[docs/deploy.md](docs/deploy.md)** — the four-app Fly.io stack.

A POC built to demonstrate the thesis, not to deploy. Hardening items are listed
in `docs/architecture.md`.
