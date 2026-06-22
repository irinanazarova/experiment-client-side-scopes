# frozen_string_literal: true

module Cells
  # Domain layer query object. The visible slice of the grid (the first N rows;
  # a real sheet virtualizes the rest). One relation is both rendered and
  # watched: #values shapes it for ActionView, #watch_sql (its #to_sql) is the
  # live query whose result set changing is exactly when the visible grid is
  # stale. The relation is plain Active Record, so there is no SQL to keep in
  # sync with the render.
  class GridWindow < ApplicationQuery
    # The rendered window; a real sheet virtualizes the rest. Matches the server
    # simulator's tick window (Cells::RandomTick) so every rendered row is
    # "live", and keeps the rows fragment cheap enough for the in-VM ActionView
    # render to keep up with once-a-second updates.
    DEFAULT_LIMIT = 25

    observable_by :window
    alias_method :sql, :watch_sql

    def initialize(sheet, limit = DEFAULT_LIMIT)
      super(sheet)
      @limit = limit
    end

    # The observable relation: the visible window, projected to the rendered
    # columns.
    def window
      cells.where(row: 1..@limit).order(:row, :col).select(:row, :col, :value)
    end

    # The same rows shaped for the partial: { row => { col => value } }.
    def values
      window.pluck(:row, :col, :value).each_with_object({}) do |(row, col, value), out|
        (out[row] ||= {})[col] = value
      end
    end
  end
end
