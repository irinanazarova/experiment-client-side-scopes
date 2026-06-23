# frozen_string_literal: true

# Presentation layer (thin). Renders the spreadsheet. The first paint is
# server-rendered from real data (host: server Postgres; Wasm build: the
# PGlite replica); after that, the grid and aggregates are read locally in
# the browser.
class SheetsController < ApplicationController
  def show
    @sheet = Sheet.find(params[:id])
    # The SQL the browser watches as PGlite live queries (the page bakes these
    # into data- attributes); each query object pairs it with the server value.
    @column_aggregates = Cells::ColumnAggregates.new(@sheet)
    @sheet_stats = Cells::SheetStats.new(@sheet)
    @grid = grid_locals(@sheet)
  end

  # The coarse local-first variant. One Turbo Frame holds the whole grid; the
  # page watches a single change signal (Cells::ChangeSignal, DataChange.topic
  # over the whole relation) as a local live query and reloads the frame when it
  # fires. The reload reads server Postgres on the host and the in-browser
  # replica in the slice build: same frame, same endpoint, the data source is
  # the only thing that changes. The reload IS the frame fetching this very
  # action again (Turbo extracts the matching frame from the response).
  def coarse
    @sheet = Sheet.find(params[:id])
    @signal = Cells::ChangeSignal.new(@sheet)
    @stats = Cells::SheetStats.new(@sheet).compute
    @sums = Cells::ColumnAggregates.new(@sheet).by_column
    @values = Cells::GridWindow.new(@sheet).values

    # A reload only needs the frame, so render it alone (no layout, no page
    # chrome): Turbo extracts the matching frame from the response either way.
    # The aggregates still re-run on every change, which is the coarse strategy's
    # cost, made plain in the route's latency readout.
    return unless turbo_frame_request?

    render partial: "sheets/coarse_grid", locals: {
      sheet: @sheet, signal: @signal, stats: @stats, sums: @sums,
      values: @values, row_limit: Cells::GridWindow::DEFAULT_LIMIT
    }
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
    {sheet:, row_limit: Cells::GridWindow::DEFAULT_LIMIT}
  end
end
