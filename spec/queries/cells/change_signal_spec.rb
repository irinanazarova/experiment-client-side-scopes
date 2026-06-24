# frozen_string_literal: true

require "rails_helper"

RSpec.describe Cells::ChangeSignal do
  let_it_be(:sheet) { create(:sheet) }

  subject(:signal) { described_class.new(sheet) }

  it "watches one aggregate row over the whole sheet relation" do
    sql = signal.sql
    expect(sql).to include(%(sheet_id" = #{sheet.id}))
    expect(sql).to match(/COUNT\(\*\)/i)
    expect(sql).to match(/SUM\(value \* id\)/i)
    expect(sql).not_to match(/GROUP BY/i) # one row: the whole-relation signature
  end

  it "moves when a cell's value changes (so the client reloads on any write)" do
    cell = create(:cell, sheet:, row: 1, col: 1, value: 10)
    before = sheet.cells.reload.pick(Arel.sql("SUM(value * id)"))
    cell.update!(value: 11)
    after = sheet.cells.reload.pick(Arel.sql("SUM(value * id)"))
    expect(after).not_to eq(before)
  end
end
