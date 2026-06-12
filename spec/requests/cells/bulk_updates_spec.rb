# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Cells::BulkUpdates", type: :request do
  let_it_be(:sheet) { create(:sheet, row_count: 3, col_count: 3) }

  before { create(:cell, sheet:, row: 1, col: 1, value: 10) }

  def params(overrides = {})
    {sheet_id: sheet.id, row_from: 1, row_to: 3, col_from: 1, col_to: 1,
     operation: "multiply", operand: "2"}.merge(overrides)
  end

  it "applies the write and returns the updated count" do
    post cells_bulk_updates_path, params: params
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("updated" => 1)
    expect(Cell.find_by(sheet:, row: 1, col: 1).value).to eq(20)
  end

  it "returns 422 for an invalid (non-finite) operand" do
    post cells_bulk_updates_path, params: params(operand: "1e309")
    expect(response).to have_http_status(:unprocessable_content)
  end

  it "returns 403 when the policy denies the write" do
    allow_any_instance_of(SheetPolicy).to receive(:update?).and_return(false)
    post cells_bulk_updates_path, params: params
    expect(response).to have_http_status(:forbidden)
    expect(Cell.find_by(sheet:, row: 1, col: 1).value).to eq(10)
  end

  # The "Server rejects writes" demo toggle adds reject=1; the host authority
  # (any non-wasm env) refuses without applying, so the client rolls back.
  it "rejects the write when the demo reject flag is set" do
    post cells_bulk_updates_path, params: params(reject: "1")
    expect(response).to have_http_status(:forbidden)
    expect(Cell.find_by(sheet:, row: 1, col: 1).value).to eq(10)
  end

  # The in-browser slice (pwa/) posts here with a CSRF token minted by the
  # in-VM Rails, which this server cannot verify. The endpoint uses
  # null_session, so the write proceeds to the policy gate instead of dying
  # on token verification. This pins that contract.
  context "with forgery protection enabled (the PWA write path)" do
    around do |example|
      ActionController::Base.allow_forgery_protection = true
      example.run
    ensure
      ActionController::Base.allow_forgery_protection = false
    end

    it "accepts the write despite an unverifiable CSRF token" do
      post cells_bulk_updates_path, params: params, headers: {"X-CSRF-Token" => "from-another-session"}
      expect(response).to have_http_status(:ok)
      expect(Cell.find_by(sheet:, row: 1, col: 1).value).to eq(20)
    end
  end
end
