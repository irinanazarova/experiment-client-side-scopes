# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Cells::Ticks", type: :request do
  let_it_be(:sheet) { create(:sheet, row_count: 50, col_count: 20) }

  # The tick targets a short vertical run in a random column of the visible
  # window, so the window must be populated (as the real seeded sheet is). Seed
  # it with a sentinel a tick can never produce, so the changed cells are
  # unambiguous.
  before do
    now = Time.current
    rows = (1..50).flat_map do |row|
      (1..20).map { |col| {sheet_id: sheet.id, row:, col:, value: -1, created_at: now, updated_at: now} }
    end
    Cell.insert_all(rows)
  end

  it "applies a random server section write and returns 204" do
    post cells_ticks_path, params: {sheet_id: sheet.id}

    expect(response).to have_http_status(:no_content)
    changed = Cell.for_sheet(sheet.id).where.not(value: -1)
    expect(changed.count).to eq(5) # a 5-cell vertical section in one column
    expect(changed.pluck(:col).uniq.size).to eq(1) # all in the same column
    expect(changed.pluck(:value).uniq.size).to eq(1) # all set to the same value
    sorted_rows = changed.pluck(:row).sort
    expect(sorted_rows).to eq((sorted_rows.first..sorted_rows.first + 4).to_a) # 5 consecutive rows
    expect(changed.first.value).to be_between(0, 1000)
  end

  it "returns 403 when the policy denies the write" do
    allow_any_instance_of(SheetPolicy).to receive(:update?).and_return(false)
    post cells_ticks_path, params: {sheet_id: sheet.id}
    expect(response).to have_http_status(:forbidden)
  end
end
