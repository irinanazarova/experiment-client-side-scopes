# frozen_string_literal: true

require_relative "production"

Rails.application.configure do
  config.enable_reloading = false

  config.assume_ssl = false
  config.force_ssl  = false

  # FIXME: Tags are not being reset right now
  config.log_tags = []

  if ENV["DEBUG"] == "1"
    config.consider_all_requests_local = true
    config.action_dispatch.show_exceptions = :none
    config.log_level = :debug
    config.logger = Logger.new($stdout)
  end

  config.cache_store = :memory_store
  config.active_job.queue_adapter = :inline

  # The slice's /public JS modules (sheet.mjs, flow.mjs, ...) are referenced
  # without a content digest, so production's inherited 1-year immutable cache
  # would let the service worker pin a stale copy across deploys (new HTML, old
  # JS). Revalidate instead, so a redeploy reaches installed clients.
  config.public_file_server.headers = {"cache-control" => "no-cache"}

  # This app does not load action_mailer (see config/application.rb).
  if config.respond_to?(:action_mailer)
    config.action_mailer.delivery_method = :null
  end

  if config.respond_to?(:active_storage)
    config.active_storage.variant_processor = :null
  end

  # The in-browser Rails is PUBLIC: app.wasm is downloadable, so it must never
  # need or contain the master key. It has no real sessions, so we set a fixed,
  # non-secret secret_key_base and skip the master-key requirement; the
  # `slice:pack` task strips config/master.key + credentials from the module
  # (wasmify maps all of config/ in, see lib/tasks/slice.rake).
  config.require_master_key = false
  config.secret_key_base = "wasm-secret"
  # Use a different session cookie name to avoid conflicts
  config.session_store :cookie_store, key: "_local_session"
end
