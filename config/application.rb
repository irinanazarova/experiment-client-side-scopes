require_relative "boot"

require "wasmify/rails/shim"

require "rails"
# Pick the frameworks you want:
require "active_model/railtie"
require "active_job/railtie"
require "active_record/railtie"
# require "active_storage/engine"
require "action_controller/railtie"
# require "action_mailer/railtie"
# require "action_mailbox/engine"
# require "action_text/engine"
require "action_view/railtie"
# Host-only: the slice (RAILS_ENV=wasm) has no cable server, and loading the
# engine there risks the in-VM boot. The /hotwire comparison route needs it.
require "action_cable/engine" unless ENV["RAILS_ENV"] == "wasm"
# require "rails/test_unit/railtie"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module ClientSideScopes
  class Application < Rails::Application
    # Initialize configuration defaults for originally generated Rails version.
    config.load_defaults 8.1

    # Please, add to the `ignore` list any other `lib` subdirectories that do
    # not contain `.rb` files, or that should not be reloaded or eager loaded.
    # Common ones are `templates`, `generators`, or `middleware`, for example.
    config.autoload_lib(ignore: %w[assets tasks])

    # The slice (RAILS_ENV=wasm) does not load action_cable (no cable server, see
    # the require above), but app/channels/* subclass ActionCable::*::Base, so
    # eager-loading them there raises an uninitialized-constant NameError at boot.
    # Keep the directory out of the autoloader in the wasm build; the host loads
    # it normally for the /hotwire route.
    if ENV["RAILS_ENV"] == "wasm"
      Rails.autoloaders.main.ignore(Rails.root.join("app/channels"))
    end

    # Configuration for the application, engines, and railties goes here.
    #
    # These settings can be overridden in specific environments using the files
    # in config/environments, which are processed later.
    #
    # config.time_zone = "Central Time (US & Canada)"
    # config.eager_load_paths << Rails.root.join("extras")

    # Don't generate system test files.
    config.generators.system_tests = nil
  end
end
