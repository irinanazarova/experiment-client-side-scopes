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

    # In the in-browser build, bound the single-threaded Wasm VM's heap so
    # sustained server activity can't trap it mid-render (see Wasm::HeapReclaimer).
    # Guarded to the Wasm env, so the multi-threaded host never pays for it.
    HEAP_RECLAIMER = Wasm::HeapReclaimer.new
    after_action(if: -> { Rails.env.wasm? }) { HEAP_RECLAIMER.tick }

    def show
      sheet = Sheet.find(params[:sheet_id])
      authorize! sheet, to: :sync?

      region = ::LiveRegion.fetch(params[:id])
      render partial: region.partial, locals: region.locals(sheet), layout: false
    end
  end
end
