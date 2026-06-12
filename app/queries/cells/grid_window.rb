# frozen_string_literal: true

module Cells
  # Domain layer query object. The visible slice of the grid (the first N rows;
  # a real sheet virtualizes the rest). One object owns both halves so the
  # live-query trigger and the rendered data come from the same source:
  #   - #sql    the AR-generated query the browser watches (its result set
  #             changing is exactly when the visible grid is stale)
  #   - #values the same rows shaped for rendering ({row => {col => value}})
  class GridWindow
    def initialize(sheet, limit)
      @sheet = sheet
      @limit = limit
    end

    def sql
      relation.select(:row, :col, :value).to_sql
    end

    def values
      relation.pluck(:row, :col, :value).each_with_object({}) do |(row, col, value), out|
        (out[row] ||= {})[col] = value
      end
    end

    private

    def relation
      Cell.for_sheet(@sheet.id).where(row: 1..@limit).order(:row, :col)
    end
  end
end
