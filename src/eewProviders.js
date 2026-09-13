import { USE_TEST_SERVER } from "./constants.js";

// Detect Tauri runtime — when running as a desktop app, we can bypass CORS
// by using Tauri's HTTP plugin which makes requests through Rust's HTTP client.
const IS_TAURI = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
let tauriFetch = null;
if (IS_TAURI) {
  import("@tauri-apps/plugin-http")
    .then((mod) => {
      tauriFetch = mod.fetch;
    })
    .catch((err) => {
      console.warn("[EEW] Failed to load Tauri HTTP plugin, falling back to browser fetch.", err);
    });
}

/**
 * Base EEW Data Provider
 */
export class BaseEewProvider {
  constructor({
    id,
    name,
    requiresToken = false,
    tokenLabel = "Token • トークン:",
    tokenPlaceholder = "Bearer Token",
    tauriOnly = false,
    infoHtml = null,
  }) {
    this.id = id;
    this.name = name;
    this.requiresToken = requiresToken;
    this.tokenLabel = tokenLabel;
    this.tokenPlaceholder = tokenPlaceholder;
    this.tauriOnly = tauriOnly;
    this.infoHtml = infoHtml;
    this.callbacks = null;
  }

  isAvailable() {
    return !(this.tauriOnly && !IS_TAURI);
  }

  getToken() {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem(`eew-token-${this.id}`) || "";
  }

  setToken(token) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`eew-token-${this.id}`, token);
  }

  removeToken() {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(`eew-token-${this.id}`);
  }

  resetTokenState() {
    // Override in subclasses for provider-specific token tracking
  }

  async connect(callbacks) {
    this.callbacks = callbacks;
  }

  disconnect() {
    this.callbacks = null;
  }

  /**
   * Normalizes raw EEW message to the common format expected by handleEewMessage.
   * @param {Object} rawMsg
   * @returns {Object|null}
   */
  normalizeMessage(rawMsg) {
    if (!rawMsg?.Title) return null;
    return {
      Title: String(rawMsg.Title || ""),
      EventID: String(rawMsg.EventID || ""),
      Serial: rawMsg.Serial ?? 1,
      OriginDateTime: rawMsg.OriginDateTime || "",
      ReportDateTime: rawMsg.ReportDateTime || "",
      Hypocenter: {
        Code: rawMsg.Hypocenter?.Code ?? 0,
        Name: rawMsg.Hypocenter?.Name ?? "不明",
        Coordinate: Array.isArray(rawMsg.Hypocenter?.Coordinate)
          ? [Number(rawMsg.Hypocenter.Coordinate[0]), Number(rawMsg.Hypocenter.Coordinate[1])]
          : null,
        Depth: String(rawMsg.Hypocenter?.Depth || "--"),
        Description: rawMsg.Hypocenter?.Description || "",
      },
      Intensity: String(rawMsg.Intensity || "不明"),
      Magnitude: String(rawMsg.Magnitude ?? "--"),
      Flag: {
        is_final: Boolean(rawMsg.Flag?.is_final),
        is_cancel: Boolean(rawMsg.Flag?.is_cancel),
        is_training: Boolean(rawMsg.Flag?.is_training),
      },
      Forecast: Array.isArray(rawMsg.Forecast) ? rawMsg.Forecast : [],
      Text: rawMsg.Text || "",
    };
  }
}

/**
 * Base provider for WebSocket-based EEW services.
 */
export class WebSocketEewProvider extends BaseEewProvider {
  constructor(options) {
    super(options);
    this.socket = null;
    this.retrySec = 100;
    this.retryCount = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.hasConnectedOnce = false;
    this.isManualDisconnect = false;
  }

  /**
   * Subclasses must return the WebSocket URL to connect to.
   * @returns {Promise<string|null>}
   */
  async getWebSocketUrl() {
    throw new Error("getWebSocketUrl() must be implemented by subclass");
  }

  async connect(callbacks) {
    this.callbacks = callbacks;
    this.retrySec = 100;
    this.retryCount = 0;
    this.hasConnectedOnce = false;
    this.isManualDisconnect = false;

    await this.connectSocket();
  }

