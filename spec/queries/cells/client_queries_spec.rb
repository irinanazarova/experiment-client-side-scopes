# frozen_string_literal: true

require "rails_helper"

# These SQL strings are a contract the browser depends on (PGlite runs them
# verbatim), so we pin their shape.
RSpec.describe Cells::ClientQueries do
  let_it_be(:sheet) { create(:sheet) }

  subject(:queries) { described_class.new(sheet) }

  describe "#column_sums_sql" do
    it "groups and orders by column and aliases the sum as total" do
      sql = queries.column_sums_sql
      expect(sql).to include("SUM(value) AS total")
      expect(sql).to match(/GROUP BY .*col/i)
      expect(sql).to match(/ORDER BY .*col/i)
    end

    it "is scoped to the sheet" do
      expect(queries.column_sums_sql).to include("sheet_id\" = #{sheet.id}")
    end
  end

  describe "#grand_total_sql" do
    it "coalesces the sum so an empty sheet returns 0, aliased total" do
      expect(queries.grand_total_sql).to include("COALESCE(SUM(value), 0) AS total")
    end
  end

  describe "#stats_sql" do
    it "selects the four header statistics, aliased" do
      sql = queries.stats_sql
      expect(sql).to include("MAX(value) AS max", "MIN(value) AS min", "AVG(value) AS avg")
      expect(sql).to include("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value) AS median")
    end
  end

  it "produces SQL that actually runs (executes against Postgres)" do
    create(:cell, sheet:, row: 1, col: 1, value: 42)
    rows = ActiveRecord::Base.connection.select_all(queries.grand_total_sql)
    expect(rows.first["total"].to_i).to eq(42)

    stats = ActiveRecord::Base.connection.select_all(queries.stats_sql).first
    expect(stats["median"].to_f).to eq(42.0)
  end
end
