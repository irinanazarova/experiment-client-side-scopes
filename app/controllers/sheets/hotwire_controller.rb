# frozen_string_literal: true

module Sheets
  # The coarse, server-push comparison route. A plain Hotwire spreadsheet: no
  # PGlite, no Electric. A write posts to Rails; on commit we publish a refresh
  # to the data-change topic, and every subscribed tab morphs. The consumer is a
  # Turbo Stream subscription to DataChange.topic(relation); the trigger is
  # coarse (any cell change in the sheet wakes the page) and a morphing refresh
  # keeps that affordable. Contrast with the local-first routes, which read from
  # a client replica and never round-trip.
  class HotwireController < ApplicationController
    protect_from_forgery with: :null_session

    def show
      @sheet = Sheet.find(params[:sheet_id])
      load_grid
    end

    def update
      @sheet = Sheet.find(params[:sheet_id])
      column = Integer(params[:column])
      region = Cells::Region.new(
        sheet_id: @sheet.id,
        row_from: 1, row_to: @sheet.row_count,
        col_from: column, col_to: column
      )
      transform = Cells::Transform.new(operation: params[:operation].to_sym, operand: params[:operand])
      Cells::BulkUpdate.new(user: current_user, region:, transform:).call

      # The whole new surface on the producer side: announce that this slice
      # changed. broadcast_refresh_to is Turbo 8's content-free refresh, so the
      # producer names no partial and no DOM id, only the data topic.
      Turbo::StreamsChannel.broadcast_refresh_to(DataChange.topic(cells_scope))
      redirect_to sheet_hotwire_path(@sheet)
    end

    private

    def cells_scope
      Cell.for_sheet(@sheet.id)
    end

    def load_grid
      @stats = Cells::SheetStats.new(@sheet).compute
      @sums = Cells::ColumnAggregates.new(@sheet).by_column
      @values = Cells::GridWindow.new(@sheet).values
      @row_limit = Cells::GridWindow::DEFAULT_LIMIT
    end
  end
end
