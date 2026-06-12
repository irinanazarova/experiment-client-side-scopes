# frozen_string_literal: true

module Cells
  # Domain layer query object. The server-side executed aggregates over a sheet
  # (the counterpart to the SQL the client runs locally, see Cells::ClientQueries).
  class ColumnAggregates
    def initialize(sheet)
      @sheet = sheet
    end

    # { col => sum }, ordered by column.
    def by_column
      relation.group(:col).order(:col).sum(:value)
    end

    def grand_total
      relation.sum(:value)
    end

    private

    def relation
      Cell.for_sheet(@sheet.id)
    end
  end
end
