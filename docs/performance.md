# Performance: local-first vs classic Hotwire

What the POC costs and what it buys, measured against the live Fly deploy and the
local stack. The headline: the local-first read win comes from the browser
replica (PGlite + Electric), not from Rails-in-Wasm. Wasm is a separate axis.

All numbers below are measured, with the method noted. Network samples are from a
warm client to the `sjc` deploy; treat absolute latencies as representative of a
good network, and the *ratios* as the durable result.

## The three points on the curve

The same URL path is served three ways. They differ on two independent axes:
where the **data** lives, and where the **render** runs.

| | Data | Render | Server load per read | Entry cost |
|---|---|---|---|---|
| Classic Hotwire (`/sheets/1/hotwire`) | server | server | full (query + render) | lowest |
| Local-first precise (`/sheets/1`) | **browser** | browser (JS) | **zero** | HTML + PGlite + 50k seed |
| Slice (`client-side-scopes-slice.fly.dev`) | **browser** | **browser (Rails/Wasm)** | **zero** | + 9.4 MB `app.wasm` + ~10 s boot |

"Local-first" means the data is in the browser. `/sheets/1` does that with plain
JS render, no Wasm. The slice adds one thing: it moves the renderer into the tab
too, as ActionView compiled to Wasm.

## Initial load (measured, prod)

| | Server-side page (`/sheets/1`) | Slice loader |
|---|---|---|
| First HTML | 8.2 KB, server-rendered, windowed to 25 of 2,500 rows | 1.8 KB loader + 1.2 KB JS (brotli) |
| Heavy payload | none beyond the page | **`app.wasm` 9.4 MB brotli** (~52 MB raw) |
| Time to interactive | **~180 ms warm** (one round-trip) | **20-40 s first visit, ~10 s repeat** |

Method: `curl -w` timing to the Fly deploy, warm and cold; `app.wasm` size from
the `content-length` of the brotli response. The slice boot figure is the
loader's own estimate, consistent with the boot path (9.4 MB download + PGlite +
the Electric initial sync of the 50k-cell shape + the Ruby VM boot).

The gap is ~100-200x, and it is almost entirely one file. The slice's loader and
JS are ~3 KB combined; the whole barrier is the 9.4 MB wasm plus the ~10 s VM
boot. So "is the slice viable" reduces to "can you amortize one 9 MB download and
a 10 s boot." For a long-lived app tab, yes; for a landing page, no.

## Read latency (measured)

| Path | Cost |
|---|---|
| Server round-trip to `/sheets/1/aggregates`, real browser | **~61 ms median** (54-142 ms, 6 samples) |
| Rails render alone (`x-runtime`), server-side | **32 ms** |
| Local aggregate, PGlite in the tab | **no request** (page renders "computed locally by PGlite") |

Method: `fetch()` timing from the live page's own context for the round-trip;
the `x-runtime` response header for the server render; the page status line and
the precise route's live queries for the local path. On `/sheets/1` the page does
not make the `/aggregates` call in steady state, it reads the local replica, so
the 61 ms is the cost the route *avoids*, not one it pays.

The local win is real but modest in absolute ms on a warm fast network (server
render is only 32 ms, RTT is low). It widens exactly where it matters:
high-latency or mobile networks, and read-heavy interaction (live filtering,
per-keystroke aggregates, scrubbing) where classic Hotwire pays ~61 ms *per
gesture* and the server pays render CPU *per client*.

## Per-edit render cost (measured, `bin/rails reactive:compare`)

Server-side render of the 50k sheet, the same query objects + ActionView
partials each route uses:

| Fragment | Queries | Render ms | Bytes |
|---|---|---|---|
| stats | 1 | 30.9 | 993 |
| totals | 2 | 37.7 | 658 |
| rows (grid body) | 1 | 2.3 | 38,422 |
| **whole grid** | **4** | **70.9** | **40,073** |

What each strategy re-renders per edit:

| | Classic Hotwire | Local-first precise |
|---|---|---|
| Re-renders | **whole grid**: 40 KB, 4 queries, 70.9 ms server CPU | **changed fragments only**: 1.6 KB |
| Out-of-window edit | still ships the whole 40 KB grid | resettles stats+totals (1.6 KB), grid body untouched |
| Where the render runs | server (ActionView, 70.9 ms) | client (hand-rolled JS, ~ms); slice: in-VM Rails, slower |
| Network per edit | 1 round-trip (~61-180 ms) + cable push | 0 (reads the local replica) |
| Who pays | the server, for every client, every gesture | the server sees writes only |

The two render identical server-quality HTML. Hotwire centralizes: every gesture
is a round-trip plus a 70.9 ms whole-grid render, multiplied by every connected
client. Local-first decentralizes reads: the common case (an out-of-window edit)
ships 1.6 KB instead of 40 KB, a ~25x difference, at zero network and zero server
CPU. The task header is explicit that the same render in the Wasm VM is slower
than this server-side 70.9 ms, so treat these as the lower bound on render work.

## Writes are the same in both

Both versions send one transaction to the server and reconcile through Electric.
Local-first's optimistic apply (~15 ms) makes writes *feel* instant, then the
authoritative row settles. Write latency and server load are identical; only the
perceived latency differs. Electric being read-path-only structurally enforces
"reads local, writes server" and gives the no-divergence-on-rejection property,
which held identically across both deploys.

## Conclusions

1. **Classic Hotwire is the right default when interactions are sparse or reads
   are cheap and the network is good.** Lightest entry, no replica; 70.9 ms of
   server render per edit is fine if edits are occasional. It degrades where reads
   are frequent and aggregating: every recompute is a 61-180 ms round-trip and the
   server pays per client.

2. **Local-first wins on read-heavy, latency-sensitive, multi-client
   interaction.** The 50k aggregates go from a round-trip to local SQL, the common
   edit ships 1.6 KB instead of 40 KB, and the server scales because it only
   handles writes. The cost is a heavier first load (PGlite + the Electric seed).

3. **You get the local-first win without Wasm.** The sharpest finding: the entire
   read-latency and server-offload benefit comes from PGlite + Electric plus a few
   KB of JS. The 9.4 MB `app.wasm` is not what makes it local-first.

4. **Wasm earns its 9.4 MB only when the render itself must leave the server:**
   offline, edge, or a no-backend deploy. For a normal Rails app with a server,
   the precise route is the better local-first path, and Wasm is the optional
   "runs without the server" capability on top.

5. **The seed cost is the honest ceiling, and it is shared.** Both replica-backed
   versions pull the 50k-cell shape; the server-side page hides it behind a usable
   first paint, the slice cannot (nothing renders until replica + VM are ready).
   Initial-seed cost, eviction, and shape size are the real scaling questions,
   more than wasm size.

## Reproduce

```bash
# render cost across the three strategies (needs the local stack up)
docker compose up -d && bin/rails db:prepare db:seed
bin/rails reactive:compare

# network + load numbers against the live deploy
curl -s -o /dev/null -w 'ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
  https://client-side-scopes.fly.dev/sheets/1/aggregates
curl -sI -H 'Accept-Encoding: br' https://client-side-scopes-slice.fly.dev/app.wasm \
  | grep -i content-length
```
