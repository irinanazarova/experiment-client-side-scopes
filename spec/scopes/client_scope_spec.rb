# frozen_string_literal: true

require "rails_helper"

RSpec.describe ClientScope do
  describe ".fetch" do
    it "resolves a registered scope by name" do
      expect(described_class.fetch(:sheet_cells).name).to eq(:sheet_cells)
    end

    it "raises UnknownScope for an unregistered name" do
      expect { described_class.fetch(:nope) }.to raise_error(ClientScope::UnknownScope)
    end
  end

  describe "the :sheet_cells definition" do
    subject(:definition) { described_class.fetch(:sheet_cells) }

    it "ships only the allow-listed columns (no surprise widening)" do
      expect(definition.columns).to eq(%i[id sheet_id row col value formula])
    end

    it "always includes the primary key and the scoping foreign key" do
      # The declaration ships only the payload (%i[row col value formula]); id and
      # sheet_id are added automatically because you cannot replicate without them.
      expect(definition.columns).to include(:id, :sheet_id)
    end

    it "authorizes against the sheet via the sync? rule" do
      expect(definition.policy_action).to eq(:sync?)
    end

    it "resolves the policy subject to the sheet" do
      sheet = create(:sheet)
      expect(definition.subject(sheet_id: sheet.id.to_s)).to eq(sheet)
    end

    it "coerces sheet_id to an Integer (rejects arbitrary input)" do
      expect(definition.electric_where(sheet_id: "42")).to eq({sheet_id: 42})
    end

    # The invariant: the explicit Electric filter and the server relation
    # describe the same slice. If they ever drift, this fails.
    it "declares an Electric where that matches the server relation's filter" do
      params = {sheet_id: 1}
      relation_filter = definition.relation(params).where_values_hash.symbolize_keys
      expect(definition.electric_where(params)).to eq(relation_filter)
    end
  end
end
