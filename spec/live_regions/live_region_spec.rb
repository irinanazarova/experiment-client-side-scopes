# frozen_string_literal: true

require "rails_helper"

RSpec.describe LiveRegion do
  let_it_be(:sheet) { create(:sheet) }

  describe ".fetch" do
    it "resolves a registered region" do
      expect(described_class.fetch(:stats).name).to eq(:stats)
    end

    it "raises for an unknown region" do
      expect { described_class.fetch(:nope) }.to raise_error(LiveRegion::UnknownRegion)
    end
  end

  describe "the registered regions" do
    it "each bind a partial to a watch query and build locals" do
      %i[stats totals rows].each do |name|
        region = described_class.fetch(name)
        expect(region.partial).to eq("sheets/#{name}")
        expect(region.watch_sql(sheet)).to be_a(String).and include("cells")
        expect(region.locals(sheet)).to be_a(Hash)
      end
    end

    # The point of the primitive: different regions watch different slices, so
    # they fire independently.
    it "watch distinct result sets (rows watches the window, totals the sums)" do
      expect(described_class.fetch(:rows).watch_sql(sheet)).to match(/row.* (<=|BETWEEN)/i)
      expect(described_class.fetch(:totals).watch_sql(sheet)).to match(/SUM\(value\)/i)
    end
  end
end
