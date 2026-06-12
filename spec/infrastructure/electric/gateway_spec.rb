# frozen_string_literal: true

require "rails_helper"

RSpec.describe Electric::Gateway do
  let(:definition) do
    Electric::ShapeDefinition.new(table: "cells", columns: %i[id value], where: {sheet_id: 1})
  end

  it "builds the shape config the client passes to pglite-sync" do
    config = Electric::Config.new(url: "http://electric.test")
    result = described_class.new(config:).shape_config(definition)

    expect(result).to eq(
      url: "http://electric.test/v1/shape",
      params: {table: "cells", columns: "id,value", where: "sheet_id = 1"}
    )
  end

  # The production posture: the client learns only the same-origin proxy URL
  # and the scope identity. Electric's address and the shape derivation stay
  # server-side.
  it "in proxied mode points the client at the authorizing proxy with only the scope identity" do
    config = Electric::Config.new(url: "http://electric.internal", proxied: true)
    result = described_class.new(config:).shape_config(
      definition, scope_name: :sheet_cells, scope_params: {sheet_id: 1}, base_url: "https://app.test"
    )

    expect(result).to eq(
      url: "https://app.test/electric/v1/shape",
      params: {scope: :sheet_cells, sheet_id: 1}
    )
  end

  it "reads the base URL from config (env-overridable via anyway_config)" do
    expect(Electric::Config.new.url).to eq("http://localhost:3010")
  end
end
