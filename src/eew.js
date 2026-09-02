import maplibregl from "maplibre-gl";
import {
  formatTimeJSTWithSeconds,
  INTENSITY_CONFIG,
  USE_TEST_SERVER,
  TEST_GMPE_OVERRIDE,
  haversineDistance
} from "./constants.js";
import { playAudio } from "./audio.js";
import {
  updateCityAreasVisibility,
  updateShakemapVisibility,
  clearEpicenter,
  fitBoundsToObservations,
  highlightObservations,
  updateLpgmVisibility,
  hideHomeLocationIntensity,
} from "./map.js";
import { createRubyHtml, loadCityForecastMapCsv, loadStationsCsvText } from "./areaCodes.js";
import { getCityAreasState, getHomeIntensityState } from "./sidebarUI.js";
import { updateMapLegend } from "./main.js";

// Detect Tauri runtime — when running as a desktop app, we can bypass CORS
// by using Tauri's HTTP plugin which makes requests through Rust's HTTP client.
const IS_TAURI = Boolean(window.__TAURI_INTERNALS__);
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

let eewSocket = null;
let activeEews = new Map(); // EventID -> EEW Object
let retrySec = 100;
let retryCount = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let eewToken = "";
let hasConnectedOnce = false;
let tokenRefreshTimer = null;

// For map and carousel
let carouselIndex = 0;
let carouselTimer = null;
let mapInstance = null;
let featureBounds = null;
let cityNames = null;
let areaCodes = null;
let eewEpicenterMarkers = [];

let travelTimeData = null;
let cityForecastMap = new Map();
let stationsData = [];
let _eewDependenciesPromise = null;

async function loadEewDependencies() {
  if (_eewDependenciesPromise) return _eewDependenciesPromise;

  _eewDependenciesPromise = (async () => {
    try {
      const [tjmaRes, cityRes, stationsRes] = await Promise.all([
        fetch("/tjma2001.csv").then((res) => res.text()),
        loadCityForecastMapCsv(),
        loadStationsCsvText(),
      ]);

      travelTimeData = {};
      const tjmaLines = tjmaRes.trim().split("\n");
      for (let i = 1; i < tjmaLines.length; i++) {
        if (!tjmaLines[i]) continue;
        const [depth, distance, p_time, s_time] = tjmaLines[i].split(",").map(Number);
        if (!travelTimeData[depth]) {
          travelTimeData[depth] = [];
        }
        travelTimeData[depth].push({ distance, p_time, s_time });
      }

      cityRes.split("\n").forEach((line) => {
        const parts = line.split(",");
        if (parts.length >= 2) {
          cityForecastMap.set(parts[0].trim(), parts[1].trim());
        }
      });

      const stationsLines = stationsRes.trim().split("\n");
      for (let i = 1; i < stationsLines.length; i++) {
        if (!stationsLines[i]) continue;
        const parts = stationsLines[i].split(";");
        if (parts.length >= 8) {
          stationsData.push({
            lat: Number.parseFloat(parts[4]),
            lon: Number.parseFloat(parts[5]),
            cityCode: parts[6],
            arv: Number.parseFloat(parts[7]),
          });
        }
      }
      console.info("[EEW] Loaded dependencies.");
    } catch (err) {
      console.error("[EEW] Could not load dependencies:", err);
    }
  })();

  return _eewDependenciesPromise;
}

function calculateGmpe(magnitude, depthKm, epicentralDistance, arv) {
  const hypocentralDistance = Math.hypot(epicentralDistance, depthKm);
  const faultFactor = 0.0028 * 10.0 ** (0.5 * magnitude);
  const d2 = Math.max(hypocentralDistance - faultFactor, 3.0);
  const sourceEnergy = magnitude * 0.58 + 0.0038 * depthKm - 1.29;
  const geometricDecay = Math.log10(d2 + faultFactor);
  const anelasticDecay = 0.002 * d2;
  const siteAmplification = Math.log10(arv * 1.31);
  const log10a = sourceEnergy - geometricDecay - anelasticDecay + siteAmplification;
  const shindo = 2.68 + 1.72 * log10a;
  return shindo;
}

function floatToShindo(val) {
  if (val < 0.5) return "0";
  if (val < 1.5) return "1";
  if (val < 2.5) return "2";
  if (val < 3.5) return "3";
  if (val < 4.5) return "4";
  if (val < 5.0) return "5-";
  if (val < 5.5) return "5+";
  if (val < 6.0) return "6-";
  if (val < 6.5) return "6+";
  return "7";
}

// For restoring map state
let mapInteractionTimeout = null;
let isUserInteractingWithMap = false;
let isEewMapActive = false;
let previousReport = null; // Store currently opened normal report to restore after EEWs clear

/**
 * Clears EEW visual elements from the map when a normal report is selected.
 */
export function clearEewMapDisplay() {
  isEewMapActive = false;
  isUserInteractingWithMap = false;

  if (mapInteractionTimeout) {
    clearTimeout(mapInteractionTimeout);
    mapInteractionTimeout = null;
  }

  hideHomeLocationIntensity();

  for (const marker of eewEpicenterMarkers) {
    marker.remove();
  }
  eewEpicenterMarkers = [];

  if (mapInstance) {
    const pSrc = mapInstance.getSource("eew-p-wave");
    const sSrc = mapInstance.getSource("eew-s-wave");
    if (pSrc) pSrc.setData({ type: "FeatureCollection", features: [] });
    if (sSrc) sSrc.setData({ type: "FeatureCollection", features: [] });
  }
}

/**
 * Initializes the EEW settings and connects if enabled.
 */
export function initEewSettings(map, bounds, cities, areas) {
  mapInstance = map;
  featureBounds = bounds;
  cityNames = cities;
  areaCodes = areas;

  const toggleEl = document.getElementById("eew-toggle");
  const tokenEl = document.getElementById("eew-token-input");

  if (!toggleEl || !tokenEl) return;

  const savedEnabled = localStorage.getItem("eew-enabled") === "true";
  const savedToken = localStorage.getItem("eew-token") || "";

  toggleEl.checked = savedEnabled;
  tokenEl.value = savedToken;
  eewToken = savedToken;

  if (savedEnabled && savedToken) {
    hasConnectedOnce = false;
    connectEew();
  }

  toggleEl.addEventListener("change", (e) => {
    const isEnabled = e.target.checked;
    localStorage.setItem("eew-enabled", isEnabled ? "true" : "false");
    if (isEnabled) {
      hasConnectedOnce = false;
      connectEew();
    } else {
      disconnectEew();
    }
  });

  tokenEl.addEventListener("change", (e) => {
    const token = e.target.value.trim();
    localStorage.setItem("eew-token", token);
    eewToken = token;
    // User manually changed the token — reset refresh tracking state
    resetTokenRefreshState();
    if (toggleEl.checked) {
      disconnectEew();
      if (token) {
        hasConnectedOnce = false;
        connectEew();
      }
    }
  });

  // Track map interactions to pause fitBounds
  map.on("mousedown", onMapInteract);
  map.on("wheel", onMapInteract);
  map.on("touchstart", onMapInteract);

  const eewStatusContainer = document.getElementById("eew-status-container");
  if (eewStatusContainer) {
    eewStatusContainer.addEventListener("click", () => {
      if (toggleEl.checked) {
        console.info("[EEW] Manual reconnect triggered");
        disconnectEew();
        hasConnectedOnce = false;
        connectEew();
      }
    });
  }
}

