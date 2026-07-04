# frozen_string_literal: true

# Declare which server scopes are shippable to client replicas.
#
# This is a sync/transport boundary, so it lives in the application's
# configuration, not on the domain models (which stay plain Active Record
# classes with plain scopes). ClientScope.define reads like the scope plus the
# columns to ship; the model, the Electric filter, the policy subject and the
# authorization rule are all derived. Wrapped in to_prepare so it re-registers
# across code reloads in development.
Rails.application.config.to_prepare do
  ClientScope.define :sheet_cells,
    scope: ->(sheet_id) { Cell.for_sheet(sheet_id) },
    ship: %i[row col value formula]
end
