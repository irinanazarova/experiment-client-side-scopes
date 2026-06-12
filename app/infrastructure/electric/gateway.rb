# frozen_string_literal: true

module Electric
  # Infrastructure layer. Builds the config the browser needs to subscribe to
  # a Shape. This is the seam between the two postures:
  #
  # - insecure (local POC): hand the client Electric's own URL plus the
  #   derived shape params; the client talks to Electric directly.
  # - proxied (production): hand the client a same-origin URL into
  #   Electric::ProxiesController plus only the scope name and its declared
  #   params. The shape itself is re-derived and signed server-side on every
  #   poll; the client never learns Electric's address or the secret.
  class Gateway
    def initialize(config: Config.new)
      @config = config
    end

    # definition: a ShapeDefinition. scope_name/scope_params identify the
    # registered ClientScope for the proxied posture; base_url is the
    # requesting app's origin. Returns a plain hash the front end passes
    # straight into @electric-sql/pglite-sync's syncShapeToTable.
    def shape_config(definition, scope_name: nil, scope_params: {}, base_url: nil)
      if @config.proxied
        {
          url: "#{base_url}/electric/v1/shape",
          params: {scope: scope_name, **scope_params}
        }
      else
        {
          url: "#{@config.url}/v1/shape",
          params: definition.to_params
        }
      end
    end
  end
end
