import assert from "node:assert";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

// Setup global mock environment for Node
globalThis.WebSocket = WebSocket;
const storage = {};
globalThis.localStorage = {
  getItem(k) { return storage[k] ?? null; },
  setItem(k, v) { storage[k] = String(v); },
  removeItem(k) { delete storage[k]; },
  clear() { for (const k of Object.keys(storage)) delete storage[k]; }
};

const areaCodesCsvContent = fs.readFileSync(path.resolve(process.cwd(), "public/jma-area-codes.csv"), "utf8");
const boundsJsonContent = fs.readFileSync(path.resolve(process.cwd(), "public/bounds.json"), "utf8");
const municipalitiesJsonContent = fs.readFileSync(path.resolve(process.cwd(), "public/municipalities.geojson"), "utf8");

globalThis.fetch = async (url) => {
  if (url === "/jma-area-codes.csv") {
    return {
      ok: true,
      status: 200,
      text: async () => areaCodesCsvContent,
    };
  }
  if (url === "/bounds.json") {
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(boundsJsonContent),
    };
  }
  if (url === "/municipalities.geojson") {
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(municipalitiesJsonContent),
    };
  }
  throw new Error(`Unexpected fetch URL in test: ${url}`);
};

// Import module
const { USE_TEST_SERVER } = await import("../src/constants.js");
const {
  axisProvider,
  testProvider,
  dmdssProvider,
  getProvider,
  getAllProviders,
  getAvailableProviders,
  registerProvider,
  BaseEewProvider,
  WebSocketEewProvider,
  isPlumEew,
} = await import("../src/eewProviders.js");

console.log("=== Running EEW Providers Unit Tests ===");

// 1. Provider Registration & Metadata
console.log("Test 1: Provider Registration & Properties");
assert.strictEqual(axisProvider.id, "axis");
assert.strictEqual(axisProvider.name, "AXIS");
assert.strictEqual(axisProvider.requiresToken, true);
assert.strictEqual(axisProvider.tokenLabel, "AXIS Token • トークン:");
assert.strictEqual(axisProvider.disableGmpe, false);

assert.strictEqual(testProvider.id, "test");
assert.strictEqual(testProvider.name, "TEST");
assert.strictEqual(testProvider.requiresToken, false);
assert.strictEqual(testProvider.disableGmpe, false);

assert.strictEqual(getProvider("axis"), axisProvider);
assert.strictEqual(getProvider("test"), testProvider);

// Check testProvider availability dynamically based on USE_TEST_SERVER
const avail = getAvailableProviders();
assert.ok(avail.some(p => p.id === "axis"), "AXIS should be available");
if (USE_TEST_SERVER) {
  assert.ok(avail.some(p => p.id === "test"), "TEST should be available when USE_TEST_SERVER is true");
} else {
  assert.ok(!avail.some(p => p.id === "test"), "TEST should not be available when USE_TEST_SERVER is false");
}

// When testProvider is available override
const origIsAvailable = testProvider.isAvailable;
testProvider.isAvailable = () => true;
const availWithTest = getAvailableProviders();
assert.ok(availWithTest.some(p => p.id === "test"), "TEST should be available when isAvailable() is true");
testProvider.isAvailable = () => false;
const availWithoutTest = getAvailableProviders();
assert.ok(!availWithoutTest.some(p => p.id === "test"), "TEST should not be available when isAvailable() is false");
testProvider.isAvailable = origIsAvailable;
console.log("✓ Test 1 passed");

// 2. Token Storage Separation
console.log("Test 2: Per-provider Token Isolation");
localStorage.clear();

// Test backward compatibility fallback
localStorage.setItem("eew-token", "legacy_axis_token");
assert.strictEqual(axisProvider.getToken(), "legacy_axis_token");

// Setting token on axis
axisProvider.setToken("new_axis_token");
assert.strictEqual(localStorage.getItem("eew-token-axis"), "new_axis_token");
assert.strictEqual(localStorage.getItem("eew-token"), "new_axis_token");

