import { AXIS_REPORT_CHANNEL, normalizeIntensityString } from "./constants.js";
import { loadAreaNameToCodeMap, getAreaCodeByName } from "./areaCodes.js";

import { isDesktop, desktopFetch } from "./desktopBridge.js";
import { isUseTestServerEnabled, logEewDebugMessage } from "./debugOptions.js";

/**
 * Decodes the payload (claims) of a JWT without verifying its signature.
 *
 * AXIS access tokens are JWTs whose payload carries the expiry (`exp`, seconds
 * since the Unix epoch) and the channels the token grants access to. Decoding
 * is sufficient for display and refresh scheduling; the server remains
 * responsible for validating the signature.
 *
 * @param {string} token Raw token, optionally prefixed with "Bearer ".
 * @returns {Object|null} Decoded claims, or null when the token is not a
 *   well-formed JWT or its payload is not a JSON object.
 */
export function parseJwtPayload(token) {
  if (typeof token !== "string") return null;

  const trimmed = token.trim().replace(/^Bearer\s+/i, "");
  const parts = trimmed.split(".");
  if (parts.length !== 3 || !parts[1]) return null;

  // JWT payloads are base64url-encoded but may also be copied as plain base64.
  let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  if (padding > 0) base64 += "=".repeat(4 - padding);

  try {
    let json;
    if (typeof atob === "function" && typeof TextDecoder !== "undefined") {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      json = new TextDecoder("utf-8").decode(bytes);
    } else if (typeof Buffer !== "undefined") {
      json = Buffer.from(base64, "base64").toString("utf8");
    } else if (typeof atob === "function") {
      // Last-resort ASCII fallback for environments without TextDecoder.
      json = atob(base64);
    } else {
      return null;
    }

    const claims = JSON.parse(json);
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Returns the JWT expiry as milliseconds since the Unix epoch, or null when
 * the token cannot be decoded or has no valid `exp` claim.
 *
 * @param {string} token Raw JWT.
 * @returns {number|null}
 */
export function getJwtExpiryMs(token) {
  const claims = parseJwtPayload(token);
  const exp = Number(claims?.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return exp * 1000;
}

/**
 * Determines whether an EEW is PLUM-method only.
 */
export function isPlumEew(msg) {
  if (!msg) return false;
  if (msg.isPlumOnly) {
    return true;
  }
  const mag = String(msg.Magnitude ?? "").trim();
  const depth = String(msg.Hypocenter?.Depth ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  const isDummyMag = mag === "1.0" || mag === "1" || Number.parseFloat(mag) === 1.0;
  const isDummyDepth = depth === "10km" || depth === "10";
  return isDummyMag && isDummyDepth;
}

/**
 * Formats an EEW depth value with a space before the "km" unit.
 * AXIS and test providers send values like "10km", while EEW Client sends
 * "10 km". Returns "--" for empty values.
 */
export function formatEewDepth(depthValue) {
  const text = String(depthValue ?? "").trim();
  if (!text) return "--";
  return text.replace(/\s*km$/i, " km");
}

/** Values that mean a normalized EEW field carries no usable information. */
const UNKNOWN_FIELD_VALUES = new Set(["", "--", "不明", "unknown", "null", "undefined", "nan"]);

/**
 * Returns true when a normalized EEW field has no usable value.
 */
export function isUnknownValue(value) {
  if (value == null) return true;
  return UNKNOWN_FIELD_VALUES.has(String(value).trim().toLowerCase());
}

/**
 * Returns true when the normalized message is an EEW warning (警報).
 */
export function isWarningEew(msg) {
  if (!msg) return false;
  if (msg.isWarning === true) return true;
  return String(msg.Title ?? "").includes("警報");
}

/**
 * Level method (レベル法), also known as the 100gal method: the magnitude could
 * not be determined from a single station's record.
 *
 * Providers that report the method explicitly (EEW Client `isLevelOver`) take
 * precedence; otherwise the method is inferred from an unknown magnitude.
 * This is a pure method check (like `isPlumEew`) and is evaluated for every
 * provider; the warning/low-accuracy gates live in `computeIsLowAccuracy`.
 */
export function isLevelMethodEew(msg) {
  if (!msg) return false;
  if (typeof msg.isLevelOver === "boolean") return msg.isLevelOver;
  return isUnknownValue(msg.Magnitude);
}

/**
 * Single-station IPF method (IPF法): the hypocenter was estimated from a single
 * station, so the maximum intensity is unknown while the depth is shallower or equal
 * than 150 km. Evaluated for every provider.
 */
export function isSingleStationIpfEew(msg) {
  if (!msg) return false;
  if (!isUnknownValue(msg.Intensity)) return false;
  const depth = Number.parseFloat(String(msg.Hypocenter?.Depth ?? ""));
  return Number.isFinite(depth) && depth <= 150;
}

/**
 * Normalizes the intensity labels inside an EEW area forecast.
 * AXIS uses Japanese labels such as "5弱" / "5強" in Forecast.Intensity,
 * while the rest of the app expects the canonical "5-" / "5+" form.
 */
function normalizeEewForecast(forecast) {
  if (!forecast || typeof forecast !== "object") return forecast;
  const intensity = forecast.Intensity;
  if (!intensity || typeof intensity !== "object") return forecast;
  return {
    ...forecast,
    Intensity: {
      ...intensity,
      From: normalizeIntensityString(intensity.From),
      To: normalizeIntensityString(intensity.To),
    },
  };
}

/**
 * A low-accuracy EEW never carries area forecasts.
 */
function hasAreaForecast(msg) {
  return Array.isArray(msg.Forecast) && msg.Forecast.length > 0;
}

/**
 * Computes the `isLowAccuracy` flag for a normalized EEW message.
 *
 * Providers that expose native accuracy metadata keep the original behaviour:
 * the value '1' in either `accuracy.epicenters` entry marks a low-accuracy EEW.
 * Providers without accuracy metadata have low accuracy inferred from the
 * calculation method. The level (100gal) method is detected for every provider.
 *
 * @param {Object} msg Normalized EEW message.
 * @param {Object} [options]
 * @param {boolean} [options.hasAccuracyInfo] Source exposes native accuracy metadata.
 * @param {boolean} [options.nativeIsLowAccuracy] Source's own low-accuracy flag.
 * @returns {boolean}
 */
export function computeIsLowAccuracy(
  msg,
  { hasAccuracyInfo = false, nativeIsLowAccuracy = false } = {},
) {
  if (!msg || isWarningEew(msg)) return false;

  if (hasAccuracyInfo) {
    const epicenters = msg.accuracy?.epicenters;
    const epicenterLowAccuracy =
      Array.isArray(epicenters) && epicenters.some((value) => String(value) === "1");
    // The level method is checked for all providers, even those with accuracy info.
    return Boolean(nativeIsLowAccuracy) || epicenterLowAccuracy || isLevelMethodEew(msg);
  }

  // Providers without accuracy info: a low-accuracy EEW never has area forecasts.
  if (hasAreaForecast(msg)) return false;

  return isPlumEew(msg) || isLevelMethodEew(msg) || isSingleStationIpfEew(msg);
}

/** Data capabilities an external service can provide. */
export const EXTERNAL_CAPABILITY = {
  EEW: "eew",
  REPORTS: "reports",
};

/**
 * Base External Data Provider.
 *
 * A provider is a data service that can supply one or more capabilities (EEW,
 * earthquake reports). Providers that only exist for documentation (the base
 * JMA XML feed) set `selectable` and `configurable` to false.
 */
export class BaseExternalProvider {
  constructor({
    id,
    name,
    capabilities = [],
    requiresToken = false,
    requiresPort = false,
    defaultPort = "",
    tokenLabel = "Token • トークン:",
    tokenPlaceholder = "Bearer Token",
    tauriOnly = false,
    desktopOnly = false,
    disableGmpe = false,
    supportsHomeSync = false,
    hasAccuracyInfo = false,
    supportsWarningAreas = false,
    selectable = true,
    configurable = true,
    detail = null,
  }) {
    this.id = id;
    this.name = name;
    this.capabilities = capabilities;
    this.requiresToken = requiresToken;
    this.requiresPort = requiresPort;
    this.defaultPort = defaultPort;
    this.tokenLabel = tokenLabel;
    this.tokenPlaceholder = tokenPlaceholder;
    this.desktopOnly = desktopOnly || tauriOnly;
    this.tauriOnly = this.desktopOnly;
    this.disableGmpe = disableGmpe;
    this.supportsHomeSync = supportsHomeSync;
    this.hasAccuracyInfo = hasAccuracyInfo;
    this.supportsWarningAreas = supportsWarningAreas;
    this.selectable = selectable;
    this.configurable = configurable;
    this.detail = detail;
    this.callbacks = null;
    this.nameToCodeMap = new Map();
  }

  supports(capability) {
    return this.capabilities.includes(capability);
  }

  supportsEew() {
    return this.supports(EXTERNAL_CAPABILITY.EEW);
  }

  supportsReports() {
    return this.supports(EXTERNAL_CAPABILITY.REPORTS);
  }

  getHomeSync() {
    if (typeof localStorage === "undefined") return true;
    const val = localStorage.getItem(`external-sync-home-${this.id}`);
    if (val === null) return true; // Enabled by default
    return val === "true";
  }

  setHomeSync(enabled) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`external-sync-home-${this.id}`, enabled ? "true" : "false");
  }

  isAvailable() {
    return !(this.desktopOnly && !isDesktop);
  }

  getToken() {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem(`external-token-${this.id}`) || "";
  }

  setToken(token) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`external-token-${this.id}`, token);
  }

  removeToken() {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(`external-token-${this.id}`);
  }

  getPort() {
    if (typeof localStorage === "undefined") return this.defaultPort;
    return localStorage.getItem(`external-port-${this.id}`) || this.defaultPort;
  }

  setPort(port) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`external-port-${this.id}`, String(port));
  }

  setAreaCodesFromCsv(csvText) {
    if (!csvText) return;
    this.nameToCodeMap.clear();
    for (const raw of csvText.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(";");
      if (parts.length < 2) continue;
      const code = Number.parseInt(parts[0], 10);
      const ja = parts[1]?.trim();
      if (!Number.isNaN(code) && ja) {
        this.nameToCodeMap.set(ja, code);
      }
    }
  }

  async loadAreaCodes(csvText = null) {
    if (csvText) {
      this.setAreaCodesFromCsv(csvText);
      return this.nameToCodeMap;
    }
    if (this.nameToCodeMap.size > 0) return this.nameToCodeMap;
    try {
      const map = await loadAreaNameToCodeMap();
      for (const [name, code] of map.entries()) {
        this.nameToCodeMap.set(name, code);
      }
    } catch (err) {
      console.warn(`[EXTERNAL][${this.name}] Could not load area codes CSV:`, err);
    }
    return this.nameToCodeMap;
  }

  getAreaCode(name) {
    if (!name) return 0;
    const trimmed = name.trim();
    const candidates = [trimmed, `${trimmed}地方`];

    for (const candidate of candidates) {
      if (this.nameToCodeMap.has(candidate)) {
        return this.nameToCodeMap.get(candidate);
      }
      const cached = getAreaCodeByName(candidate);
      if (cached != null) {
        this.nameToCodeMap.set(candidate, cached);
        return cached;
      }
    }

    if (typeof globalThis !== "undefined" && globalThis.__areaCodes) {
      for (const [code, info] of globalThis.__areaCodes.entries()) {
        if (candidates.includes(info.ja)) {
          for (const candidate of candidates) this.nameToCodeMap.set(candidate, code);
          return code;
        }
      }
    }
    return 0;
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
    const isTest = Boolean(rawMsg.isTest || rawMsg.Flag?.is_training);
    const mag = String(rawMsg.Magnitude ?? "").trim();
    const depth = String(rawMsg.Hypocenter?.Depth ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    const isDummyMag = mag === "1.0" || mag === "1" || Number.parseFloat(mag) === 1.0;
    const isDummyDepth = depth === "10km" || depth === "10";
    const isPlum = Boolean(rawMsg.isPlumOnly) || (isDummyMag && isDummyDepth);

    const normalized = {
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
        Depth: formatEewDepth(rawMsg.Hypocenter?.Depth),
        Description: rawMsg.Hypocenter?.Description || "",
      },
      Intensity: normalizeIntensityString(rawMsg.Intensity || "不明"),
      Magnitude: String(rawMsg.Magnitude ?? "--"),
      Flag: {
        is_final: Boolean(rawMsg.Flag?.is_final),
        is_cancel: Boolean(rawMsg.Flag?.is_cancel),
        is_training: isTest,
      },
      Forecast: Array.isArray(rawMsg.Forecast)
        ? rawMsg.Forecast.map(normalizeEewForecast)
        : [],
      Text: rawMsg.Text || "",
      isTest: isTest,
      isLowAccuracy: Boolean(rawMsg.isLowAccuracy),
      isPlumOnly: isPlum,
      accuracy: rawMsg.accuracy ?? null,
    };

    // Providers without native accuracy metadata have low accuracy inferred
    // from the calculation method (PLUM / level (100gal) / single-station IPF).
    normalized.isLowAccuracy = computeIsLowAccuracy(normalized, {
      hasAccuracyInfo:
        this.hasAccuracyInfo || rawMsg.isLowAccuracy != null || rawMsg.accuracy != null,
      nativeIsLowAccuracy: Boolean(rawMsg.isLowAccuracy),
    });

    return normalized;
  }
}

