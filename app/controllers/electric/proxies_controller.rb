# frozen_string_literal: true

module Electric
  # Presentation layer (thin). The authorizing proxy Electric is designed to
  # run behind: the browser polls here with a scope NAME plus the protocol's
  # cursor params; we re-authorize on every poll, re-derive the shape from
  # the registered scope (the client cannot widen table, columns or where),
  # and Electric::Proxy signs and forwards upstream. Electric itself stays
  # private; the secret never reaches the client.
  class ProxiesController < ApplicationController
    rescue_from ClientScope::UnknownScope, with: -> { head :not_found }
    rescue_from ActionPolicy::Unauthorized, with: -> { head :forbidden }

    def shape
      definition = ClientScope.fetch(params.require(:scope))
      authorize! definition.subject(scope_params), to: definition.policy_action

      shape = ShapeDefinition.new(
        table: definition.model.table_name,
        columns: definition.columns,
        where: definition.electric_where(scope_params)
      )

      result = Proxy.new.call(shape, request.query_parameters)
      result.headers.each { |key, value| response.set_header(key, value) }
      render plain: result.body, status: result.status, content_type: result.headers["content-type"]
    end

    private

    # Named scopes take a fixed, declared set of params. Never an arbitrary query.
    def scope_params
      params.permit(:sheet_id).to_h.symbolize_keys
    end
  end
end