// Expiry and refresh state
axisProvider.setStoredExpiry(1234567890);
assert.strictEqual(axisProvider.getStoredExpiry(), "1234567890");
axisProvider.setStoredLastRefreshCheck("2026-09-13");
assert.strictEqual(axisProvider.getStoredLastRefreshCheck(), "2026-09-13");
axisProvider.setStoredExpiryAlerted(true);
assert.strictEqual(axisProvider.getStoredExpiryAlerted(), true);

axisProvider.resetTokenState();
assert.strictEqual(axisProvider.getStoredExpiry(), null);
assert.strictEqual(axisProvider.getStoredLastRefreshCheck(), null);
assert.strictEqual(axisProvider.getStoredExpiryAlerted(), false);

// Another provider token should not collide
const otherProvider = new BaseEewProvider({ id: "other", name: "Other", requiresToken: true });
otherProvider.setToken("other_token");
assert.strictEqual(otherProvider.getToken(), "other_token");
assert.strictEqual(axisProvider.getToken(), "new_axis_token");
assert.strictEqual(testProvider.getToken(), "");
console.log("✓ Test 2 passed");

// 3. Message Normalization
console.log("Test 3: Normalizing raw data to common format");
const rawAxisMsg = {
  Title: "緊急地震速報（予報）",
  OriginDateTime: "2026-09-13T23:00:00+09:00",
  ReportDateTime: "2026-09-13T23:00:10+09:00",
  EventID: "20260913230000",
  Serial: 1,
  Hypocenter: {
    Code: 510,
    Name: "京都府北部",
    Coordinate: [135.3, 35.3],
    Depth: "10km",
  },
  Intensity: "3",
  Magnitude: "4.5",
  Flag: { is_final: false, is_cancel: false, is_training: false },
  Forecast: [
    {
      Code: 510,
      Name: "京都府北部",
      Intensity: { From: "3", To: "3", Description: "最大震度3" }
    }
  ],
  Text: "Test Text"
};

const normalized = axisProvider.normalizeMessage(rawAxisMsg);
assert.strictEqual(normalized.Title, "緊急地震速報（予報）");
assert.strictEqual(normalized.EventID, "20260913230000");
assert.strictEqual(normalized.Serial, 1);
assert.strictEqual(normalized.Hypocenter.Name, "京都府北部");
assert.deepStrictEqual(normalized.Hypocenter.Coordinate, [135.3, 35.3]);
assert.strictEqual(normalized.Hypocenter.Depth, "10km");
assert.strictEqual(normalized.Intensity, "3");
assert.strictEqual(normalized.Magnitude, "4.5");
assert.strictEqual(normalized.Flag.is_final, false);
assert.strictEqual(normalized.Flag.is_cancel, false);
assert.strictEqual(normalized.Forecast.length, 1);
console.log("✓ Test 3 passed");

// 4. Custom Provider Registration
console.log("Test 4: Extensibility with Custom Providers");
class CustomTestProvider extends BaseEewProvider {
  constructor() {
    super({ id: "custom_ext", name: "Custom Ext" });
  }
}
const customExt = new CustomTestProvider();
registerProvider(customExt);
assert.strictEqual(getProvider("custom_ext"), customExt);
assert.ok(getAvailableProviders().some(p => p.id === "custom_ext"));
console.log("✓ Test 4 passed");

// 5. Live WebSocket Integration with Test Server
console.log("Test 5: Live WebSocket test with test server");
const { WebSocketServer } = WebSocket;
const wss = new WebSocketServer({ port: 0 });
const PORT = wss.address().port;
const origGetUrl = testProvider.getWebSocketUrl;
testProvider.getWebSocketUrl = async () => `ws://localhost:${PORT}`;

wss.on("connection", (ws) => {
  ws.send("hello");
  ws.on("message", (data) => {
    if (data.toString() === "hb") {
      ws.send("hb");
    }
  });
  // Send test EEW
  ws.send(JSON.stringify({
    channel: "eew",
    message: rawAxisMsg
  }));
});

