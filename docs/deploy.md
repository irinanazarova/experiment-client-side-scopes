# Cloud deploy (Fly.io)

Live:
- **Standalone** (server Rails + browser PGlite): https://client-side-scopes.fly.dev/sheets/1
- **The slice, Rails in the browser**: https://client-side-scopes-slice.fly.dev
  Just open it: a loading screen installs the in-browser Rails and drops you
  into the app (no launch step). The first visit downloads the ~125 MB
  `app.wasm`; after that it opens instantly (the service worker serves `/`
  from the in-VM Rails). `/boot.html` is a diagnostics launcher.

Four apps: `client-side-scopes` (Rails, public), `client-side-scopes-slice`
(Caddy serving the built PWA + `app.wasm`, proxying the API paths to the host),
`client-side-scopes-electric` (Electric, secret-gated), and
`client-side-scopes-db` (Postgres, `wal_level=logical`).

## The slice

The slice has its own origin so its service worker can own `/sheets/*` and
serve them from the in-VM Rails; Caddy proxies `/client_scopes`, `/cells` and
`/electric` to the host Rails so the browser stays same-origin (the production
equivalent of the Vite dev proxy). Build + deploy:

```bash
bin/rails wasmify:pack                         # pack the app into app.wasm
cd pwa && npm run build                        # dist/ incl. app.wasm
rm -rf infra/slice/dist && cp -r pwa/dist infra/slice/dist   # into the Caddy build context
cd infra/slice && fly deploy                   # MUST cd in; the root .dockerignore excludes dist/
```

## The host stack

In the cloud the browser never talks to Electric: shapes long-poll same-origin
through the authorizing proxy (`Electric::ProxiesController`), which
re-authorizes each poll, derives the shape server-side and signs upstream.
Locally nothing changes (`ELECTRIC_PROXIED` defaults to false; the browser hits
the open Electric directly).

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
sees the green blinks. Nothing runs server-side when no one is watching.
(`bin/rails cells:simulate` is still there for a headless writer.)

## Notes from deploying this on Fly (each cost a debugging cycle)

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
- **Build context for the slice:** run `fly deploy` from inside `infra/slice`,
  not the repo root, or the root `.dockerignore` excludes `dist/` and the
  `COPY dist` step fails.
