import { test } from "node:test";
import assert from "node:assert/strict";
import { regionUpdate } from "../sw_regions.js";

test("regionUpdate: the baseline (first) fire is remembered but not broadcast", () => {
  const { signature, broadcast } = regionUpdate(undefined, [{ n: 1 }]);
  assert.equal(broadcast, false);
  assert.equal(signature, JSON.stringify([{ n: 1 }]));
});

test("regionUpdate: an unchanged result does not broadcast", () => {
  const sig = JSON.stringify([{ n: 1 }]);
  assert.deepEqual(regionUpdate(sig, [{ n: 1 }]), { signature: sig, broadcast: false });
});

test("regionUpdate: a changed result broadcasts and returns the new signature", () => {
  const sig = JSON.stringify([{ n: 1 }]);
  const out = regionUpdate(sig, [{ n: 2 }]);
  assert.equal(out.broadcast, true);
  assert.equal(out.signature, JSON.stringify([{ n: 2 }]));
});
