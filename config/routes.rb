Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check

  # aggregates: the Σ values as JSON; on the server a convergence check, in the
  # Wasm build the same action serves them from the in-browser replica.
  # grid: the ActionView fragment the slice page morphs in on replica changes.
  resources :sheets, only: [:show] do
    get :aggregates, on: :member
    get :grid, on: :member
    # The coarse local-first variant: the whole grid in one Turbo Frame,
    # reloaded when a single local change signal (DataChange.topic over the whole
    # relation) fires. The "as simple as Hotwire" receiver: a stock turbo-frame
    # and one trigger. Compare with /hotwire (same whole-grid reload, pushed from
    # the server) and the precise route (per-fragment live regions).
    get :coarse, on: :member
    # Named reactive regions: a live-query fire re-fetches one of these and
    # morphs just its element. Served by the in-VM Rails in the slice build.
    resources :regions, only: [:show], module: :sheets
  end

  # Phase B / B+ demos: Ruby in the browser (ruby.wasm) querying the local
  # PGlite replica. /wasm proves the ruby.wasm <-> PGlite bridge; /wasm_ar runs
  # the real activerecord gem in the VM through a pure-Ruby connection adapter.
  #
  # Host-only: both pages fetch /ruby-app.wasm and the demo scripts, which
  # slice:pack stashes out of the slice (they would otherwise add ~7 MB brotli
  # for a demo the slice never uses). Skipping the routes under RAILS_ENV=wasm
  # makes the slice return a clean 404 instead of rendering a page that 500s on
  # the missing assets.
  unless Rails.env.wasm?
    # Action Cable carries the Turbo refresh broadcasts for /hotwire. Mounted
    # explicitly (host-only; the slice has no cable server) because the engine is
    # required conditionally, so the railtie does not auto-mount it.
    mount ActionCable.server => "/cable"

    get "wasm" => "wasm#show"
    get "wasm_ar" => "wasm#ar"

    # Comparison route: the coarse, server-push (plain Hotwire) spreadsheet.
    # Host-only; it needs Action Cable, which the slice does not load.
    get "sheets/:sheet_id/hotwire" => "sheets/hotwire#show", as: :sheet_hotwire
    post "sheets/:sheet_id/hotwire" => "sheets/hotwire#update"
    post "sheets/:sheet_id/hotwire/cell" => "sheets/hotwire#update_cell", as: :sheet_hotwire_cell
    post "sheets/:sheet_id/hotwire/tick" => "sheets/hotwire#tick", as: :sheet_hotwire_tick
  end

  # The browser asks for a named client-side scope -> gets an Electric Shape config.
  resources :client_scopes, only: [:show]

  # Production posture: the authorizing proxy in front of a private Electric.
  # Mirrors Electric's /v1/shape path so pglite-sync needs no special casing.
  get "electric/v1/shape" => "electric/proxies#shape"

  # The one write path: a bulk edit is one server transaction.
  # ticks: one simulated server write, driven by the UI's "Server activity"
  # toggle (under /cells so the slice's proxy forwards it to the host).
  namespace :cells do
    resources :bulk_updates, only: [:create]
    resources :ticks, only: [:create]
  end

  root "sheets#show", defaults: { id: "1" }
end
