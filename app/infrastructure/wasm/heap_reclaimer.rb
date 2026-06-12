# frozen_string_literal: true

module Wasm
  # Infrastructure layer. Bounds the single-threaded Wasm VM's Ruby heap (and
  # the Wasm linear memory under it), which only grows: under sustained server
  # activity that growth eventually traps the VM mid-render. A full GC sweep on
  # a cadence keeps the heap bounded, cheap next to a fragment render. Only the
  # in-browser build instantiates this; the multi-threaded host never pays for
  # it. (GC.compact would fight fragmentation too, but it is unimplemented in
  # ruby.wasm, so we don't call it.)
  class HeapReclaimer
    def initialize(every: 4)
      @every = every
      @renders = 0
    end

    # Call once per render; runs a full sweep every Nth call.
    def tick
      @renders += 1
      return unless (@renders % @every).zero?

      GC.start(full_mark: true, immediate_sweep: true)
    rescue StandardError, ScriptError => e
      # Never let a GC hiccup turn a successful render into a 500. ScriptError is
      # caught too so an unimplemented GC primitive can't either (it is not a
      # StandardError, so a bare rescue would miss it).
      Rails.logger.warn("vm heap reclaim skipped: #{e.class}")
    end
  end
end
