# Primitives and tooling for reactive, local-first Rails

A proposal from the `client-side-scopes` experiment, for Marco Roth
(Herb / ReActionView), Vladimir Dementyev (Layered Design), and the team. The
goal is better Rails-native primitives for collaborative, realtime, and
zero-latency user experience: features that update the moment the data behind
them changes. It looks past our one demo at the stacks that would receive such
primitives, and the tooling that would make them cheap.

## Three receivers, one missing capability

Rails reaches the browser through three stacks today, and a reactive primitive
has to land in all three:

1. **Hotwire**: server-rendered HTML over the wire, Turbo and Stimulus.
2. **Inertia + React / Vue / Svelte**: the controller returns props, a client
   component renders them, with no separate API layer. Props over the wire.
3. **Local-first**: a database in the client, local-first reads, the server as
   the authority. Nothing over the wire on the read path.

All three want the same thing: **a view that re-renders when the data it depends
on changes.** Rails' current answer, `broadcasts_to` from the model, only serves
the first, and even there it couples the model to a named stream and a DOM
target.

The first two stacks share a deeper trait worth naming up front: both are
**server-authoritative**. Hotwire ships HTML, Inertia ships props, and in each
the server recomputes and the client swaps. Inertia's protocol is strictly
request and response with no server push; "realtime" there is a client timer
(`usePoll`) or an Action Cable signal that triggers a reload. So a single
primitive can serve both, and the third stack is where the model genuinely
changes.

## The shift: make the change signal a property of the data

Reactivity should be computed from the shape of the data a view reads. A view
declares the query it depends on; when that query's result set changes, the view
updates. The dependency arrow points down: Presentation depends on Domain, and
the model stays a pure domain object.

The signal is one primitive. How a stack consumes it differs. The signal itself
is transport-agnostic: it can ride Postgres `LISTEN/NOTIFY`, Action Cable, a
local live query, or polling.

## The primitives

### Observable query (Domain): the universal change signal

A query object whose result-set signature is an addressable dependency. The thing
a view watches is derived from an Active Record relation, authored once.

```ruby
class GridWindow < ApplicationQuery
  observable_by :window           # the watched signal is window's result set
  def window = cells.where(row: 1..@limit).order(:row, :col)
end
```

Because the dependency is the data, it survives dynamic rendering (a view chosen
at request time) that template-structure analysis cannot follow. This one
primitive lands in every stack:

- **Hotwire** re-renders the fragment server-side and streams the HTML (or
  morphs it). This is the data-derived successor to a Turbo Frame's
  `refreshes_on`: the trigger is a result-set change, with no `broadcasts_to`
  wiring on the model.
- **Inertia** turns the signal into a precise partial reload. Today a live
  Inertia view either polls blindly (`usePoll(2000, { only: ['totals'] })`) or
  reloads on a bare Action Cable ping that carries no information about what
  changed. An observable query's signal *is* that information:

  ```js
  // the prop name is the join: observable-query dependency  <=>  Inertia prop
  onSignal("totals", () => router.reload({ only: ["totals"] }))
  ```

  The server then re-evaluates only that prop's lambda
  (`InertiaRails.optional { ColumnAggregates.new(sheet).by_column }`), so the
  update is event-driven and minimal, and the backend stays the single source of
  truth. Inertia already has the receiver (`router.reload({ only })`); the
  observable query supplies the missing precision.
- **Local-first** runs the same query as a live query against the local replica
  and re-renders in the client.

### Shippable scope (Domain): the local-first foundation

A model declares a named, authorized slice of its data that a client may hold
locally. One declaration is the query, the authorization rule, and the sync
shape, with the replication filter derived from the same relation so they cannot
drift.

```ruby
client_scope :sheet_cells, ->(sheet_id) { for_sheet(sheet_id) },
  ship: %i[row col value formula]
```

This is the primitive the local-first stack is built on, and it is the one place
the three receivers diverge sharply:

- **Hotwire**: optional. The server stays the source; a shippable scope only
  matters if you add a client replica.
- **Inertia**: friction. Inertia is server-authoritative and discourages a
  client store (its only memory is `history.state`, not a queryable replica; the
  sole offline effort, `inertia-offline`, is a beta service-worker cache of whole
  JSON payloads). A shippable scope would live *beside* Inertia, with components
  reading the local store instead of props, which reduces Inertia to routing and
  boot.
- **Local-first**: foundational. It defines the replica and its policy.

Stating that boundary plainly matters: a local replica is a third model that
neither HTML-over-the-wire nor props-over-the-wire was built for.

### Live region (Presentation): the Hotwire receiver

A tag helper in the `turbo_frame_tag` family, whose trigger is a result-set
change rather than a model broadcast.

```erb
<%= live_region :totals, sheet: @sheet %>
```

