# frozen_string_literal: true

require "rails_helper"

# The derivation helpers behind the `client_scope` macro. The macro itself is
# exercised end-to-end through Cell's :sheet_cells scope (see
# spec/scopes/client_scope_spec.rb); here we pin the two pieces that decide the
# trust boundary by convention, using the real Cell/Sheet models.
RSpec.describe ClientScopable do
  describe ".derive_via" do
    it "finds the belongs_to whose foreign key the scope filters on" do
      expect(described_class.derive_via(Cell, [:sheet_id])).to eq(:sheet)
    end

    it "fails loudly when no foreign key matches (so via: can't be guessed wrong)" do
      expect { described_class.derive_via(Cell, [:nonexistent_id]) }
        .to raise_error(ArgumentError, /cannot derive `via:`/)
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
