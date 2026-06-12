# frozen_string_literal: true

module Cells
  # Application layer. One unit of simulated server activity: set a short
  # vertical run of cells in a random column (within the given row/col ranges)
  # to a random value, through the same write authority a user write uses.
  # Committed, so Electric's WAL stream carries it to every replica, which is
  # what makes the change show up as a small cluster of green (remote) blinks on
  # every open client.
  class RandomTick
    # The demo window: the top-left block that is always on the first screen, so
    # every tick produces a visible green flash.
    VISIBLE_ROWS = (1..25)
    VISIBLE_COLS = (1..10)
    SECTION_HEIGHT = 5

    def initialize(sheet, rows: VISIBLE_ROWS, cols: VISIBLE_COLS, user: nil)
      @sheet = sheet
      @rows = rows
      @cols = cols
      @user = user
    end

    def call
      col = rand(@cols)
      value = rand(0.0..1000.0).round(2)

      # A short 5-cell vertical run (not the whole column): a small cluster of
      # green blinks each tick, easy to spot without flooding the grid. Clamped
      # to fit inside the visible window so every changed cell lands on screen.
      height = [SECTION_HEIGHT, @rows.size].min
      row_from = rand(@rows.begin..(@rows.end - height + 1))
      region = Cells::Region.new(
        sheet_id: @sheet.id,
        row_from: row_from, row_to: row_from + height - 1,
        col_from: col, col_to: col
      )
      transform = Cells::Transform.new(operation: :set, operand: value)
      Cells::BulkUpdate.new(user: @user, region:, transform:).call
    end
  end
end
