# frozen_string_literal: true

# Spike: route ActionView's .html.erb through Herb (ReActionView) instead of
# Erubi. Off by default; flip with REACTIONVIEW_ERB=1 so we can A/B the
# rendered output and the suite. Guarded on the constant because the gem is
# server-side only (not in the :wasm bundle), so this file is a no-op in the
# in-VM Rails.
if defined?(ReActionView)
  ReActionView.configure do |config|
    config.intercept_erb = ENV["REACTIONVIEW_ERB"] == "1"
    config.debug_mode = false # avoids the dev-tools JS assets; pure rendering
  end
end
