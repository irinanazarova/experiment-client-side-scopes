# What to test, and what you should see

Reproduction steps for each property the POC demonstrates. Run it first (see the
[README](../README.md)) and open `http://localhost:3000/sheets/1`.

## 1. The spreadsheet + local aggregates (reads are local and instant)
Open `/sheets/1`. The first paint is server-rendered with real data; after a
moment the status line turns green: *"Replica live. Stats, Max column and Σ
row are computed locally by PGlite."* You see the stats header (Max / Min /
Average / Median in large type; the median is a real `PERCENTILE_CONT`
ordered-set aggregate), a sticky green **Max** column with each row's
maximum, and the indigo **Σ** totals row. All of it aggregates the full
50,000 cells and is computed by PGlite **in your browser**. Open
DevTools -> Network: there is no request per aggregate.

## 1b. The live data-flow trace
Under the controls is a **Live data flow** panel: five nodes (Edit → PGlite
replica → Rails authority → Electric WAL → Render). Each gesture lights the
hops it travels, color-coded (green = local/no network, indigo = crossed the
wire to the authority, amber = Electric reconciling) with per-hop timing, plus
a rolling event log. It makes the "reads local, writes to the authority,
reconcile via Electric" loop visible while you use it, and works in both
standalone and slice modes (the in-browser Rails service worker emits the
same events).

## 1c. Live updates, colour-coded by origin
Edits blink so you can see where each change came from. A change **you** make
blinks **yellow**; a change that arrives from elsewhere (the server, another
client) blinks **green**. The client decides the colour by whether it
initiated the change, so the two directions of the sync loop are visually
distinct.

To see server-originated (green) updates, toggle **Server activity** in
the toolbar. While on, the page posts one tick every two seconds to
`POST /cells/ticks`; the server sets a random 5-cell vertical section in the
always-on-screen window (rows 1–25, cols 1–10) to a new random value, through
the same `Cells::BulkUpdate` write authority, commits, and Electric streams it
to every replica, so a small cluster of ~5 green flashes lands here and in any
other open tab. Edit a column and watch those blink yellow. (No console needed;
the same tick is also available headless as `bin/rails cells:simulate`.)

## 2a. Edit one cell (per-cell write)
Click any cell, type a number, press Enter. The cell and its column's Σ update
instantly (no network); the write posts to Rails; Electric reconciles. Verify:
```bash
bin/rails runner 'puts Cell.find_by(sheet_id:1, row:1, col:1).value'
```

## 2b. Optimistic bulk write + reconcile (the core loop)
Set Column = 3, Operation = multiply, Operand = 2, click **Apply to whole
column**.
- The whole column and its Σ update in **~15-20 ms with no network**
  (see the timing text).
- The status line shows *"Server updated 2500 cells. Electric reconciling
  replica..."*. The write went to Rails as one transaction; Electric streams the
  authoritative rows back; the local value settles on the server's.
- Verify they agree:
  ```bash
  bin/rails runner 'puts Cells::ColumnAggregates.new(Sheet.first).by_column[3]'
  ```
  matches the col-3 sum on screen.

## 3. Server -> client push (multi-client, no refresh)
With `/sheets/1` open and untouched, run a write as if from another client:
```bash
bin/rails runner '
  region = Cells::Region.new(sheet_id: 1, row_from: 1, row_to: 2500, col_from: 10, col_to: 10)
  transform = Cells::Transform.new(operation: :add, operand: "1000")
  Cells::BulkUpdate.new(user: nil, region:, transform:).call'
```
Within a few seconds the browser's col-10 sum jumps by 2,500,000 on its own.
That is the WAL -> Electric -> PGlite -> live query -> morph path, no user action.

## 4. Rollback on rejection (the safety property: no divergence)
Temporarily make the server reject writes:
```bash
# in app/policies/sheet_policy.rb, set:  def update? = false
```
Reload `/sheets/1`, apply any change to a column. The value flips optimistically
then **rolls back**, and the status shows
*"Server rejected (403)... Rolled back, replica still matches server."* The
replica never diverges from the (unchanged) server. Restore `def update? = true`
afterward.

## 5. Ruby in the browser (Phase B, the AR-adapter bridge)
Open `http://localhost:3000/wasm`. It boots real CRuby (ruby.wasm), which
queries the same PGlite replica through a `Pglite::Connection` seam and computes
the grand total in Ruby. The Ruby panel matches the JS panel, and the status
shows *"Bridge proven..."*. This is the async boundary the full ActiveRecord ->
PGlite adapter sits on.

## 6. Real ActiveRecord in the VM (Phase B+)
Open `http://localhost:3000/wasm_ar`. It downloads a 55 MB ruby.wasm with the
real `activerecord` gem packed in, runs it in the tab, defines a pure-Ruby
`PgliteAdapter`, and climbs a staged ladder: raw `exec_query`, then Arel
composing SQL in the VM, then the payoff stage, the full model API
`Cell.where(sheet_id: 1).group(:col).sum(:value)` running through
model -> relation -> connection pool -> adapter -> PGlite. AR's own pool
deadlocks in single-threaded Wasm (its checkout waits need a second thread to
signal them), so the VM installs a threadless one-connection pool. Every stage
logs in the page; the final Σ matches the JS panel. First load is slow
(downloads + boots the VM); subsequent loads are cached.

To rebuild the wasm (only if you change the packed gems):
```bash
cd wasm_build && bundle exec rbwasm build --ruby-version 3.4 --build-profile full -o ruby-app.wasm
cp ruby-app.wasm ../public/ruby-app.wasm
```

## 7. The Rails slice in the browser (Phase C, wasmify-rails)
The whole app, packed by `wasmify-rails`, boots inside a service worker and
serves pages in the tab: real router, controllers, Active Record over the
`pglite` adapter, ActionView. Reads come from the same Electric-synced
replica.
```bash
bin/rails slice:pack              # builds + strips pwa/public/app.wasm (~112 MB; slow the first time)
cd pwa && npm install && npm run dev
```
Open `http://localhost:5173/boot.html` and wait for *"Service Worker Ready"*
(the first boot compiles the module). Then:
- `http://localhost:5173/sheets/1` is the spreadsheet, **served by Rails
  running in your browser**, down to the `cells.count` in the header.
- `http://localhost:5173/sheets/1/aggregates` (in-browser Rails reading the
  replica) returns the same JSON as
  `http://localhost:3000/sheets/1/aggregates` (host Rails reading server
  Postgres). Same action, same query object, two databases.
- Boot problems? `http://localhost:5173/debug.html` runs the identical stack
  in the page and prints every step and the failing backtrace.

In this mode the page is thin Hotwire over one replica (the worker's),
composed of **live regions**: the stats panel, the Σ row, and the grid body
are each an ERB partial bound to the SQL it depends on. The worker runs that
SQL as a PGlite live query and, when its result changes, names the region;
the page re-fetches just that fragment (**rendered by ActionView in the tab**,
no network) and morphs it. So an edit inside the visible window resettles all
three regions, while an edit *outside* it resettles only the aggregates and
leaves the grid body untouched, the live query is the dependency graph.

The optimistic write is application code: the worker dispatches the same POST
into the in-VM Rails first, so `Cells::BulkUpdate` runs locally against the
replica, then forwards it to host Rails, the write authority, as one
transaction. Electric reconciles onto the authoritative rows; a rejected
write (422) restores the snapshot and the replica never diverges.
