# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_05_30_000001) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "cells", force: :cascade do |t|
    t.integer "col", null: false
    t.datetime "created_at", null: false
    t.string "formula"
    t.integer "row", null: false
    t.bigint "sheet_id", null: false
    t.datetime "updated_at", null: false
    t.decimal "value", precision: 18, scale: 4
    t.index ["sheet_id", "col"], name: "index_cells_on_sheet_id_and_col"
    t.index ["sheet_id", "row", "col"], name: "index_cells_on_sheet_id_and_row_and_col", unique: true
    t.index ["sheet_id"], name: "index_cells_on_sheet_id"
  end

  create_table "sheets", force: :cascade do |t|
    t.integer "col_count", default: 0, null: false
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.integer "row_count", default: 0, null: false
    t.datetime "updated_at", null: false
  end

  add_foreign_key "cells", "sheets"
end
