# frozen_string_literal: true

require "rails_helper"

RSpec.describe Electric::Proxy do
  let(:config) { instance_double(Electric::Config, url: "http://electric.test", secret: nil) }
  # Proxy#call receives a server-derived shape (Electric::ShapeDefinition), not a
  # ClientScope::Definition; the shape is what carries #to_params.
  let(:shape) do
    instance_double(
      Electric::ShapeDefinition,
      to_params: {table: "cells", columns: "id,sheet_id", where: "sheet_id = 1"}
    )
  end

  subject(:proxy) { described_class.new(config:) }

  it "relays Electric's status, body and protocol headers on success" do
    response = instance_double(Net::HTTPResponse, code: "200", body: '[{"control":"up-to-date"}]')
    # relay_headers calls each_header without a block (it chains .filter_map),
    # so return the pairs rather than yielding them.
    allow(response).to receive(:each_header).and_return([
      ["electric-handle", "h-1"],
      ["content-type", "application/json"],
      ["x-internal", "drop-me"]
    ])
    allow(Net::HTTP).to receive(:start).and_return(response)

    result = proxy.call(shape, {"offset" => "-1"})

    expect(result.status).to eq(200)
    expect(result.body).to eq('[{"control":"up-to-date"}]')
    expect(result.headers).to eq("electric-handle" => "h-1", "content-type" => "application/json")
  end

  # Upstream Electric reconnects its replication periodically; a blip must not
  # surface as a 500. The client (pglite-sync) re-polls on a 503.
  [Net::OpenTimeout, Net::ReadTimeout, Errno::ECONNREFUSED, SocketError].each do |error|
    it "returns a retryable 503 when upstream raises #{error}" do
      allow(Net::HTTP).to receive(:start).and_raise(error)

      result = proxy.call(shape, {})

      expect(result.status).to eq(503)
      expect(result.headers["retry-after"]).to eq("1")
      expect(result.body).to eq("")
    end
  end
end
