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

    private

    def relation
      Cell.for_sheet(@sheet.id)
    end
  end
end