/**
 * Base provider for WebSocket-based external services.
 */
export class WebSocketExternalProvider extends BaseExternalProvider {
  constructor(options) {
    super(options);
    this.socket = null;
    this.retrySec = 100;
    this.retryCount = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.hasConnectedOnce = false;
    this.isManualDisconnect = false;
    this.expectsHello = options.expectsHello ?? true;
    this.useHeartbeat = options.useHeartbeat ?? true;
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
      console.warn(`[EXTERNAL][${this.name}] Failed to resolve WebSocket URL:`, err);
    }

    if (!wsUrl) {
      // If getWebSocketUrl returned null (e.g. auth failed or no token), abort
      this.callbacks?.onStatusChange?.("error");
      return;
    }

    if (this.isManualDisconnect) return;

    console.info(`[EXTERNAL][${this.name}] Connecting to ${wsUrl}`);
    try {
      this.socket = new WebSocket(wsUrl);
    } catch (err) {
      console.warn(`[EXTERNAL][${this.name}] WebSocket creation error:`, err);
      this.retryConnection();
      return;
    }

    this.socket.onopen = () => {
      console.info(`[EXTERNAL][${this.name}] WebSocket Connected.`);
      if (!this.expectsHello) {
        this.hasConnectedOnce = true;
        this.retrySec = 100;
        this.retryCount = 0;
        if (this.useHeartbeat) this.startHeartbeat();
        this.onConnectionEstablished?.();
      } else {
        console.info(`[EXTERNAL][${this.name}] Waiting for hello...`);
      }
    };

