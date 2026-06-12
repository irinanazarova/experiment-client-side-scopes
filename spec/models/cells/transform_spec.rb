# frozen_string_literal: true

require "rails_helper"

RSpec.describe Cells::Transform do
  describe "construction" do
    it "coerces a numeric string operand to a Float" do
      expect(described_class.new(operation: :multiply, operand: "1.5").operand).to eq(1.5)
    end

    it "rejects an unknown operation" do
      expect { described_class.new(operation: :divide, operand: 2) }
        .to raise_error(ArgumentError, /unknown operation/)
    end

    it "rejects a non-finite operand (Infinity)" do
      expect { described_class.new(operation: :multiply, operand: "1e309") }
        .to raise_error(ArgumentError, /finite/)
    end

    it "rejects NaN" do
      expect { described_class.new(operation: :set, operand: "NaN") }
        .to raise_error(ArgumentError)
    end

    # The load-bearing test: the injection defense is the Float coercion, and it
    # must reject anything that is not a number before it can reach a write.
    it "rejects a SQL-injection operand at the boundary" do
      expect { described_class.new(operation: :multiply, operand: "1); DROP TABLE cells;--") }
        .to raise_error(ArgumentError)
    end

    it "is frozen (immutable value object)" do
      expect(described_class.new(operation: :add, operand: 1)).to be_frozen
    end
  end

  describe "#apply (the client-side semantics)" do
    it "multiplies" do
      expect(described_class.new(operation: :multiply, operand: 1.1).apply(100)).to be_within(1e-9).of(110.0)
    end

    it "adds" do
      expect(described_class.new(operation: :add, operand: 5).apply(100)).to eq(105.0)
    end

    it "sets" do
      expect(described_class.new(operation: :set, operand: 42).apply(100)).to eq(42.0)
    end

    it "treats a nil current value as zero" do
      expect(described_class.new(operation: :add, operand: 5).apply(nil)).to eq(5.0)
    end
  end
end
