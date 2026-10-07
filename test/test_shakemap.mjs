import assert from "node:assert";
globalThis.self = globalThis;

const { highlightShakemapObservations, clearShakemapHighlights } = await import("../src/map.js");

console.log("=== Testing Shakemap Highlighting and Clear Logic ===");

function createMockMap() {
  const featureStates = new Map(); // id -> state
  const removedStates = [];
  const setStates = [];

  return {
    isStyleLoaded: () => true,
    getSource: (id) => (id === "shakemap" ? {} : null),
    setFeatureState: (target, state) => {
      setStates.push({ target, state });
      if (target.id) {
        const existing = featureStates.get(target.id) || {};
        featureStates.set(target.id, { ...existing, ...state });
      }
    },
    removeFeatureState: (target) => {
      removedStates.push(target);
      if (target.id) {
        featureStates.delete(target.id);
      } else {
        featureStates.clear();
      }
    },
    _featureStates: featureStates,
    _removedStates: removedStates,
    _setStates: setStates,
  };
}

// Test 1: Highlighting Report 1
console.log("Test 1: Highlight Report 1 stations");
const map = createMockMap();

const report1Observations = [
  {
    pref: "北海道",
    areas: [
      {
        name: "石狩地方南部",
        cities: [
          {
            name: "札幌中央区",
            stations: [
              { name: "札幌中央区北２条", int: "4" },
              { name: "札幌中央区南４条", int: "3" },
            ],
          },
        ],
      },
    ],
  },
];

highlightShakemapObservations(map, report1Observations);

assert.strictEqual(highlightShakemapObservations._active.length, 2);
assert.ok(highlightShakemapObservations._active.includes("札幌中央区北２条"));
assert.ok(highlightShakemapObservations._active.includes("札幌中央区南４条"));

const s1State = map._featureStates.get("札幌中央区北２条");
assert.deepStrictEqual(s1State, { highlighted: true, intensity: "4" });
console.log("✓ Test 1 passed: Report 1 stations highlighted correctly");

// Test 2: Opening Report 2 clears Report 1 stations and highlights Report 2
console.log("Test 2: Highlight Report 2 stations (should clear Report 1)");

const report2Observations = [
  {
    pref: "宮城県",
    areas: [
      {
        name: "宮城中部",
        cities: [
          {
            name: "仙台青葉区",
            stations: [
              { name: "仙台青葉区雨宮", int: "5-" },
            ],
          },
        ],
      },
    ],
  },
];

highlightShakemapObservations(map, report2Observations);

// Report 1 stations must no longer be active
assert.strictEqual(highlightShakemapObservations._active.length, 1);
assert.ok(highlightShakemapObservations._active.includes("仙台青葉区雨宮"));
assert.ok(!highlightShakemapObservations._active.includes("札幌中央区北２条"));

// Check that Report 1 stations were explicitly unhighlighted
const unhighlightEvent = map._setStates.find(
  (s) => s.target.id === "札幌中央区北２条" && s.state.highlighted === false
);
assert.ok(unhighlightEvent, "Previous station was explicitly set to highlighted: false");
assert.strictEqual(unhighlightEvent.state.intensity, null);

// Check that Report 1 stations had removeFeatureState called
const removeEvent = map._removedStates.find((r) => r.id === "札幌中央区北２条");
assert.ok(removeEvent, "Previous station had removeFeatureState called");

// Only Report 2 station is in active feature states
assert.ok(map._featureStates.has("仙台青葉区雨宮"));
assert.ok(!map._featureStates.has("札幌中央区北２条"));
assert.deepStrictEqual(map._featureStates.get("仙台青葉区雨宮"), { highlighted: true, intensity: "5-" });

console.log("✓ Test 2 passed: Previous stations cleanly cleared, new stations highlighted");

// Test 3: clearShakemapHighlights
console.log("Test 3: clearShakemapHighlights resets all states");
clearShakemapHighlights(map);

assert.strictEqual(highlightShakemapObservations._active.length, 0);
assert.strictEqual(map._featureStates.size, 0);

console.log("✓ Test 3 passed: clearShakemapHighlights resets all state");

console.log("\n=== ALL SHAKEMAP TESTS PASSED ===");
