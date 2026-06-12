# frozen_string_literal: true

require "rails_helper"

RSpec.describe Cells::RandomTick do
  let_it_be(:sheet) { create(:sheet, row_count: 50, col_count: 20) }

  before do
    (1..3).each { |row| (1..3).each { |col| create(:cell, sheet:, row:, col:, value: -1) } }
  end

  subject(:tick) { described_class.new(sheet, rows: 1..3, cols: 1..3) }

  it "sets a whole column within the ranges to a value in [0, 1000]" do
    result = tick.call

    expect(result.updated_count).to eq(3) # every row in the range, one column
    changed = Cell.for_sheet(sheet.id).where.not(value: -1)
    expect(changed.count).to eq(3)
    expect(changed.pluck(:col).uniq.size).to eq(1) # all in the same column
    expect(changed.pluck(:value).uniq.size).to eq(1) # all set to the same value
    changed.each do |cell|
      expect(cell.row).to be_between(1, 3)
      expect(cell.col).to be_between(1, 3)
      expect(cell.value).to be_between(0, 1000)
    end
  end
end
