# frozen_string_literal: true

module Cells
  # Presentation layer (thin). One "server tick": a random visible cell gets a
  # random value through the write authority. The UI's "Server activity" toggle
  # posts here once a second; the write commits and Electric streams it to every
  # replica, so it shows up as a green (remote) blink on all open clients.
  #
  # Lives under /cells so the slice's Caddy proxy forwards it to the host (the
  # write authority), the same path the bulk write uses.
  class TicksController < ApplicationController
    protect_from_forgery with: :null_session # posted cross-session from the slice

    rescue_from ActionPolicy::Unauthorized, with: -> { head :forbidden }

    def create
      sheet = Sheet.find(params.require(:sheet_id))
      # Default window (rows 1..25, cols 1..10): always on the first screen.
      Cells::RandomTick.new(sheet, user: current_user).call
      head :no_content
    end
  end
end
