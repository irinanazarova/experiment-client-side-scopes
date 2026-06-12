# frozen_string_literal: true

require "rails_helper"

RSpec.describe Cells::Region do
  subject(:region) do
    described_class.new(sheet_id: 7, row_from: 2, row_to: 5, col_from: 1, col_to: 3)
  end

  it "exposes inclusive row and column ranges" do
    expect(region.rows).to eq(2..5)
    expect(region.cols).to eq(1..3)
  end

  it "counts the cells it covers" do
    expect(region.cell_count).to eq(4 * 3)
  end

  it "knows which cells it covers (inclusive bounds)" do
    expect(region.cover?(2, 1)).to be(true)
    expect(region.cover?(5, 3)).to be(true)
    expect(region.cover?(6, 3)).to be(false)
    expect(region.cover?(2, 4)).to be(false)
  end

  it "is frozen (immutable value object)" do
    expect(region).to be_frozen
  end
end
