# frozen_string_literal: true

module Cells
  # Domain layer query object. Column sums and the grand total over a sheet.
  # Each aggregate is offered two ways from one relation, so the server value and
  # the SQL the browser runs against its PGlite replica cannot drift: #by_column
  # / #grand_total execute the relation (Active Record), #watch_sql / #total_sql
  # are the same relations as strings the browser watches. Mirrors how GridWindow
  # pairs #values and #watch_sql.
  class ColumnAggregates < ApplicationQuery
    observable_by :sums, as: :sums_sql

    # The observable relation the Σ row watches: per-column sums, ordered by
    # column. #by_column executes it for the server render.
    def sums
      cells.group(:col).order(:col).select("col, SUM(value) AS total")
    end

    def by_column
      sums.each_with_object({}) { |row, out| out[row["col"].to_i] = decimal(row["total"]) }
    end

    # The grand total: a second observable read (the host-mode patch and the JSON
    # convergence check). COALESCE keeps an empty sheet at 0 rather than NULL.
    def grand_total_relation
      cells.select(Arel.sql("COALESCE(SUM(value), 0) AS total"))
    end

    def grand_total
      decimal(grand_total_relation.take["total"])
    end

    def total_sql
      grand_total_relation.to_sql
    end
  end
end
