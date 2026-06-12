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
end