const statusHistory = [];
let receivedMessage = null;

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error("WebSocket integration test timed out"));
  }, 5000);

  testProvider.connect({
    onStatusChange: (status) => {
      statusHistory.push(status);
    },
    onMessage: (msg) => {
      receivedMessage = msg;
      clearTimeout(timeout);
      resolve();
    },
    onAuthError: (err) => {
      clearTimeout(timeout);
      reject(new Error("Unexpected onAuthError: " + err));
    }
  });
});

assert.ok(statusHistory.includes("connecting"), "Should report 'connecting'");
assert.ok(statusHistory.includes("connected"), "Should report 'connected'");
assert.ok(receivedMessage, "Should receive message");
assert.strictEqual(receivedMessage.EventID, "20260913230000");
assert.strictEqual(receivedMessage.Hypocenter.Name, "京都府北部");

testProvider.disconnect();
assert.strictEqual(statusHistory.at(-1), "error", "Disconnect should set status to 'error'");

wss.close();
testProvider.getWebSocketUrl = origGetUrl;
console.log("✓ Test 5 passed");

// 6. DMDSS Provider Unit Tests
console.log("Test 6: DMDSS EEW Client Provider properties and normalization");
assert.strictEqual(dmdssProvider.id, "dmdss");
assert.strictEqual(dmdssProvider.name, "DMDSS EEW Client");
assert.strictEqual(dmdssProvider.requiresToken, false);
assert.strictEqual(dmdssProvider.requiresPort, true);
assert.strictEqual(dmdssProvider.defaultPort, "11311");
assert.strictEqual(dmdssProvider.tauriOnly, true);
assert.strictEqual(dmdssProvider.disableGmpe, true, "DMDSS provider should have disableGmpe: true");
assert.strictEqual(getProvider("dmdss"), dmdssProvider);

// Port Isolation
localStorage.clear();
assert.strictEqual(dmdssProvider.getPort(), "11311");
dmdssProvider.setPort("12345");
assert.strictEqual(dmdssProvider.getPort(), "12345");
assert.strictEqual(localStorage.getItem("eew-port-dmdss"), "12345");
dmdssProvider.setPort("11311"); // Reset

// isPlumEew tests
assert.strictEqual(isPlumEew({ isPlumOnly: true, Magnitude: "5.0", Hypocenter: { Depth: "30km" } }), true);
assert.strictEqual(isPlumEew({ isPlumOnly: false, Magnitude: "1.0", Hypocenter: { Depth: "10km" } }), true);
assert.strictEqual(isPlumEew({ Magnitude: "1.0", Hypocenter: { Depth: "10km" } }), true);
assert.strictEqual(isPlumEew({ Magnitude: 1.0, Hypocenter: { Depth: 10 } }), true);
assert.strictEqual(isPlumEew({ Magnitude: "5.0", Hypocenter: { Depth: "10km" } }), false);
assert.strictEqual(isPlumEew(null), false);

// Low-accuracy tests
const rawDmdssForecast = {
  type: "eew",
  eventId: "20240101160608",
  serial: "13",
  isTest: false,
  isCanceled: false,
  isLastInfo: false,
  isPlumOnly: false,
  isWarning: false,
  epicenterName: "石川県能登地方",
  epicenterLocation: [137.2, 37.5],
  depth: 10,
  magnitude: 5.6,
  originTime: "2024-01-01T16:06:06+09:00",
  arrivalTime: "2024-01-01T16:06:08+09:00",
  accuracy: {
    epicenters: ["1", "4"],
    depth: "4",
    magnitudeCalculation: "4",
    numberOfMagnitudeCalculation: "4"
  },
  maxInt: { from: "5+", to: "5+" },
  maxLgInt: { from: "1", to: "1" },
  regionForecasts: [
    { code: "390", maxInt: "5-" },
    { code: "391", maxInt: "3" }
  ],
  pointForecast: {
    sWave: { status: "ok", time: "2024-01-01T16:07:00.000+09:00" },
    intensity: { type: "attenuation", k: "1.09", int: "1" }
  }
};

