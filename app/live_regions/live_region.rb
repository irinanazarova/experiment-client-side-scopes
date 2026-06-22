# frozen_string_literal: true

# A reactive region: an ERB partial bound to the query whose result it depends
# on. The region observes an ApplicationQuery; the browser runs that query's
# #watch_sql as a PGlite live query, which is both the change signal and the
# dependency tracker. It fires exactly when that result set changes, and only
# then does the region re-render (in-VM ActionView) and morph. So "data change
# propels into the view," per fragment, with no template dependency analysis:
# the database is the dependency graph.
#
# A region names a query (its change signal) and builds its render locals
# separately, so a region may compose extra reads at render time (totals shows
# the stats too) while still being woken by a single result set.
#
# Like ClientScope, regions are NAMED and server-defined: the render endpoint
# resolves a registered region, never a client-chosen partial.
class LiveRegion
  class UnknownRegion < KeyError; end

  Definition = Data.define(:name, :partial, :query_builder, :locals_builder) do
    def query(sheet) = query_builder.call(sheet)

    def watch_sql(sheet) = query(sheet).watch_sql

    def locals(sheet) = locals_builder.call(sheet)
  end

  REGISTRY = {}
  private_constant :REGISTRY

  def self.register(name, partial:, query:, locals:)
    REGISTRY[name.to_sym] = Definition.new(name.to_sym, partial, query, locals)
  end

  def self.fetch(name)
    REGISTRY.fetch(name.to_sym) { raise UnknownRegion, "unknown live region: #{name}" }
  end

  # The spreadsheet's reactive regions. Each query observes a different slice of
  # the data, so they fire independently: an edit outside the visible window
  # resettles the aggregates without repainting the grid body.
  register :stats,
    partial: "sheets/stats",
    query: ->(sheet) { Cells::SheetStats.new(sheet) },
    locals: ->(sheet) { {stats: Cells::SheetStats.new(sheet).compute} }

  register :totals,
    partial: "sheets/totals",
    query: ->(sheet) { Cells::ColumnAggregates.new(sheet) },
    locals: ->(sheet) {
      {
        sheet:,
        sums: Cells::ColumnAggregates.new(sheet).by_column,
        stats: Cells::SheetStats.new(sheet).compute
      }
    }

  register :rows,
    partial: "sheets/rows",
    query: ->(sheet) { Cells::GridWindow.new(sheet) },
    locals: ->(sheet) {
      {
        sheet:,
        row_limit: Cells::GridWindow::DEFAULT_LIMIT,
        values: Cells::GridWindow.new(sheet).values
      }
    }
end
