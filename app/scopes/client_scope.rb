# frozen_string_literal: true

# Application layer. The "named client-side scope" abstraction.
#
# A client subscribes by NAME, never by an arbitrary query (a client-supplied
# replication query would be a data-exfiltration hole). Each scope declares, in
# one place, the pieces that share one boundary:
#   - relation:       the server-side Active Record scope (source of truth for reads)
#   - electric_where: the explicit, parameterized Electric filter (the trust boundary)
#   - columns:        the allow-list of columns safe to ship
#   - policy_action:  the Action Policy rule a subscriber must pass
#   - subject:        the record the policy authorizes against
#
# Declared with ClientScope.define (see config/initializers/client_scopes.rb),
# NOT on the model: which slice ships to a client, under what columns and policy,
# is a sync/transport concern, so the domain model stays a plain Active Record
# class with plain scopes. `define` derives everything else from the scope:
#   - params         the scope lambda's own parameters, coerced to Integer (ids)
#   - model          read off the relation the scope returns (no DB at boot)
#   - electric_where read back from the relation's own conditions
#                    (where_values_hash), so the filter cannot drift from the relation
#   - via / subject  the belongs_to whose foreign key the scope filters on
#                    (sheet_id -> :sheet); pass via: to override when ambiguous
#   - authorize      defaults to :sync?; fail loudly at boot if that policy rule
#                    is not defined, so a scope is never shipped without a gate
class ClientScope
  class UnknownScope < KeyError; end

  Definition = Data.define(
    :name, :model, :payload_columns, :policy_action,
    :relation_builder, :electric_where_builder, :subject_builder
  ) do
    def relation(params) = relation_builder.call(params)
    def electric_where(params) = electric_where_builder.call(params)
    def subject(params) = subject_builder.call(params)

    # The full column allow-list shipped to the client: the declared payload plus
    # the primary key, resolved lazily so declaring a scope never connects at boot.
    def columns
      ([model.primary_key.to_sym] + payload_columns).uniq
    end

    # The Electric Shape this scope authorizes, derived entirely server-side.
    def shape_definition(params)
      Electric::ShapeDefinition.new(table: model.table_name, columns:, where: electric_where(params))
    end
  end

  REGISTRY = {}
  private_constant :REGISTRY

  # Declare a named client-side scope from a server scope. Reads like the scope
  # plus the columns to ship; everything else is derived, so the boundary is
  # stated once and cannot drift.
  #
  #   ClientScope.define :sheet_cells,
  #     scope: ->(sheet_id) { Cell.for_sheet(sheet_id) },
  #     ship: %i[row col value formula]
  def self.define(name, scope:, ship:, authorize: :sync?, via: nil)
    param_keys = scope.parameters.filter_map { |type, key| key if %i[req keyreq].include?(type) }
    keyword = scope.parameters.any? { |type, _| type == :keyreq }
    coerce = ->(params) { param_keys.index_with { |key| Integer(params.fetch(key)) } }
    relation = lambda do |params|
      values = coerce.call(params)
      keyword ? scope.call(**values) : scope.call(*values.values)
    end

    # The model is whatever the scope returns; read it without touching the DB.
    model = relation.call(param_keys.index_with { 0 }).klass

    via ||= derive_via(model, param_keys)
    reflection = model.reflect_on_association(via) ||
      raise(ArgumentError, "client_scope #{name}: no association #{via.inspect} on #{model}")

    assert_policy_rule!(name, reflection.klass, authorize)

    register(
      name,
      model: model,
      # Payload columns + the scoping foreign key (both known without the DB); the
      # primary key is prepended lazily in Definition#columns.
      payload_columns: ([reflection.foreign_key] + ship).map(&:to_sym).uniq,
      policy_action: authorize,
      relation: relation,
      electric_where: ->(params) { relation.call(params).where_values_hash.symbolize_keys.transform_values { Integer(it) } },
      subject: ->(params) { reflection.klass.find(Integer(params.fetch(reflection.foreign_key.to_sym))) }
    )
  end

  def self.register(name, model:, payload_columns:, policy_action:, relation:, electric_where:, subject:)
    key = name.to_sym
    raise ArgumentError, "client scope #{key} already registered" if REGISTRY.key?(key)

    REGISTRY[key] = Definition.new(key, model, payload_columns, policy_action, relation, electric_where, subject)
  end

  def self.fetch(name)
    REGISTRY.fetch(name.to_sym) { raise UnknownScope, "unknown client scope: #{name}" }
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
    return if policy&.public_method_defined?(rule)

    raise ArgumentError, "client_scope #{name}: #{subject_klass}Policy##{rule} is not " \
      "defined (the rule that guards replication); define it or pass authorize:"
  end
end
