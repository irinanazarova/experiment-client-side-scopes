source "https://rubygems.org"

# Bundle edge Rails instead: gem "rails", github: "rails/rails", branch: "main"
gem "rails", "~> 8.1.3", group: [:default, :wasm]
# The modern asset pipeline for Rails [https://github.com/rails/propshaft]
gem "propshaft", group: [:default, :wasm]
# Use postgresql as the database for Active Record
gem "pg", "~> 1.1"
# Use the Puma web server [https://github.com/puma/puma]
gem "puma", ">= 5.0"
# Use JavaScript with ESM import maps [https://github.com/rails/importmap-rails]
gem "importmap-rails", group: [:default, :wasm]
# Hotwire's SPA-like page accelerator [https://turbo.hotwired.dev]
gem "turbo-rails", group: [:default, :wasm]
# Hotwire's modest JavaScript framework [https://stimulus.hotwired.dev]
gem "stimulus-rails", group: [:default, :wasm]
# Use Tailwind CSS [https://github.com/rails/tailwindcss-rails]
gem "tailwindcss-rails"

# Authorization as a first-class application-layer concern.
gem "action_policy", group: [:default, :wasm]
# Typed, multi-source configuration objects.
gem "anyway_config", "~> 2.0", group: [:default, :wasm]

# Package the app as a Wasm module (Rails-in-the-browser, Phase C).
gem "wasmify-rails", group: [:development, :wasm]
# HTML-aware ERB engine (Herb). Server-side only for now: it ships a native
# extension that we are not yet cross-compiling to wasm, so it stays out of the
# :wasm group (the in-VM Rails keeps Erubi). Routed in behind a flag; see
# config/initializers/reactionview.rb.
gem "reactionview"
# minitest >= 6 pulls the prism gem, whose C extension clashes with the baked-in
# prism under the wasi cross-compiler (same pin as wasm_build/Gemfile).
gem "minitest", "~> 5.25", group: [:default, :wasm]

# Use Active Model has_secure_password [https://guides.rubyonrails.org/active_model_basics.html#securepassword]
# gem "bcrypt", "~> 3.1.7"

# Windows does not include zoneinfo files, so bundle the tzinfo-data gem
# gem "tzinfo-data", platforms: %i[windows jruby]

# Reduces boot times through caching; required in config/boot.rb
gem "bootsnap", require: false

# Add HTTP asset caching/compression and X-Sendfile acceleration to Puma [https://github.com/basecamp/thruster/]
gem "thruster", require: false

group :development, :test do
  # See https://guides.rubyonrails.org/debugging_rails_applications.html#debugging-with-the-debug-gem
  gem "debug", platforms: %i[mri windows], require: "debug/prelude"

  # Audits gems for known security defects (use config/bundler-audit.yml to ignore issues)
  gem "bundler-audit", require: false

  # Test stack.
  gem "rspec-rails", "~> 7.0"
  gem "factory_bot_rails"
  gem "test-prof"
end

group :development do
  # Use console on exceptions pages [https://github.com/rails/web-console]
  gem "web-console"

  # Ruby style, Standard flavor (zero-config, opinionated).
  gem "standard", require: false
  gem "standard-rails", require: false
end

group :wasm do
  gem "tzinfo-data"
end
