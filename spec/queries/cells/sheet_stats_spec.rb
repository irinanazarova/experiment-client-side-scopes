# frozen_string_literal: true

require "rails_helper"

RSpec.describe Cells::SheetStats do
  let_it_be(:sheet) { create(:sheet) }

  before do
    [10, 20, 70].each_with_index do |value, i|
      create(:cell, sheet:, row: 1, col: i + 1, value:)
    end
    create(:cell, sheet: create(:sheet), row: 1, col: 1, value: 9_999)
  end

  subject(:stats) { described_class.new(sheet).compute }

  it "computes max, min, avg and median over exactly this sheet" do
    expect(stats.max).to eq(70)
    expect(stats.min).to eq(10)
    expect(stats.avg).to be_within(0.01).of(33.33)
    expect(stats.median).to eq(20)
  end

  # #sql is a contract the browser depends on (PGlite runs it verbatim): same
  # four statistics as #compute, as a string.
  describe "#sql" do
    subject(:sql) { described_class.new(sheet).sql }

    it "selects the four header statistics, aliased" do
      expect(sql).to include("MAX(value) AS max", "MIN(value) AS min", "AVG(value) AS avg")
      expect(sql).to include("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value) AS median")
    end

    it "runs against Postgres and agrees with #compute" do
      row = ActiveRecord::Base.connection.select_all(sql).first
      expect(row["median"].to_f).to eq(described_class.new(sheet).compute.median)
    end
  end
end