  async connectSocket() {
    if (this.isManualDisconnect) return;

    this.callbacks?.onStatusChange?.("connecting");

    let wsUrl = null;
    try {
      wsUrl = await this.getWebSocketUrl();
    } catch (err) {
      console.warn(`[EEW][${this.name}] Failed to resolve WebSocket URL:`, err);
    }

    if (!wsUrl) {
      // If getWebSocketUrl returned null (e.g. auth failed or no token), abort connection
      return;
    }

    if (this.isManualDisconnect) return;

    console.info(`[EEW][${this.name}] Connecting to ${wsUrl}`);
    try {
      this.socket = new WebSocket(wsUrl);
    } catch (err) {
      console.warn(`[EEW][${this.name}] WebSocket creation error:`, err);
      this.retryConnection();
      return;
    }

    this.socket.onopen = () => {
      console.info(`[EEW][${this.name}] WebSocket Connected. Waiting for hello...`);
    };

    this.socket.onmessage = (event) => {
      const message = event.data;
      if (typeof message === "string") {
        if (message === "hello") {
          console.info(
            `[EEW][${this.name}] Received hello from server. Connection fully established.`,
          );
          this.hasConnectedOnce = true;
          this.callbacks?.onStatusChange?.("connected");
          this.retrySec = 100;
          this.retryCount = 0;
          this.startHeartbeat();
          this.onConnectionEstablished?.();
          return;
        } else if (message === "hb") {
          return;
        }
      }

      this.handleIncomingRawMessage(message);
    };

    this.socket.onclose = (event) => {
      console.info(
        `[EEW][${this.name}] Connection closed (code: ${event.code}, reason: ${event.reason})`,
      );
      this.socket = null;
      this.stopHeartbeat();
      if (!this.isManualDisconnect) {
        this.retryConnection();
      }
    };

    this.socket.onerror = (err) => {
      console.warn(`[EEW][${this.name}] WebSocket error occurred`, err);
    };
  }

  handleIncomingRawMessage(raw) {
    try {
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (data?.channel === "eew" && data.message) {
        const normalized = this.normalizeMessage(data.message);
        if (normalized) {
          this.callbacks?.onMessage?.(normalized);
        }
      }
    } catch (err) {
      // Non-JSON or unhandled message format
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send("hb");
        this.startHeartbeat();
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  retryConnection() {
    this.retrySec = this.retrySec * 2;
    if (this.retrySec > 300000) {
      this.retrySec = 300000;
    }

    this.retryCount++;

    if (!this.hasConnectedOnce && this.retryCount > 5) {
      if (this.requiresToken) {
        console.warn(
          `[EEW][${this.name}] Failed to connect after 5 retries. Assuming invalid token.`,
        );
        this.callbacks?.onAuthError?.(
          "EEW connection failed: Token may be invalid. Please check your token in Settings.\n接続に失敗しました：トークンが無効である可能性があります。「設定」でトークンを確認してください。",
        );
      } else {
        console.warn(`[EEW][${this.name}] Failed to connect after 5 retries.`);
        this.callbacks?.onStatusChange?.("error");
      }
      return;
    }

    console.info(`[EEW][${this.name}] Retry: ${this.retryCount} (delay ${this.retrySec}ms)`);
    this.callbacks?.onStatusChange?.("connecting");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connectSocket(), this.retrySec);
  }

  disconnect() {
    this.isManualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.callbacks?.onStatusChange?.("error");
    super.disconnect();
  }
}

/**
 * Base provider for HTTP-polling-based EEW services.
 */
export class HttpEewProvider extends BaseEewProvider {
  constructor(options) {
    super(options);
    this.pollInterval = options.pollInterval || 2000;
    this.pollTimer = null;
    this.isPolling = false;
    this.abortController = null;
  }

  /**
   * Subclasses must implement fetchEewData to retrieve raw data from the HTTP endpoint.
   * @returns {Promise<Object|null>}
   */
  async fetchEewData() {
    throw new Error("fetchEewData() must be implemented by subclass");
  }

  async connect(callbacks) {
    this.callbacks = callbacks;
    this.isPolling = true;
    this.callbacks?.onStatusChange?.("connecting");
    this.startPolling();
  }

  startPolling() {
    const poll = async () => {
      if (!this.isPolling) return;
      try {
        const rawData = await this.fetchEewData();
        if (rawData) {
          const normalized = this.normalizeMessage(rawData);
          if (normalized) {
            this.callbacks?.onMessage?.(normalized);
          }
        }
        this.callbacks?.onStatusChange?.("connected");
      } catch (err) {
        console.warn(`[EEW][${this.name}] Poll error:`, err);
        this.callbacks?.onStatusChange?.("error");
      }
      if (this.isPolling) {
        this.pollTimer = setTimeout(poll, this.pollInterval);
      }
    };
    poll();
  }

  disconnect() {
    this.isPolling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.callbacks?.onStatusChange?.("error");
    super.disconnect();
  }
}

/**
 * AXIS EEW Provider
 * Handles AXIS server list resolution, 401 detection, and monthly token refresh on Tauri.
 */
export class AxisEewProvider extends WebSocketEewProvider {
  constructor() {
    super({
      id: "axis",
      name: "AXIS",
      requiresToken: true,
      tokenLabel: "AXIS Token • トークン:",
      tokenPlaceholder: "Bearer Token",
    });
    this.tokenRefreshTimer = null;
  }

