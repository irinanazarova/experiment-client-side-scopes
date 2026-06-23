# frozen_string_literal: true

# Presentation layer (thin). Renders the spreadsheet. The whole grid is one
# Turbo Frame; a local change signal reloads and morphs it. First paint is
# server-rendered from real data (host: server Postgres; Wasm build: the PGlite
# replica). Two routes share the frame and differ only in how it re-renders:
#   show   - precise local-first: the page reads its own PGlite replica and
#            morphs the frame's parts in the tab (zero network on the host).
#   coarse - coarse local-first: the frame reloads itself wholesale on a change.
class SheetsController < ApplicationController
  # In the in-browser build, bound the single-threaded Wasm VM's heap so
  # sustained reload activity can't trap it mid-render (see Wasm::HeapReclaimer).
  # Only the reload endpoints re-render repeatedly, and only the Wasm env pays.
  HEAP_RECLAIMER = Wasm::HeapReclaimer.new
  after_action(only: %i[grid coarse], if: -> { Rails.env.wasm? }) { HEAP_RECLAIMER.tick }

  def show
    @sheet = Sheet.find(params[:id])
    # The query objects whose watch SQL the page bakes into data- attributes
    # (the host's local live queries) and whose server value first paint renders.
    @column_aggregates = Cells::ColumnAggregates.new(@sheet)
    @sheet_stats = Cells::SheetStats.new(@sheet)
    assign_frame_ivars
  end

  # Coarse local-first. The frame watches one change signal (Cells::ChangeSignal,
  # DataChange.topic over the whole relation) and reloads itself on any write.
  # The reload IS the frame fetching this action again; on a frame request we
  # render the frame alone (no layout), and Turbo morphs it in.
  def coarse
    @sheet = Sheet.find(params[:id])
    assign_frame_ivars
    return unless turbo_frame_request?

    render_grid_frame(reload_url: coarse_sheet_path(@sheet))
  end

  # The grid frame, re-rendered on demand: the slice reload endpoint for the
  # precise route. In the Wasm build this action runs in the tab and reads the
  # replica, so a replica change becomes ActionView output morphed into the
  # frame. HTML over a zero-length wire.
  def grid
    @sheet = Sheet.find(params[:id])
    assign_frame_ivars
    render_grid_frame(reload_url: grid_sheet_path(@sheet))
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

  # The frame's locals: the change signal it watches plus the server values its
  # partials render. Shared by first paint and every reload.
  def assign_frame_ivars
    @signal = Cells::ChangeSignal.new(@sheet)
    @stats = Cells::SheetStats.new(@sheet).compute
    @sums = Cells::ColumnAggregates.new(@sheet).by_column
    @values = Cells::GridWindow.new(@sheet).values
    @row_limit = Cells::GridWindow::DEFAULT_LIMIT
  end

  def render_grid_frame(reload_url:)
    render partial: "sheets/grid_frame", layout: false, locals: {
      sheet: @sheet, signal: @signal, stats: @stats, sums: @sums,
      values: @values, row_limit: @row_limit, reload_url:
    }
  end
end
