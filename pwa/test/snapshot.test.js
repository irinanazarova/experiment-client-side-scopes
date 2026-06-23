import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForSnapshot } from "../snapshot.js";

const noSleep = async () => {};

test("waitForSnapshot resolves with the attempt index when rows arrive", async () => {
  let polls = 0;
  const attempts = await waitForSnapshot({
    count: async () => (++polls >= 3 ? 5 : 0),
    attempts: 10,
    sleep: noSleep,
  });
  assert.equal(attempts, 2); // arrived on the third poll (0-indexed)
});

test("waitForSnapshot resolves immediately when rows are already present", async () => {
  const attempts = await waitForSnapshot({ count: async () => 1, attempts: 10, sleep: noSleep });
  assert.equal(attempts, 0);
});

test("waitForSnapshot throws once the budget is exhausted (no silent empty boot)", async () => {
  let polls = 0;
  await assert.rejects(
    waitForSnapshot({
      count: async () => {
        polls++;
        return 0;
      },
      attempts: 4,
      delayMs: 250,
      sleep: noSleep,
    }),
    /did not arrive/,
  );
  assert.equal(polls, 4);
});
