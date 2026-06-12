# The Rails slice in the browser

A Vite PWA that boots the packed Rails app (`public/app.wasm`, built by
`bin/rails wasmify:pack`) inside a service worker and serves same-origin
requests from it. The in-browser Rails reads through the `pglite` adapter
from a local PGlite replica kept current by Electric; the slice bootstrap
(schema + authorized shape subscription) lives in `database.js`.

Based on the `wasmify:pwa` starter from
[wasmify-rails](https://github.com/palkan/wasmify-rails); the launcher
HTML/JS derives from Yuta Saito's
[Mastodon-in-the-browser](https://github.com/kateinoigakukun/mastodon/tree/katei/wasmify)
work. The JS runtime in `vendor/wasmify-rails/` is vendored from the gem's
`src/` at v0.4.1 because the npm package lags the gem; `@ruby/wasm-wasi` is
pinned to the same version as the `ruby_wasm` gem that builds the module
(the JS glue and the packed `js` gem must agree).

## Running locally

Prerequisites: the host stack from the repo root (`docker compose up -d`,
`bin/rails server`) must be running; the service worker fetches the
authorized Electric shape config from host Rails (proxied by Vite) and the
page then streams the slice from Electric directly.

```sh
npm install
npm run dev
```

Then open [http://localhost:5173/boot.html](http://localhost:5173/boot.html),
wait for "Service Worker Ready" (the first boot compiles a ~124 MB module),
and launch. `/sheets/1` and `/sheets/1/aggregates` are served by Rails
running in the tab, reading the Electric-synced replica.

## Debugging boot

A failed service worker install is silent (the worker just stays
"installing"). Open
[http://localhost:5173/debug.html](http://localhost:5173/debug.html): it
boots the identical stack in the page context with `DEBUG=1` and prints
every step, Ruby's stdout, and the backtrace of a boot failure.

## Caveats

- Writes go to the wire: the worker serves reads from the in-VM Rails and
  forwards every write to the host write authority (`/cells` is proxied by
  Vite in dev). Before forwarding, the worker runs the same request through
  the in-VM Rails as the optimistic apply (`Cells::BulkUpdate` against the
  replica) and restores its snapshot if the host rejects.
- The page is thin Hotwire: the worker broadcasts replica changes
  (`BroadcastChannel("cells-replica")`), and the page morphs in the grid
  fragment rendered by ActionView running in the tab.
- Use Chrome or another browser supporting the
  [CookieStore API](https://caniuse.com/?search=cookiestore).