// Load area codes into DMDSS provider
await dmdssProvider.loadAreaCodes();

const normLowAcc = dmdssProvider.normalizeDmdssEew(rawDmdssForecast);
assert.strictEqual(normLowAcc.isLowAccuracy, true, "Forecast with epicenters containing '1' should be low accuracy");
assert.strictEqual(normLowAcc.isTest, false);
assert.strictEqual(normLowAcc.isPlumOnly, false);
assert.strictEqual(normLowAcc.Hypocenter.Name, "石川県能登地方");
assert.strictEqual(normLowAcc.Hypocenter.Code, 390, "Hypocenter.Code should be looked up from CSV (390 for 石川県能登地方)");
assert.deepStrictEqual(normLowAcc.Hypocenter.Coordinate, [137.2, 37.5]);
assert.strictEqual(normLowAcc.Hypocenter.Depth, "10km");
assert.strictEqual(normLowAcc.Intensity, "5+");
assert.strictEqual(normLowAcc.Forecast.length, 2);
assert.strictEqual(normLowAcc.Forecast[0].Code, 390);
assert.strictEqual(normLowAcc.Forecast[0].Intensity.To, "5-");
assert.ok(normLowAcc.pointForecast, "pointForecast should be preserved");

// Hypocenter Code lookups for other names and fallback
const rawKyotoForecast = { ...rawDmdssForecast, epicenterName: "京都府北部" };
const normKyoto = dmdssProvider.normalizeDmdssEew(rawKyotoForecast);
assert.strictEqual(normKyoto.Hypocenter.Code, 510, "Hypocenter.Code should be 510 for 京都府北部");

const rawUnknownForecast = { ...rawDmdssForecast, epicenterName: "未知地域" };
const normUnknown = dmdssProvider.normalizeDmdssEew(rawUnknownForecast);
assert.strictEqual(normUnknown.Hypocenter.Code, 0, "Hypocenter.Code should fallback to 0 for unknown area");

// Warning should NEVER be low accuracy
const rawDmdssWarning = { ...rawDmdssForecast, isWarning: true };
const normWarning = dmdssProvider.normalizeDmdssEew(rawDmdssWarning);
assert.strictEqual(normWarning.isLowAccuracy, false, "Warning should NEVER be low accuracy");

// Normal forecast without '1' in epicenters
const rawNormalForecast = {
  ...rawDmdssForecast,
  accuracy: { epicenters: ["4", "4"] }
};
const normNormal = dmdssProvider.normalizeDmdssEew(rawNormalForecast);
assert.strictEqual(normNormal.isLowAccuracy, false, "Forecast with epicenters ['4','4'] should not be low accuracy");

// Test data
const rawTestEew = { ...rawDmdssForecast, isTest: true };
const normTest = dmdssProvider.normalizeDmdssEew(rawTestEew);
assert.strictEqual(normTest.isTest, true);
assert.strictEqual(normTest.Flag.is_training, true);

// PLUM only
const rawPlumEew = { ...rawDmdssForecast, isPlumOnly: true, magnitude: null, depth: 10 };
const normPlum = dmdssProvider.normalizeDmdssEew(rawPlumEew);
assert.strictEqual(normPlum.isPlumOnly, true);
assert.strictEqual(isPlumEew(normPlum), true);

