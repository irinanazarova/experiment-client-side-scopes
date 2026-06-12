# frozen_string_literal: true

module Cells
  # The SQL the browser runs against its PGlite replica. Built by Active Record
  # so the client executes AR's own SQL, not hand-written queries: this is how
  # "you write Active Record, it runs locally" holds. PGlite is real Postgres,
  # so the generated quoting and grouping run as-is, and a PGlite live query
  # re-fires these strings whenever a cell changes.
  class ClientQueries
    def initialize(sheet)
      @sheet = sheet
    end

    def column_sums_sql
      relation.group(:col).order(:col).select("col, SUM(value) AS total").to_sql
    end

    def grand_total_sql
      relation.select("COALESCE(SUM(value), 0) AS total").to_sql
    end

    # The header stats (max/min/avg/median). PERCENTILE_CONT is an ordered-set
    # aggregate; PGlite runs it locally because it is real Postgres.
    def stats_sql
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
