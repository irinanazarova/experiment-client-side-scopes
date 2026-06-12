# frozen_string_literal: true

require "rails_helper"

# Uses Action Policy's RSpec DSL. The predicates are POC stubs (always allow),
# so these tests pin the contract before real RBAC lands.
RSpec.describe SheetPolicy do
  let(:user) { nil }
  let(:record) { build_stubbed(:sheet) }
  let(:context) { {user:} }

  describe_rule :sync? do
    succeed "for the trusted (anonymous) POC user"
  end

  describe_rule :update? do
    succeed "for the trusted (anonymous) POC user"
  end
end
