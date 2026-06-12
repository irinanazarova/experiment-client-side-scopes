# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Sheets::Regions", type: :request do
  let_it_be(:sheet) { create(:sheet) }

  before do
    create(:cell, sheet:, row: 1, col: 1, value: 10)
    create(:cell, sheet:, row: 1, col: 2, value: 100)
  end

  it "re-renders the stats region fragment (no layout)" do
    get sheet_region_path(sheet, :stats)
    expect(response).to have_http_status(:ok)
    expect(response.body).to include('id="stat-median"')
    expect(response.body).not_to include("<html")
  end

  it "re-renders the totals region fragment" do
    get sheet_region_path(sheet, :totals)
    expect(response).to have_http_status(:ok)
    expect(response.body).to include('class="ss-totals"')
  end

  it "re-renders the rows region fragment" do
    get sheet_region_path(sheet, :rows)
    expect(response).to have_http_status(:ok)
    expect(response.body).to include('data-row="1" data-col="1"')
  end

  it "404s for an unknown region" do
    get sheet_region_path(sheet, :nope)
    expect(response).to have_http_status(:not_found)
  end

  it "403s when the policy denies syncing the slice" do
    allow_any_instance_of(SheetPolicy).to receive(:sync?).and_return(false)
    get sheet_region_path(sheet, :stats)
    expect(response).to have_http_status(:forbidden)
  end
end
