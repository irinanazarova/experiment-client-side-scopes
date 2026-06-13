# Client-side scopes (POC)

Let's run an experiment: achieve zero-latency UX on Rails. For true zero latency, we want to have a DB running in the browser, and soo all edits from user are applied first to this replica, rendered in UI (almost instantly, no network), and then propagated to server-side application. Also, updates from server are pushed to local app as authoritative. But does this mean that we have to duplicate a big chunk of Rails application logic in JS/TS for this to run in the browser? Data migrations, validations, domain modelling. Let's try another way: run Rails in the browser - on WebAssembly (via `wasmify-rails`). Sync data from server-side Postgres to our client-side pglite with ElectricSQL: one way sync only - pglite is a read replica of a subset of data (defined by the scope and auth policy). All writes go to local app and then to server-app the normal way (HTTP request to Rails). 

UI is Hotwire and rendered by Rails: local app needs a way of updating the UI upon pglite data updates. We had to "hack" this with "live regions" (an ERB partial bound to the SQL it depends on, re-rendered on a PGlite live-query change).

**The demo:** a 50,000-cell spreadsheet. Yellow-highlighting is for edits from our client. Green highlighting is for updates coming from server.

- **Rails in the browser:** https://client-side-scopes-slice.fly.dev
  A loader installs the in-browser Rails and drops you in. The spreadsheet is
  rendered by **Rails running in your tab** over a local Postgres replica.

Hit **Apply to whole column**: the column and its Σ update in ~15 ms with no
network, then the write lands on the server (one transaction) and Electric
reconciles every replica. Hit **Server activity** to watch changes stream
in from server-side.

Toggle **Server rejects writes** to see that scenario too. 

## What it proves

- **One Rails codebase, two databases.** The same controller and query objects
  serve `/sheets/1` from server Postgres and, packed into `app.wasm`, from the
  in-browser PGlite replica. `/sheets/1/aggregates` returns identical JSON either
  way.
- **Reads are local and instant.** Stats, the per-row Max column, and the Σ row
  (including a real `PERCENTILE_CONT` median) are computed by PGlite in the
  browser, with no request per aggregate.
- **The server stays the sole write authority.** A write applies optimistically
  in the browser, then goes to Rails as one transaction; Electric streams the
  authoritative rows back. A rejected write rolls back and the replica never
  diverges.

## Key elements

Two "slices": the **data** and the **code** that go to the device.

**The data slice, the client-side *scope*** (which rows/columns replicate):

| | |
|---|---|
| Declaration (start here) | [`app/models/cell.rb`](app/models/cell.rb): `client_scope :sheet_cells, ->(sheet_id){ for_sheet(sheet_id) }, ship: %i[row col value formula]` |
| The macro behind it | [`app/models/concerns/client_scopable.rb`](app/models/concerns/client_scopable.rb) |
| Registry + the shape seam | [`app/scopes/client_scope.rb`](app/scopes/client_scope.rb) |
| The Electric filter | [`app/infrastructure/electric/shape_definition.rb`](app/infrastructure/electric/shape_definition.rb) |
| Authorization | [`app/policies/sheet_policy.rb`](app/policies/sheet_policy.rb) (`sync?`) |

It reads like a scope plus one rider: **`ship:`** (the payload columns) is the
only explicit choice, the data that leaves the server. The `where`, the policy
subject, the params, and the pk/FK are derived.

**The code slice, the part of Rails packed into `app.wasm`:**
[`config/wasmify.yml`](config/wasmify.yml) (dirs + gem exclusions) and the
`:wasm` bundler group in the [`Gemfile`](Gemfile); booted by
[`pwa/rails.sw.js`](pwa/rails.sw.js). The rest of `app/` is plain layered Rails
(`queries/`, `services/`, `live_regions/`, `policies/`, `infrastructure/`).

## Run it locally

```bash
docker compose up -d            # Postgres (wal_level=logical) + Electric
bin/rails db:prepare db:seed    # schema + ~50k cells
bin/rails server                # http://localhost:3000/sheets/1
```

The slice (Rails in the browser):

```bash
bin/rails slice:pack            # pack app.wasm (~52 MB; slow first time) — never wasmify:pack (leaks secrets)
cd pwa && npm install && npm run dev   # http://localhost:5173
```

## Tests

```bash
bin/rails db:test:prepare
bundle exec rspec               # 83 examples
bundle exec standardrb
```

## More

- **[docs/architecture.md](docs/architecture.md)** — the design and the layers.
- **[docs/verify.md](docs/verify.md)** — step-by-step: what to test and what you
  should see (with verification commands).
- **[docs/deploy.md](docs/deploy.md)** — the four-app Fly.io stack.

A POC built to demonstrate the thesis, not to deploy. Hardening items are listed
in `docs/architecture.md`.
