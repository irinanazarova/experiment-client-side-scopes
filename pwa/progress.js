// The boot loader's progress model, with no DOM and no clock so it can be unit
// tested. The caller passes `now` (ms since boot) into every read; loader.js
// wires the result to the bar and the per-step rows.
//
// There is no per-byte progress signal: app.wasm stopped streaming during
// compileStreaming (it keeps Chrome's code cache, commit b0bfd7b) and Electric
// sync exposes only an "initial sync done" callback. So every phase decays its
// typical duration toward 0 without freezing, and the bar creeps asymptotically
// inside the active phase. The estimate self-corrects as observed phase
// durations replace the typical ones.

// User-facing milestones, in order. `est` is the typical duration in seconds.
export const MILESTONES = [
  { id: "engine", est: 3 },
  { id: "data", est: 8 }, // Electric sync; no usable incremental signal (see database.js)
  { id: "app", est: 6 }, // app.wasm via compileStreaming (no byte stream, keeps the code cache)
  { id: "rails", est: 3 },
];

// Which milestone a worker step message belongs to (specific -> general).
// "replica live" closes the data phase and advances into the app phase.
export function stepMilestone(step) {
  const s = (step || "").toLowerCase();
  if (/instantiat|initializ/.test(s)) return 3;
  if (/loading|webassembly|replica live/.test(s)) return 2;
  if (/syncing slice/.test(s)) return 1;
  if (/starting pglite|fetching|shape|pglite/.test(s)) return 0;
  return null;
}

// A pure progress state machine over a milestone list. All times are ms since
// boot, passed in by the caller.
export function makeProgress(milestones = MILESTONES) {
  const n = milestones.length;
  let cur = 0;
  let lastFrac = 0;
  const startMs = new Array(n).fill(null);
  const doneMs = new Array(n).fill(null);
  startMs[0] = 0;

  const estDur = (i) =>
    doneMs[i] != null && startMs[i] != null ? (doneMs[i] - startMs[i]) / 1000 : milestones[i].est;
  const elapsedIn = (i, now) => (startMs[i] != null ? Math.max(0, (now - startMs[i]) / 1000) : 0);

  // Seconds left in milestone i: decay the typical duration toward 0 but never
  // hit it, so a slow phase keeps a shrinking estimate instead of freezing.
  const remainingOf = (i, now) => milestones[i].est * Math.exp(-elapsedIn(i, now) / milestones[i].est);

  return {
    get current() {
      return cur;
    },
    estDur,
    remainingOf,

    // Advance to milestone m at time t, closing the phases in between.
    enter(m, t) {
      if (m == null || m < cur) return;
      for (let i = cur; i < m; i++) {
        if (doneMs[i] == null) doneMs[i] = t;
        if (startMs[i + 1] == null) startMs[i + 1] = t;
      }
      if (m !== cur) {
        cur = m;
        if (startMs[m] == null) startMs[m] = t;
      }
    },

    // The determinate bar: weight phases by their (observed or typical) duration
    // and creep asymptotically inside the active one. Monotonic; capped below 1
    // so it never reads 100% until boot actually finishes.
    barFraction(now) {
      let total = 0;
      let done = 0;
      for (let i = 0; i < n; i++) {
        const d = estDur(i);
        total += d;
        if (i < cur) done += d;
        else if (i === cur) done += d * (1 - Math.exp(-elapsedIn(i, now) / d));
      }
      const f = Math.max(lastFrac, Math.min(total > 0 ? done / total : 0, 0.985));
      lastFrac = f;
      return f;
    },

    // Total seconds left: the active phase's projection plus the typical cost of
    // everything after it.
    remainingSeconds(now) {
      let rem = remainingOf(cur, now);
      for (let i = cur + 1; i < n; i++) rem += milestones[i].est;
      return rem;
    },
  };
}
