// Whether a service-worker (re)registration should be skipped: skip if any
// existing registration already has a worker installing, so we don't stack a
// fresh registration on top of an in-progress one. `installing` is null unless a
// worker is actively installing (an already-active registration has it null), so
// testing the slot itself also avoids the TypeError of reading .state on null.
export function workerInstalling(registrations) {
  return registrations.some((registration) => registration.installing != null);
}