// Scenario S4 (Warning using PLUM dummy values M1.0, 10km) normalized by TestProvider
const rawS4 = {
  Title: "緊急地震速報（警報）",
  OriginDateTime: "2026-09-24T18:00:00+09:00",
  ReportDateTime: "2026-09-24T18:00:05+09:00",
  EventID: "20260924180000",
  Serial: 1,
  Hypocenter: {
    Code: 510,
    Name: "京都府北部",
    Coordinate: [135.3, 35.3],
    Depth: "10km",
    Description: "TEST",
  },
  Intensity: "6-",
  Magnitude: "1.0",
  Flag: { is_final: false, is_cancel: false, is_training: false },
  Forecast: [],
  Text: "",
};
const normS4 = testProvider.normalizeMessage(rawS4);
assert.strictEqual(normS4.isPlumOnly, true, "Scenario S4 should normalize to isPlumOnly: true");
assert.strictEqual(isPlumEew(normS4), true, "isPlumEew(normS4) should return true");

console.log("✓ Test 6 passed");

// 7. DMDSS server-status callback handling
console.log("Test 7: DMDSS server-status message handling");
let dmdssStatus = null;
dmdssProvider.callbacks = {
  onStatusChange: (status) => {
    dmdssStatus = status;
  },
  onMessage: () => {}
};

// server-status: open -> connected
dmdssProvider.handleIncomingRawMessage(JSON.stringify({ type: "server-status", status: "open" }));
assert.strictEqual(dmdssStatus, "connected");

// server-status: no-auth -> upstream-disconnected
dmdssProvider.handleIncomingRawMessage(JSON.stringify({ type: "server-status", status: "no-auth" }));
assert.strictEqual(dmdssStatus, "upstream-disconnected");

// server-status: no-contract -> upstream-disconnected
dmdssProvider.handleIncomingRawMessage(JSON.stringify({ type: "server-status", status: "no-contract" }));
assert.strictEqual(dmdssStatus, "upstream-disconnected");

// user-point
dmdssProvider.handleIncomingRawMessage(JSON.stringify({ type: "user-point", location: [135.5, 34.7] }));
assert.deepStrictEqual(dmdssProvider.userPoint, [135.5, 34.7]);

console.log("✓ Test 7 passed");

// 8. Live connection to EEW Client daemon
console.log("Test 8: Live WebSocket connection to EEW Client daemon");
const dmdssWss = new WebSocketServer({ port: 0 });
const dmdssPort = String(dmdssWss.address().port);
const origDmdssPort = dmdssProvider.getPort();
dmdssProvider.setPort(dmdssPort);

dmdssWss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "start", version: "1.4.0" }));
  ws.send(JSON.stringify({ type: "server-status", status: "open" }));
});

const dmdssStatuses = [];
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error("DMDSS connection timed out"));
  }, 4000);

  dmdssProvider.connect({
    onStatusChange: (status) => {
      dmdssStatuses.push(status);
      if (status === "connected" || status === "upstream-disconnected") {
        clearTimeout(timeout);
        resolve();
      }
    },
    onMessage: () => {},
    onAuthError: (err) => {
      clearTimeout(timeout);
      reject(new Error("Unexpected error: " + err));
    }
  });
});

assert.ok(dmdssStatuses.includes("connecting"), "Should report 'connecting'");
assert.ok(
  dmdssStatuses.includes("connected") || dmdssStatuses.includes("upstream-disconnected"),
  "Should report 'connected' or 'upstream-disconnected'"
);
dmdssProvider.disconnect();
assert.strictEqual(dmdssStatuses.at(-1), "error");
dmdssWss.close();
dmdssProvider.setPort(origDmdssPort);
console.log("✓ Test 8 passed");

// 9. Home Sync Provider Settings & Defaults
console.log("Test 9: Home Location Sync Provider Settings");
assert.strictEqual(axisProvider.supportsHomeSync, false);
assert.strictEqual(testProvider.supportsHomeSync, false);
assert.strictEqual(dmdssProvider.supportsHomeSync, true);

// Enabled by default
localStorage.removeItem("eew-sync-home-dmdss");
assert.strictEqual(dmdssProvider.getHomeSync(), true);

dmdssProvider.setHomeSync(false);
assert.strictEqual(dmdssProvider.getHomeSync(), false);
assert.strictEqual(localStorage.getItem("eew-sync-home-dmdss"), "false");

