# frozen_string_literal: true

# Domain layer.
# The spreadsheet *is* this table. Aggregates and the viewport are plain scopes,
# so they read identically against server Postgres and against the in-browser
# PGlite replica (run through ruby.wasm + the PGlite Active Record adapter).
#
# `value` numericality is an advisory client-side check in the Wasm VM and the
# authoritative check on the server write. Same Ruby, so they cannot drift.
class Cell < ApplicationRecord
  include ClientScopable

  belongs_to :sheet

  validates :row, :col, presence: true
  validates :value, numericality: true, allow_nil: true

  # A named, server-defined slice.
  scope :for_sheet, ->(sheet_id) { where(sheet_id:) }

  # The bulk-write selection, expressed via a Cells::Region value object so the
  # bounds live in one place.
  scope :in_region, ->(region) { where(row: region.rows, col: region.cols) }

  # Expose for_sheet as a client-side scope: clients subscribe by name, the
  # Electric filter is derived from the scope itself, and subscribers are
  # authorized through the parent sheet. (See ClientScopable.)
  client_scope :sheet_cells, ->(sheet_id:) { for_sheet(sheet_id) },
    authorize: :sync?, via: :sheet, ship: %i[id sheet_id row col value formula]
end