    this.socket.onmessage = (event) => {
      const message = event.data;
      if (typeof message === "string") {
        if (this.expectsHello && message === "hello") {
          console.info(
            `[EXTERNAL][${this.name}] Received hello from server. Connection fully established.`,
          );
          this.hasConnectedOnce = true;
          this.callbacks?.onStatusChange?.("connected");
          this.retrySec = 100;
          this.retryCount = 0;
          if (this.useHeartbeat) this.startHeartbeat();
          this.onConnectionEstablished?.();
          return;
        } else if (this.useHeartbeat && message === "hb") {
          return;
        }
      }

      this.handleIncomingRawMessage(message);
    };

    this.socket.onclose = (event) => {
      console.info(
        `[EXTERNAL][${this.name}] Connection closed (code: ${event.code}, reason: ${event.reason})`,
      );
      this.socket = null;
      this.stopHeartbeat();
      if (!this.isManualDisconnect) {
        this.retryConnection();
      }
    };

    this.socket.onerror = (err) => {
      console.warn(`[EXTERNAL][${this.name}] WebSocket error occurred`, err);
    };
  }

  handleIncomingRawMessage(raw) {
    try {
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      logEewDebugMessage(data);
      if (data?.channel === "eew" && data.message) {
        const normalized = this.normalizeMessage(data.message);
        if (normalized) {
          this.callbacks?.onMessage?.(normalized);
        }
      } else if (data?.channel === AXIS_REPORT_CHANNEL && data.message) {
        this.callbacks?.onSeismologyMessage?.(data.message, data);
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
          `[EXTERNAL][${this.name}] Failed to connect after 5 retries. Assuming invalid token.`,
        );
        this.callbacks?.onAuthError?.(
          "EEW connection failed: Token may be invalid. Please check your token in Settings.\n接続に失敗しました：トークンが無効である可能性があります。「設定」でトークンを確認してください。",
        );
      } else if (this.requiresPort) {
        console.warn(
          `[EXTERNAL][${this.name}] Failed to connect to local websocket on port ${this.getPort()}.`,
        );
        this.callbacks?.onAuthError?.(
          "EEW connection failed: Unable to connect to EEW Client.\n" +
            "Please check if the port is correct in Settings and if EEW Client is running with external services enabled.\n\n" +
            "接続に失敗しました：EEW Clientに接続できません。\n" +
            "「設定」でポート番号を確認し、EEW Clientの外部連携機能が有効になっているか確認してください。",
        );
      } else {
        console.warn(`[EXTERNAL][${this.name}] Failed to connect after 5 retries.`);
        this.callbacks?.onStatusChange?.("error");
      }
      return;
    }

    console.info(`[EXTERNAL][${this.name}] Retry: ${this.retryCount} (delay ${this.retrySec}ms)`);
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
    this.callbacks?.onStatusChange?.("disconnected");
    super.disconnect();
  }
}

/**
 * AXIS External Provider
 * Provides EEW and earthquake reports. Handles AXIS server list resolution,
 * 401 detection, and monthly token refresh on desktop.
 */
