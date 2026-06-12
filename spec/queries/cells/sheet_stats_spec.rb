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
end
