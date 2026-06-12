# frozen_string_literal: true

require "rails_helper"

RSpec.describe Electric::ShapeDefinition do
  def shape(where:, table: "cells", columns: %i[id sheet_id value])
    described_class.new(table:, columns:, where:)
  end

  it "renders integer equality as an unqualified Electric where" do
    expect(shape(where: {sheet_id: 1}).where).to eq("sheet_id = 1")
  end

  it "AND-joins multiple conditions" do
    expect(shape(where: {sheet_id: 1, owner_id: 2}).where).to eq("sheet_id = 1 AND owner_id = 2")
  end

  it "omits the where for empty or nil conditions" do
    expect(shape(where: nil).where).to be_nil
    expect(shape(where: {}).where).to be_nil
  end

  # The trust boundary: a non-integer value (where injection could hide) fails
  # loudly instead of shipping a wrong or wider shape.
  it "raises for a non-integer value" do
    expect { shape(where: {sheet_id: "1 OR 1=1"}) }
      .to raise_error(ArgumentError, /integer equality only/)
  end

  it "exposes Electric params with comma-joined columns" do
    params = shape(where: {sheet_id: 1}).to_params
    expect(params).to eq(table: "cells", columns: "id,sheet_id,value", where: "sheet_id = 1")
  end
end
