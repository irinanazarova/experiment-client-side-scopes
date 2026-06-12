# frozen_string_literal: true

require "rails_helper"

RSpec.describe Cells::ColumnAggregates do
  let_it_be(:sheet) { create(:sheet) }
  let_it_be(:cells) do
    [
      create(:cell, sheet:, row: 1, col: 1, value: 10),
      create(:cell, sheet:, row: 2, col: 1, value: 5),
      create(:cell, sheet:, row: 1, col: 2, value: 100)
    ]
  end

  subject(:aggregates) { described_class.new(sheet) }

  it "sums per column, ordered by column" do
    expect(aggregates.by_column).to eq({1 => 15, 2 => 100})
  end

  it "sums the whole sheet" do
    expect(aggregates.grand_total).to eq(115)
  end

  it "ignores cells from other sheets" do
    create(:cell, sheet: create(:sheet), row: 1, col: 1, value: 999)
    expect(aggregates.grand_total).to eq(115)
  end

  # The *_sql methods are a contract the browser depends on (PGlite runs them
  # verbatim), so we pin their shape and that they execute and agree with the
  # server-side values above.
  describe "#sums_sql" do
    it "groups and orders by column, aliasing the sum as total, scoped to the sheet" do
      sql = aggregates.sums_sql
      expect(sql).to include("SUM(value) AS total")
      expect(sql).to match(/GROUP BY .*col/i)
      expect(sql).to match(/ORDER BY .*col/i)
      expect(sql).to include(%(sheet_id" = #{sheet.id}))
    end
  end

  describe "#total_sql" do
    it "coalesces the sum so an empty sheet returns 0, aliased total" do
      expect(aggregates.total_sql).to include("COALESCE(SUM(value), 0) AS total")
    end

    it "runs against Postgres and agrees with #grand_total" do
      rows = ActiveRecord::Base.connection.select_all(aggregates.total_sql)
      expect(rows.first["total"].to_i).to eq(aggregates.grand_total)
    end
  end
end
