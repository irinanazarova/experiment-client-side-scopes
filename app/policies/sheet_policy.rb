# frozen_string_literal: true

# Application layer. One policy guards both faces of the slice boundary:
#   - sync?   -> may this user subscribe to this sheet's client-side scope?
#   - update? -> may this user write to it?
# "The slice boundary is the trust boundary, decide once": read and write are
# the same policy, re-checked authoritatively on every server write.
#
# POC stub: single trusted user, everything allowed. The call sites and the
# spec pin the contract; swap the predicate bodies for real RBAC/ABAC later.
class SheetPolicy < ApplicationPolicy
  def sync?
    true
  end

  def update?
    true
  end
end
