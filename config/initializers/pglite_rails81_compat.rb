# frozen_string_literal: true

# wasmify-rails 0.4.1 predates Rails 8.1, whose postgresql adapter reports
# `result.ntuples` in the query instrumentation payload (see
# PostgreSQL::DatabaseStatements#perform_query). Extend the gem's PGlite
# result shim with the missing PG::Result method. Upstream candidate.
return unless on_wasm?

require "active_record/connection_adapters/pglite_adapter"

module PGlite
  class Result
    def ntuples = @res[:rows][:length].to_i
  end
end
