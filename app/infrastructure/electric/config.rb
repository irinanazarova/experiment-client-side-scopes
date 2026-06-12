# frozen_string_literal: true

module Electric
  # Infrastructure layer. Typed configuration for the Electric sync service.
  # Sources (in order): ENV (ELECTRIC_URL, ELECTRIC_INSECURE, ELECTRIC_PROXIED,
  # ELECTRIC_SECRET), config/electric.yml, credentials.
  #
  # Two postures:
  # - insecure (local POC): Electric runs open and the browser hits it
  #   directly; Rails only authorizes issuing the shape config.
  # - proxied (production): Electric stays private behind ELECTRIC_SECRET and
  #   the browser fetches shapes same-origin through Electric::ProxiesController,
  #   which re-authorizes, derives the shape server-side and signs upstream.
  class Config < Anyway::Config
    config_name :electric

    attr_config(
      url: "http://localhost:3010",
      insecure: true,
      proxied: false,
      secret: nil
    )

    coerce_types insecure: :boolean, proxied: :boolean
  end
end
