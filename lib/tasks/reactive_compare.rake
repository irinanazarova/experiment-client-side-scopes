# frozen_string_literal: true

# A log to compare the three reactive strategies on the same sheet: what each
# one re-renders per edit, and what that costs. The render cost is measured
# server-side here (the same query objects + ActionView partials each route
# uses); in the local-first routes the identical render runs in the in-browser
# VM, where it is slower (see the slice render-hotspot notes), so treat these as
# the lower bound on render work, not wall-clock parity.
#
#   bin/rails reactive:compare
namespace :reactive do
  desc "Compare render cost across the reactive strategies"
  task compare: :environment do
    sheet = Sheet.first or abort("No sheet; run db:seed first.")
    renderer = ApplicationController.renderer

    count_queries = lambda do |&blk|
      n = 0
      sub = ActiveSupport::Notifications.subscribe("sql.active_record") do |*, payload|
        n += 1 unless payload[:cached] || payload[:name].to_s.match?(/SCHEMA|TRANSACTION/)
      end
      blk.call
      ActiveSupport::Notifications.unsubscribe(sub)
      n
    end

    best_ms = lambda do |runs = 5, &blk|
      runs.times.map do
        t = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        blk.call
        (Process.clock_gettime(Process::CLOCK_MONOTONIC) - t) * 1000
      end.min
    end

    # Each fragment: the locals a route computes, then the partial render.
    fragments = {
      "stats" => -> {
        renderer.render(partial: "sheets/stats", locals: {stats: Cells::SheetStats.new(sheet).compute})
      },
      "totals" => -> {
        renderer.render(partial: "sheets/totals", locals: {
          sheet:, sums: Cells::ColumnAggregates.new(sheet).by_column, stats: Cells::SheetStats.new(sheet).compute
        })
      },
      "rows" => -> {
        renderer.render(partial: "sheets/rows", locals: {
          sheet:, row_limit: Cells::GridWindow::DEFAULT_LIMIT, values: Cells::GridWindow.new(sheet).values
        })
      }
    }

    measured = fragments.transform_values do |render|
      {queries: count_queries.call(&render), ms: best_ms.call(&render).round(1), bytes: render.call.bytesize}
    end
    sum = lambda do |*parts|
      parts.reduce({queries: 0, ms: 0.0, bytes: 0}) do |acc, m|
        {queries: acc[:queries] + m[:queries], ms: (acc[:ms] + m[:ms]).round(1), bytes: acc[:bytes] + m[:bytes]}
      end
    end
    whole = sum.call(*measured.values)
    aggregates = sum.call(measured["stats"], measured["totals"]) # an out-of-window edit

    puts "\nSheet ##{sheet.id}: #{sheet.cells.count} cells (#{sheet.row_count}×#{sheet.col_count})\n\n"
    puts "Per-fragment render cost (server-side: query objects + ActionView):"
    puts format("  %-8s %8s %10s %10s", "fragment", "queries", "ms", "bytes")
    measured.each { |name, m| puts format("  %-8s %8d %10.1f %10d", name, m[:queries], m[:ms], m[:bytes]) }
    puts format("  %-8s %8d %10.1f %10d", "WHOLE", whole[:queries], whole[:ms], whole[:bytes])

    puts "\nWhat each strategy re-renders per edit, and the cost:\n\n"
    rows = [
      ["server-push (/hotwire)", "whole grid", whole, "1 round-trip (~270ms measured)", "Action Cable + persistent subscription"],
      ["local-first per-query (precise)", "only changed fragment(s)*", aggregates, "0 (reads the local replica)", "PGlite + Electric"],
      ["local-first stream-from-relation", "whole grid", whole, "0 (reads the local replica)", "PGlite + Electric"]
    ]
    rows.each do |name, scope, cost, latency, infra|
      puts "  #{name}"
      puts "    re-renders : #{scope}  (#{cost[:queries]} queries, ~#{cost[:ms]} ms render, #{cost[:bytes]} bytes)"
      puts "    latency    : #{latency}"
      puts "    infra      : #{infra}"
      puts
    end
    puts "  * precise: an edit inside the visible window touches all three fragments;"
    puts "    an edit outside it resettles stats+totals only and leaves the grid body alone,"
    puts "    which is the work the per-query trigger saves over re-rendering the whole grid."
    puts
  end
end
