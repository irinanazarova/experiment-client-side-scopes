# frozen_string_literal: true

# Presentation layer (thin). Phase B pages: boot ruby.wasm in the browser and
# run Ruby against the local PGlite replica. /wasm proves the ruby.wasm <->
# PGlite bridge; /wasm_ar runs the real activerecord gem in the VM.
class WasmController < ApplicationController
  before_action :load_sheet

  def show
  end

  # Real activerecord packed in ruby.wasm, executing against PGlite.
  def ar
  end

  private

  def load_sheet
    @sheet = Sheet.first
    @column_aggregates = Cells::ColumnAggregates.new(@sheet)
  end
end
