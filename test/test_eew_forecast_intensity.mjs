import assert from "node:assert";

import {
  isOverIntensity,
  resolveForecastIntensity,
  mergeForecasts,
} from "../src/eew/physics.js";

console.log("=== Running EEW Forecast Intensity Unit Tests ===");

// 1. The "over" sentinel is detected regardless of casing/whitespace.
console.log("Test 1: over detection");
assert.strictEqual(isOverIntensity("over"), true);
assert.strictEqual(isOverIntensity("OVER"), true);
assert.strictEqual(isOverIntensity(" Over "), true);
assert.strictEqual(isOverIntensity("over\n"), true);
assert.strictEqual(isOverIntensity(4), false);
assert.strictEqual(isOverIntensity(null), false);
assert.strictEqual(isOverIntensity(undefined), false);
console.log("✓ Test 1 passed");

// 2. An unbounded forecast resolves to its lower bound.
console.log("Test 2: resolve forecast intensity");
assert.strictEqual(
  resolveForecastIntensity({ Intensity: { From: "4", To: "over" } }),
  "4",
  "From 4 / To over should resolve to 4",
);
assert.strictEqual(
  resolveForecastIntensity({ Intensity: { From: "4", To: "OVER" } }),
  "4",
  "The sentinel must be matched case-insensitively",
);
assert.strictEqual(
  resolveForecastIntensity({ Intensity: { From: "5-", To: " over " } }),
  "5-",
  "Composite intensities keep their sign",
);
assert.strictEqual(
  resolveForecastIntensity({ Intensity: { From: "4", To: "4" } }),
  "4",
  "A normal bounded forecast is unchanged",
);
assert.strictEqual(
  resolveForecastIntensity({ Intensity: { From: "4" } }),
  "4",
  "A missing upper bound falls back to the lower bound",
);
assert.strictEqual(resolveForecastIntensity({ Intensity: { From: "4", To: "0" } }), null);
assert.strictEqual(resolveForecastIntensity({ Intensity: { From: "4", To: "不明" } }), null);
assert.strictEqual(resolveForecastIntensity({ Intensity: { From: "0", To: "over" } }), null);
assert.strictEqual(resolveForecastIntensity({ Intensity: { To: "over" } }), null);
assert.strictEqual(resolveForecastIntensity({ Intensity: { From: "over", To: "over" } }), null);
assert.strictEqual(resolveForecastIntensity({}), null);
assert.strictEqual(resolveForecastIntensity(null), null);
console.log("✓ Test 2 passed");

// 3. Merging ranks an unbounded forecast by its lower bound.
console.log("Test 3: mergeForecasts with over");
const merged = mergeForecasts([
  { msg: { Forecast: [{ Code: 610, Intensity: { From: "3", To: "3" } }] } },
  { msg: { Forecast: [{ Code: 610, Intensity: { From: "4", To: "over" } }] } },
]);
assert.strictEqual(merged.length, 1);
assert.strictEqual(resolveForecastIntensity(merged[0]), "4");

const retained = mergeForecasts([
  { msg: { Forecast: [{ Code: 610, Intensity: { From: "4", To: "over" } }] } },
  { msg: { Forecast: [{ Code: 610, Intensity: { From: "3", To: "3" } }] } },
]);
assert.strictEqual(resolveForecastIntensity(retained[0]), "4");
console.log("✓ Test 3 passed");

console.log("=== ALL TESTS PASSED SUCCESSFULLY! ===");