  getToken() {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem("eew-token-axis") || localStorage.getItem("eew-token") || "";
  }

  setToken(token) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem("eew-token-axis", token);
    localStorage.setItem("eew-token", token);
  }

  removeToken() {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem("eew-token-axis");
    localStorage.removeItem("eew-token");
  }

  getStoredExpiry() {
    if (typeof localStorage === "undefined") return null;
    return (
      localStorage.getItem("eew-token-expiry-axis") || localStorage.getItem("eew-token-expiry")
    );
  }

  setStoredExpiry(expiry) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem("eew-token-expiry-axis", String(expiry));
    localStorage.setItem("eew-token-expiry", String(expiry));
  }

  getStoredLastRefreshCheck() {
    if (typeof localStorage === "undefined") return null;
    return (
      localStorage.getItem("eew-token-last-refresh-check-axis") ||
      localStorage.getItem("eew-token-last-refresh-check")
    );
  }

  setStoredLastRefreshCheck(dateStr) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem("eew-token-last-refresh-check-axis", dateStr);
    localStorage.setItem("eew-token-last-refresh-check", dateStr);
  }

  getStoredExpiryAlerted() {
    if (typeof localStorage === "undefined") return false;
    return (
      (localStorage.getItem("eew-token-expiry-alerted-axis") ||
        localStorage.getItem("eew-token-expiry-alerted")) === "true"
    );
  }

  setStoredExpiryAlerted(val) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem("eew-token-expiry-alerted-axis", val ? "true" : "false");
    localStorage.setItem("eew-token-expiry-alerted", val ? "true" : "false");
  }

  resetTokenState() {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem("eew-token-expiry-axis");
    localStorage.removeItem("eew-token-last-refresh-check-axis");
    localStorage.removeItem("eew-token-expiry-alerted-axis");
    localStorage.removeItem("eew-token-expiry");
    localStorage.removeItem("eew-token-last-refresh-check");
    localStorage.removeItem("eew-token-expiry-alerted");
  }

  async getWebSocketUrl() {
    const token = this.getToken();
    if (!token) {
      console.warn("[EEW][AXIS] No token provided.");
      return null;
    }

    let targetServer = "wss://ws.axis.prioris.jp";
    try {
      const fetchFn = tauriFetch || fetch;
      const res = await fetchFn("https://axis.prioris.jp/api/server/list/", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        if (data.servers && data.servers.length > 0) {
          targetServer = data.servers[0];
        }
      } else if (res.status === 401) {
        console.warn("[EEW][AXIS] 401 Unauthorized. Invalid token.");
        this.callbacks?.onAuthError?.(
          "EEW connection failed: Invalid Token (401). Please check your token in Settings.\n接続に失敗しました：トークンが無効である可能性があります。「設定」でトークンを確認してください。",
        );
        return null;
      } else {
        console.warn(
          `[EEW][AXIS] Failed to get server list, HTTP ${res.status}. Falling back to default server.`,
        );
      }
    } catch (err) {
      console.warn("[EEW][AXIS] Fetch error (likely CORS). Falling back to default server.", err);
    }

    return targetServer.endsWith("/socket")
      ? `${targetServer}?token=${encodeURIComponent(token)}`
      : `${targetServer}/socket?token=${encodeURIComponent(token)}`;
  }

  onConnectionEstablished() {
    this.scheduleTokenRefresh();
  }

  // ─── Token Refresh (Tauri only) ──────────────────────────────────────────────
  scheduleTokenRefresh() {
    if (!IS_TAURI) return;

    const storedExpiry = this.getStoredExpiry();
    if (!storedExpiry || Number(storedExpiry) < Date.now()) {
      const expiry = this.getEndOfMonthUTC(new Date());
      this.setStoredExpiry(expiry);
      console.debug(
        "[EEW][AXIS] Token expiry updated to end of current month:",
        new Date(expiry).toISOString(),
      );
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem("eew-token-last-refresh-check-axis");
        localStorage.removeItem("eew-token-last-refresh-check");
      }
    }

    this.checkTokenRefresh();
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = setTimeout(
      () => {
        const tick = () => {
          this.checkTokenRefresh();
          this.tokenRefreshTimer = setTimeout(tick, 24 * 60 * 60 * 1000);
        };
        tick();
      },
      24 * 60 * 60 * 1000,
    );
  }

  getEndOfMonthUTC(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999)).getTime();
  }

  toUTCDateString(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  async checkTokenRefresh() {
    const token = this.getToken();
    if (!IS_TAURI || !tauriFetch || !token) return;

    const now = new Date();
    const todayStr = this.toUTCDateString(now.getTime());

    const lastCheck = this.getStoredLastRefreshCheck();
    if (lastCheck === todayStr) {
      console.debug("[EEW][AXIS] Token refresh already checked today, skipping.");
      return;
    }

    const expiry = Number(this.getStoredExpiry());
    if (!expiry) return;
    const msUntilExpiry = expiry - now.getTime();
    const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24);
    if (daysUntilExpiry > 7) {
      console.debug(
        `[EEW][AXIS] Token expiry in ${Math.round(daysUntilExpiry)} days, no refresh needed yet.`,
      );
      return;
    }

    console.info(
      `[EEW][AXIS] Token expiry in ${Math.round(daysUntilExpiry)} days, attempting refresh...`,
    );

    try {
      const res = await tauriFetch("https://axis.prioris.jp/api/token/refresh/", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      this.setStoredLastRefreshCheck(todayStr);

      if (res.status === 402) {
        console.warn("[EEW][AXIS] Token refresh failed: contract has expired (402).");
        this.alertTokenExpiry();
        return;
      }

      if (!res.ok) {
        console.warn(`[EEW][AXIS] Token refresh failed with HTTP ${res.status}.`);
        this.alertTokenExpiry();
        return;
      }

      const data = await res.json();

      if (data.status === "generate a new token" && data.token) {
        console.info("[EEW][AXIS] Token refreshed successfully.");
        this.setToken(data.token);
        this.setStoredExpiryAlerted(false);

        const nextMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
        const newExpiry = this.getEndOfMonthUTC(nextMonthDate);
        this.setStoredExpiry(newExpiry);
        console.debug("[EEW][AXIS] New token expiry:", new Date(newExpiry).toISOString());

        this.callbacks?.onTokenUpdated?.(data.token);

        // Reconnect with new token
        this.disconnect();
        this.connect(this.callbacks);
      } else if (data.status === "not due for refresh yet") {
        console.debug("[EEW][AXIS] Token refresh not due yet, will retry tomorrow.");
      } else {
        console.warn("[EEW][AXIS] Unexpected token refresh response:", data);
        this.alertTokenExpiry();
      }
    } catch (err) {
      console.warn("[EEW][AXIS] Token refresh request failed:", err);
    }
  }

  alertTokenExpiry() {
    if (this.getStoredExpiryAlerted()) return;
    this.setStoredExpiryAlerted(true);
    alert(
      "EEW token could not be refreshed and will expire at the end of this month. " +
        "Please check your AXIS subscription or update your token in Settings.\n" +
        "EEWトークンの更新に失敗しました。今月末にトークンが無効になります。" +
        "AXISのサブスクリプションを確認するか、「設定」でトークンを更新してください。",
    );
  }

  disconnect() {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    super.disconnect();
  }
}

