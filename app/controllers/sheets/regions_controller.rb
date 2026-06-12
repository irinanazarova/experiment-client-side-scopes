# frozen_string_literal: true

module Sheets
  # Presentation layer (thin). Re-renders a named reactive region. On the host
  # it reads server Postgres; in the Wasm build the identical action runs in
  # the tab and reads the PGlite replica, so a live-query fire becomes
  # ActionView output morphed into one fragment, no network. Same authorization
  # as subscribing to the slice (the region reads the same authorized data).
  class RegionsController < ApplicationController
    rescue_from ::LiveRegion::UnknownRegion, with: -> { head :not_found }
    rescue_from ActionPolicy::Unauthorized, with: -> { head :forbidden }

    # The in-browser build renders into a single-threaded Wasm VM whose Ruby
    # heap (and the Wasm linear memory under it) only grows. Under sustained
    # server activity that growth eventually traps the VM mid-render. A full
    # sweep on a cadence keeps the heap bounded (cheap next to the render).
    # Guarded to the Wasm env, so the multi-threaded host never pays for it.
    # (GC.compact would fight fragmentation too, but it is unimplemented in
    # ruby.wasm — it raises NotImplementedError — so we don't call it.)
    after_action :reclaim_vm_heap, if: -> { Rails.env.wasm? }

    def show
      sheet = Sheet.find(params[:sheet_id])
      authorize! sheet, to: :sync?

      region = ::LiveRegion.fetch(params[:id])
      render partial: region.partial, locals: region.locals(sheet), layout: false
    end

    private

    @@renders = 0

    def reclaim_vm_heap
      @@renders += 1
      GC.start(full_mark: true, immediate_sweep: true) if (@@renders % 4).zero?
    rescue StandardError, ScriptError => e
      # Never let a GC hiccup turn a successful render into a 500. ScriptError
      # is included so an unimplemented GC primitive can't either (it is not a
      # StandardError, so a bare rescue would miss it).
      Rails.logger.warn("vm heap reclaim skipped: #{e.class}")
    end
  end
end
