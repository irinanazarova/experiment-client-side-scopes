# frozen_string_literal: true

module Sheets
  # The server-push comparison route. A plain Hotwire spreadsheet: no PGlite, no
  # Electric. A write posts to Rails; on commit we publish a refresh to the
  # relation's stream, and every subscribed tab morphs. The consumer streams from
  # the whole sheet's cells (turbo_stream_from DataChange.topic(relation)), so any
  # change to them refreshes the page, and a morphing re-render keeps that fine.
  # Contrast with the local-first routes, which read from a client replica and
  # never round-trip.
  class HotwireController < ApplicationController
    protect_from_forgery with: :null_session

    # A value past the cell's numeric range should not 500 the write. The cell
    # endpoints answer 422 (the client reverts and flags it); the column-apply
    # form just re-renders unchanged.
    rescue_from ActiveRecord::RangeError do
      (action_name == "update") ? redirect_to(sheet_hotwire_path(@sheet)) : head(:unprocessable_content)
    end

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
      Turbo::StreamsChannel.broadcast_refresh_to(topic)
      redirect_to sheet_hotwire_path(@sheet)
    end

    # Inline cell edit: a single-cell "set", through the same authorized write
    # path as everything else. We answer 204 and let the refresh broadcast morph
    # the page, so the edit lands the same way a remote one does.
    def update_cell
      @sheet = Sheet.find(params[:sheet_id])
      row = Integer(params[:row])
      col = Integer(params[:col])
      region = Cells::Region.new(sheet_id: @sheet.id, row_from: row, row_to: row, col_from: col, col_to: col)
      transform = Cells::Transform.new(operation: :set, operand: params[:value])
      Cells::BulkUpdate.new(user: current_user, region:, transform:).call

      Turbo::StreamsChannel.broadcast_refresh_to(topic)
      head :no_content
    end

    # Simulate a server-originated write (the "server activity" of the other
    # demos): one random visible cell changes on the server, the page refreshes.
    # This is the server-push payoff, a change you did not make appears live.
    def tick
      @sheet = Sheet.find(params[:sheet_id])
      Cells::RandomTick.new(@sheet, user: current_user).call

      Turbo::StreamsChannel.broadcast_refresh_to(topic)
      head :no_content
    end

    private

    def cells_scope
      Cell.for_sheet(@sheet.id)
    end

    # The data topic both halves rendezvous on: the producer broadcasts to it,
    # the page subscribes via turbo_stream_from. Derived from the relation once,
    # so producer and subscriber cannot name different streams.
    def topic
      DataChange.topic(cells_scope)
    end

    def load_grid
      @topic = topic
      @stats = Cells::SheetStats.new(@sheet).compute
      @sums = Cells::ColumnAggregates.new(@sheet).by_column
      @values = Cells::GridWindow.new(@sheet).values
      @row_limit = Cells::GridWindow::DEFAULT_LIMIT
      # The cell's numeric range, derived from the column, so the client can
      # reject an out-of-range edit before it round-trips.
      value_column = Cell.columns_hash["value"]
      @max_value = 10**(value_column.precision - value_column.scale)
    end
  end
end
