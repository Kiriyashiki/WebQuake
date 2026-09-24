import assert from "node:assert";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const WebSocket = require("./node_modules/ws");

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
globalThis.fetch = async (url) => {
  if (url === "/jma-area-codes.csv") {
    return {
      ok: true,
      status: 200,
      text: async () => areaCodesCsvContent,
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
  HttpEewProvider,
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

// 4. Custom Provider Registration & HTTP base provider
console.log("Test 4: Extensibility with Custom Providers (HTTP & Tauri-only)");
class CustomHttpProvider extends HttpEewProvider {
  constructor() {
    super({ id: "custom_http", name: "Custom HTTP", pollInterval: 500 });
  }
  async fetchEewData() {
    return rawAxisMsg;
  }
}
const customHttp = new CustomHttpProvider();
registerProvider(customHttp);
assert.strictEqual(getProvider("custom_http"), customHttp);
assert.ok(getAvailableProviders().some(p => p.id === "custom_http"));
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
assert.strictEqual(statusHistory[statusHistory.length - 1], "error", "Disconnect should set status to 'error'");

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

// 8. Live connection to running local EEW Client on 127.0.0.1:11311
console.log("Test 8: Live WebSocket connection to local EEW Client daemon (127.0.0.1:11311)");
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
assert.strictEqual(dmdssStatuses[dmdssStatuses.length - 1], "error");
console.log("✓ Test 8 passed");

console.log("\n=== ALL TESTS PASSED SUCCESSFULLY! ===");
