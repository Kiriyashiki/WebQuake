import assert from "node:assert";

const storage = {};
globalThis.localStorage = {
  getItem(key) {
    return storage[key] ?? null;
  },
  setItem(key, value) {
    storage[key] = String(value);
  },
  removeItem(key) {
    delete storage[key];
  },
  clear() {
    for (const key of Object.keys(storage)) delete storage[key];
  },
};

const {
  isUseTestServerEnabled,
  setUseTestServerEnabled,
  isTestGmpeOverrideEnabled,
  setTestGmpeOverrideEnabled,
  isSm1999GmpeEnabled,
  setSm1999GmpeEnabled,
} = await import("../src/debugOptions.js");
const {
  getEewGmpe,
  EEW_GMPE_MF2013,
  EEW_GMPE_SM1999,
} = await import("../src/eew/physics.js");
const { testProvider } = await import("../src/eewProviders.js");

console.log("=== Running Debug Options Unit Tests ===");

console.log("Test 1: Debug switches default to off");
assert.strictEqual(isUseTestServerEnabled(), false);
assert.strictEqual(isTestGmpeOverrideEnabled(), false);
assert.strictEqual(isSm1999GmpeEnabled(), false);
assert.strictEqual(testProvider.isAvailable(), false);
assert.strictEqual(getEewGmpe(), EEW_GMPE_MF2013);
console.log("✓ Test 1 passed");

console.log("Test 2: TEST server switch controls provider availability");
setUseTestServerEnabled(true);
assert.strictEqual(isUseTestServerEnabled(), true);
assert.strictEqual(testProvider.isAvailable(), true);
setUseTestServerEnabled(false);
assert.strictEqual(isUseTestServerEnabled(), false);
assert.strictEqual(testProvider.isAvailable(), false);
console.log("✓ Test 2 passed");

console.log("Test 3: GMPE override switch is persisted");
setTestGmpeOverrideEnabled(true);
assert.strictEqual(isTestGmpeOverrideEnabled(), true);
setTestGmpeOverrideEnabled(false);
assert.strictEqual(isTestGmpeOverrideEnabled(), false);
console.log("✓ Test 3 passed");

console.log("Test 4: SM 1999 switch directly toggles the GMPE");
// The retired eew-gmpe selection must no longer affect the active model.
localStorage.setItem("eew-gmpe", "mf2013");
setSm1999GmpeEnabled(true);
assert.strictEqual(isSm1999GmpeEnabled(), true);
assert.strictEqual(getEewGmpe(), EEW_GMPE_SM1999);

setSm1999GmpeEnabled(false);
assert.strictEqual(isSm1999GmpeEnabled(), false);
assert.strictEqual(getEewGmpe(), EEW_GMPE_MF2013);
console.log("✓ Test 4 passed");

console.log("=== ALL DEBUG OPTION TESTS PASSED SUCCESSFULLY! ===");
