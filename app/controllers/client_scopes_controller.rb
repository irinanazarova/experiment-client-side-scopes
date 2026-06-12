# frozen_string_literal: true

# Presentation layer (thin). The browser asks for a named client-side scope;
# we authorize it and hand back the Electric Shape config. No business logic
# here: resolve -> authorize -> delegate to the gateway.
class ClientScopesController < ApplicationController
  rescue_from ClientScope::UnknownScope, with: -> { head :not_found }
  rescue_from ActionPolicy::Unauthorized, with: -> { head :forbidden }

  def show
    definition = ClientScope.fetch(params[:id])
    authorize! definition.subject(scope_params), to: definition.policy_action

    shape = Electric::ShapeDefinition.new(
      table: definition.model.table_name,
      columns: definition.columns,
      where: definition.electric_where(scope_params)
    )

    render json: Electric::Gateway.new.shape_config(
      shape,
      scope_name: definition.name, scope_params:, base_url: request.base_url
    )
  end

  private

  # Named scopes take a fixed, declared set of params. Never an arbitrary query.
  def scope_params
    params.permit(:sheet_id).to_h.symbolize_keys
  end
end
