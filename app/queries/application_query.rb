# frozen_string_literal: true

# Domain layer. Base for observable query objects: a query whose result set the
# client replica watches. The query is authored as an Active Record relation
# (scope, window, group, order); the SQL the browser runs as a PGlite live query
# is DERIVED from that relation with #to_sql, never written alongside it. So the
# relation the server renders from and the query the browser watches are the
# same object and cannot drift.
#
#   class Cells::GridWindow < ApplicationQuery
#     observable_by :window          # => #watch_sql is `window.to_sql`
#     def window = cells.where(...).select(...)
#   end
#
# `observable_by` names a relation, so reactivity is declared in terms of data,
# not a hand-maintained SQL string. Mirrors ClientScope, where the Electric
# replication filter is likewise read back out of the relation.
class ApplicationQuery
  # Declare the relation whose result set is this query's reactivity signature.
  # Defines #watch_sql (the live query the client replica observes) and exposes
  # it under the query's public name (`as:`, default #sql), so the watch-SQL
  # surface is named here in one place rather than re-aliased in every subclass.
  def self.observable_by(relation_method, as: :sql)
    define_method(:watch_sql) { public_send(relation_method).to_sql }
    alias_method(as, :watch_sql)
  end

  def initialize(sheet)
    @sheet = sheet
  end

  private

  attr_reader :sheet

  # Every query here is scoped to one sheet's cells, on whichever database is
  # current: server Postgres on the host, the PGlite replica in the Wasm VM.
  def cells
    Cell.for_sheet(sheet.id)
  end

  # Cells store decimals. Read a computed aggregate (an aliased SELECT column,
  # which has no schema type to cast by) back as BigDecimal, so server values
  # keep the column's type and JSON shape.
  def decimal(value)
    return if value.nil?

    BigDecimal(value.to_s)
  end
end