This one is Hotwire-shaped and has **no Inertia equivalent**: Inertia ships props,
not HTML fragments, so there is no server-rendered region to target. The Inertia
analogue is always "re-send the prop, let the component re-render." Worth saying
so the proposal does not overreach.

**The rule that keeps all of this native:** a view depends on a query, a query
never depends on a view, a model never depends on either.

## The tooling

Higher render frequency puts new weight on the template toolchain. This is where
Herb / ReActionView fits, and it serves the server-rendered paths (Hotwire and
the local-first in-client render); Inertia's components carry their own JS build.

### Compile-time value formatting, in place of runtime helpers

`number_to_currency`, `number_with_precision`, `l(date)` and friends are
interpreted Ruby on every render. In a fragment that repaints on every data
change, or that runs in a constrained client runtime, that per-call machinery is
a measurable share of render time; in our experiment it was the single largest
cost in a fragment re-render. A formatting layer the template **compiles in**,
reducing locale-aware output to plain string operations at build time, removes
that cost while the template surface stays identical. This is L3/L5 on the
ReActionView roadmap, and it pays off most where reactive fragments repaint often.

### Reactive-aware template analysis

Dependency and dead-code analysis has to follow **dynamically resolved renders**
(`render partial: runtime_value`). A static render graph reports reactive
partials, the ones addressed by a value computed at request time, as unused. The
toolchain needs a way to recognize or annotate reactive fragments so the linter
helps rather than misfires.

### Slot diffing as the patch step

Re-render-and-morph is a placeholder for a real **slot-diffing renderer**:
re-render the fragment, diff against the prior output at the slot level, emit the
minimal patch. Shipping that as a renderer output (Marco's L4/L5) lets every
Hotwire live region upgrade its patch step without touching its wiring.

## Objections to answer (the DHH lens)

The proposal is stronger for answering its sharpest critic.

- **"`broadcasts_to` is not a layer violation, it is conceptual compression."**
  A model declaring "when I change, refresh my view" in one line is the Rails
  way. Fair, for server-rendered apps. The data-derived version earns its place
  on capability, not purity: a dependency that survives dynamic rendering, the
  precise Inertia reload that replaces blind polling, and a path to local-first
  where there is no socket to broadcast over. Keep `broadcasts_to` for the common
  case; reach for an observable query when a view's dependency is a query result
  rather than one record's lifecycle.
- **"HTML over the wire is enough."** For most apps, yes, and Inertia's
  props-over-the-wire shares that assumption. So lead with the server-rendered
  win: the observable query upgrades both Hotwire and Inertia without any local
  database. Local-first is the genuinely contested frontier, claimed only for
  apps with a hard latency floor, never as a default.
- **"No new app-visible layers."** A query-object hierarchy and an `observable_by`
  DSL are the abstraction tax DHH avoids. The answer is conceptual compression:
  each primitive should read like one line, like `scope` or `turbo_frame_tag`,
  with the machinery inside the framework. If it needs a diagram to justify, it
  is a library, not a primitive.
- **The tooling is where he is already going.** Turbo 8 morphing and
  `broadcasts_refreshes` are Rails core moving toward "data changed, re-render,
  morph." Compile-time formatting and slot diffing extend that invisibly, with no
  API change. Start there.

## When each helps

| Capability | Hotwire | Inertia + React/Vue/Svelte | Local-first |
| --- | --- | --- | --- |
| Observable query | Re-render and stream/morph the fragment | Precise `router.reload({ only })`, ends blind polling | The local live query that drives instant reads |
| Shippable scope | Optional; server stays the source | Friction; lives beside Inertia, not through it | Foundational: defines the replica and its policy |
| Live region | Native receiver | No equivalent (props, not HTML fragments) | Renders from the local DB with no round trip |
| Compile-time formatting | Cuts render cost at high frequency | Handled by the JS framework | Essential on constrained client runtimes |
| Reactive-aware analysis | Keeps linters honest as fragments multiply | Not applicable (no ERB) | Same as Hotwire |
| Slot diffing | Smaller patches, less DOM churn | Not applicable | Smaller patches, less client work |

## Adopting it without a rewrite

The path is incremental and matches how Rails teams already work:

1. **Tooling first.** Adopt the Herb toolchain now (valid-HTML templates are the
   precondition for everything downstream), then the compile-time formatter and
   reactive-aware analysis as they land. No app changes.
2. **The observable query next, server-side.** Drop it into the hot fragments of
   an existing Hotwire or Inertia app. In Hotwire it reads like `turbo_frame_tag`;
   in Inertia it turns a blind poll into a targeted reload. No client database
   required.
3. **Local-first when it pays.** Add a shippable scope and a client replica only
   for the surfaces that need zero latency. The same queries serve both the
   server-rendered and the local-first paths.

The throughline: keep the model a pure domain object, make the change signal a
property of the data, and let the toolchain make the high-frequency render cheap.
That is reactive Rails that still feels like Rails.
