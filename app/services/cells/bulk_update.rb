# frozen_string_literal: true

module Cells
  # Application layer service: the write authority for a bulk edit.
  #
  # One user gesture == one server transaction == one UPDATE. This is the line
  # that keeps us on write-ladder point B and out of point C: writes are never
  # batched on a cadence, the server is always the sole authority, and the
  # authoritative rows flow back to the device through Electric's WAL stream
  # (which sees this update_all, unlike an after_commit callback).
  #
  # Authorization lives here, not only in the controller, so the write authority
  # gates itself: a job or console call cannot bypass it. Inputs are domain
  # value objects (Region, Transform), never request params, so this service has
  # no presentation-layer dependency.
  class BulkUpdate
    include ActionPolicy::Behaviour

    # The write authority passes its user as the policy context.
    authorize :user

    Result = Data.define(:updated_count)

    # operand is bound, never interpolated; the Transform already guaranteed it
    # is a finite number.
    ASSIGNMENTS = {
      multiply: "value = COALESCE(value, 0) * :operand",
      add: "value = COALESCE(value, 0) + :operand",
      set: "value = :operand"
    }.freeze

    def initialize(user:, region:, transform:)
      @user = user
      @region = region
      @transform = transform
    end

    def call
      sheet = Sheet.find(@region.sheet_id)
      authorize! sheet, to: :update?

      updated = scope.update_all([ASSIGNMENTS.fetch(@transform.operation), {operand: @transform.operand}])
      Result.new(updated_count: updated)
    end

    private

    attr_reader :user

    def scope
      Cell.for_sheet(@region.sheet_id).in_region(@region)
    end
  end
end
