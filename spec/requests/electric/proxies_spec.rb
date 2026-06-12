# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Electric::Proxies", type: :request do
  let_it_be(:sheet) { create(:sheet) }

  let(:upstream) do
    Electric::Proxy::Result.new(
      status: 200,
      headers: {"electric-handle" => "h-1", "content-type" => "application/json"},
      body: '[{"headers":{"control":"up-to-date"}}]'
    )
  end
  let(:proxy) { instance_double(Electric::Proxy) }

  before do
    allow(Electric::Proxy).to receive(:new).and_return(proxy)
    allow(proxy).to receive(:call) do |definition, passthrough|
      @forwarded_definition = definition
      @forwarded_passthrough = passthrough
      upstream
    end
  end

  it "authorizes, derives the shape server-side and relays Electric's reply" do
    get "/electric/v1/shape", params: {scope: "sheet_cells", sheet_id: sheet.id, offset: "-1", live: "true"}

    expect(response).to have_http_status(:ok)
    expect(response.headers["electric-handle"]).to eq("h-1")
    expect(response.body).to eq('[{"headers":{"control":"up-to-date"}}]')

    expect(@forwarded_definition.to_params).to eq(
      table: "cells",
      columns: "id,sheet_id,row,col,value,formula",
      where: "sheet_id = #{sheet.id}"
    )
    expect(@forwarded_passthrough).to include("offset" => "-1", "live" => "true")
  end

  # The trust boundary: a client cannot widen the slice. Whatever table,
  # columns or where it sends, the forwarded shape is the registered scope's.
  it "ignores client-supplied shape params" do
    get "/electric/v1/shape", params: {
      scope: "sheet_cells", sheet_id: sheet.id, offset: "-1",
      table: "users", columns: "id,password_digest", where: "1=1"
    }

    expect(response).to have_http_status(:ok)
    expect(@forwarded_definition.to_params).to eq(
      table: "cells",
      columns: "id,sheet_id,row,col,value,formula",
      where: "sheet_id = #{sheet.id}"
    )
  end

  it "returns 404 for an unknown scope" do
    get "/electric/v1/shape", params: {scope: "nope", sheet_id: sheet.id}
    expect(response).to have_http_status(:not_found)
  end

  it "returns 403 when the policy denies the subscription" do
    allow_any_instance_of(SheetPolicy).to receive(:sync?).and_return(false)
    get "/electric/v1/shape", params: {scope: "sheet_cells", sheet_id: sheet.id}
    expect(response).to have_http_status(:forbidden)
  end
end