export function updateEewStatus(state) {
  const container = document.getElementById("eew-status-container");
  const dot = document.getElementById("eew-status-dot");
  const text = document.getElementById("eew-status-text");

  if (!container || !dot || !text) return;

  const toggleEl = document.getElementById("eew-toggle");
  if (!toggleEl?.checked) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");

  if (state === "connecting") {
    dot.className = "dot-loading";
    text.textContent = "EEW: Connecting";
  } else if (state === "connected") {
    dot.className = "dot-live";
    text.textContent = "EEW: Connected";
  } else if (state === "error") {
    dot.className = "dot-error";
    text.textContent = "EEW: Disconnected";
  }
}

function onMapInteract() {
  if (activeEews.size === 0 || !isEewMapActive || document.querySelector(".eq-item.active")) return;
  isUserInteractingWithMap = true;
  if (mapInteractionTimeout) clearTimeout(mapInteractionTimeout);
  mapInteractionTimeout = setTimeout(() => {
    isUserInteractingWithMap = false;
    if (activeEews.size > 0 && isEewMapActive && !document.querySelector(".eq-item.active")) {
      updateMapForEew(); // Resume fitBounds
    }
  }, 5000);
}

async function connectEew() {
  if (!eewToken) return;
  if (eewSocket) disconnectEew();

  await loadEewDependencies();

  updateEewStatus("connecting");

  let targetServer = "wss://ws.axis.prioris.jp";

  if (USE_TEST_SERVER) {
    targetServer = "ws://localhost:8565";
  } else {
    try {
      const fetchFn = tauriFetch || fetch;
      const res = await fetchFn("https://axis.prioris.jp/api/server/list/", {
        headers: {
          Authorization: `Bearer ${eewToken}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        if (data.servers && data.servers.length > 0) {
          targetServer = data.servers[0];
        }
      } else if (res.status === 401) {
        console.warn("[EEW] 401 Unauthorized. Invalid token.");
        alert(
          "EEW connection failed: Invalid Token (401). Please check your token in Settings.\n接続に失敗しました：トークンが無効である可能性があります。「設定」でトークンを確認してください。",
        );
        disconnectEew();
        const toggleEl = document.getElementById("eew-toggle");
        if (toggleEl) {
          toggleEl.checked = false;
          localStorage.setItem("eew-enabled", "false");
          updateEewStatus("error"); // Will hide the status container
        }
        return; // Stop connection flow completely
      } else {
        console.warn(
          "[EEW] Failed to get server list, HTTP " +
            res.status +
            ". Falling back to default server.",
        );
      }
    } catch (err) {
      console.warn("[EEW] Fetch error (likely CORS). Falling back to default server.", err);
    }
  }

  connectToWebSocket(targetServer);
}

function connectToWebSocket(serverUrl) {
  const wsUrl = serverUrl.endsWith("/socket")
    ? `${serverUrl}?token=${encodeURIComponent(eewToken)}`
    : `${serverUrl}/socket?token=${encodeURIComponent(eewToken)}`;

  console.info("[EEW] Connecting to", serverUrl);
  eewSocket = new WebSocket(wsUrl);

  eewSocket.onopen = () => {
    console.info("[EEW] WebSocket Connected. Waiting for hello...");
  };

  eewSocket.onmessage = (event) => {
    const message = event.data;
    if (typeof message === "string") {
      if (message === "hello") {
        console.info("[EEW] Received hello from server. Connection fully established.");
        hasConnectedOnce = true;
        updateEewStatus("connected");
        retrySec = 100;
        retryCount = 0;
        startHeartbeat();
        scheduleTokenRefresh();
        return;
      } else if (message === "hb") {
        return;
      }
    }

    // Attempt JSON decode
    try {
      const data = JSON.parse(message);
      if (data?.channel === "eew" && data.message) {
        console.debug(Date.now());
        console.debug(data.message);
        handleEewMessage(data.message);
      }
    } catch (err) {
      // Not JSON, ignore
    }
  };

  eewSocket.onclose = (event) => {
    console.info(`[EEW] Connection closed (code: ${event.code}, reason: ${event.reason})`);
    eewSocket = null;
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    retryConnection();
  };

  eewSocket.onerror = (err) => {
    console.warn("[EEW] WebSocket error occurred");
  };
}

function retryConnection() {
  if (!document.getElementById("eew-toggle")?.checked) {
    updateEewStatus("error");
    return;
  }

  retrySec = retrySec * 2;
  if (retrySec > 300000) {
    retrySec = 300000;
  }

  retryCount++;

  if (!hasConnectedOnce && retryCount > 5) {
    console.warn("[EEW] Failed to connect after 5 retries. Assuming invalid token.");
    alert(
      "EEW connection failed: Token may be invalid. Please check your token in Settings.\n接続に失敗しました：トークンが無効である可能性があります。「設定」でトークンを確認してください。",
    );
    disconnectEew();
    const toggleEl = document.getElementById("eew-toggle");
    if (toggleEl) {
      toggleEl.checked = false;
      localStorage.setItem("eew-enabled", "false");
      updateEewStatus("error"); // Will hide the status container
    }
    return;
  }

  console.info(`[EEW] Retry: ${retryCount} (delay ${retrySec}ms)`);
  updateEewStatus("connecting");
  reconnectTimer = setTimeout(connectEew, retrySec);
}

function disconnectEew() {
  updateEewStatus("error");
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }
  if (eewSocket) {
    eewSocket.onclose = null;
    eewSocket.close();
    eewSocket = null;
  }
  clearAllEews();
}

// ─── Token Refresh (Tauri only) ──────────────────────────────────────────────
// AXIS tokens expire at month's end. In the last 7 days, the refresh API can
// issue a new token valid through next month. We poll at most once per day.

/**
 * Returns the end-of-month timestamp (UTC, last millisecond) for a given date.
 */
function getEndOfMonthUTC(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  // Day 0 of next month = last day of current month
  return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999)).getTime();
}

/**
 * Returns the UTC date string (YYYY-MM-DD) for a given timestamp.
 */
function toUTCDateString(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Resets token refresh tracking when the user manually changes the token.
 */
function resetTokenRefreshState() {
  localStorage.removeItem("eew-token-expiry");
  localStorage.removeItem("eew-token-last-refresh-check");
  localStorage.removeItem("eew-token-expiry-alerted");
}

/**
 * Called after a successful EEW connection ("hello" received).
 * Sets the token expiry if not already set, then runs the refresh check
 * and schedules a 24-hour recurring timer.
 */
function scheduleTokenRefresh() {
  if (!IS_TAURI) return;

  // If we don't have a stored expiry yet, or it's in the past but the token
  // still works, push the expiry to the end of the current month.
  const storedExpiry = localStorage.getItem("eew-token-expiry");
  if (!storedExpiry || Number(storedExpiry) < Date.now()) {
    const expiry = getEndOfMonthUTC(new Date());
    localStorage.setItem("eew-token-expiry", String(expiry));
    console.debug(
      "[EEW] Token expiry updated to end of current month:",
      new Date(expiry).toISOString(),
    );
    // Remove the last refresh check so we can check again if needed
    localStorage.removeItem("eew-token-last-refresh-check");
  }

  // Run immediately, then every 24 hours
  checkTokenRefresh();
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
  tokenRefreshTimer = setTimeout(
    function tick() {
      checkTokenRefresh();
      tokenRefreshTimer = setTimeout(tick, 24 * 60 * 60 * 1000);
    },
    24 * 60 * 60 * 1000,
  );
}

/**
 * Checks whether the AXIS token should be refreshed.
 * Only calls the API if running in Tauri, we're in the last 7 days of the
 * expiry month, and we haven't already checked today.
 */
async function checkTokenRefresh() {
  if (!IS_TAURI || !tauriFetch || !eewToken) return;

  const now = new Date();
  const todayStr = toUTCDateString(now.getTime());

  // Don't check more than once per day
  const lastCheck = localStorage.getItem("eew-token-last-refresh-check");
  if (lastCheck === todayStr) {
    console.debug("[EEW] Token refresh already checked today, skipping.");
    return;
  }

  // Only check in the last 7 days before expiry
  const expiry = Number(localStorage.getItem("eew-token-expiry"));
  if (!expiry) return;
  const msUntilExpiry = expiry - now.getTime();
  const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24);
  if (daysUntilExpiry > 7) {
    console.debug(
      `[EEW] Token expiry in ${Math.round(daysUntilExpiry)} days, no refresh needed yet.`,
    );
    return;
  }

  console.info(`[EEW] Token expiry in ${Math.round(daysUntilExpiry)} days, attempting refresh...`);

  try {
    const res = await tauriFetch("https://axis.prioris.jp/api/token/refresh/", {
      headers: {
        Authorization: `Bearer ${eewToken}`,
      },
    });

    // Record that we checked today regardless of outcome
    localStorage.setItem("eew-token-last-refresh-check", todayStr);

    if (res.status === 402) {
      // Contract expired
      console.warn("[EEW] Token refresh failed: contract has expired (402).");
      alertTokenExpiry();
      return;
    }

    if (!res.ok) {
      console.warn(`[EEW] Token refresh failed with HTTP ${res.status}.`);
      alertTokenExpiry();
      return;
    }

    const data = await res.json();

    if (data.status === "generate a new token" && data.token) {
      // Success — new token issued
      console.info("[EEW] Token refreshed successfully.");
      eewToken = data.token;
      localStorage.setItem("eew-token", data.token);
      localStorage.removeItem("eew-token-expiry-alerted");

      // New token is valid until end of next month
      const nextMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
      const newExpiry = getEndOfMonthUTC(nextMonthDate);
      localStorage.setItem("eew-token-expiry", String(newExpiry));
      console.debug("[EEW] New token expiry:", new Date(newExpiry).toISOString());

      // Update the token input field if it exists
      const tokenEl = document.getElementById("eew-token-input");
      if (tokenEl) tokenEl.value = data.token;

      // Reconnect with the new token
      disconnectEew();
      hasConnectedOnce = false;
      connectEew();
    } else if (data.status === "not due for refresh yet") {
      // Not time yet — will retry tomorrow (lastCheck date is already saved)
      console.debug("[EEW] Token refresh not due yet, will retry tomorrow.");
    } else {
      console.warn("[EEW] Unexpected token refresh response:", data);
      alertTokenExpiry();
    }
  } catch (err) {
    console.warn("[EEW] Token refresh request failed:", err);
    // Don't save lastCheck on network errors so we can retry sooner
  }
}

/**
 * Alerts the user once that their token may expire soon.
 * The flag resets when the token is manually changed or successfully refreshed.
 */
function alertTokenExpiry() {
  if (localStorage.getItem("eew-token-expiry-alerted") === "true") return;
  localStorage.setItem("eew-token-expiry-alerted", "true");
  alert(
    "EEW token could not be refreshed and will expire at the end of this month. " +
      "Please check your AXIS subscription or update your token in Settings.\n" +
      "EEWトークンの更新に失敗しました。今月末にトークンが無効になります。" +
      "AXISのサブスクリプションを確認するか、「設定」でトークンを更新してください。",
  );
}

function startHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    if (eewSocket?.readyState === WebSocket.OPEN) {
      eewSocket.send("hb");
      startHeartbeat();
    }
  }, 30000);
}

function handleEewMessage(msg) {
  if (!msg?.Title) return;
  if (msg.Flag?.is_training) return;

  const eventId = msg.EventID;

  // Check if cancel
  if (msg.Flag?.is_cancel) {
    if (activeEews.has(eventId)) {
      const eew = activeEews.get(eventId);
      eew.isCancelled = true;
      eew.msg = msg;

      setTimeout(() => {
        removeEew(eventId);
      }, 15000);
      updateEewUI(false);
    }
  } else {
    // Forecast or Warning
    const isNew = !activeEews.has(eventId);
    const eew = activeEews.get(eventId) || { receivedAt: Date.now() };
    eew.msg = msg;
    eew.isFinal = msg.Flag?.is_final;
    activeEews.set(eventId, eew);

    if (eew.isFinal) {
      setTimeout(
        () => {
          removeEew(eventId);
        },
        3 * 60 * 1000,
      );
    }

    if (isNew) {
      console.debug(`[EEW] New EEW recieved: ${eventId}`);
      // Auto open logic
      const liveTab = document.querySelector('[data-tab="live"]');
      if (liveTab && !liveTab.classList.contains("active")) {
        liveTab.click();
      }
      playAudio("/sfx/eew.wav");
    }

    updateEewUI(isNew);
    startWaveAnimation();
  }
}

function removeEew(eventId) {
  if (activeEews.has(eventId)) {
    activeEews.delete(eventId);
    updateEewUI(false);
  }
}

function clearAllEews() {
  activeEews.clear();
  updateEewUI(false);
}

export function handlePossibleEewReport(report) {
  // Call this from liveMode when a normal report is received to auto-open
  if (activeEews.has(report.eventId)) {
    // If multiple EEWs, check if highest intensity
    let isHighest = true;
    const thisEewMsg = activeEews.get(report.eventId).msg;
    const thisInt = getIntVal(thisEewMsg.Intensity);

    for (const [id, eew] of activeEews.entries()) {
      if (id !== report.eventId && !eew.isCancelled) {
        const otherInt = getIntVal(eew.msg.Intensity);
        if (otherInt > thisInt) {
          isHighest = false;
        }
      }
    }

    return isHighest; // true to allow, false to suppress
  }
  return null; // Not an EEW related report
}

function updateEewUI(isNewEew = false) {
  console.debug(`[eq-viewer-eew] updateEewUI: START (isNewEew=${isNewEew})`);
  if (activeEews.size === 0) {
    console.debug("[eq-viewer-eew] updateEewUI: no active EEWs, cleaning up");
    clearEewMapDisplay();
    stopWaveAnimation();

    // Restore city/area layer visibility to user's preference
    // (updateMapForEew forced it off while EEWs were active)
    if (mapInstance) {
      updateCityAreasVisibility(mapInstance, getCityAreasState());
    }

    // Remove UI
    const container = document.getElementById("eew-list-container");
    if (container) {
      container.innerHTML = "";
      container.classList.add("hidden");
    }

    if (carouselTimer) {
      clearInterval(carouselTimer);
      carouselTimer = null;
    }

    // Resume normal report
    const activeItem = document.querySelector(".eq-item.active");
    if (activeItem) {
      activeItem.click();
    } else if (previousReport) {
      const el = document.querySelector(`[data-event-id="${previousReport.eventId}"]`);
      if (el) el.click();
      else {
        const firstEl = document.querySelector(".eq-item");
        if (firstEl) firstEl.click();
      }
    } else {
      const firstEl = document.querySelector(".eq-item");
      if (firstEl) firstEl.click();
    }

    // Force cleanup if nothing was clicked
    setTimeout(() => {
      const stillActive = document.querySelector(".eq-item.active");
      const infoBox = document.getElementById("map-info-box");
      if (infoBox && !stillActive) infoBox.classList.add("hidden");

      if (!stillActive && mapInstance) {
        highlightObservations(mapInstance, []);
      }
    }, 50);

    return;
  }

  // Filter active and sort by order received
  const eews = Array.from(activeEews.values()).sort((a, b) => a.receivedAt - b.receivedAt);

  // Store previous report and switch map to EEW if a brand new EEW arrived
  if (isNewEew) {
    console.debug("[eq-viewer-eew] updateEewUI: handling brand new EEW");
    isEewMapActive = true;
    const currentActive = document.querySelector(".eq-item.active");
    if (currentActive?.closest("#eq-list") || currentActive?.closest("#history-list")) {
      previousReport = globalThis.__currentReport;
      currentActive.classList.remove("active"); // Deactivate normal report in list
    }
  }

  // Render list entry container
  const container = document.getElementById("eew-list-container");
  container.classList.remove("hidden");

  if (!carouselTimer && eews.length > 1) {
    carouselTimer = setInterval(() => {
      carouselIndex = (carouselIndex + 1) % activeEews.size;
      renderCurrentEew();
    }, 4000);
  } else if (eews.length <= 1) {
    if (carouselTimer) {
      clearInterval(carouselTimer);
      carouselTimer = null;
    }
    carouselIndex = 0;
  }

  if (carouselIndex >= eews.length) carouselIndex = 0;

  console.debug("[eq-viewer-eew] updateEewUI: rendering current EEW");
  renderCurrentEew();
}

function renderCurrentEew() {
  console.debug("[eq-viewer-eew] renderCurrentEew: START");
  const eews = Array.from(activeEews.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  if (eews.length === 0) return;

  const currentEew = eews[carouselIndex];
  const msg = currentEew.msg;
  const isCancelled = currentEew.isCancelled;
  const isWarning = msg.Title.includes("警報");
  const isPlum = msg.Magnitude === "1.0" && msg.Hypocenter.Depth === "10km";

  const hypoCodeNum = parseInt(msg.Hypocenter.Code);
  const hypoInfo = areaCodes
    ? areaCodes.get(hypoCodeNum) || { ja: msg.Hypocenter.Name, en: "Unknown", kana: "" }
    : { ja: msg.Hypocenter.Name, en: "Unknown", kana: "" };

  let labelColor = isCancelled ? "#7f8c8d" : isWarning ? "#e84c3d" : "#f39c12";
  let labelText = isCancelled
    ? "Cancelled • キャンセル"
    : isWarning
      ? "EEW (Warning) • 緊急地震速報（警報）"
      : "EEW (Forecast) • 緊急地震速報（予報）";

  // Render the list entry
  const container = document.getElementById("eew-list-container");
  let listHtml = `
    <div class="eew-list-item" style="border-top: 4px solid ${labelColor};">
      <div class="eew-list-header" style="color: ${labelColor}; font-weight: bold; font-size: 11px; margin-bottom: 4px;">
         ${eews.length > 1 ? `[${carouselIndex + 1}/${eews.length}] ` : ""}${labelText}
      </div>
      <div class="eq-content">
        <div class="eq-left">
          <div class="eq-location-ja">${hypoInfo.ja}</div>
          <div class="eq-location-en" style="font-size: 11px; color: var(--text-dim); margin-bottom: 4px;">${hypoInfo.en}</div>
          <div class="eq-footer">
            <div class="eq-mag">
              <span class="eq-mag-label">M</span>
              ${isPlum ? "--" : msg.Magnitude || "--"}
            </div>
            <div class="eq-time">${formatTimeJSTWithSeconds(new Date(msg.OriginDateTime).getTime())}</div>
          </div>
        </div>
        <div class="eq-intensity-container">
  `;

  if (msg.Intensity && msg.Intensity !== "不明") {
    const intensityConfig = INTENSITY_CONFIG[msg.Intensity] || INTENSITY_CONFIG["1"];
    listHtml += `<img src="/img/shindo/${intensityConfig.img}" class="eq-intensity-img" />`;
  } else {
    listHtml += `<div class="eew-intensity-placeholder" style="width:60px; height:60px; border-radius:3px; background:#1e2e44; display:flex; align-items:center; justify-content:center; color:#fff; font-size:24px; font-weight:bold;">-</div>`;
  }

  listHtml += `</div></div></div>`;
  container.innerHTML = listHtml;

  const listItem = container.querySelector(".eew-list-item");
  if (listItem) {
    listItem.addEventListener("click", () => {
      console.debug("[eq-viewer-eew] EEW list item clicked");
      // If a normal report was clicked, it becomes active. Deactivate it.
      const currentActive = document.querySelector(".eq-item.active");
      if (currentActive) {
        currentActive.classList.remove("active");
      }
      globalThis.__currentReport = null;
      isEewMapActive = true;
      renderEewInfoBox(msg, isCancelled, isWarning, isPlum, eews.length, carouselIndex + 1);
      updateMapForEew();

      // Defer wave updates to avoid synchronous source operations right after layout changes
      setTimeout(updateWaves, 50);
    });
  }

  // Render info box and map only if EEW is active and no normal report is currently active
  const currentActive = document.querySelector(".eq-item.active");
  if (isEewMapActive && !currentActive) {
    console.debug("[eq-viewer-eew] renderCurrentEew: rendering info box");
    renderEewInfoBox(msg, isCancelled, isWarning, isPlum, eews.length, carouselIndex + 1);
    console.debug("[eq-viewer-eew] renderCurrentEew: updating map for EEW");
    updateMapForEew();
    console.debug("[eq-viewer-eew] renderCurrentEew: COMPLETE");
  }
}

// ─── EEW Wave Animation ──────────────────────────────────────────────────────

let waveInterval = null;

function getCircleCoords(centerLat, centerLng, radiusKm, points = 64) {
  const coords = [];
  const R = 6371; // Earth radius in km
  const lat1 = (centerLat * Math.PI) / 180;
  const lon1 = (centerLng * Math.PI) / 180;
  const d = radiusKm / R;

  for (let i = 0; i <= points; i++) {
    const brng = (i / points) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
    );
    let lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return coords;
}

function ensureWaveSources() {
  if (!mapInstance || !mapInstance.isStyleLoaded()) {
    return false;
  }

  if (!mapInstance.getSource("eew-p-wave")) {
    console.debug("[eq-viewer-eew] ensureWaveSources: adding p-wave source and layer");
    mapInstance.addSource("eew-p-wave", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    mapInstance.addLayer({
      id: "eew-p-wave-layer",
      type: "line",
      source: "eew-p-wave",
      paint: {
        "line-color": "#3498db", // Blue for P wave
        "line-width": 2,
        "line-opacity": ["get", "opacity"],
      },
    });
  }

  if (!mapInstance.getSource("eew-s-wave")) {
    console.debug("[eq-viewer-eew] ensureWaveSources: adding s-wave source and layer");
    mapInstance.addSource("eew-s-wave", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    mapInstance.addLayer({
      id: "eew-s-wave-layer",
      type: "line",
      source: "eew-s-wave",
      paint: {
        "line-color": "#e74c3c", // Red for S wave
        "line-width": 2,
        "line-opacity": ["get", "opacity"],
      },
    });
  }
  return true;
}

function startWaveAnimation() {
  console.debug("[eq-viewer-eew] startWaveAnimation: START");
  if (waveInterval) return;

  console.debug("[eq-viewer-eew] startWaveAnimation: setting interval");
  waveInterval = setInterval(updateWaves, 500);

  // Defer the initial wave update to avoid interacting with MapLibre sources
  // synchronously in the same tick as layout property changes, which can
  // crash WebKit2GTK's WebGL context.
  setTimeout(() => {
    console.debug("[eq-viewer-eew] startWaveAnimation: initial updateWaves");
    updateWaves();
  }, 50);
}

function stopWaveAnimation() {
  if (waveInterval) {
    clearInterval(waveInterval);
    waveInterval = null;
  }
  if (mapInstance?.getSource("eew-p-wave")) {
    mapInstance.getSource("eew-p-wave").setData({ type: "FeatureCollection", features: [] });
  }
  if (mapInstance?.getSource("eew-s-wave")) {
    mapInstance.getSource("eew-s-wave").setData({ type: "FeatureCollection", features: [] });
  }
}

function getTravelDistance(depth, time, phase) {
  if (!travelTimeData?.[depth]) return 0;

  const data = travelTimeData[depth];

  let prev = data[0];
  for (let i = 1; i < data.length; i++) {
    const curr = data[i];
    const prevTime = phase === "P" ? prev.p_time : prev.s_time;
    const currTime = phase === "P" ? curr.p_time : curr.s_time;

    if (time >= prevTime && time <= currTime) {
      if (currTime === prevTime) return prev.distance;
      const ratio = (time - prevTime) / (currTime - prevTime);
      return prev.distance + ratio * (curr.distance - prev.distance);
    }
    prev = curr;
  }

  const lastTime = phase === "P" ? prev.p_time : prev.s_time;
  if (time > lastTime) {
    return prev.distance;
  }

  return 0;
}

function updateWaves() {
  if (!mapInstance) return;
  if (document.hidden) return;

  ensureWaveSources();

  const pSrc = mapInstance.getSource("eew-p-wave");
  const sSrc = mapInstance.getSource("eew-s-wave");

  // If EEW is not active on the map or user is viewing a normal report, do not draw wave animations
  if (!isEewMapActive || activeEews.size === 0 || document.querySelector(".eq-item.active")) {
    if (pSrc) pSrc.setData({ type: "FeatureCollection", features: [] });
    if (sSrc) sSrc.setData({ type: "FeatureCollection", features: [] });
    if (activeEews.size === 0) {
      stopWaveAnimation();
    }
    return;
  }

  const pFeatures = [];
  const sFeatures = [];
  const now = Date.now();
  let allFinished = true;

  for (const eew of activeEews.values()) {
    const msg = eew.msg;
    if (!msg?.Hypocenter || eew.isCancelled) continue;

    const isPlum = msg.Magnitude === "1.0" && msg.Hypocenter.Depth === "10km";
    if (isPlum) continue;

    const originTime = new Date(msg.OriginDateTime).getTime();
    const t = Math.max(0, (now - originTime) / 1000);

    let depth = Number.parseInt(msg.Hypocenter.Depth, 10);
    if (Number.isNaN(depth)) depth = 10;

    // Convert to multiple of 10 for table lookup, cap at 700km
    depth = Math.round(depth / 10) * 10;
    if (depth > 700) depth = 700;

    const pRad = getTravelDistance(depth, t, "P");
    const sRad = getTravelDistance(depth, t, "S");

    if (pRad >= 2000) {
      continue;
    }
    allFinished = false;

    let opacity = 1.0;
    if (pRad > 1750) {
      opacity = 1.0 - (pRad - 1750) / 250;
      if (opacity < 0) opacity = 0;
    }

    const coords = msg.Hypocenter.Coordinate;
    if (coords && coords.length >= 2) {
      const lng = Number.parseFloat(coords[0]);
      const lat = Number.parseFloat(coords[1]);

      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        if (pRad > 0) {
          pFeatures.push({
            type: "Feature",
            properties: { opacity },
            geometry: {
              type: "Polygon",
              coordinates: [getCircleCoords(lat, lng, pRad, 96)],
            },
          });
        }
        if (sRad > 0) {
          sFeatures.push({
            type: "Feature",
            properties: { opacity },
            geometry: {
              type: "Polygon",
              coordinates: [getCircleCoords(lat, lng, sRad, 64)],
            },
          });
        }
      }
    }
  }

  if (pSrc) pSrc.setData({ type: "FeatureCollection", features: pFeatures });
  if (sSrc) sSrc.setData({ type: "FeatureCollection", features: sFeatures });

  if (allFinished && activeEews.size === 0) {
    stopWaveAnimation();
  }
}

function renderEewInfoBox(msg, isCancelled, isWarning, isPlum, totalCount, currentIndex) {
  const infoBox = document.getElementById("map-info-box");
  if (!infoBox) return;
  infoBox.classList.remove("hidden");

  const mapTogglesWrapper = infoBox.querySelector(".map-toggles-wrapper");
  if (mapTogglesWrapper) mapTogglesWrapper.classList.add("hidden");

  const lpgmRow = infoBox.querySelector(".info-box-lpgm-row");
  if (lpgmRow) lpgmRow.classList.add("hidden");

  const locationJa = infoBox.querySelector(".info-box-location-ja");
  const locationEn = infoBox.querySelector(".info-box-location-en");
  const flashBadge = infoBox.querySelector(".info-box-flash-badge");
  const intensityImg = infoBox.querySelector(".info-box-intensity-img");
  const intensityContainer = infoBox.querySelector(".info-box-intensity-container");
  const magnitude = infoBox.querySelector(".info-magnitude");
  const depth = infoBox.querySelector(".info-depth");
  const coordinates = infoBox.querySelector(".info-coordinates");
  const timeEl = infoBox.querySelector(".info-time");

  let labelColor = isCancelled ? "#7f8c8d" : isWarning ? "#e84c3d" : "#f39c12";
  let labelText = isCancelled ? "Cancelled" : isWarning ? "EEW (Warning)" : "EEW (Forecast)";
  if (totalCount > 1) labelText = `[${currentIndex}/${totalCount}] ` + labelText;

  const hypoCodeNum = Number.parseInt(msg.Hypocenter.Code);
  const hypoInfo = areaCodes
    ? areaCodes.get(hypoCodeNum) || { ja: msg.Hypocenter.Name, en: "Unknown", kana: "" }
    : { ja: msg.Hypocenter.Name, en: "Unknown", kana: "" };

  locationJa.innerHTML = createRubyHtml(hypoInfo.ja, hypoInfo.kana) || msg.Hypocenter.Name;
  locationEn.textContent = hypoInfo.en;

  if (flashBadge) {
    flashBadge.classList.remove("hidden");
    flashBadge.style.backgroundColor = labelColor + "33";
    flashBadge.style.borderColor = labelColor;
    flashBadge.querySelector(".flash-badge-text").textContent = labelText;
    flashBadge.querySelector(".flash-badge-text").style.color = labelColor;
  }

  if (msg.Intensity && msg.Intensity !== "不明") {
    const intensityConfig = INTENSITY_CONFIG[msg.Intensity] || INTENSITY_CONFIG["1"];
    intensityImg.src = `/img/shindo/${intensityConfig.img}`;
    intensityImg.style.display = "block";
    const existingPlaceholder = intensityContainer.querySelector(".eew-intensity-placeholder");
    if (existingPlaceholder) existingPlaceholder.remove();
    const infoPlaceholder = intensityContainer.querySelector(".info-box-intensity-placeholder");
    if (infoPlaceholder) infoPlaceholder.remove();
  } else {
    intensityImg.style.display = "none";
    const infoPlaceholder = intensityContainer.querySelector(".info-box-intensity-placeholder");
    if (infoPlaceholder) infoPlaceholder.remove();
    let placeholder = intensityContainer.querySelector(".eew-intensity-placeholder");
    if (!placeholder) {
      placeholder = document.createElement("div");
      placeholder.className = "eew-intensity-placeholder";
      placeholder.style.cssText =
        "width:60px; height:60px; border-radius:3px; background:#1e2e44; display:flex; align-items:center; justify-content:center; color:#fff; font-size:24px; font-weight:bold;";
      placeholder.textContent = "-";
      intensityContainer.appendChild(placeholder);
    }
  }

  magnitude.textContent = isPlum ? "--" : `M ${msg.Magnitude}`;
  depth.textContent = isPlum ? "--" : msg.Hypocenter.Depth;

  if (isPlum) {
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "PLUM method • PLUM法による仮定震源要素";
    coordinates.textContent = "";
  } else if (msg.Hypocenter.Coordinate) {
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "Coordinates";
    const [lon, lat] = msg.Hypocenter.Coordinate;
    coordinates.textContent = `${lat.toFixed(1)} ; ${lon.toFixed(1)}`;
  } else {
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "Coordinates";
    coordinates.textContent = "--";
  }

  if (timeEl) {
    timeEl.textContent = formatTimeJSTWithSeconds(new Date(msg.OriginDateTime).getTime());
  }

  // Add Extra row for Serial and Final
  const detailsContainer = infoBox.querySelector(".info-box-details");
  let serialRow = detailsContainer.querySelector(".eew-serial-row");
  if (!serialRow) {
    serialRow = document.createElement("div");
    serialRow.className = "info-box-row eew-serial-row";
    detailsContainer.appendChild(serialRow);
  }
  serialRow.innerHTML = `
    <span class="info-label">Report • 報</span>
    <span class="info-value mono">#${msg.Serial} ${msg.Flag.is_final ? "(Final)" : ""}</span>
  `;

  // Forecast Observations
  const obsHeaderLabel = infoBox.querySelector(".observations-list-label");
  if (obsHeaderLabel) obsHeaderLabel.textContent = "Forecast • 予想";

  const observationsContainer = infoBox.querySelector("#observations-list-container");
  if (observationsContainer) {
    observationsContainer.innerHTML = "";

    let disclaimer = observationsContainer.querySelector(".eew-forecast-disclaimer");
    if (!disclaimer) {
      disclaimer = document.createElement("div");
      disclaimer.className = "eew-forecast-disclaimer";
      disclaimer.style.cssText =
        "font-size: 11px; color: var(--text-dim); text-align: center; padding: 4px; background: rgba(0,0,0,0.2); border-radius: 4px; margin-bottom: 6px;";
      disclaimer.textContent = "Estimated intensities • 予想震度";
      observationsContainer.appendChild(disclaimer);
    }

    // Group and sort Forecast
    if (msg.Forecast && msg.Forecast.length > 0) {
      const mergedForecast = mergeForecasts(Array.from(activeEews.values()));

      const forecastByInt = {};
      for (const f of mergedForecast) {
        if (f.Intensity.To === "0" || f.Intensity.To === "over" || f.Intensity.To === "不明")
          continue;
        const intStr = f.Intensity.To;
        if (!forecastByInt[intStr]) forecastByInt[intStr] = [];
        forecastByInt[intStr].push(f);
      }

      const sortedInts = Object.keys(forecastByInt).sort((a, b) => {
        const getVal = (v) => {
          if (v === "7") return 70;
          if (v === "6+") return 65;
          if (v === "6-") return 60;
          if (v === "5+") return 55;
          if (v === "5-") return 50;
          return Number.parseInt(v) * 10;
        };
        return getVal(b) - getVal(a);
      });

      for (const intStr of sortedInts) {
        const config = INTENSITY_CONFIG[intStr] || INTENSITY_CONFIG["1"];

        const section = document.createElement("div");
        section.className = "observations-intensity-section";

        const header = document.createElement("div");
        header.className = "observations-intensity-header";
        header.style.backgroundColor = config.color;
        header.style.cursor = "default";

        const labelText = `震度 ${intStr.replace("-", "弱").replace("+", "強")}`;
        header.innerHTML = `<span class="observations-intensity-label" style="color: ${config.fontColor}; padding-left: 8px;">${labelText}</span>`;

        const content = document.createElement("div");
        content.className = "observations-intensity-content";
        content.style.borderLeft = "2px solid " + config.color;

        forecastByInt[intStr].forEach((f) => {
          const codeNum = Number.parseInt(f.Code);
          const areaInfo = areaCodes
            ? areaCodes.get(codeNum) || { ja: f.Name, en: f.Code }
            : { ja: f.Name, en: f.Code };

          const prefDiv = document.createElement("div");
          prefDiv.className = "observation-area";

          const prefRow = document.createElement("div");
          prefRow.className = "observation-row area-row";
          prefRow.innerHTML = `<span class="observation-ja">${areaInfo.ja}</span><span class="observation-dot">·</span><span class="observation-en">${areaInfo.en}</span>`;

          prefDiv.appendChild(prefRow);
          content.appendChild(prefDiv);
        });

        section.appendChild(header);
        section.appendChild(content);
        observationsContainer.appendChild(section);
      }
    }

    // Force open observations and lock it
    const obsWrapper = infoBox.querySelector(".observations-list-wrapper");
    if (obsWrapper) {
      obsWrapper.classList.add("expanded");
      const toggleBtn = obsWrapper.querySelector(".observations-list-toggle");
      if (toggleBtn) toggleBtn.style.display = "none"; // Lock toggle
    }
  }
}

function mergeForecasts(eewList) {
  const map = new Map();
  for (const eew of eewList) {
    if (eew.isCancelled || !eew.msg.Forecast) continue;
    for (const f of eew.msg.Forecast) {
      const existing = map.get(f.Code);
      if (!existing) {
        map.set(f.Code, f);
      } else {
        const existingInt = getIntVal(existing.Intensity.To);
        const newInt = getIntVal(f.Intensity.To);
        if (newInt > existingInt) {
          map.set(f.Code, f);
        }
      }
    }
  }
  return Array.from(map.values());
}

function getIntVal(v) {
  if (v === "7") return 70;
  if (v === "6+") return 65;
  if (v === "6-") return 60;
  if (v === "5+") return 55;
  if (v === "5-") return 50;
  const parsed = Number.parseInt(v);
  return Number.isNaN(parsed) ? 0 : parsed * 10;
}

function updateMapForEew() {
  console.debug("[eq-viewer-eew] updateMapForEew: START");
  if (!mapInstance) return;
  if (!isEewMapActive || activeEews.size === 0 || document.querySelector(".eq-item.active")) {
    console.debug("[eq-viewer-eew] updateMapForEew: aborted early (not active)");
    return;
  }

  console.debug("[eq-viewer-eew] updateMapForEew: removing old markers");
  for (const marker of eewEpicenterMarkers) marker.remove();
  eewEpicenterMarkers = [];

  console.debug("[eq-viewer-eew] updateMapForEew: clearing normal UI elements");
  clearEpicenter(mapInstance); // Clear normal epicenter
  updateCityAreasVisibility(mapInstance, false); // Force Cities off temporarily
  updateShakemapVisibility(mapInstance, false); // Force Shakemap off temporarily
  updateLpgmVisibility(mapInstance, false); // Force LPGM off temporarily
  updateMapLegend(false); // Restore standard legend

  console.debug("[eq-viewer-eew] updateMapForEew: scheduling phase 2 via setTimeout");
  // Give MapLibre a moment to apply layout property changes before setting feature states.
  setTimeout(() => {
    console.debug("[eq-viewer-eew] updateMapForEew Phase 2: START");
    // Guard: EEW state may have changed during the delay
    if (!isEewMapActive || activeEews.size === 0 || document.querySelector(".eq-item.active")) {
      return;
    }

    console.debug("[eq-viewer-eew] updateMapForEew Phase 2: calculating GMPE");
    const mergedForecast = mergeForecasts(Array.from(activeEews.values()));
    const eews = Array.from(activeEews.values()).sort((a, b) => a.receivedAt - b.receivedAt);

    // Track the highest estimated intensity for each individual station across all EEWs
    const stationMaxInts = new Int32Array(stationsData.length).fill(0);

    for (const eew of eews) {
      if (eew.isCancelled) continue;
      const msg = eew.msg;
      if (!msg.Hypocenter?.Coordinate) continue;

      const isPlum = msg.Magnitude === "1.0" && msg.Hypocenter.Depth === "10km";
      if (isPlum) continue;

      let depthKm = Number.parseInt(msg.Hypocenter.Depth, 10);
      if (Number.isNaN(depthKm) || depthKm >= 150) continue;

      let mag = Number.parseFloat(msg.Magnitude);
      if (Number.isNaN(mag)) continue;

      const [eqLon, eqLat] = msg.Hypocenter.Coordinate;

      for (let i = 0; i < stationsData.length; i++) {
        const station = stationsData[i];
        const distance = haversineDistance(station.lat, station.lon, eqLat, eqLon);
        let arv = station.arv;
        if (arv === null || arv <= 0.0 || Number.isNaN(arv)) {
          arv = 1.0;
        }
        const shindoFloat = calculateGmpe(mag, depthKm, distance, arv);
        const shindoStr = floatToShindo(shindoFloat);

        if (shindoStr === "0") continue;

        let finalShindo = shindoStr;

        if (!TEST_GMPE_OVERRIDE) {
          if (getIntVal(finalShindo) > getIntVal("3")) {
            finalShindo = "3";
          }
        }

        const val = getIntVal(finalShindo);
        if (val > stationMaxInts[i]) {
          stationMaxInts[i] = val;
        }
      }
    }

    // Group station intensities by forecast area
    const areaInts = new Map();
    for (let i = 0; i < stationsData.length; i++) {
      const val = stationMaxInts[i];
      if (val === 0) continue;

      const areaCodeStr = cityForecastMap.get(stationsData[i].cityCode);
      if (areaCodeStr) {
        let arr = areaInts.get(areaCodeStr);
        if (!arr) {
          arr = [];
          areaInts.set(areaCodeStr, arr);
        }
        arr.push(val);
      }
    }

    const getIntStr = (val) => {
      if (val === 70) return "7";
      if (val === 65) return "6+";
      if (val === 60) return "6-";
      if (val === 55) return "5+";
      if (val === 50) return "5-";
      return String(val / 10);
    };

    // Determine the area's intensity by requiring at least 2 stations
    const localPredictions = new Map();
    for (const [areaCodeStr, vals] of areaInts.entries()) {
      if (vals.length >= 2) {
        vals.sort((a, b) => b - a); // descending
        const secondHighestVal = vals[1];
        if (secondHighestVal > 0) {
          localPredictions.set(areaCodeStr, getIntStr(secondHighestVal));
        }
      }
    }

    console.debug("[eq-viewer-eew] updateMapForEew Phase 2: merging GMPE and forecast");
    const finalMapIntensities = new Map();

    if (TEST_GMPE_OVERRIDE) {
      for (const f of mergedForecast) {
        if (f.Intensity.To === "0" || f.Intensity.To === "over" || f.Intensity.To === "不明")
          continue;
        finalMapIntensities.set(String(f.Code), f.Intensity.To);
      }
      for (const [areaCode, localInt] of localPredictions.entries()) {
        finalMapIntensities.set(areaCode, localInt);
      }
    } else {
      for (const [areaCode, localInt] of localPredictions.entries()) {
        finalMapIntensities.set(areaCode, localInt);
      }
      for (const f of mergedForecast) {
        if (f.Intensity.To === "0" || f.Intensity.To === "over" || f.Intensity.To === "不明")
          continue;
        finalMapIntensities.set(String(f.Code), f.Intensity.To);
      }
    }

    // Create mock observations for map highlighter
    const mockObservations = [];
    if (finalMapIntensities.size > 0) {
      const prefMock = { areas: [] };
      for (const [code, maxInt] of finalMapIntensities.entries()) {
        prefMock.areas.push({
          code: String(code),
          maxInt: maxInt,
          cities: [],
        });
      }
      mockObservations.push(prefMock);
    }

    console.debug("[eq-viewer-eew] updateMapForEew Phase 2: highlighting observations");
    highlightObservations(mapInstance, mockObservations);
    console.debug("[eq-viewer-eew] updateMapForEew Phase 2: highlights applied");

    console.debug("[eq-viewer-eew] updateMapForEew: scheduling phase 3 via rAF");
    // Defer marker placement and camera movement to the next animation frame
    // to avoid overwhelming WebKit2GTK's WebGL context
    requestAnimationFrame(() => {
      console.debug("[eq-viewer-eew] updateMapForEew Phase 3: START");
      // Guard: EEW state may have changed by the time this frame fires
      if (!isEewMapActive || activeEews.size === 0 || document.querySelector(".eq-item.active")) {
        return;
      }

      if (getHomeIntensityState()) {
        // Update home intensity display for EEW
        const homeCityCode = localStorage.getItem("home-city");
        const homeAreaCodeStr = cityForecastMap.get(homeCityCode);

        if (homeAreaCodeStr) {
          const forecastArea = mergedForecast.find(
            (f) => f.Code === Number.parseInt(homeAreaCodeStr),
          );
          const forecastInt = forecastArea ? forecastArea.Intensity.To : null;
          updateEewHomeLocationDisplay(homeCityCode, forecastInt || null); // Only use EEW intensities, without GMPE
        } else {
          updateEewHomeLocationDisplay(homeCityCode, null);
        }
      }

      // Add EEW epicenters
      console.debug("[eq-viewer-eew] updateMapForEew Phase 3: placing markers");
      let minLng = Infinity,
        minLat = Infinity,
        maxLng = -Infinity,
        maxLat = -Infinity;
      let hasValidEpicenter = false;

      let i = 0;
      for (const eew of eews) {
        i++;
        const msg = eew.msg;
        if (msg.Hypocenter?.Coordinate) {
          const [lon, lat] = msg.Hypocenter.Coordinate;
          hasValidEpicenter = true;
          if (lon < minLng) minLng = lon;
          if (lat < minLat) minLat = lat;
          if (lon > maxLng) maxLng = lon;
          if (lat > maxLat) maxLat = lat;

          const isPlum = msg.Magnitude === "1.0" && msg.Hypocenter.Depth === "10km";
          const isCancel = eew.isCancelled;

          let icon = "epicenter-eew.png";
          if (isCancel) icon = "epicenter-cancel.png";
          else if (isPlum) icon = "epicenter-plum.png";

          const markerEl = document.createElement("div");
          markerEl.className = "epicenter-eew-marker";
          markerEl.innerHTML = `<img src="/img/${icon}" style="width:32px; height:32px;" />`;
          if (eews.length > 1) {
            markerEl.innerHTML += `<div style="position:absolute; top:-20px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.7); color:#fff; padding:2px 6px; border-radius:4px; font-size:12px; font-weight:bold;">${i}</div>`;
          }

          const marker = new maplibregl.Marker({ element: markerEl })
            .setLngLat([lon, lat])
            .addTo(mapInstance);
          eewEpicenterMarkers.push(marker);
        }
      }

      console.debug("[eq-viewer-eew] updateMapForEew Phase 3: fitting bounds");
      if (!isUserInteractingWithMap && featureBounds) {
        fitBoundsToObservations(
          mapInstance,
          mockObservations,
          featureBounds,
          false,
          "1",
          hasValidEpicenter ? { longitude: minLng, latitude: minLat } : null,
          6.5,
        );
      }
      console.debug("[eq-viewer-eew] updateMapForEew Phase 3: COMPLETE");
    });
  }, 50);
}

function updateEewHomeLocationDisplay(cityCode, intensityStr) {
  const display = document.getElementById("home-intensity-display");
  if (!display) return;

  const cityInfo = cityNames.get(cityCode) || { ja: "不明", en: "Unknown" };

  display.querySelector(".tooltip-ja").textContent = cityInfo.ja;
  display.querySelector(".tooltip-en").textContent = cityInfo.en;

  const intensityContainer = display.querySelector(".tooltip-intensity-container");

  if (intensityStr && intensityStr !== "0" && intensityStr !== "over" && intensityStr !== "不明") {
    const config = INTENSITY_CONFIG[intensityStr];
    if (config) {
      const img = intensityContainer.querySelector("img");
      if (img) {
        img.style.display = "";
        img.src = `/img/shindo/${config.img}`;
        img.alt = `Intensity ${intensityStr}`;
        img.title = `Forecasted Intensity: ${intensityStr}`;
      }

      const placeholder = intensityContainer.querySelector(".tooltip-intensity-placeholder");
      if (placeholder) placeholder.style.display = "none";

      intensityContainer.classList.remove("hidden");
      display.style.borderTopColor = config.color;
      display.querySelector(".tooltip-code").style.color = config.color;
    }
  } else {
    const img = intensityContainer.querySelector("img");
    if (img) img.style.display = "none";

    let placeholder = intensityContainer.querySelector(".tooltip-intensity-placeholder");
    if (placeholder) {
      placeholder.style.display = "";
    } else {
      placeholder = document.createElement("div");
      placeholder.className = "tooltip-intensity-placeholder";
      placeholder.textContent = "-";
      intensityContainer.appendChild(placeholder);
    }

    intensityContainer.classList.remove("hidden");
    const defaultColor = "#1e2e44";
    display.style.borderTopColor = defaultColor;
    display.querySelector(".tooltip-code").style.color = defaultColor;
  }

  display.classList.remove("hidden");
}
