import { test } from "node:test";
import assert from "node:assert/strict";
import { MILESTONES, stepMilestone, makeProgress } from "../progress.js";

test("stepMilestone maps worker step messages to milestones", () => {
  assert.equal(stepMilestone("Starting PGlite (Postgres in your browser)…"), 0);
  assert.equal(stepMilestone("Fetching authorized shape from Rails"), 0);
  assert.equal(stepMilestone("Syncing slice from Electric"), 1);
  assert.equal(stepMilestone("PGlite replica live."), 2); // "replica live" advances into the app phase
  assert.equal(stepMilestone("Loading WebAssembly"), 2);
  assert.equal(stepMilestone("Initializing Rails"), 3);
  assert.equal(stepMilestone("Instantiating the VM"), 3);
  assert.equal(stepMilestone("something unrelated"), null);
  assert.equal(stepMilestone(undefined), null);
});

test("enter advances forward only and ignores backward / null", () => {
  const p = makeProgress();
  assert.equal(p.current, 0);
  p.enter(2, 1000);
  assert.equal(p.current, 2);
  p.enter(1, 2000); // backward: ignored
  assert.equal(p.current, 2);
  p.enter(null, 3000); // null: ignored
  assert.equal(p.current, 2);
});

test("barFraction is monotonic and never reaches 1.0", () => {
  const p = makeProgress();
  let prev = -1;
  for (let now = 0; now <= 20000; now += 500) {
    const f = p.barFraction(now);
    assert.ok(f >= prev, `fraction dropped at ${now}ms: ${f} < ${prev}`);
    assert.ok(f <= 0.985, `fraction passed the cap at ${now}ms: ${f}`);
    prev = f;
  }
  assert.ok(prev > 0, "fraction should advance over time");
});

test("advancing a milestone raises the bar; remaining shrinks while a phase runs", () => {
  const p = makeProgress();
  const f0 = p.barFraction(500);
  p.enter(2, 1000);
  assert.ok(p.barFraction(1500) > f0);
  assert.ok(p.remainingSeconds(4000) < p.remainingSeconds(1500));
});

test("the milestone table carries no dead real/fmt fields", () => {
  // Locks in the dead-code removal: app.wasm stopped streaming progress, so the
  // real-progress machinery (real/fmt/frac) is gone for good.
  for (const m of MILESTONES) {
    assert.ok(!("real" in m), `milestone ${m.id} still has a dead 'real' field`);
    assert.ok(!("fmt" in m), `milestone ${m.id} still has a dead 'fmt' field`);
  }
});
