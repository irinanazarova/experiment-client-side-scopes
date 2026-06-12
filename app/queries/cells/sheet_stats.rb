# frozen_string_literal: true

module Cells
  # Domain layer query object. Whole-sheet statistics for the header panel:
  # the demo's "every dependent aggregate resettles instantly" claim, beyond
  # sums. Median exercises an ordered-set aggregate (PERCENTILE_CONT), which
  # PGlite, being real Postgres, computes locally exactly like the server.
  class SheetStats
    Stats = Data.define(:max, :min, :avg, :median)

    def initialize(sheet)
      @sheet = sheet
    end

    def compute
      max, min, avg, median = relation.pick(
        Arel.sql("MAX(value)"),
        Arel.sql("MIN(value)"),
        Arel.sql("AVG(value)"),
        Arel.sql("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value)")
      )
      Stats.new(max:, min:, avg:, median:)
    end

    # The same four statistics as SQL for the browser to run against PGlite as a
    # live query (the counterpart to #compute, kept in one object so they cannot
    # drift). PERCENTILE_CONT is an ordered-set aggregate PGlite runs locally.
    def sql
      relation.select(
        "MAX(value) AS max, MIN(value) AS min, AVG(value) AS avg, " \
        "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value) AS median"
      ).to_sql
    end

    private

    def relation
      Cell.for_sheet(@sheet.id)
    end
  end
end
