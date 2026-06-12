// Cell-change animations. After the grid re-renders (morph), we diff the
// visible cells against a snapshot taken just before, and flash the ones whose
// value changed. Colour comes from origin: a change the user initiated blinks
// yellow, anything else (a server tick, another client) blinks green.

const cellKey = (td) => `${td.dataset.row}-${td.dataset.col}`;

// Morph options that preserve the transient flash classes. A cell's class is
// otherwise static ("ss-cell grid-cell"), so skipping its class update keeps a
// just-added flash-* class instead of letting the next render strip it (which
// would cut the animation short).
export const morphOptions = {
  morphStyle: "innerHTML",
  callbacks: {
    beforeAttributeUpdated: (attr, node) =>
      !(attr === "class" && node.classList?.contains("ss-cell")),
  },
};

// Map of "row-col" -> rendered text for every grid cell in the container.
export function snapshotCells(container) {
  const map = new Map();
  for (const td of container.querySelectorAll("[data-row][data-col]")) {
    map.set(cellKey(td), td.textContent);
  }
  return map;
}

// Flash every grid cell whose text differs from the snapshot. `classify(key)`
// returns "local" or "remote". A render that changes many cells at once is a
// bulk load (the initial Electric snapshot streaming in), not a per-cell
// update, so we skip flashing it — a server tick changes one cell, a column
// edit at most the visible window height.
//
// Returns the origin tally { local, remote } of what actually flashed, so the
// caller can route the flow-trace render node to the right diagram (a local
// edit lights the write loop; a server push lights the push diagram).
const MAX_FLASH = 60;

export function flashChanged(container, before, classify) {
  const changed = [];
  for (const td of container.querySelectorAll("[data-row][data-col]")) {
    if (before.get(cellKey(td)) !== td.textContent) changed.push(td);
  }
  if (changed.length === 0 || changed.length > MAX_FLASH) return { local: 0, remote: 0 };
  let local = 0;
  let remote = 0;
  for (const td of changed) {
    const origin = classify(cellKey(td));
    flash(td, origin);
    if (origin === "local") local++;
    else remote++;
  }
  return { local, remote };
}

function flash(td, origin) {
  const cls = origin === "local" ? "flash-local" : "flash-remote";
  td.classList.remove("flash-local", "flash-remote");
  void td.offsetWidth; // reflow, so re-adding the class restarts the animation
  td.classList.add(cls);
}
