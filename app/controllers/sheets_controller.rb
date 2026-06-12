# frozen_string_literal: true

# Presentation layer (thin). Renders the spreadsheet. The first paint is
# server-rendered from real data (host: server Postgres; Wasm build: the
# PGlite replica); after that, the grid and aggregates are read locally in
# the browser.
class SheetsController < ApplicationController
  # The rendered window; a real sheet virtualizes the rest. Matches the server
  # simulator's tick window (Cells::RandomTick) so every rendered row is "live"
  # and the rows fragment stays cheap enough for the in-VM ActionView render to
  # keep up with once-a-second updates.
  GRID_ROW_LIMIT = 25

  def show
    @sheet = Sheet.find(params[:id])
    @client_queries = Cells::ClientQueries.new(@sheet)
    @grid = grid_locals(@sheet)
  end

  # The grid fragment: the same partial the first paint uses, re-rendered on
  # demand. In the Wasm build this action runs in the tab, so a replica
  # change becomes ActionView output morphed into the DOM. HTML over a
  # zero-length wire.
  def grid
    sheet = Sheet.find(params[:id])
    render partial: "sheets/grid", locals: grid_locals(sheet), layout: false
  end

  # The aggregates the Σ row mirrors, as JSON. On the server this verifies
  # convergence; in the Wasm build the same action runs inside the browser and
  # the query object reads the PGlite replica instead. One action, two
  # databases, no extra code.
  def aggregates
    sheet = Sheet.find(params[:id])
    aggregates = Cells::ColumnAggregates.new(sheet)
    render json: {grand_total: aggregates.grand_total, by_column: aggregates.by_column}
  end

  private

  # _grid is just the shell now; each region partial builds its own data
  # through LiveRegion, so the same render serves first paint and re-render.
  def grid_locals(sheet)
    {sheet:, row_limit: GRID_ROW_LIMIT}
  end
end
