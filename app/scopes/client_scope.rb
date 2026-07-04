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
#   - model          read off the relation the scope returns
#   - electric_where read back from the relation's own conditions
#                    (where_values_hash), so the filter cannot drift from the relation
#   - via / subject  the belongs_to whose foreign key the scope filters on
#                    (sheet_id -> :sheet); pass via: to override when ambiguous
#   - authorize      defaults to :sync?; the policy rule is checked the first time
#                    the scope is used, so a scope is never shipped without a gate
#
# Everything that needs the model (its associations, the policy subject, the
# column list) resolves LAZILY on first use, never at declaration time: building
# a relation reads the table schema, so resolving at boot would require a
# database connection, and the app must boot without one (asset precompile and
# the wasm pack do exactly that).
class ClientScope
  class UnknownScope < KeyError; end

  # One registered scope. Stores the raw declaration; the model and the pieces
  # derived from it resolve once, memoized, on first use.
  class Definition
    attr_reader :name, :policy_action

    def initialize(name:, scope:, ship:, authorize:, via:)
      @name = name
      @scope = scope
      @ship = ship.map(&:to_sym)
      @policy_action = authorize
      @via = via
      @param_keys = scope.parameters.filter_map { |type, key| key if %i[req keyreq].include?(type) }
      @keyword = scope.parameters.any? { |type, _| type == :keyreq }
    end

    # The server relation for these params, with ids coerced to Integer (the one
    # place request strings become the trusted filter values).
    def relation(params)
      values = @param_keys.index_with { |key| Integer(params.fetch(key)) }
      @keyword ? @scope.call(**values) : @scope.call(*values.values)
    end

    # The Electric filter, read back out of the relation's own conditions so it
    # cannot drift from what the scope actually selects.
    def electric_where(params)
      relation(params).where_values_hash.symbolize_keys.transform_values { Integer(it) }
    end

    # The record the policy authorizes against (the scope's belongs_to parent).
    def subject(params)
      reflection.klass.find(Integer(params.fetch(reflection.foreign_key.to_sym)))
    end

    # The full column allow-list shipped to the client: the primary key, the
    # scoping foreign key, and the declared payload.
    def columns
      ([model.primary_key.to_sym, reflection.foreign_key.to_sym] + @ship).uniq
    end

    # The Electric Shape this scope authorizes, derived entirely server-side.
    def shape_definition(params)
      Electric::ShapeDefinition.new(table: model.table_name, columns:, where: electric_where(params))
    end

    # The model the scope returns. Reading the relation's klass builds a relation,
    # which touches the schema, so this is resolved lazily (never at boot).
    def model
      @model ||= relation(@param_keys.index_with { 0 }).klass
    end

    private

    # The belongs_to the scope filters on, resolved once. Asserting the policy
    # rule here (rather than at declaration) keeps boot database-free while still
    # failing loudly the first time an unguarded scope is used.
    def reflection
      @reflection ||= begin
        via = @via || ClientScope.derive_via(model, @param_keys)
        association = model.reflect_on_association(via) ||
          raise(ArgumentError, "client_scope #{@name}: no association #{via.inspect} on #{model}")
        ClientScope.assert_policy_rule!(@name, association.klass, @policy_action)
        association
      end
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
    key = name.to_sym
    raise ArgumentError, "client scope #{key} already registered" if REGISTRY.key?(key)

    REGISTRY[key] = Definition.new(name: key, scope:, ship:, authorize:, via:)
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

  # Fail loudly if the rule that guards replication is not defined, so a scope is
  # never silently shipped without an authorization gate. (If a policy expresses
  # the rule via alias_rule rather than a method, pass authorize: explicitly.)
  def self.assert_policy_rule!(name, subject_klass, rule)
    policy = "#{subject_klass}Policy".safe_constantize
    return if policy&.public_method_defined?(rule)

    raise ArgumentError, "client_scope #{name}: #{subject_klass}Policy##{rule} is not " \
      "defined (the rule that guards replication); define it or pass authorize:"
  end
end
