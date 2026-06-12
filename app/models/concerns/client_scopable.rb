# frozen_string_literal: true

# A Ruby-like way to expose a server-defined Active Record scope as a named
# client-side scope. One declaration on the model, next to the scope it builds
# on, instead of a hand-written registry entry:
#
#   client_scope :sheet_cells, ->(sheet_id:) { for_sheet(sheet_id) },
#     authorize: :sync?, via: :sheet, ship: %i[id sheet_id row col value formula]
#
# What it derives, so the boundary is stated once:
#   - relation       — the body, run in the model's context (it composes real
#                      scopes like for_sheet, not a parallel query)
#   - electric_where  — read back from the relation's own conditions
#                      (where_values_hash), so the Electric filter cannot drift
#                      from the server relation: they are the same object
#   - subject        — the parent record named by `via:`, found by its foreign
#                      key (the association reflection gives both)
#   - params         — the body's required keywords, coerced to Integer at the
#                      boundary (ids)
#
# `ship:` (the column allow-list) stays explicit on purpose: it is the one
# security-critical choice, so it should be visible rather than inferred.
module ClientScopable
  extend ActiveSupport::Concern

  class_methods do
    def client_scope(name, body, authorize:, via:, ship:)
      model = self
      param_keys = body.parameters.filter_map { |type, key| key if type == :keyreq }
      reflection = reflect_on_association(via) ||
        raise(ArgumentError, "client_scope #{name}: no association #{via.inspect} on #{model}")

      coerce = ->(params) { param_keys.index_with { |key| Integer(params.fetch(key)) } }
      relation = ->(params) { model.instance_exec(**coerce.call(params), &body) }

      ClientScope.register(
        name,
        model: model,
        columns: ship,
        policy_action: authorize,
        relation: relation,
        electric_where: ->(params) { relation.call(params).where_values_hash.symbolize_keys.transform_values { Integer(it) } },
        subject: ->(params) { reflection.klass.find(Integer(params.fetch(reflection.foreign_key.to_sym))) }
      )
    end
  end
end
