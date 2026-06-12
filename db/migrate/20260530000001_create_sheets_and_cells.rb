class CreateSheetsAndCells < ActiveRecord::Migration[8.1]
  def change
    create_table :sheets do |t|
      t.string :name, null: false
      t.integer :row_count, null: false, default: 0
      t.integer :col_count, null: false, default: 0
      t.timestamps
    end

    create_table :cells do |t|
      t.references :sheet, null: false, foreign_key: true
      t.integer :row, null: false
      t.integer :col, null: false
      t.decimal :value, precision: 18, scale: 4
      t.string :formula
      t.timestamps
    end

    # The aggregate path (GROUP BY col, SUM value) and the viewport path
    # (WHERE row BETWEEN ..) both lean on this. Same index server-side and,
    # once synced, in PGlite.
    add_index :cells, [:sheet_id, :col]
    add_index :cells, [:sheet_id, :row, :col], unique: true
  end
end
