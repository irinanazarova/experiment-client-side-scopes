# frozen_string_literal: true

# The one new primitive: a transport-neutral name for "this slice of data
# changed." A topic is derived from an Active Record relation (its table plus its
# equality conditions), so a writer and a subscriber rendezvous on the same
# string without naming each other, and without the model knowing about any
# view.
#
#   DataChange.topic(Cell.where(sheet_id: 1))  # => "cells/sheet_id=1"
#
# Producers publish a topic when data moves; consumers subscribe to it. How the
# signal travels (a Turbo refresh broadcast, an Inertia reload, a local live
# query) is the transport's job, chosen per route, not baked in here. This is the
# layer Rails skips today: broadcasts_to goes straight from a model write to a
# Turbo Stream; ActiveSupport::Notifications is instrumentation. Neither is a
# data-change name you can point any transport at.
module DataChange
  module_function

  # A stable stream name for a relation. Only equality conditions reduce to a
  # name: a writer touching any row in the slice wakes every subscriber to it,
  # and a cheap morphing re-render keeps that fine. Relations with ranges or
  # joins fall back to the table-level name.
  def topic(relation)
    conditions = relation.where_values_hash.sort.map { |key, value| "#{key}=#{value}" }
    [relation.klass.table_name, *conditions].join("/")
  end
end
