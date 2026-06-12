# ~50k cells: large enough that doing aggregates server-side per keystroke
# would visibly lag, small enough that PGlite stays instant.
ROWS = 2_500
COLS = 20

# Restart identity so the demo sheet is always id 1 (the root route targets it).
ActiveRecord::Base.connection.execute("TRUNCATE cells, sheets RESTART IDENTITY CASCADE")

sheet = Sheet.create!(name: "Demo budget", row_count: ROWS, col_count: COLS)

puts "Seeding #{ROWS * COLS} cells..."

now = Time.current

(1..ROWS).each_slice(250) do |row_batch|
  rows = []
  row_batch.each do |row|
    (1..COLS).each do |col|
      rows << {sheet_id: sheet.id, row:, col:, value: rand(1.0..1000.0).round(2), created_at: now, updated_at: now}
    end
  end
  Cell.insert_all(rows)
end

puts "Done. Sheet ##{sheet.id} has #{sheet.cells.count} cells."
puts "Grand total: #{Cells::ColumnAggregates.new(sheet).grand_total}"
