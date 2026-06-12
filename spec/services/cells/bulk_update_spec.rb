# frozen_string_literal: true

require "rails_helper"

# Specification test: exercise the write authority end to end (authorize ->
# update -> Result) without booting a controller. This is where the design's
# claims become executable proof.
RSpec.describe Cells::BulkUpdate do
  let_it_be(:sheet) { create(:sheet, row_count: 3, col_count: 3) }
  let_it_be(:other_sheet) { create(:sheet) }

  # A 3x3 grid of 10s, plus a guard cell on another sheet.
  before do
    (1..3).each do |row|
      (1..3).each { |col| create(:cell, sheet:, row:, col:, value: 10) }
    end
    @untouched = create(:cell, sheet: other_sheet, row: 1, col: 1, value: 10)
  end

  def run(operation:, operand:, region:)
    described_class.new(user: nil, region:, transform: Cells::Transform.new(operation:, operand:)).call
  end

  let(:column_two) do
    Cells::Region.new(sheet_id: sheet.id, row_from: 1, row_to: 3, col_from: 2, col_to: 2)
  end

  it "applies the transform to exactly the cells in the region" do
    result = run(operation: :multiply, operand: 2, region: column_two)

    expect(result.updated_count).to eq(3)
    expect(Cell.for_sheet(sheet.id).where(col: 2).pluck(:value)).to all(eq(20))
    # neighbouring columns are untouched
    expect(Cell.for_sheet(sheet.id).where(col: 1).pluck(:value)).to all(eq(10))
  end

  it "never touches another sheet" do
    run(operation: :set, operand: 0, region: column_two)
    expect(@untouched.reload.value).to eq(10)
  end

  it "matches Transform#apply (server SQL and client math agree)" do
    transform = Cells::Transform.new(operation: :add, operand: 7)
    described_class.new(user: nil, region: column_two, transform:).call
    expect(Cell.for_sheet(sheet.id).where(col: 2).pluck(:value)).to all(eq(transform.apply(10)))
  end

  context "when the user is not authorized" do
    before { allow_any_instance_of(SheetPolicy).to receive(:update?).and_return(false) }

    it "raises and writes nothing" do
      expect { run(operation: :set, operand: 0, region: column_two) }
        .to raise_error(ActionPolicy::Unauthorized)
      expect(Cell.for_sheet(sheet.id).pluck(:value)).to all(eq(10))
    end
  end
end
