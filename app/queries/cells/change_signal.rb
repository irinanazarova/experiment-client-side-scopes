# frozen_string_literal: true

module Cells
  # Domain layer query object. The coarse change signal for a sheet: a single
  # aggregate row over the whole cell relation that moves whenever any cell in
  # it changes. This is DataChange.topic realized as a client live query: the
  # browser watches one cheap query and, on any write, reloads the whole grid
  # frame. The mirror of broadcast_refresh's whole-page morph, with the change
  # detected locally instead of pushed from the server.
  #
  # COUNT catches inserts and deletes; SUM(value * id) catches a single cell's
  # value moving (the id weights each cell, so two cells swapping values still
  # trips the sum). One row, no per-cell streaming, so it is cheap to watch.
  class ChangeSignal < ApplicationQuery
    observable_by :signal

    # The observable relation: the whole sheet reduced to one signature row.
    def signal
      cells.select("COUNT(*) AS n, COALESCE(SUM(value * id), 0) AS checksum")
    end
  end
end
