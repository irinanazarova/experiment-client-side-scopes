Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check

  # aggregates: the Σ values as JSON; on the server a convergence check, in the
  # Wasm build the same action serves them from the in-browser replica.
  # grid: the ActionView fragment the slice page morphs in on replica changes.
  resources :sheets, only: [:show] do
    get :aggregates, on: :member
    get :grid, on: :member
    # Named reactive regions: a live-query fire re-fetches one of these and
    # morphs just its element. Served by the in-VM Rails in the slice build.
    resources :regions, only: [:show], module: :sheets
  end

  # Phase B: Ruby running in the browser (ruby.wasm) querying the local PGlite
  # replica through a connection seam. Proves the ruby.wasm <-> PGlite bridge.
  get "wasm" => "wasm#show"

  # Phase B+: the real activerecord gem packed into ruby.wasm, executing a query
  # against the PGlite replica through a pure-Ruby connection adapter.
  get "wasm_ar" => "wasm#ar"

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