export class AxisProvider extends WebSocketExternalProvider {
  constructor() {
    super({
      id: "axis",
      name: "AXIS",
      capabilities: [EXTERNAL_CAPABILITY.EEW, EXTERNAL_CAPABILITY.REPORTS],
      requiresToken: true,
      supportsWarningAreas: true,
      tokenLabel: "AXIS Token • トークン:",
      tokenPlaceholder: "Bearer Token",
      detail: {
        descriptionEn:
          "Receives both EEW and earthquake reports. Requires the appropriate channels to be configured.",
        descriptionJa:
          "緊急地震速報と地震情報の両方を受信します。適切なチャンネルの設定が必要です。",
        importantEn: [
          "AXIS is a service in Beta testing. Issues may arise.",
          "EEW data is for personal use only: videos, streams and screenshots including data received via AXIS should not be posted to social media. This does not apply to earthquake reports.",
        ],
        importantJa: [
          "AXISはベータテスト中のサービスです。問題が発生する可能性があります。",
          "緊急地震速報のデータは個人利用のみです。AXISで受信したデータを含む動画・配信・スクリーンショットをSNSに投稿しないでください。これは地震情報には適用されません。",
        ],
        docs: {
          en: "https://github.com/Kiriyashiki/WebQuake/blob/main/doc/AXIS-about-en.md",
          ja: "https://github.com/Kiriyashiki/WebQuake/blob/main/doc/AXIS-about-ja.md",
        },
        sections: [
          {
            titleEn: "EEW",
            titleJa: "緊急地震速報",
            rows: [
              { label: "Speed", labelJa: "速度", value: "Fast", valueJa: "速い" },
              { label: "Stability", labelJa: "安定性", value: "Great", valueJa: "とても良好" },
              { label: "Hypo details", labelJa: "震源詳細", value: "Yes", valueJa: "はい" },
              { label: "Forecast areas", labelJa: "予報区域", value: "Yes", valueJa: "はい" },
              { label: "Warning areas", labelJa: "警報区域", value: "Yes", valueJa: "はい" },
              {
                label: "Low-accuracy EEW",
                labelJa: "1点計算EEW",
                value: "Yes, inferred",
                valueJa: "はい（推定）",
              },
              { label: "LPGM", labelJa: "長周期地震動", value: "No", valueJa: "いいえ" },
              {
                label: "Home location forecast",
                labelJa: "ホーム場所の予報",
                value: "No",
                valueJa: "いいえ",
              },
              { label: "Drills / Tests", labelJa: "訓練・テスト", value: "No", valueJa: "いいえ" },
            ],
          },
          {
            titleEn: "Reports",
            titleJa: "地震情報",
            rows: [
              { label: "Speed", labelJa: "速度", value: "Average", valueJa: "普通" },
              { label: "Stability", labelJa: "安定性", value: "Great", valueJa: "とても良好" },
              {
                label: "震度速報 - Intensity Flash",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label: "震源速報 / 震源に関する情報 - Epicenter Flash",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label:
                  "震源・震度情報 / 震源・震度に関する情報 - Intensity & Epicenter Information",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label:
                  "顕著な地震の震源要素更新のお知らせ - Epicenter update for Notable Earthquake",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label:
                  "長周期地震動に関する観測情報 - Long-period ground motion (LPGM) Information",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label:
                  "推計震度分布図250mメッシュ - Estimated Intensity 250m mesh map",
                labelJa: "",
                value: "No",
                valueJa: "いいえ",
              },
            ],
          },
        ],
      },
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

  /**
   * Claims decoded from the currently stored AXIS token, or null when the
   * token is not a decodable JWT.
   * @returns {Object|null}
   */
  getTokenClaims() {
    return parseJwtPayload(this.getToken());
  }

  /**
   * Token expiry in milliseconds since the Unix epoch, read from the `exp`
   * claim. Returns null when the token has no readable expiry.
   * @returns {number|null}
   */
  getTokenExpiry() {
    return getJwtExpiryMs(this.getToken());
  }

  /**
   * Channels granted by the currently stored token.
   * @returns {string[]}
   */
  getTokenChannels() {
    const channels = this.getTokenClaims()?.channels;
    return Array.isArray(channels) ? channels.map((channel) => String(channel)) : [];
  }

  /**
   * Whether the current token includes the `eew` channel. This is advisory
   * only: a missing channel produces a warning but never invalidates the
   * token or disables EEW reception.
   * @returns {boolean}
   */
  hasEewChannel() {
    return this.getTokenChannels().includes("eew");
  }

  /**
   * Whether the current token includes the `jmx-seismology` channel used for
   * AXIS earthquake reports.  Advisory only, like hasEewChannel().
   * @returns {boolean}
   */
  hasJmxSeismologyChannel() {
    return this.getTokenChannels().includes(AXIS_REPORT_CHANNEL);
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
      console.warn("[EXTERNAL][AXIS] No token provided.");
      return null;
    }

    let targetServer = "wss://ws.axis.prioris.jp";
    try {
      const fetchFn = isDesktop ? desktopFetch : fetch;
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
        console.warn("[EXTERNAL][AXIS] 401 Unauthorized. Invalid token.");
        this.callbacks?.onAuthError?.(
          "EEW connection failed: Invalid Token (401). Please check your token in Settings.\n接続に失敗しました：トークンが無効である可能性があります。「設定」でトークンを確認してください。",
        );
        return null;
      } else {
        console.warn(
          `[EXTERNAL][AXIS] Failed to get server list, HTTP ${res.status}. Falling back to default server.`,
        );
      }
    } catch (err) {
      console.warn("[EXTERNAL][AXIS] Fetch error (likely CORS). Falling back to default server.", err);
    }

    return targetServer.endsWith("/socket")
      ? `${targetServer}?token=${encodeURIComponent(token)}`
      : `${targetServer}/socket?token=${encodeURIComponent(token)}`;
  }

  onConnectionEstablished() {
    this.scheduleTokenRefresh();
  }

  // ─── Token Refresh (Desktop only) ──────────────────────────────────────────────
  scheduleTokenRefresh() {
    if (!isDesktop) return;

    const expiry = this.getTokenExpiry();
    if (!expiry) {
      console.warn(
        "[EXTERNAL][AXIS] Could not read the token expiry (exp) claim; automatic token refresh is disabled.",
      );
      if (this.tokenRefreshTimer) {
        clearTimeout(this.tokenRefreshTimer);
        this.tokenRefreshTimer = null;
      }
      return;
    }

    const storedExpiry = Number(this.getStoredExpiry());
    if (!storedExpiry || storedExpiry !== expiry) {
      this.setStoredExpiry(expiry);
      console.debug(
        "[EXTERNAL][AXIS] Token expiry read from token:",
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

  toUTCDateString(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  async checkTokenRefresh() {
    const token = this.getToken();
    if (!isDesktop || !token) return;

    const now = new Date();
    const todayStr = this.toUTCDateString(now.getTime());

    const lastCheck = this.getStoredLastRefreshCheck();
    if (lastCheck === todayStr) {
      console.debug("[EXTERNAL][AXIS] Token refresh already checked today, skipping.");
      return;
    }

    const expiry = this.getTokenExpiry();
    if (!expiry) {
      console.debug("[EXTERNAL][AXIS] Token expiry unavailable, skipping refresh check.");
      return;
    }
    const msUntilExpiry = expiry - now.getTime();
    const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24);
    if (daysUntilExpiry > 7) {
      console.debug(
        `[EXTERNAL][AXIS] Token expiry in ${Math.round(daysUntilExpiry)} days, no refresh needed yet.`,
      );
      return;
    }

    console.info(
      `[EXTERNAL][AXIS] Token expiry in ${Math.round(daysUntilExpiry)} days, attempting refresh...`,
    );

    try {
      const res = await desktopFetch("https://axis.prioris.jp/api/token/refresh/", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      this.setStoredLastRefreshCheck(todayStr);

      if (res.status === 402) {
        console.warn("[EXTERNAL][AXIS] Token refresh failed: contract has expired (402).");
        this.alertTokenExpiry();
        return;
      }

      if (!res.ok) {
        console.warn(`[EXTERNAL][AXIS] Token refresh failed with HTTP ${res.status}.`);
        this.alertTokenExpiry();
        return;
      }

      const data = await res.json();

      if (data.status === "generate a new token" && data.token) {
        console.info("[EXTERNAL][AXIS] Token refreshed successfully.");
        this.setToken(data.token);
        this.setStoredExpiryAlerted(false);

        const newExpiry = this.getTokenExpiry();
        if (newExpiry) {
          this.setStoredExpiry(newExpiry);
          console.debug("[EXTERNAL][AXIS] New token expiry:", new Date(newExpiry).toISOString());
        } else {
          console.warn("[EXTERNAL][AXIS] Refreshed token has no readable expiry (exp) claim.");
          if (typeof localStorage !== "undefined") {
            localStorage.removeItem("eew-token-expiry-axis");
            localStorage.removeItem("eew-token-expiry");
          }
        }

        this.callbacks?.onTokenUpdated?.(data.token);

        // Reconnect with new token
        this.disconnect();
        this.connect(this.callbacks);
      } else if (data.status === "not due for refresh yet") {
        console.debug("[EXTERNAL][AXIS] Token refresh not due yet, will retry tomorrow.");
      } else {
        console.warn("[EXTERNAL][AXIS] Unexpected token refresh response:", data);
        this.alertTokenExpiry();
      }
    } catch (err) {
      console.warn("[EXTERNAL][AXIS] Token refresh request failed:", err);
    }
  }

  alertTokenExpiry() {
    if (this.getStoredExpiryAlerted()) return;
    this.setStoredExpiryAlerted(true);
    alert(
      "EEW token could not be refreshed. Please check your AXIS subscription or update your token in Settings.\n" +
        "EEWトークンを更新できませんでした。AXISのサブスクリプションを確認するか、「設定」でトークンを更新してください。",
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
 * TEST Server Provider
 * Behaves like AXIS but connects to ws://localhost:8565 without tokens or
 * server list requests. Intended for development.
 */
export class TestProvider extends WebSocketExternalProvider {
  constructor() {
    super({
      id: "test",
      name: "TEST",
      capabilities: [EXTERNAL_CAPABILITY.EEW],
      requiresToken: false,
      supportsWarningAreas: true,
      detail: {
        descriptionEn: "Allows usage of a test server for EEWs. Intended for developer use.",
        descriptionJa: "緊急地震速報のテストサーバーを使用できます。開発者向けです。",
      },
    });
  }

  isAvailable() {
    return isUseTestServerEnabled();
  }

  async getWebSocketUrl() {
    return "ws://localhost:8565";
  }

  normalizeMessage(rawMsg) {
    const msg = super.normalizeMessage(rawMsg);
    if (msg) {
      msg.isTest = true;
      msg.Flag.is_training = true;
    }
    return msg;
  }
}

const WOLF_LOW_ACCURACY_TEXT = "P 波／S 波レベル超え、IPF 法（1 点）、または仮定震源要素";
const WOLF_LEVEL_METHOD_CODETYPE = "最大予測震度のみの緊急地震速報";

/**
 * Converts a Wolfx JST timestamp ("YYYY/MM/DD HH:mm:ss") to an ISO string with
 * an explicit +09:00 offset so it is parsed consistently in every timezone.
 */
function formatWolfxTime(value) {
  const match = String(value ?? "").match(
    /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) return String(value ?? "");
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+09:00`;
}

/**
 * Wolfx Provider
 * Connects to the free public Wolfx EEW WebSocket. No configuration required.
 */
export class WolfxProvider extends WebSocketExternalProvider {
  constructor() {
    super({
      id: "wolfx",
      name: "Wolfx",
      capabilities: [EXTERNAL_CAPABILITY.EEW],
      requiresToken: false,
      expectsHello: false,
      useHeartbeat: false,
      supportsWarningAreas: true,
      detail: {
        descriptionEn:
          "Receives EEW. Wolfx is a free, open service. It requires no extra configuration.",
        descriptionJa:
          "緊急地震速報を受信します。Wolfxは無料のオープンサービスです。追加の設定は必要ありません。",
        sections: [
          {
            titleEn: "EEW",
            titleJa: "緊急地震速報",
            rows: [
              { label: "Speed", labelJa: "速度", value: "Fast", valueJa: "速い" },
              { label: "Stability", labelJa: "安定性", value: "Average", valueJa: "普通" },
              { label: "Hypo details", labelJa: "震源詳細", value: "Yes", valueJa: "はい" },
              { label: "Forecast areas", labelJa: "予報区域", value: "Yes", valueJa: "はい" },
              { label: "Warning areas", labelJa: "警報区域", value: "Yes", valueJa: "はい" },
              {
                label: "Low-accuracy EEW",
                labelJa: "1点計算EEW",
                value: "Yes",
                valueJa: "はい",
              },
              { label: "LPGM", labelJa: "長周期地震動", value: "No", valueJa: "いいえ" },
              {
                label: "Home location forecast",
                labelJa: "ホーム場所の予報",
                value: "No",
                valueJa: "いいえ",
              },
              { label: "Drills / Tests", labelJa: "訓練・テスト", value: "Yes", valueJa: "はい" },
            ],
          },
        ],
      },
    });
  }

  async connect(callbacks) {
    await this.loadAreaCodes().catch(() => {});
    return super.connect(callbacks);
  }

  async getWebSocketUrl() {
    return "wss://ws-api.wolfx.jp/jma_eew";
  }

  onConnectionEstablished() {
    this.callbacks?.onStatusChange?.("connected");
  }

  handleIncomingRawMessage(raw) {
    try {
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      logEewDebugMessage(data);

      if (data?.type === "heartbeat") {
        this.sendPong();
        return;
      }
      if (data?.type === "pong") return;
      if (data?.type && data.type !== "jma_eew") return;
      if (!data?.Title && !data?.EventID) return;

      const normalized = this.normalizeWolfxEew(data);
      if (normalized) this.callbacks?.onMessage?.(normalized);
    } catch (err) {
      console.warn("[EXTERNAL][Wolfx] Error parsing message:", err);
    }
  }

  sendPong() {
    if (typeof WebSocket === "undefined") return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({ type: "pong", timestamp: String(Date.now()) }));
    } catch (err) {
      console.warn("[EXTERNAL][Wolfx] Failed to send pong:", err);
    }
  }

  normalizeWolfxEew(data) {
    if (!data?.Title) return null;

    const title = String(data.Title);
    const isWarning = Boolean(data.isWarn) || title.includes("警報");
    const isCancel = Boolean(data.isCancel);
    const isFinal = Boolean(data.isFinal);
    const isTest =
      Boolean(data.isTraining) || title.includes("訓練") || title.includes("テスト");

    const magnitudeValue = data.Magnitude ?? data.Magunitude;
    const magnitudeNumber = Number(magnitudeValue);
    const magnitude =
      magnitudeValue == null ||
      magnitudeValue === "" ||
      !Number.isFinite(magnitudeNumber) ||
      magnitudeNumber === 0
        ? "--"
        : String(magnitudeValue);

    const depthValue = data.Depth != null ? `${data.Depth}km` : null;
    const isPlum = magnitudeNumber === 1 && Number(data.Depth) === 10;

    const latitude = Number(data.Latitude);
    const longitude = Number(data.Longitude);

    const forecasts = Array.isArray(data.WarnArea)
      ? data.WarnArea.map((area) => {
          const from = normalizeIntensityString(area.Shindo2 || "不明") || "不明";
          const to = normalizeIntensityString(area.Shindo1 || "不明") || "不明";
          return {
            Code: this.getAreaCode(area.Chiiki),
            Name: area.Chiiki || "",
            Intensity: {
              From: from,
              To: to,
              Description: `最大震度${to}`,
            },
            isWarningArea: area.Type === "警報" || area.Type === "Warning",
          };
        })
      : [];

    const accuracyText = String(data.Accuracy?.Epicenter || "");
    const isLowAccuracyByAccuracy =
      accuracyText === WOLF_LOW_ACCURACY_TEXT ||
      accuracyText.includes("IPF 法（1 点）") ||
      accuracyText.includes("レベル超え") ||
      accuracyText.includes("仮定震源要素");
    const isLevelMethod = String(data.CodeType || "").includes(WOLF_LEVEL_METHOD_CODETYPE);

    const normalized = {
      Title: title,
      EventID: String(data.EventID || ""),
      Serial: Number(data.Serial) || data.Serial || 1,
      OriginDateTime: formatWolfxTime(data.OriginTime),
      ReportDateTime: formatWolfxTime(data.AnnouncedTime),
      Hypocenter: {
        Code: this.getAreaCode(data.Hypocenter),
        Name: data.Hypocenter || "不明",
        Coordinate:
          Number.isFinite(latitude) && Number.isFinite(longitude)
            ? [longitude, latitude]
            : null,
        Depth: formatEewDepth(depthValue),
        Description: "",
      },
      Intensity: normalizeIntensityString(data.MaxIntensity || "不明") || "不明",
      Magnitude: magnitude,
      Flag: {
        is_final: isFinal,
        is_cancel: isCancel,
        is_training: isTest,
      },
      Forecast: forecasts,
      Text: data.OriginalText || "",
      isTest,
      isWarning,
      isPlumOnly: isPlum,
      isLowAccuracy: false,
      accuracy: data.Accuracy || null,
    };

    normalized.isLowAccuracy =
      !isWarning && !isCancel && (isLowAccuracyByAccuracy || isLevelMethod);

    return normalized;
  }
}

/**
 * EEW Client Provider (Project DM-D.S.S)
 * Connects to a local websocket running in EEW Client on 127.0.0.1:<port>
 * (desktop only).
 */
export class EewClientProvider extends WebSocketExternalProvider {
  constructor() {
    super({
      id: "eewclient",
      name: "DMDSS EEW Client",
      capabilities: [EXTERNAL_CAPABILITY.EEW],
      requiresToken: false,
      requiresPort: true,
      defaultPort: "11311",
      desktopOnly: true,
      tauriOnly: true,
      expectsHello: false,
      useHeartbeat: false,
      disableGmpe: true,
      supportsHomeSync: true,
      hasAccuracyInfo: true,
      detail: {
        descriptionEn:
          "Receives EEW. Requires having the EEW Client application running, with a subscription active.",
        descriptionJa:
          "緊急地震速報を受信します。EEW Clientアプリケーションを起動し、サブスクリプションを有効にしておく必要があります。",
        importantEn: [
          "Videos, streams and screenshots including data received via EEW Client can be posted to social media, but require the application's name to be included (for example, in video descriptions).",
        ],
        importantJa: [
          "EEW Clientで受信したデータを含む動画・配信・スクリーンショットはSNSに投稿できますが、アプリケーション名を記載する必要があります（例：動画の説明欄）。",
        ],
        docs: {
          en: "https://github.com/Kiriyashiki/WebQuake/blob/main/doc/EEWC-about-en.md",
          ja: "https://github.com/Kiriyashiki/WebQuake/blob/main/doc/EEWC-about-ja.md",
        },
        sections: [
          {
            titleEn: "EEW",
            titleJa: "緊急地震速報",
            rows: [
              { label: "Speed", labelJa: "速度", value: "Fast", valueJa: "速い" },
              { label: "Stability", labelJa: "安定性", value: "Good", valueJa: "良好" },
              { label: "Hypo details", labelJa: "震源詳細", value: "Yes", valueJa: "はい" },
              {
                label: "Forecast areas",
                labelJa: "予報区域",
                value: "Yes *1",
                valueJa: "はい *1",
              },
              { label: "Warning areas", labelJa: "警報区域", value: "No", valueJa: "いいえ" },
              { label: "Low-accuracy EEW", labelJa: "1点計算EEW", value: "Yes", valueJa: "はい" },
              { label: "LPGM", labelJa: "長周期地震動", value: "Yes", valueJa: "はい" },
              {
                label: "Home location forecast",
                labelJa: "ホーム場所の予報",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label: "Drills / Tests",
                labelJa: "訓練・テスト",
                value: "No *2",
                valueJa: "いいえ *2",
              },
            ],
          },
        ],
        footnotes: [
          {
            marker: "*1",
            en: "Forecast areas are calculated by EEW Client and not the JMA issued ones; so discrepancies can occur.",
            ja: "予報区域はEEW Clientが計算したものであり、気象庁が発表したものではないため、相違が生じる場合があります。",
          },
          {
            marker: "*2",
            en: "Official EEW drills are not included, but you can run tests from EEW Client's settings.",
            ja: "気象庁の公式な訓練は含まれませんが、EEW Clientの設定からテストを実行できます。",
          },
        ],
      },
    });
    this.userPoint = null;
    this.lastServerStatus = null;
  }

  async connect(callbacks) {
    await this.loadAreaCodes().catch(() => {});
    return super.connect(callbacks);
  }

  async getWebSocketUrl() {
    const port = this.getPort() || "11311";
    return `ws://127.0.0.1:${port}`;
  }

  onConnectionEstablished() {
    if (this.lastServerStatus === "open") {
      this.callbacks?.onStatusChange?.("connected");
    } else {
      this.callbacks?.onStatusChange?.("upstream-disconnected");
    }
  }

  handleIncomingRawMessage(raw) {
    try {
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      logEewDebugMessage(data);
      if (!data?.type) return;

      if (data.type === "start") {
        console.info(`[EXTERNAL][EEW Client] Connected to EEW Client v${data.version}`);
        return;
      }

      if (data.type === "user-point") {
        this.userPoint = data.location;
        console.debug("[EXTERNAL][EEW Client] Received user-point:", data.location);
        this.callbacks?.onUserPoint?.(data.location);
        return;
      }

      if (data.type === "server-status") {
        this.lastServerStatus = data.status;
        console.info(`[EXTERNAL][EEW Client] Upstream server status: ${data.status}`);
        if (data.status === "open") {
          this.callbacks?.onStatusChange?.("connected");
        } else {
          this.callbacks?.onStatusChange?.("upstream-disconnected");
        }
        return;
      }

      if (data.type === "eew") {
        const normalized = this.normalizeEewClientEew(data);
        if (normalized) {
          this.callbacks?.onMessage?.(normalized);
        }
      }
    } catch (err) {
      console.warn("[EXTERNAL][EEW Client] Error parsing message:", err);
    }
  }

  normalizeEewClientEew(data) {
    const isWarning = Boolean(data.isWarning);
    const isCancel = Boolean(data.isCanceled);
    const isFinal = Boolean(data.isLastInfo);
    const isTest = Boolean(data.isTest);
    const mag = String(data.magnitude ?? "").trim();
    const depth = String(data.depth != null ? `${data.depth}km` : "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    const isDummyMag = mag === "1.0" || mag === "1" || Number.parseFloat(mag) === 1.0;
    const isDummyDepth = depth === "10km" || depth === "10";
    const isPlumOnly = Boolean(data.isPlumOnly) || (isDummyMag && isDummyDepth);

    // Native accuracy: value '1' in either 'epicenters' value is a low-accuracy EEW.
    const epicentersAcc = data.accuracy?.epicenters;
    const nativeIsLowAccuracy =
      Array.isArray(epicentersAcc) && epicentersAcc.some((v) => String(v) === "1");

    // Look up hypocenter code by epicenterName from area code data
    const epicenterName = (data.epicenterName || "").trim();
    const hypoCode = this.getAreaCode(epicenterName);

    const forecasts = Array.isArray(data.regionForecasts)
      ? data.regionForecasts.map((rf) => {
          const maxIntStr = normalizeIntensityString(rf.maxInt || rf.to || "0");
          return {
            Code: Number(rf.code) || rf.code,
            Intensity: {
              From: maxIntStr,
              To: maxIntStr,
              Description: `最大震度${maxIntStr}`,
            },
          };
        })
      : [];

    let intensityStr = "不明";
    if (data.maxInt?.to) {
      if (data.maxInt.to === "over" && data.maxInt.from) {
        intensityStr = normalizeIntensityString(data.maxInt.from);
      } else {
        intensityStr = normalizeIntensityString(data.maxInt.to);
      }
    } else if (data.maxInt && typeof data.maxInt === "string") {
      intensityStr = normalizeIntensityString(data.maxInt);
    }

    let lpgmStr = "";
    if (data.maxLgInt?.to) {
      if (data.maxLgInt.to === "over" && data.maxLgInt.from) {
        lpgmStr = data.maxLgInt.from;
      } else {
        lpgmStr = data.maxLgInt.to;
      }
    } else if (data.maxLgInt && typeof data.maxLgInt === "string") {
      lpgmStr = data.maxLgInt;
    }

    const normalized = {
      Title: isWarning ? "緊急地震速報（警報）" : "緊急地震速報（予報）",
      EventID: String(data.eventId || ""),
      Serial: Number(data.serial) || data.serial || 1,
      OriginDateTime:
        data.originTime || data.arrivalTime || data.pressTime || new Date().toISOString(),
      ReportDateTime: data.pressTime || data.processTime || new Date().toISOString(),
      Hypocenter: {
        Code: hypoCode,
        Name: data.epicenterName || "不明",
        Coordinate:
          Array.isArray(data.epicenterLocation) && data.epicenterLocation.length >= 2
            ? [Number(data.epicenterLocation[0]), Number(data.epicenterLocation[1])]
            : null,
        Depth: formatEewDepth(data.depth != null ? `${data.depth}km` : null),
        Description: "",
      },
      Intensity: intensityStr,
      Magnitude: data.magnitude != null ? String(data.magnitude) : "--",
      Flag: {
        is_final: isFinal,
        is_cancel: isCancel,
        is_training: isTest,
      },
      Forecast: forecasts,
      Text: "",
      isTest: isTest,
      isPlumOnly: isPlumOnly,
      // Native level-method flag (レベル法 / 100gal detection). null when the
      // source does not report it, so level method is inferred from the magnitude.
      isLevelOver: data.isLevelOver ?? null,
      isLowAccuracy: false,
      pointForecast: data.pointForecast
        ? {
            ...data.pointForecast,
            intensity: data.pointForecast.intensity
              ? {
                  ...data.pointForecast.intensity,
                  int: normalizeIntensityString(data.pointForecast.intensity.int),
                }
              : data.pointForecast.intensity,
          }
        : null,
      maxLgInt: lpgmStr,
      accuracy: data.accuracy || null,
    };

    normalized.isLowAccuracy = computeIsLowAccuracy(normalized, {
      hasAccuracyInfo: true,
      nativeIsLowAccuracy,
    });

    return normalized;
  }

  disconnect() {
    this.lastServerStatus = null;
    super.disconnect();
  }
}

/**
 * JMA XML Provider
 *
 * The base earthquake report feed is always used and cannot be connected or
 * configured. This entry exists so the provider list documents the app's base
 * data source.
 */
export class JmaXmlProvider extends BaseExternalProvider {
  constructor() {
    super({
      id: "jma-xml",
      name: "JMA XML",
      capabilities: [EXTERNAL_CAPABILITY.REPORTS],
      selectable: false,
      configurable: false,
      detail: {
        descriptionEn:
          "Receives earthquake reports. The base data source of the app, always used, without any configuration needed.",
        descriptionJa:
          "地震情報を受信します。このアプリの基本データソースであり、設定なしで常に使用されます。",
        sections: [
          {
            titleEn: "Reports",
            titleJa: "地震情報",
            rows: [
              { label: "Speed", labelJa: "速度", value: "Slow", valueJa: "遅い" },
              { label: "Stability", labelJa: "安定性", value: "Good", valueJa: "良好" },
              {
                label: "震度速報 - Intensity Flash",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label: "震源速報 / 震源に関する情報 - Epicenter Flash",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label:
                  "震源・震度情報 / 震源・震度に関する情報 - Intensity & Epicenter Information",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label:
                  "顕著な地震の震源要素更新のお知らせ - Epicenter update for Notable Earthquake",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label:
                  "長周期地震動に関する観測情報 - Long-period ground motion (LPGM) Information",
                labelJa: "",
                value: "Yes",
                valueJa: "はい",
              },
              {
                label:
                  "推計震度分布図250mメッシュ - Estimated Intensity 250m mesh map",
                labelJa: "",
                value: "No",
                valueJa: "いいえ",
              },
            ],
          },
        ],
      },
    });
  }

  isAvailable() {
    return true;
  }
}

// ─── Provider Registry ───────────────────────────────────────────────────────
const providers = new Map();

export const axisProvider = new AxisProvider();
export const testProvider = new TestProvider();
export const wolfxProvider = new WolfxProvider();
export const eewClientProvider = new EewClientProvider();
export const jmaXmlProvider = new JmaXmlProvider();

export function registerProvider(provider) {
  providers.set(provider.id, provider);
}

registerProvider(axisProvider);
registerProvider(testProvider);
registerProvider(wolfxProvider);
registerProvider(eewClientProvider);
registerProvider(jmaXmlProvider);

export function getProvider(id) {
  return providers.get(id);
}

export function getAllProviders() {
  return Array.from(providers.values());
}

export function getAvailableProviders() {
  return Array.from(providers.values()).filter((p) => p.isAvailable());
}

/** Providers that can be chosen as a source for the given capability. */
export function getSelectableProviders(capability) {
  return getAvailableProviders().filter((p) => p.selectable && p.supports(capability));
}

// ─── External source selection ──────────────────────────────────────────────
const EXTERNAL_STORAGE_KEYS = {
  [EXTERNAL_CAPABILITY.EEW]: {
    source: "external-eew-source",
    enabled: "external-eew-enabled",
  },
  [EXTERNAL_CAPABILITY.REPORTS]: {
    source: "external-reports-source",
    enabled: "external-reports-enabled",
  },
};

/**
 * Copies legacy EEW settings to the generalized external-service keys.
 * Safe to call repeatedly.
 */
export function migrateExternalServiceSettings() {
  if (typeof localStorage === "undefined") return;

  const read = (key) => localStorage.getItem(key);
  const copy = (newKey, oldKey) => {
    if (read(newKey) == null && read(oldKey) != null) {
      localStorage.setItem(newKey, read(oldKey));
    }
  };

  copy(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.EEW].source, "eew-provider");
  copy(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.EEW].enabled, "eew-enabled");

  const eewSource = read(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.EEW].source);
  if (eewSource === "dmdss") {
    localStorage.setItem(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.EEW].source, "eewclient");
  }

  // The old app defaulted to AXIS when EEW was enabled without an explicit
  // provider selection.
  if (
    read(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.EEW].enabled) === "true" &&
    !read(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.EEW].source)
  ) {
    localStorage.setItem(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.EEW].source, "axis");
  }

  copy("external-port-eewclient", "eew-port-dmdss");
  copy("external-sync-home-eewclient", "eew-sync-home-dmdss");

  if (read("axis-reports-enabled") === "true") {
    if (read(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.REPORTS].source) == null) {
      localStorage.setItem(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.REPORTS].source, "axis");
    }
    if (read(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.REPORTS].enabled) == null) {
      localStorage.setItem(EXTERNAL_STORAGE_KEYS[EXTERNAL_CAPABILITY.REPORTS].enabled, "true");
    }
  }

  // Retire migrated legacy keys.
  localStorage.removeItem("eew-provider");
  localStorage.removeItem("eew-enabled");
  localStorage.removeItem("eew-port-dmdss");
  localStorage.removeItem("eew-sync-home-dmdss");
  localStorage.removeItem("axis-reports-enabled");
}

