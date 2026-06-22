# Primitives and tooling for reactive, local-first Rails

A proposal from the `client-side-scopes` experiment, for Marco Roth
(Herb / ReActionView), Vladimir Dementyev (Layered Design), and the team. It
looks past our one demo at two app shapes Rails should serve natively, and the
primitives and tooling that would get it there.

## Two app shapes, one missing capability

1. **Highly interactive apps** built on Hotwire, or on Rails with Inertia and
   React / Vue / Svelte. Many fragments on screen update as data changes. The
   render path runs often and has to stay cheap.
2. **Zero-latency professional apps**: a local database in the client,
   local-first reads, the server as the authority. Every interaction is instant
   because it never waits on the network.

Both need the same thing: **a view fragment that re-renders when the data it
depends on changes.** Rails' current answer, `broadcasts_to` from the model,
serves neither well. It couples the model to the view, it assumes the change
originates on the server and travels over a socket, and it leaves "which fragment
depends on what" to hand-wired stream names.

## The shift: derive reactivity from data

Reactivity should be computed from the shape of the data a fragment reads. A
fragment names the query it depends on; when that query's result set changes, the
fragment re-renders. The dependency arrow points down: Presentation depends on
Domain, and the model stays a pure domain object.

This is portable across both app shapes and across transports. The "what changed"
signal can come from Postgres `LISTEN/NOTIFY`, a live query over a local replica,
Solid Cable, or polling. The primitive does not mandate one.

## Proposed primitives

### A shippable scope (Domain)

A model declares a named, authorized slice of its data that a client may hold
locally. One declaration is the query, the authorization rule, and the sync
shape, with the replication filter derived from the same relation so they cannot
drift.

```ruby
client_scope :sheet_cells, ->(sheet_id) { for_sheet(sheet_id) },
  ship: %i[row col value formula]
```

This is the foundation for local-first Rails: "what may this client replicate,
and under what policy" lives in one place and reads like `scope`.

### An observable query (Domain)

A query object whose result-set signature is its dependency. The thing a fragment
watches is derived from an Active Record relation, authored once.

```ruby
class GridWindow < ApplicationQuery
  observable_by :window           # the watched signal is window's result set
  def window = cells.where(row: 1..@limit).order(:row, :col)
end
```

Because the dependency is the data, it survives dynamic rendering (a partial
chosen at request time) that template-structure analysis cannot follow. The same
relation produces the server render and the change signal.

### A live region (Presentation)

A tag helper in the `turbo_frame_tag` family, whose trigger is a result-set
change rather than a model broadcast.

```erb
<%= live_region :totals, sheet: @sheet %>
```

First paint is server-rendered; updates re-render the same template and patch the
node. The model never names a target.

**The rule that keeps it native:** a region depends on a query, a query never
depends on a region, a model never depends on either.

## Proposed tooling

The primitives raise render frequency, which puts new weight on the template
toolchain. This is where Herb / ReActionView fits.

### Compile-time value formatting, in place of runtime helpers

`number_to_currency`, `number_with_precision`, `l(date)` and friends are
interpreted Ruby on every render. In a fragment that repaints on every data
change, or that runs in a constrained client runtime, that per-call machinery is
a measurable share of render time; in our experiment it was the single largest
cost in a fragment re-render. A formatting layer the template **compiles in**,
reducing locale-aware output to plain string operations at build time, removes
that cost while the template's surface stays the same. This is squarely L3/L5 on
the ReActionView roadmap, and it pays off most where reactive fragments repaint
often.

### Reactive-aware template analysis

Dependency and dead-code analysis has to follow **dynamically resolved renders**
(`render partial: runtime_value`). A static render graph reports reactive
partials, the ones addressed by a value computed at request time, as unused. The
toolchain needs a way to recognize or annotate reactive fragments so the linter
helps rather than misfires.

### Slot diffing as the patch step

Re-render-and-morph is a placeholder for a real **slot-diffing renderer**:
re-render the fragment, diff against the prior output at the slot level, emit the
minimal patch. Shipping that as a renderer output (Marco's L4/L5) lets every live
region upgrade its patch step without touching its wiring.

## When each helps

| Capability | Highly interactive (Hotwire / Inertia+React) | Zero-latency local-first |
| --- | --- | --- |
| Shippable scope | Optional; the server stays the source | **Foundational**: defines the local replica and its policy |
| Observable query | Cheap, correct dependency tracking for many live fragments | The local live query that drives instant updates |
| Live region | Declarative reactive fragments without broadcast plumbing | Renders from the local DB with no round trip |
| Compile-time formatting | Cuts render cost at high update frequency | Essential on constrained client runtimes |
| Reactive-aware analysis | Keeps linters honest as fragments multiply | Same |
| Slot diffing | Smaller patches, less DOM churn | Smaller patches, less client work |

## Adopting it without a rewrite

The path is incremental and matches how Rails teams already work:

1. **Tooling first.** Adopt the Herb toolchain now (valid-HTML templates are the
   precondition for everything downstream), and the compile-time formatter and
   reactive-aware analysis as they land. No app changes.
2. **Primitives next.** Introduce observable queries and live regions in the hot
   fragments of an existing Hotwire app, leaving the rest untouched. They read
   like `scope` and `turbo_frame_tag`, so they feel native on day one.
3. **Local-first when it pays.** Add a shippable scope and a client replica only
   for the surfaces that need zero latency. The same templates and queries serve
   both the server-rendered and the local-first paths.

The throughline: keep the model a pure domain object, derive reactivity from
data, and let the template toolchain make the high-frequency render cheap. That
is reactive Rails that still feels like Rails.