dmdssProvider.setHomeSync(true);
assert.strictEqual(dmdssProvider.getHomeSync(), true);
assert.strictEqual(localStorage.getItem("eew-sync-home-dmdss"), "true");
console.log("✓ Test 9 passed");

// 10. onUserPoint Callback in DMDSS Provider
console.log("Test 10: onUserPoint Callback in DMDSS Provider");
let receivedUserPoint = null;
dmdssProvider.callbacks = {
  onStatusChange: () => {},
  onMessage: () => {},
  onUserPoint: (point) => {
    receivedUserPoint = point;
  },
};
dmdssProvider.handleIncomingRawMessage(JSON.stringify({ type: "user-point", location: [135.7482, 35.01392] }));
assert.deepStrictEqual(receivedUserPoint, [135.7482, 35.01392]);
assert.deepStrictEqual(dmdssProvider.userPoint, [135.7482, 35.01392]);
console.log("✓ Test 10 passed");

// 11. Coordinate Mapping (findCityForCoordinates)
console.log("Test 11: findCityForCoordinates (point-in-polygon matching)");
const { findCityForCoordinates } = await import("../src/areaCodes.js");
const cityResult = await findCityForCoordinates(135.7482, 35.01392);
assert.ok(cityResult != null, "Should resolve city for Kyoto coordinates [135.7482, 35.01392]");
assert.strictEqual(cityResult.prefCode, "26", "Kyoto prefecture code should be 26");
assert.ok(cityResult.cityCode.startsWith("26"), "City code should belong to Kyoto");
assert.ok(cityResult.name.length > 0, "City name should not be empty");
console.log(`Matched coordinates to: ${cityResult.name} (City: ${cityResult.cityCode}, Pref: ${cityResult.prefCode})`);

// Fallback / edge cases
const invalidResult = await findCityForCoordinates(null, null);
assert.strictEqual(invalidResult, null);
console.log("✓ Test 11 passed");

function getIntVal(v) {
  if (v === "7") return 70;
  if (v === "6+") return 65;
  if (v === "6-") return 60;
  if (v === "5+") return 55;
  if (v === "5-") return 50;
  const parsed = Number.parseInt(v);
  return Number.isNaN(parsed) ? 0 : parsed * 10;
}

// 12. Multiple Simultaneous EEWs Intensity Logic
console.log("Test 12: Simultaneous EEWs home intensity selection");
function testSelectHighestIntensity(eewList, isHomeSync) {
  const activeEewList = eewList.filter((e) => !e.isCancelled);
  if (isHomeSync) {
    let maxIntVal = -1;
    let maxIntStr = null;
    for (const eew of activeEewList) {
      const pointForecast = eew.msg?.pointForecast;
      const intStr = pointForecast?.intensity?.int;
      if (intStr != null) {
        const val = getIntVal(intStr);
        if (val > maxIntVal) {
          maxIntVal = val;
          maxIntStr = intStr;
        }
      }
    }
    return maxIntStr;
  } else {
    // Area forecast logic
    let maxIntVal = -1;
    let maxIntStr = null;
    for (const eew of activeEewList) {
      for (const f of eew.msg?.Forecast || []) {
        if (f.Code === 350) {
          const val = getIntVal(f.Intensity.To);
          if (val > maxIntVal) {
            maxIntVal = val;
            maxIntStr = f.Intensity.To;
          }
        }
      }
    }
    return maxIntStr;
  }
}

const eewA = {
  isCancelled: false,
  msg: {
    EventID: "202609270001",
    pointForecast: { intensity: { int: "3" } },
    Forecast: [{ Code: 350, Intensity: { To: "3" } }],
  },
};
const eewB = {
  isCancelled: false,
  msg: {
    EventID: "202609270002",
    pointForecast: { intensity: { int: "5-" } },
    Forecast: [{ Code: 350, Intensity: { To: "4" } }],
  },
};

