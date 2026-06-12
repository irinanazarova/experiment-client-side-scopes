// The flow-trace panel: three live diagrams side by side, each a vertical
// column of stations, so each path through the system is legible on its own
// instead of crammed into one busy loop.
//
//   loop   — Edit -> PGlite -> Rails -> Electric -> Render   (your write, full journey)
//   local  — Edit -> PGlite ............... -> Render        (instant, no network)
//   push   — Server -> PGlite ............. -> Render        (a change from elsewhere)
//
// All three share ONE five-row backbone: the columns line up row-for-row (Edit
// at top, Render at bottom), and the local/push paths leave the middle rows as
// a dashed gap, so you can see at a glance that they skip the network hops the
// full write takes. A local edit lights loop + local; a server push lights
// push. The renderers emit step events on BroadcastChannel("cells-flow") and
// name which flow(s) to light; this panel is the sole subscriber.

export const FLOW_CHANNEL = "cells-flow";

// Each diagram is five slots on the shared backbone. A slot is [id, label] for
// a node, or null for a gap (a hop this path skips).
const DIAGRAMS = [
  {id: "loop", title: "Your write · full loop",
    slots: [["edit", "Edit"], ["replica", "PGlite"], ["authority", "Server Rails"], ["wal", "Electric"], ["render", "Render"]]},
  {id: "local", title: "Local · instant",
    slots: [["edit", "Edit"], ["replica", "PGlite"], null, null, ["render", "Render"]]},
  {id: "push", title: "Server push",
    slots: [["server", "Server"], ["replica", "PGlite"], null, null, ["render", "Render"]]},
];

const TONE = {
  local: "#16a34a", // green: no network
  network: "#4f46e5", // indigo: crossed the wire
  reconcile: "#d97706", // amber: converging
  remote: "#16a34a", // green: a change from elsewhere
  error: "#dc2626",
};

const LABELS = Object.fromEntries(
  DIAGRAMS.flatMap((d) => d.slots.filter(Boolean)).map(([id, label]) => [id, label])
);

// nodeEls[flowId][nodeId] -> element
const nodeEls = {};

export function mountFlowPanel(root) {
  root.innerHTML = `
    <div class="flow-head">Live data flow <span id="flow-mode" class="flow-mode"></span></div>
    <div class="flow-grid">
    ${DIAGRAMS.map((d) => `
      <div class="flow-diagram">
        <div class="flow-diagram-label">${d.title}</div>
        <div class="flow-track">${d.slots.map((slot, i) => {
          const edge = `${i === 0 ? " first" : ""}${i === d.slots.length - 1 ? " last" : ""}`;
          if (!slot) return `<div class="flow-cell gap${edge}"></div>`;
          const [id, label] = slot;
          return `<div class="flow-cell${edge}">
            <div class="flow-node" data-flow="${d.id}" data-node="${id}">
              <div class="flow-dot"></div>
              <div class="flow-label">${label}</div>
              <div class="flow-time"></div>
            </div>
          </div>`;
        }).join("")}</div>
      </div>`).join("")}
    </div>
    <div id="flow-log" class="flow-log"></div>`;

  for (const d of DIAGRAMS) {
    nodeEls[d.id] = {};
    for (const slot of d.slots) {
      if (slot) nodeEls[d.id][slot[0]] = root.querySelector(`[data-flow="${d.id}"][data-node="${slot[0]}"]`);
    }
  }

  new BroadcastChannel(FLOW_CHANNEL).onmessage = (e) => handle(e.data);
}

// A lit node holds for FADE_MS, then fades back to rest, so the diagram only
// glows while data is actually moving and returns to a calm baseline when idle.
// Each node carries its own timer (a new step on the same node restarts it), so
// under sustained activity nodes stay lit and only dim once it stops.
const FADE_MS = 2000;
const fadeTimers = {};
function fadeToRest(el) {
  el.classList.remove("on", "err");
  const t = el.querySelector(".flow-time");
  if (t) t.textContent = "";
}
function clearAllFades() {
  for (const key in fadeTimers) clearTimeout(fadeTimers[key]);
}

let logEl;
function handle(evt) {
  if (evt.type === "mode") {
    const m = document.getElementById("flow-mode");
    if (m) m.textContent = evt.mode ? `· ${evt.mode}` : "";
    return;
  }
  if (evt.type === "reset") {
    clearAllFades();
    for (const flow of Object.values(nodeEls)) {
      for (const el of Object.values(flow)) fadeToRest(el);
    }
    return;
  }
  // step: { node, tone, flows: [...], ms?, note? }
  const color = TONE[evt.tone] ?? TONE.network;
  for (const flow of evt.flows ?? ["loop"]) {
    const el = nodeEls[flow]?.[evt.node];
    if (!el) continue;
    el.style.setProperty("--tone", color);
    el.classList.toggle("err", evt.tone === "error");
    el.classList.add("on");
    const t = el.querySelector(".flow-time");
    if (t && evt.ms != null) t.textContent = `${evt.ms}ms`;
    const key = `${flow}/${evt.node}`;
    clearTimeout(fadeTimers[key]);
    fadeTimers[key] = setTimeout(() => fadeToRest(el), FADE_MS);
  }
  log(evt, color);
}

function log(evt, color) {
  logEl ||= document.getElementById("flow-log");
  if (!logEl) return;
  const line = document.createElement("div");
  line.textContent = `${LABELS[evt.node] ?? evt.node}${evt.note ? ` — ${evt.note}` : ""}${evt.ms != null ? ` (${evt.ms}ms)` : ""}`;
  line.style.color = color;
  logEl.prepend(line);
  while (logEl.childElementCount > 5) logEl.lastChild.remove();
}

// Emitter shared by the renderers. `step(node, tone, { flows, ms, note })`.
export function flowEmitter() {
  const channel = new BroadcastChannel(FLOW_CHANNEL);
  return {
    mode: (mode) => channel.postMessage({type: "mode", mode}),
    reset: () => channel.postMessage({type: "reset"}),
    step: (node, tone, opts = {}) => channel.postMessage({type: "step", node, tone, flows: opts.flows ?? ["loop"], ms: opts.ms, note: opts.note}),
  };
}
