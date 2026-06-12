# frozen_string_literal: true

# Client scopes register themselves when their model loads (via the
# ClientScopable macro, e.g. Cell.client_scope :sheet_cells). In production
# eager loading pulls every model in at boot, so the registry is complete. In
# dev/test (lazy loading) a request can reach ClientScope.fetch before the
# model is ever referenced, so load the declaring models here.
#
# This is the one place that names them; it is an infrastructure concern, not
# the declaration surface (which lives on each model).
Rails.application.config.to_prepare do
  Cell
end