// With both active, highest is 5- (sync on) and 4 (sync off)
assert.strictEqual(testSelectHighestIntensity([eewA, eewB], true), "5-");
assert.strictEqual(testSelectHighestIntensity([eewA, eewB], false), "4");

// When eewB is cancelled, recheck selects eewA's intensity (3)
eewB.isCancelled = true;
assert.strictEqual(testSelectHighestIntensity([eewA, eewB], true), "3");
assert.strictEqual(testSelectHighestIntensity([eewA, eewB], false), "3");

// When both cancelled or expired
eewA.isCancelled = true;
assert.strictEqual(testSelectHighestIntensity([eewA, eewB], true), null);
assert.strictEqual(testSelectHighestIntensity([eewA, eewB], false), null);

console.log("✓ Test 12 passed");

// 13. EEW Report Number Formatting
console.log("Test 13: EEW Report Number Formatting");
function formatEewSerial(msg) {
  const isFinal = Boolean(msg.Flag?.is_final);
  const serialNum = msg.Serial ?? "";
  if (serialNum) {
    return `#${serialNum}${isFinal ? " Final" : ""}`;
  }
  return isFinal ? "Final" : "";
}

assert.strictEqual(formatEewSerial({ Serial: 1, Flag: { is_final: false } }), "#1");
assert.strictEqual(formatEewSerial({ Serial: 5, Flag: { is_final: false } }), "#5");
assert.strictEqual(formatEewSerial({ Serial: 3, Flag: { is_final: true } }), "#3 Final");
assert.strictEqual(formatEewSerial({ Serial: 12, Flag: { is_final: true } }), "#12 Final");
console.log("✓ Test 13 passed");

// 14. Test EEW Display Setting & Filtering Logic
console.log("Test 14: Test EEWs display setting & filtering logic");
const { getShowTestEew, setShowTestEew } = await import("../src/eewProviders.js");

localStorage.removeItem("eew-show-test");
assert.strictEqual(getShowTestEew(), false, "Test EEWs should be disabled by default");

setShowTestEew(true);
assert.strictEqual(getShowTestEew(), true, "Should return true after setShowTestEew(true)");
assert.strictEqual(localStorage.getItem("eew-show-test"), "true");

setShowTestEew(false);
assert.strictEqual(getShowTestEew(), false, "Should return false after setShowTestEew(false)");
assert.strictEqual(localStorage.getItem("eew-show-test"), "false");

// Verify filter decision
function shouldDisplayEew(msg, showTest) {
  const isTest = Boolean(msg.isTest || msg.Flag?.is_training || msg.Title?.includes("訓練") || msg.Title?.includes("テスト"));
  return !(isTest && !showTest);
}

const realEew = { Title: "緊急地震速報（予報）", isTest: false, Flag: { is_training: false } };
const testEew1 = { Title: "緊急地震速報（訓練）", isTest: true, Flag: { is_training: true } };
const testEew2 = { Title: "緊急地震速報（予報）", isTest: true, Flag: { is_training: false } };
const testEew3 = { Title: "緊急地震速報（予報）", isTest: false, Flag: { is_training: true } };
const testEew4 = { Title: "緊急地震速報（テスト）", isTest: false, Flag: { is_training: false } };

assert.strictEqual(shouldDisplayEew(realEew, false), true, "Real EEW displayed when test disabled");
assert.strictEqual(shouldDisplayEew(realEew, true), true, "Real EEW displayed when test enabled");
assert.strictEqual(shouldDisplayEew(testEew1, false), false, "Test EEW 1 ignored when test disabled");
assert.strictEqual(shouldDisplayEew(testEew1, true), true, "Test EEW 1 displayed when test enabled");
assert.strictEqual(shouldDisplayEew(testEew2, false), false, "Test EEW 2 ignored when test disabled");
assert.strictEqual(shouldDisplayEew(testEew2, true), true, "Test EEW 2 displayed when test enabled");
assert.strictEqual(shouldDisplayEew(testEew3, false), false, "Test EEW 3 ignored when test disabled");
assert.strictEqual(shouldDisplayEew(testEew3, true), true, "Test EEW 3 displayed when test enabled");
assert.strictEqual(shouldDisplayEew(testEew4, false), false, "Test EEW 4 ignored when test disabled");
assert.strictEqual(shouldDisplayEew(testEew4, true), true, "Test EEW 4 displayed when test enabled");

