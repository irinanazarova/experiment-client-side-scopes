# frozen_string_literal: true

module Cells
  # Domain value object: the math a bulk update applies to each cell.
  #
  # Pure data plus the client-side semantics (#apply, the same arithmetic the
  # browser runs optimistically). The server-side SQL is built by
  # Cells::BulkUpdate from the operation and a bound operand; the operation set
  # is the contract both sides honor.
  #
  # operand is coerced to a finite number on construction, so a non-numeric or
  # infinite operand is rejected at the boundary, before it can reach a write.
  class Transform
    OPERATIONS = %i[multiply add set].freeze

    attr_reader :operation, :operand

    def initialize(operation:, operand:)
      raise ArgumentError, "unknown operation #{operation}" unless OPERATIONS.include?(operation)

      @operation = operation
      @operand = Float(operand)
      raise ArgumentError, "operand must be finite" unless @operand.finite?

      freeze
    end

    def apply(value)
      current = value.to_f
      case operation
      when :multiply then current * operand
      when :add then current + operand
      when :set then operand
      end
    end
  end
end
