# frozen_string_literal: true

require "rails_helper"

RSpec.describe Cells::GridWindow do
  let_it_be(:sheet) { create(:sheet) }

  before do
    create(:cell, sheet:, row: 1, col: 1, value: 10)
    create(:cell, sheet:, row: 1, col: 2, value: 20)
    create(:cell, sheet:, row: 2, col: 1, value: 30)
    create(:cell, sheet:, row: 99, col: 1, value: 999) # outside the window
  end

  subject(:window) { described_class.new(sheet, 50) }

  it "shapes the visible rows as {row => {col => value}}" do
    expect(window.values).to eq(1 => {1 => 10, 2 => 20}, 2 => {1 => 30})
  end

  it "excludes rows beyond the limit" do
    expect(window.values.keys).not_to include(99)
  end

  it "generates SQL scoped to the sheet and window" do
    sql = window.sql
    expect(sql).to include(%(sheet_id" = #{sheet.id}))
    expect(sql).to match(/row.* (<= 50|BETWEEN 1 AND 50)/i)
    expect(sql).to match(/ORDER BY.*row/i)
  end
end
