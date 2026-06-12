# frozen_string_literal: true

require "rails_helper"

RSpec.describe Cell do
  describe "validations" do
    subject { build(:cell) }

    it { is_expected.to be_valid }

    it "requires row and col" do
      cell = build(:cell, row: nil, col: nil)
      expect(cell).not_to be_valid
      expect(cell.errors.attribute_names).to include(:row, :col)
    end

    it "allows a nil value" do
      expect(build(:cell, value: nil)).to be_valid
    end

    it "rejects a non-numeric value (advisory check mirrored client-side)" do
      cell = build(:cell)
      cell.value = "abc"
      expect(cell).not_to be_valid
    end
  end

  describe "scopes" do
    let_it_be(:sheet) { create(:sheet) }
    let_it_be(:other) { create(:sheet) }
    let_it_be(:in_scope) { create(:cell, sheet:, row: 2, col: 2) }
    let_it_be(:out_of_scope) { create(:cell, sheet: other, row: 2, col: 2) }

    it ".for_sheet limits to one sheet" do
      expect(Cell.for_sheet(sheet.id)).to contain_exactly(in_scope)
    end

    it ".in_region limits to the region's rows and cols" do
      region = Cells::Region.new(sheet_id: sheet.id, row_from: 1, row_to: 2, col_from: 1, col_to: 2)
      create(:cell, sheet:, row: 9, col: 9)
      expect(Cell.for_sheet(sheet.id).in_region(region)).to contain_exactly(in_scope)
    end
  end
end
