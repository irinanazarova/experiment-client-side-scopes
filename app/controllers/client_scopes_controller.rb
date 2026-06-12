# frozen_string_literal: true

# Presentation layer (thin). The browser asks for a named client-side scope;
# we authorize it and hand back the Electric Shape config. No business logic
# here: resolve -> authorize -> delegate to the gateway.
class ClientScopesController < ApplicationController
  include ClientScopeRequest

  def show
    definition = ClientScope.fetch(params[:id])
    authorize! definition.subject(scope_params), to: definition.policy_action

    render json: Electric::Gateway.new.shape_config(
      definition.shape_definition(scope_params),
      scope_name: definition.name, scope_params:, base_url: request.base_url
    )
  end
end
