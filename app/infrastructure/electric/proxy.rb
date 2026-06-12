# frozen_string_literal: true

require "net/http"
require "openssl"

module Electric
  # Infrastructure layer. The upstream half of the authorizing proxy: takes a
  # server-derived ShapeDefinition plus the protocol's cursor params, attaches
  # the secret, performs the (possibly long-polling) GET against the private
  # Electric service, and returns the pieces the controller relays back.
  class Proxy
    # The sync protocol's pagination/liveness params. Everything else the
    # client sends is ignored: table, columns and where always come from the
    # server-side scope definition.
    PASSTHROUGH_PARAMS = %w[offset handle live cursor].freeze

    # Electric long-polls live requests for ~20s; leave headroom.
    OPEN_TIMEOUT = 5
    READ_TIMEOUT = 40

    # Upstream Electric can be briefly unreachable or slow (it restarts and
    # reconnects its replication periodically). Turn those into a retryable 503
    # rather than letting them surface as an uncaught 500; pglite-sync re-polls.
    UPSTREAM_ERRORS = [
      Net::OpenTimeout, Net::ReadTimeout, IOError, SocketError,
      SystemCallError, OpenSSL::SSL::SSLError
    ].freeze

    Result = Data.define(:status, :headers, :body)

    def initialize(config: Config.new)
      @config = config
    end

    def call(definition, passthrough)
      uri = URI.join(@config.url, "/v1/shape")
      query = definition.to_params
        .merge(passthrough.slice(*PASSTHROUGH_PARAMS))
      query[:secret] = @config.secret if @config.secret
      uri.query = URI.encode_www_form(query)

      response = Net::HTTP.start(
        uri.host, uri.port,
        use_ssl: uri.scheme == "https", open_timeout: OPEN_TIMEOUT, read_timeout: READ_TIMEOUT
      ) { |http| http.request(Net::HTTP::Get.new(uri)) }

      Result.new(
        status: response.code.to_i,
        headers: relay_headers(response),
        body: response.body.to_s
      )
    rescue *UPSTREAM_ERRORS => e
      Rails.logger.warn("Electric proxy upstream error: #{e.class}: #{e.message}")
      Result.new(status: 503, headers: {"content-type" => "text/plain", "retry-after" => "1"}, body: "")
    end

    private

    # The protocol metadata lives in electric-* headers (handle, offset,
    # schema, cursor, up-to-date); content-type and cache-control keep
    # responses parseable and CDN-able.
    def relay_headers(response)
      response.each_header.filter_map do |key, value|
        [key, value] if key.start_with?("electric-") || %w[content-type cache-control].include?(key)
      end.to_h
    end
  end
end
