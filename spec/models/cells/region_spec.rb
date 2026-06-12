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

  it "is frozen (immutable value object)" do
    expect(region).to be_frozen
  end
end
