# frozen_string_literal: true

# Application layer. The "named client-side scope" abstraction.
#
# A client subscribes by NAME, never by an arbitrary query (a client-supplied
# replication query would be a data-exfiltration hole). Each scope declares,
# in one place, the pieces that share one boundary:
#   - relation:       the server-side Active Record scope (source of truth for reads)
#   - electric_where: the explicit, parameterized Electric filter (the trust boundary)
#   - columns:        the allow-list of columns safe to ship
#   - policy_action:  the Action Policy rule a subscriber must pass
#   - subject:        the record the policy authorizes against
#
# relation and electric_where describe the same slice from two angles; a spec
# pins that they agree. Domain (the relation) -> Application (this + policy) ->
# Infrastructure (Electric) is the unidirectional path.
class ClientScope
  class UnknownScope < KeyError; end

  Definition = Data.define(
    :name, :model, :columns, :policy_action,
    :relation_builder, :electric_where_builder, :subject_builder
  ) do
    def relation(params) = relation_builder.call(params)
    def electric_where(params) = electric_where_builder.call(params)
    def subject(params) = subject_builder.call(params)

    # The Electric Shape this scope authorizes, derived entirely server-side:
    # the table and column allow-list are declared, the where is the explicit
    # trust-boundary filter. Every endpoint that issues a shape goes through
    # here, so what the client may replicate is defined in exactly one place.
    def shape_definition(params)
      Electric::ShapeDefinition.new(
        table: model.table_name,
        columns: columns,
        where: electric_where(params)
      )
    end
  end

  REGISTRY = {}
  private_constant :REGISTRY

  def self.register(name, model:, columns:, policy_action:, relation:, electric_where:, subject:)
    key = name.to_sym
    raise ArgumentError, "client scope #{key} already registered" if REGISTRY.key?(key)

    REGISTRY[key] = Definition.new(key, model, columns, policy_action, relation, electric_where, subject)
  end

  def self.fetch(name)
    REGISTRY.fetch(name.to_sym) { raise UnknownScope, "unknown client scope: #{name}" }
  end
end

# Scopes register themselves declaratively on their models via the
# ClientScopable macro (e.g. Cell.client_scope :sheet_cells). This registry is
# the low-level seam the controllers and the Electric proxy resolve against.
