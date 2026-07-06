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

  # The two derivations behind .define that decide the trust boundary by
  # convention, using the real Cell/Sheet models.
  describe ".derive_via" do
    it "finds the belongs_to whose foreign key the scope filters on" do
      expect(described_class.derive_via(Cell, [:sheet_id])).to eq(:sheet)
    end

    it "fails loudly when no foreign key matches (so via: can't be guessed wrong)" do
      expect { described_class.derive_via(Cell, [:nonexistent_id]) }
        .to raise_error(ArgumentError, /cannot derive `via:`/)
    end
  end

  # slice:pack and asset precompile boot the app with no database connection, so
  # declaring a scope must not touch one: the model, its belongs_to, the policy
  # subject and the column list all resolve lazily, on first request. A regression
  # that resolved the model at declaration time (re-breaking those boots) would
  # issue a query here and fail.
  describe "boot without a database" do
    it "builds a definition without querying (nothing resolves the model at declaration)" do
      queries = 0
      subscription = ActiveSupport::Notifications.subscribe("sql.active_record") do |*, payload|
        queries += 1 unless payload[:name] == "SCHEMA" || payload[:sql].match?(/TRANSACTION/)
      end

      ClientScope::Definition.new(
        name: :boot_probe, scope: ->(sheet_id) { Cell.for_sheet(sheet_id) },
        ship: %i[value], authorize: :sync?, via: nil
      )
    ensure
      ActiveSupport::Notifications.unsubscribe(subscription)
      expect(queries).to eq(0)
    end
  end

  describe ".assert_policy_rule!" do
    it "passes when the guarding rule exists" do
      expect { described_class.assert_policy_rule!(:sheet_cells, Sheet, :sync?) }
        .not_to raise_error
    end

    it "fails loudly when the rule is missing (never ship unguarded)" do
      expect { described_class.assert_policy_rule!(:sheet_cells, Sheet, :no_such_rule?) }
        .to raise_error(ArgumentError, /SheetPolicy#no_such_rule\? is not.*defined/m)
    end
  end
end