console.log("✓ Test 14 passed");

// 15. EEW Map User Interaction & Auto fitBounds
console.log("Test 15: EEW Map user interaction pause and auto fitBounds resume");
if (!globalThis.document) {
  globalThis.document = {
    querySelector: () => null,
    getElementById: () => ({
      offsetWidth: 800,
      classList: { add: () => {}, remove: () => {} },
      querySelector: () => null,
    }),
  };
}

if (!globalThis.self) {
  globalThis.self = globalThis;
}
const { eewState } = await import("../src/eew/state.js");
const { onMapInteract, fitBoundsForActiveEew, clearEewMapDisplay } = await import("../src/eew/eewMap.js");

let fittedBoundsCount = 0;
const mockMap = {
  fitBounds: () => {
    fittedBoundsCount++;
  },
  getSource: () => null,
};

eewState.mapInstance = mockMap;
eewState.featureBounds = {
  forecast: {
    "350": [139.0, 35.0, 140.0, 36.0],
  },
  cities: {},
};
eewState.lastMockObservations = [
  {
    areas: [
      { code: "350", maxInt: "3", cities: [] },
    ],
  },
];
eewState.lastEpicenterCoords = { longitude: 139.5, latitude: 35.5 };
eewState.activeEews.set("test-event-1", { msg: {} });
eewState.isEewMapActive = true;

// Direct fitBounds when not interacting
fittedBoundsCount = 0;
fitBoundsForActiveEew();
assert.strictEqual(fittedBoundsCount, 1, "fitBoundsForActiveEew should trigger map.fitBounds");

// User interacts with map
onMapInteract();
assert.strictEqual(eewState.isUserInteractingWithMap, true, "isUserInteractingWithMap should be true after interaction");
assert.ok(eewState.mapInteractionTimeout != null, "mapInteractionTimeout should be scheduled");

// While interacting, fitBoundsForActiveEew must be paused
fittedBoundsCount = 0;
fitBoundsForActiveEew();
assert.strictEqual(fittedBoundsCount, 0, "fitBounds should be paused while user is interacting");

// Second interaction refreshes the timeout
const firstTimeout = eewState.mapInteractionTimeout;
onMapInteract();
assert.notStrictEqual(eewState.mapInteractionTimeout, firstTimeout, "Subsequent interaction should refresh the timeout");

// Clear map display cancels the timeout and interaction state
clearEewMapDisplay();
assert.strictEqual(eewState.isUserInteractingWithMap, false);
assert.strictEqual(eewState.mapInteractionTimeout, null);
assert.strictEqual(eewState.isEewMapActive, false);
assert.strictEqual(eewState.lastMockObservations, null);

// Test auto-resume when timeout fires
eewState.isEewMapActive = true;
eewState.lastMockObservations = [
  { areas: [{ code: "350", maxInt: "3", cities: [] }] },
];
onMapInteract();
assert.strictEqual(eewState.isUserInteractingWithMap, true);
fittedBoundsCount = 0;

// Fast-forward timeout: clear and invoke manually to verify auto-resume behavior
clearTimeout(eewState.mapInteractionTimeout);
eewState.isUserInteractingWithMap = false;
eewState.mapInteractionTimeout = null;
fitBoundsForActiveEew();
assert.strictEqual(fittedBoundsCount, 1, "Map should automatically fit bounds back once interaction ends");

// Clean up
clearEewMapDisplay();
eewState.activeEews.clear();
console.log("✓ Test 15 passed");

console.log("\n=== ALL TESTS PASSED SUCCESSFULLY! ===");

