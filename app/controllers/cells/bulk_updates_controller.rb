# frozen_string_literal: true

module Cells
  # Raised when request params cannot form valid domain value objects. Distinct
  # from a bare ArgumentError so that only input-construction failures become
  # 422; an ArgumentError from inside the service still surfaces as a 500.
  class InvalidInput < StandardError; end

  # Presentation layer (thin). Translate request params into domain value
  # objects here (params shape is a presentation concern, kept out of the VOs),
  # hand them to the service, render the result. The server is the write
  # authority; the browser updates optimistically and reconciles when Electric
  # streams the authoritative rows back.
  class BulkUpdatesController < ApplicationController
    # This is a JSON write API, and the in-browser slice (pwa/) posts here
    # carrying its local session's CSRF token, which this server cannot
    # verify. null_session keeps forgery protection semantics (an unverified
    # request gets an empty session) while letting the write proceed to the
    # real gate: the policy check inside Cells::BulkUpdate.
    protect_from_forgery with: :null_session

    rescue_from InvalidInput, with: :unprocessable
    rescue_from ActionPolicy::Unauthorized, with: :forbidden

    # Demo affordance for the "Server rejects writes" toggle: the client adds
    # reject=1 to the write. Only the host authority honors it; the in-VM
    # optimistic apply runs in the wasm env and ignores it, so you watch the
    # optimistic change land in the tab and then get rolled back when the
    # authority refuses it. That makes the otherwise-invisible reconcile step
    # visible: the replica never diverges from the server.
    before_action :reject_for_demo, only: :create

    def create
      region, transform = build_inputs
      result = Cells::BulkUpdate.new(user: current_user, region:, transform:).call
      render json: {updated: result.updated_count}
    end

    private

    def reject_for_demo
      return if Rails.env.wasm? # the in-VM optimistic apply must still succeed
      return unless ActiveModel::Type::Boolean.new.cast(params[:reject])

      render json: {error: "Server rejected the write (demo toggle: the server is the write authority)"},
        status: :forbidden
    end

    # Building the value objects is the only step where bad input is expected;
    # scope the ArgumentError rescue to exactly here.
    def build_inputs
      [region, transform]
    rescue ArgumentError => e
      raise InvalidInput, e.message
    end

    def region
      Cells::Region.new(
        sheet_id: Integer(bulk_params[:sheet_id]),
        row_from: Integer(bulk_params[:row_from]), row_to: Integer(bulk_params[:row_to]),
        col_from: Integer(bulk_params[:col_from]), col_to: Integer(bulk_params[:col_to])
      )
    end

    def transform
      Cells::Transform.new(operation: bulk_params[:operation].to_sym, operand: bulk_params[:operand])
    end

    def bulk_params
      @bulk_params ||= params.permit(:sheet_id, :row_from, :row_to, :col_from, :col_to, :operation, :operand)
    end

    def unprocessable(error)
      render json: {error: error.message}, status: :unprocessable_content
    end

    def forbidden(error)
      render json: {error: error.message}, status: :forbidden
    end
  end
end
