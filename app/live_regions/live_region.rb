# frozen_string_literal: true

# A reactive region: an ERB partial bound to the SQL whose result it depends
# on. The browser runs that SQL as a PGlite live query, which is both the
# change signal and the dependency tracker, it fires exactly when that result
# set changes, and only then does the region re-render (in-VM ActionView) and
# morph. So "data change propels into the view," per fragment, with no
# template dependency analysis: the database is the dependency graph.
#
# Like ClientScope, regions are NAMED and server-defined: the render endpoint
# resolves a registered region, never a client-chosen partial.
class LiveRegion
  class UnknownRegion < KeyError; end

  Definition = Data.define(:name, :partial, :watch_builder, :locals_builder) do
    def watch_sql(sheet) = watch_builder.call(sheet)

    def locals(sheet) = locals_builder.call(sheet)
  end

  REGISTRY = {}
  private_constant :REGISTRY

  def self.register(name, partial:, watch:, locals:)
    REGISTRY[name.to_sym] = Definition.new(name.to_sym, partial, watch, locals)
  end

  def self.fetch(name)
    REGISTRY.fetch(name.to_sym) { raise UnknownRegion, "unknown live region: #{name}" }
  end

  # The spreadsheet's reactive regions. Each watch query reads a different
  # slice of the data, so they fire independently: an edit outside the visible
  # window resettles the aggregates without repainting the grid body.
  register :stats,
    partial: "sheets/stats",
    watch: ->(sheet) { Cells::SheetStats.new(sheet).sql },
    locals: ->(sheet) { {stats: Cells::SheetStats.new(sheet).compute} }

  register :totals,
    partial: "sheets/totals",
    watch: ->(sheet) { Cells::ColumnAggregates.new(sheet).sums_sql },
    locals: ->(sheet) {
      {
        sheet: sheet,
        sums: Cells::ColumnAggregates.new(sheet).by_column,
        stats: Cells::SheetStats.new(sheet).compute
      }
    }

  register :rows,
    partial: "sheets/rows",
    watch: ->(sheet) { Cells::GridWindow.new(sheet).sql },
    locals: ->(sheet) {
      {
        sheet: sheet,
        row_limit: Cells::GridWindow::DEFAULT_LIMIT,
        values: Cells::GridWindow.new(sheet).values
      }
    }
end
