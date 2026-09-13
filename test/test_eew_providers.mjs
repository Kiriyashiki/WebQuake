import assert from "node:assert";
import { createRequire } from "node:module";

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

// Import module
const {
  axisProvider,
  testProvider,
  getProvider,
  getAllProviders,
  getAvailableProviders,
  registerProvider,
  BaseEewProvider,
  WebSocketEewProvider,
  HttpEewProvider,
} = await import("../src/eewProviders.js");

console.log("=== Running EEW Providers Unit Tests ===");

// 1. Provider Registration & Metadata
console.log("Test 1: Provider Registration & Properties");
assert.strictEqual(axisProvider.id, "axis");
assert.strictEqual(axisProvider.name, "AXIS");
assert.strictEqual(axisProvider.requiresToken, true);
assert.strictEqual(axisProvider.tokenLabel, "AXIS Token • トークン:");

assert.strictEqual(testProvider.id, "test");
assert.strictEqual(testProvider.name, "TEST");
assert.strictEqual(testProvider.requiresToken, false);

assert.strictEqual(getProvider("axis"), axisProvider);
assert.strictEqual(getProvider("test"), testProvider);

// When USE_TEST_SERVER is false (default in constants.js)
const avail = getAvailableProviders();
assert.ok(avail.some(p => p.id === "axis"), "AXIS should be available");
assert.ok(!avail.some(p => p.id === "test"), "TEST should not be available when USE_TEST_SERVER is false");

// When testProvider is available
const origIsAvailable = testProvider.isAvailable;
testProvider.isAvailable = () => true;
const availWithTest = getAvailableProviders();
assert.ok(availWithTest.some(p => p.id === "test"), "TEST should be available when isAvailable() is true");
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
const PORT = 8565;
const wss = new WebSocketServer({ port: PORT });

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
console.log("✓ Test 5 passed");

console.log("\n=== ALL TESTS PASSED SUCCESSFULLY! ===");
