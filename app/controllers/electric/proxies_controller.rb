# frozen_string_literal: true

module Electric
  # Presentation layer (thin). The authorizing proxy Electric is designed to
  # run behind: the browser polls here with a scope NAME plus the protocol's
  # cursor params; we re-authorize on every poll, re-derive the shape from
  # the registered scope (the client cannot widen table, columns or where),
  # and Electric::Proxy signs and forwards upstream. Electric itself stays
  # private; the secret never reaches the client.
  class ProxiesController < ApplicationController
    include ClientScopeRequest

    def shape
      definition = ClientScope.fetch(params.require(:scope))
      authorize! definition.subject(scope_params), to: definition.policy_action

      result = Proxy.new.call(definition.shape_definition(scope_params), request.query_parameters)
      result.headers.each { |key, value| response.set_header(key, value) }
      render plain: result.body, status: result.status, content_type: result.headers["content-type"]
    end
  end
end
