# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Sheets", type: :request do
  let_it_be(:sheet) { create(:sheet) }

  before do
    create(:cell, sheet:, row: 1, col: 1, value: 10)
    create(:cell, sheet:, row: 2, col: 1, value: 5)
    create(:cell, sheet:, row: 1, col: 2, value: 100)
  end

  describe "GET /sheets/:id" do
    it "renders the spreadsheet shell with the client-side queries embedded" do
      get sheet_path(sheet)
      expect(response).to have_http_status(:ok)
      expect(response.body).to include("data-sums-sql")
      # one Turbo Frame holds the whole grid, watching the change signal
      expect(response.body).to include('<turbo-frame id="sheet-grid"')
      expect(response.body).to include("data-signal-sql")
    end
  end

  describe "GET /sheets/:id/grid" do
    it "re-renders the grid frame: stats, Σ row, Max column, cells (no layout)" do
      get grid_sheet_path(sheet)

      expect(response).to have_http_status(:ok)
      expect(response.body).to include('<turbo-frame id="sheet-grid"')
      expect(response.body).to include('id="sheet-stats"')
      expect(response.body).to include('id="stat-median"')
      expect(response.body).to include('class="ss-rowmax"')
      expect(response.body).to include('data-row="1" data-col="1"')
      # no layout: this is a morph target Turbo extracts
      expect(response.body).not_to include("<html")
    end
  end

  describe "GET /sheets/:id/aggregates" do
    it "returns the grand total and per-column sums" do
      get aggregates_sheet_path(sheet)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq(
        "grand_total" => "115.0",
        "by_column" => {"1" => "15.0", "2" => "100.0"}
      )
    end
  end
end
