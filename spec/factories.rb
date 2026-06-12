# frozen_string_literal: true

FactoryBot.define do
  factory :sheet do
    sequence(:name) { |n| "Sheet #{n}" }
    row_count { 3 }
    col_count { 3 }
  end

  factory :cell do
    sheet
    row { 1 }
    col { 1 }
    value { 100.0 }
  end
end
