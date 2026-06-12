# frozen_string_literal: true

module Electric
  # Infrastructure layer. Renders the parameters of an Electric Shape
  # (table + columns + where) from structured data. This is the only place that
  # knows Electric's read-path HTTP contract.
  #
  # The `where` is built from the scope's declared conditions (see ClientScope),
  # never derived by parsing generated SQL. The filter that defines the trust
  # boundary is an explicit, reviewable artifact.
  class ShapeDefinition
    attr_reader :table, :columns, :where

    def initialize(table:, columns:, where:)
      @table = table.to_s
      @columns = columns.map(&:to_s)
      @where = render_where(where)
    end

    def to_params
      {table:, columns: columns.join(","), where:}.compact
    end

    private

    # We support the slice shape every scope uses today: column = integer
    # equality, optionally AND-ed. Integers render safely without quoting;
    # anything else fails loudly rather than shipping a wrong or wider shape.
    def render_where(conditions)
      return nil if conditions.nil? || conditions.empty?

      conditions.map do |column, value|
        unless value.is_a?(Integer)
          raise ArgumentError, "Electric where supports integer equality only " \
            "(got #{value.inspect} for #{column}); declare an explicit filter"
        end

        "#{column} = #{value}"
      end.join(" AND ")
    end
  end
end
