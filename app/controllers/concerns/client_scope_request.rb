# frozen_string_literal: true

# Presentation layer. Shared request handling for the endpoints that resolve a
# NAMED client scope and authorize it before issuing an Electric Shape
# (ClientScopesController issues the config; Electric::ProxiesController proxies
# each poll). Both translate the same failures the same way and accept the same
# fixed, declared params, so the contract lives in one place and the two paths
# cannot drift apart across the trust boundary.
module ClientScopeRequest
  extend ActiveSupport::Concern

  included do
    rescue_from ClientScope::UnknownScope, with: -> { head :not_found }
    rescue_from ActionPolicy::Unauthorized, with: -> { head :forbidden }
  end

  private

  # Named scopes take a fixed, declared set of params. Never an arbitrary query.
  def scope_params
    params.permit(:sheet_id).to_h.symbolize_keys
  end
end
