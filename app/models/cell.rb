# frozen_string_literal: true

# Domain layer.
# The spreadsheet *is* this table. Aggregates and the viewport are plain scopes,
# so they read identically against server Postgres and against the in-browser
# PGlite replica (run through ruby.wasm + the PGlite Active Record adapter).
#
# `value` numericality is an advisory client-side check in the Wasm VM and the
# authoritative check on the server write. Same Ruby, so they cannot drift.
class Cell < ApplicationRecord
  belongs_to :sheet

  validates :row, :col, presence: true
  validates :value, numericality: true, allow_nil: true

  # A named, server-defined slice. Shipped to client replicas as the
  # :sheet_cells client scope, declared in config/initializers/client_scopes.rb
  # (a sync concern, kept off the domain model).
  scope :for_sheet, ->(sheet_id) { where(sheet_id:) }

  # The bulk-write selection, expressed via a Cells::Region value object so the
  # bounds live in one place.
  scope :in_region, ->(region) { where(row: region.rows, col: region.cols) }
end
