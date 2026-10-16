import assert from "node:assert";

import {
  EEW_CANCEL_REMOVE_MS,
  EEW_FINAL_REMOVE_MS,
  EEW_STALE_REMOVE_MS,
  getEewRemovalDelay,
  scheduleEewRemoval,
  clearEewRemoval,
} from "../src/eew/removal.js";

console.log("=== Running EEW Removal Unit Tests ===");

// 1. Delay policy
console.log("Test 1: Removal delay selection");
assert.strictEqual(EEW_CANCEL_REMOVE_MS, 15 * 1000, "Cancel delay should be 15 seconds");
assert.strictEqual(EEW_FINAL_REMOVE_MS, 3 * 60 * 1000, "Final delay should be 3 minutes");
assert.strictEqual(EEW_STALE_REMOVE_MS, 8 * 60 * 1000, "Stale delay should be 8 minutes");

assert.strictEqual(getEewRemovalDelay({ Flag: { is_cancel: true } }), EEW_CANCEL_REMOVE_MS);
assert.strictEqual(getEewRemovalDelay({ Flag: { is_final: true } }), EEW_FINAL_REMOVE_MS);
assert.strictEqual(
  getEewRemovalDelay({ Flag: { is_cancel: false, is_final: false } }),
  EEW_STALE_REMOVE_MS,
);
assert.strictEqual(getEewRemovalDelay({ Flag: {} }), EEW_STALE_REMOVE_MS);
assert.strictEqual(getEewRemovalDelay({}), EEW_STALE_REMOVE_MS);
assert.strictEqual(getEewRemovalDelay(null), EEW_STALE_REMOVE_MS);
assert.strictEqual(getEewRemovalDelay(undefined), EEW_STALE_REMOVE_MS);

// Cancel takes precedence if a message somehow carries both flags.
assert.strictEqual(
  getEewRemovalDelay({ Flag: { is_cancel: true, is_final: true } }),
  EEW_CANCEL_REMOVE_MS,
);
console.log("✓ Test 1 passed");

// 2. Timer scheduling resets the deadline on every message
console.log("Test 2: Removal timer is replaced by each new message");
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const scheduled = [];
const cleared = [];
globalThis.setTimeout = (fn, delay) => {
  const handle = { fn, delay };
  scheduled.push(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  cleared.push(handle);
};

try {
  assert.strictEqual(scheduleEewRemoval(null, {}, () => {}), null);

  const eew = {};
  const first = scheduleEewRemoval(eew, { Flag: {} }, () => {});
  assert.strictEqual(first.delay, EEW_STALE_REMOVE_MS, "First non-final message uses the 8 min stale delay");
  assert.strictEqual(eew.removalTimer, first);

  // A subsequent non-final update must move the deadline (replace the timer).
  const second = scheduleEewRemoval(eew, { Flag: { is_final: false } }, () => {});
  assert.notStrictEqual(second, first, "A new message should create a new timer");
  assert.ok(cleared.includes(first), "The previous timer should be cleared");
  assert.strictEqual(second.delay, EEW_STALE_REMOVE_MS);
  assert.strictEqual(eew.removalTimer, second);

  // A final report shortens the wait to 3 minutes.
  const finalTimer = scheduleEewRemoval(eew, { Flag: { is_final: true } }, () => {});
  assert.strictEqual(finalTimer.delay, EEW_FINAL_REMOVE_MS);
  assert.ok(cleared.includes(second), "The stale timer should be cleared by the final report");

  // A cancel shortens the wait to 15 seconds.
  const cancelTimer = scheduleEewRemoval(eew, { Flag: { is_cancel: true } }, () => {});
  assert.strictEqual(cancelTimer.delay, EEW_CANCEL_REMOVE_MS);
  assert.ok(cleared.includes(finalTimer), "The final timer should be cleared by the cancel");

  // Explicit clearing stops the pending removal.
  clearEewRemoval(eew);
  assert.strictEqual(eew.removalTimer, null);
  assert.ok(cleared.includes(cancelTimer), "The cancel timer should be cleared");

  // Firing the timer invokes the removal callback and releases the handle.
  let removed = 0;
  const live = {};
  const liveTimer = scheduleEewRemoval(live, { Flag: {} }, () => {
    removed++;
  });
  liveTimer.fn();
  assert.strictEqual(removed, 1, "The removal callback should run when the timer fires");
  assert.strictEqual(live.removalTimer, null, "The handle should be released after firing");
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
console.log("✓ Test 2 passed");

console.log("\n=== ALL EEW REMOVAL TESTS PASSED SUCCESSFULLY! ===");
