# frozen_string_literal: true

module Cells
  # Domain value object: an immutable, identity-less rectangular block of cells
  # (a spreadsheet selection). A bulk update targets a Region. Pure data, no
  # Active Record dependency, so the same object describes a selection on the
  # server and in the browser.
  class Region
    attr_reader :sheet_id, :rows, :cols

    def initialize(sheet_id:, row_from:, row_to:, col_from:, col_to:)
      @sheet_id = sheet_id
      @rows = (row_from..row_to)
      @cols = (col_from..col_to)
      freeze
    end

    def cell_count
      rows.size * cols.size
    end

    def cover?(row, col)
      rows.cover?(row) && cols.cover?(col)
    end
  end
end
