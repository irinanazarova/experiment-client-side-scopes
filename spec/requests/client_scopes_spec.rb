# frozen_string_literal: true

require "rails_helper"

RSpec.describe "ClientScopes", type: :request do
  let_it_be(:sheet) { create(:sheet) }

  it "returns the authorized Electric shape config for a named scope" do
    get client_scope_path("sheet_cells", sheet_id: sheet.id)

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq(
      "url" => "http://localhost:3010/v1/shape",
      "params" => {
        "table" => "cells",
        "columns" => "id,sheet_id,row,col,value,formula",
        "where" => "sheet_id = #{sheet.id}"
      }
    )
  end

  it "returns 404 for an unknown scope name" do
    get client_scope_path("nope", sheet_id: sheet.id)
    expect(response).to have_http_status(:not_found)
  end

  it "returns 403 when the policy denies the subscription" do
    allow_any_instance_of(SheetPolicy).to receive(:sync?).and_return(false)
    get client_scope_path("sheet_cells", sheet_id: sheet.id)
    expect(response).to have_http_status(:forbidden)
  end
end
