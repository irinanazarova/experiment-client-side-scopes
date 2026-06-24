import { test } from "node:test";
import assert from "node:assert/strict";
import { workerInstalling } from "../sw_register.js";

test("workerInstalling: true when a registration has an installing worker", () => {
  assert.equal(workerInstalling([{ installing: { state: "installing" } }]), true);
  assert.equal(workerInstalling([{ installing: null }, { installing: {} }]), true);
});

test("workerInstalling: false (and does NOT throw) when installing is null", () => {
  // The crash case: reading registration.installing.state would throw here.
  assert.equal(workerInstalling([{ installing: null }, { installing: null }]), false);
});

test("workerInstalling: false for an empty registration list", () => {
  assert.equal(workerInstalling([]), false);
});