/** Stored provider id for a capability, or "" when no source is selected. */
export function getExternalSourceId(capability) {
  const keys = EXTERNAL_STORAGE_KEYS[capability];
  if (!keys || typeof localStorage === "undefined") return "";
  return localStorage.getItem(keys.source) || "";
}

/** Persists the provider id selected for a capability. */
export function setExternalSourceId(capability, providerId) {
  const keys = EXTERNAL_STORAGE_KEYS[capability];
  if (!keys || typeof localStorage === "undefined") return;
  if (providerId) localStorage.setItem(keys.source, providerId);
  else localStorage.removeItem(keys.source);
}

/** Whether the connection for a capability is enabled. */
export function isExternalSourceEnabled(capability) {
  const keys = EXTERNAL_STORAGE_KEYS[capability];
  if (!keys || typeof localStorage === "undefined") return false;
  return localStorage.getItem(keys.enabled) === "true";
}

/** Enables or disables the connection for a capability. */
export function setExternalSourceEnabled(capability, enabled) {
  const keys = EXTERNAL_STORAGE_KEYS[capability];
  if (!keys || typeof localStorage === "undefined") return;
  localStorage.setItem(keys.enabled, enabled ? "true" : "false");
}

/**
 * Resolves the provider currently selected for a capability. Returns null when
 * no provider is selected, the provider is unavailable, or it does not provide
 * the requested capability.
 */
export function getExternalSourceProvider(capability) {
  const provider = getProvider(getExternalSourceId(capability));
  if (
    !provider ||
    !provider.selectable ||
    !provider.isAvailable() ||
    !provider.supports(capability)
  ) {
    return null;
  }
  return provider;
}

/** Provider selected as the EEW source, used by the EEW rendering pipeline. */
export function getEewSourceProvider() {
  return getExternalSourceProvider(EXTERNAL_CAPABILITY.EEW);
}

export function getShowTestEew() {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem("eew-show-test") === "true";
}

export function setShowTestEew(enabled) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem("eew-show-test", enabled ? "true" : "false");
}

// Migrate the legacy EEW settings as soon as the module is loaded.
migrateExternalServiceSettings();
