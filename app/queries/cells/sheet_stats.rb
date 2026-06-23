# frozen_string_literal: true

module Cells
  # Domain layer query object. Whole-sheet statistics for the header panel: the
  # demo's "every dependent aggregate resettles instantly" claim, beyond sums.
  # One aggregate relation is both computed (#compute) and watched (#watch_sql),
  # so the server value and the browser's live query cannot drift.
  #
  # The projection is authored as SQL because the median is PERCENTILE_CONT, an
  # ordered-set aggregate with no Active Record / Arel expression. That is the
  # one place SQL is written by hand; PGlite, being real Postgres, computes it
  # locally exactly like the server.
  class SheetStats < ApplicationQuery
    Stats = Data.define(:max, :min, :avg, :median)

    observable_by :summary

    # The observable relation: the four header statistics as one aggregate row.
    def summary
      cells.select(
        "MAX(value) AS max, MIN(value) AS min, AVG(value) AS avg, " \
        "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value) AS median"
      )
    end

    def compute
      row = summary.take
      Stats.new(
        max: decimal(row["max"]),
        min: decimal(row["min"]),
        avg: decimal(row["avg"]),
        median: row["median"]&.to_f
      )
    end
  end
end