/**
 * TEST Server EEW Provider
 * Behaves like AXIS provider but connects to ws://localhost:8565 without tokens or serverlist requests.
 */
export class TestEewProvider extends WebSocketEewProvider {
  constructor() {
    super({
      id: "test",
      name: "TEST",
      requiresToken: false,
    });
  }

  isAvailable() {
    return Boolean(USE_TEST_SERVER);
  }

  async getWebSocketUrl() {
    return "ws://localhost:8565";
  }
}

// ─── Provider Registry ───────────────────────────────────────────────────────
const providers = new Map();

export const axisProvider = new AxisEewProvider();
export const testProvider = new TestEewProvider();

export function registerProvider(provider) {
  providers.set(provider.id, provider);
}

registerProvider(axisProvider);
registerProvider(testProvider);

export function getProvider(id) {
  return providers.get(id);
}

export function getAllProviders() {
  return Array.from(providers.values());
}

export function getAvailableProviders() {
  return Array.from(providers.values()).filter((p) => p.isAvailable());
}

let activeProvider = null;

export function getActiveProvider() {
  if (!activeProvider) {
    const available = getAvailableProviders();
    const savedId =
      typeof localStorage !== "undefined" ? localStorage.getItem("eew-provider") : null;
    activeProvider = available.find((p) => p.id === savedId) || available[0] || axisProvider;
  }
  return activeProvider;
}

export function setActiveProvider(providerOrId) {
  if (typeof providerOrId === "string") {
    activeProvider = getProvider(providerOrId) || activeProvider;
  } else if (providerOrId) {
    activeProvider = providerOrId;
  }
  return activeProvider;
}
