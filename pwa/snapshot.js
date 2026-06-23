// Poll until the initial Electric snapshot has landed at least one row, so the
// first in-VM request sees data instead of an empty grid. Resolves with the
// attempt count on success; throws once the budget is exhausted, so a stalled
// sync is surfaced rather than silently producing an empty-grid boot that looks
// successful. `count` and `sleep` are injected so this is pure and unit tested.
export async function waitForSnapshot({
  count,
  attempts = 80,
  delayMs = 250,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  for (let i = 0; i < attempts; i++) {
    if ((await count()) > 0) return i;
    await sleep(delayMs);
  }
  throw new Error(`initial snapshot did not arrive after ${attempts * delayMs}ms (Electric sync stalled)`);
}
