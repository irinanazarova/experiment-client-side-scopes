# frozen_string_literal: true

# Base class for application policies.
class ApplicationPolicy < ActionPolicy::Base
  # POC: there is no real authentication yet, so `user` may be nil. Declaring it
  # optional lets the anonymous trusted user flow through; real auth keeps the
  # same call sites and just stops returning nil.
  authorize :user, optional: true
end
