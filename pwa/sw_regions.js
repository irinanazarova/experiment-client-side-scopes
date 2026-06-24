// The change-signal dedup decision for a watched region. PGlite's live.query
// re-runs on any change to the tables it touches, not only when this region's
// own result changes, so we close the gap: broadcast only when the result's
// signature actually moved, and never on the baseline (first) fire, since that
// result is already on screen from the first paint. Pure, so it is unit tested.
//
// prevSignature is undefined before the first fire. Returns the new signature to
// remember and whether to broadcast a change.
export function regionUpdate(prevSignature, rows) {
  const signature = JSON.stringify(rows);
  return { signature, broadcast: prevSignature !== undefined && signature !== prevSignature };
}
