# frozen_string_literal: true

# A Ruby-like way to expose a server-defined Active Record scope as a named
# client-side scope. It reads like a normal `scope` declaration plus the one
# security-critical rider, the columns to ship:
#
#   client_scope :sheet_cells, ->(sheet_id) { for_sheet(sheet_id) },
#     ship: %i[row col value formula]
#
# Everything else is derived, so the boundary is stated once:
#   - params         the scope lambda's own parameters, coerced to Integer at the
#                    boundary (ids)
#   - relation       the lambda, run in the model's context (it composes real
#                    scopes like for_sheet, not a parallel query)
#   - electric_where read back from the relation's own conditions
#                    (where_values_hash), so the Electric filter cannot drift from
#                    the server relation: they are the same object
#   - via / subject  the belongs_to whose foreign key the scope filters on
#                    (sheet_id -> :sheet); pass via: to override when ambiguous
#   - authorize      defaults to :sync? (the read rule); we fail loudly at boot if
#                    that policy rule is not defined, so a scope is never silently
#                    shipped without an authorization gate
#   - columns        the primary key and that foreign key are always included (you
#                    cannot replicate without them); ship: lists only the payload
#                    columns, which is the deliberate, reviewable data surface
module ClientScopable
  extend ActiveSupport::Concern

  class_methods do
    def client_scope(name, body, ship:, authorize: :sync?, via: nil)
      model = self
      param_keys = body.parameters.filter_map { |type, key| key if %i[req keyreq].include?(type) }
      keyword = body.parameters.any? { |type, _| type == :keyreq }

      via ||= ClientScopable.derive_via(model, param_keys)
      reflection = model.reflect_on_association(via) ||
        raise(ArgumentError, "client_scope #{name}: no association #{via.inspect} on #{model}")

      ClientScopable.assert_policy_rule!(name, reflection.klass, authorize)

      coerce = ->(params) { param_keys.index_with { |key| Integer(params.fetch(key)) } }
      relation = lambda do |params|
        values = coerce.call(params)
        keyword ? model.instance_exec(**values, &body) : model.instance_exec(*values.values, &body)
      end

      ClientScope.register(
        name,
        model: model,
        columns: ([model.primary_key, reflection.foreign_key] + ship).map(&:to_sym).uniq,
        policy_action: authorize,
        relation: relation,
        electric_where: ->(params) { relation.call(params).where_values_hash.symbolize_keys.transform_values { Integer(it) } },
        subject: ->(params) { reflection.klass.find(Integer(params.fetch(reflection.foreign_key.to_sym))) }
      )
    end
  end

  # Derive the policy subject's association from the scope's filter: the
  # belongs_to whose foreign key is one of the scope's params (sheet_id -> :sheet).
  def self.derive_via(model, param_keys)
    candidates = model.reflect_on_all_associations(:belongs_to)
      .select { |reflection| param_keys.include?(reflection.foreign_key.to_sym) }

    case candidates.size
    when 1 then candidates.first.name
    when 0
      raise ArgumentError, "client_scope: cannot derive `via:`: no belongs_to on " \
        "#{model} whose foreign key is among #{param_keys.inspect}; pass via: explicitly"
    else
      raise ArgumentError, "client_scope: ambiguous `via:` between " \
        "#{candidates.map(&:name).inspect}; pass via: explicitly"
    end
  end

  # Fail at boot if the rule that guards replication is not defined, so a scope is
  # never silently shipped without an authorization gate. (If a policy expresses
  # the rule via alias_rule rather than a method, pass authorize: explicitly.)
  def self.assert_policy_rule!(name, subject_klass, rule)
    policy = "#{subject_klass}Policy".safe_constantize
    # public_method_defined? mirrors how Action Policy invokes a rule (public_send),
    # so a rule that exists but isn't callable as a rule still fails the check.
    return if policy&.public_method_defined?(rule)

    raise ArgumentError, "client_scope #{name}: #{subject_klass}Policy##{rule} is not " \
      "defined (the rule that guards replication); define it or pass authorize:"
  end
end
