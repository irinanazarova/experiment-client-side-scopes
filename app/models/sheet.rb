# frozen_string_literal: true

# Domain layer.
# A Sheet is the unit of sync: one client-side scope == one sheet's cells.
class Sheet < ApplicationRecord
  has_many :cells, dependent: :delete_all

  validates :name, presence: true
end
