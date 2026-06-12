# frozen_string_literal: true

module Cells
  # Domain layer query object. Column sums and the grand total over a sheet.
  # Each aggregate is offered two ways from the same relation, so the server's
  # value and the SQL the browser runs against its PGlite replica can never
  # drift: #by_column / #grand_total execute here (Active Record), #sums_sql /
  # #total_sql are the same queries as strings PGlite runs verbatim (it is real
  # Postgres, so AR's generated SQL runs as-is). Mirrors how GridWindow pairs
  # #values and #sql.
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

    # The same per-column sums as SQL for the browser to watch as a live query.
    def sums_sql
      relation.group(:col).order(:col).select("col, SUM(value) AS total").to_sql
    end

    # The grand total as SQL; COALESCE so an empty sheet returns 0, not NULL.
    def total_sql
      relation.select("COALESCE(SUM(value), 0) AS total").to_sql
    end

    private

    def relation
      Cell.for_sheet(@sheet.id)
    end
  end
end
