import maplibregl from "maplibre-gl";
import { formatTimeJST, formatTimeJSTWithSeconds, INTENSITY_CONFIG, USE_TEST_SERVER } from "./constants.js";
import {
  updateCityAreasVisibility,
  clearEpicenter,
  fitBoundsToObservations,
  highlightObservations,
} from "./map.js";
import { createRubyHtml } from "./areaCodes.js";
import { getCityAreasState } from "./sidebarUI.js";

let eewSocket = null;
let activeEews = new Map(); // EventID -> EEW Object
let retrySec = 100;
let retryCount = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let eewToken = "";
let hasConnectedOnce = false;

// For map and carousel
let carouselIndex = 0;
let carouselTimer = null;
let mapInstance = null;
let featureBounds = null;
let cityNames = null;
let areaCodes = null;
let eewEpicenterMarkers = [];

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
        console.log("[EEW] Manual reconnect triggered");
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
  if (!toggleEl || !toggleEl.checked) {
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

  updateEewStatus("connecting");

  let targetServer = "wss://ws.axis.prioris.jp";

  if (USE_TEST_SERVER) {
    targetServer = "ws://localhost:8565";
  } else {
    try {
      const res = await fetch("https://axis.prioris.jp/api/server/list/", {
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

  console.log("[EEW] Connecting to", serverUrl);
  eewSocket = new WebSocket(wsUrl);

  eewSocket.onopen = () => {
    console.log("[EEW] WebSocket Connected. Waiting for hello...");
  };

  eewSocket.onmessage = (event) => {
    const message = event.data;
    if (typeof message === "string") {
      if (message === "hello") {
        console.log("[EEW] Received hello from server. Connection fully established.");
        hasConnectedOnce = true;
        updateEewStatus("connected");
        retrySec = 100;
        retryCount = 0;
        startHeartbeat();
        return;
      } else if (message === "hb") {
        return;
      }
    }

    // Attempt JSON decode
    try {
      const data = JSON.parse(message);
      if (data?.channel === "eew" && data.message) {
        handleEewMessage(data.message);
      }
    } catch (err) {
      // Not JSON, ignore
    }
  };

  eewSocket.onclose = (event) => {
    console.log(`[EEW] Connection closed (code: ${event.code}, reason: ${event.reason})`);
    eewSocket = null;
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    retryConnection();
  };

  eewSocket.onerror = (err) => {
    console.log("[EEW] WebSocket error occurred");
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

  console.log(`[EEW] Retry: ${retryCount} (delay ${retrySec}ms)`);
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
  if (eewSocket) {
    eewSocket.onclose = null;
    eewSocket.close();
    eewSocket = null;
  }
  clearAllEews();
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
      // Auto open logic
      const liveTab = document.querySelector('[data-tab="live"]');
      if (liveTab && !liveTab.classList.contains("active")) {
        liveTab.click();
      }
      const audio = new Audio("/sfx/eew.wav");
      audio.play().catch((err) => console.warn("[eq-viewer] Failed to play sound:", err));
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
  if (activeEews.size === 0) {
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

  renderCurrentEew();
}

function renderCurrentEew() {
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
      // If a normal report was clicked, it becomes active. Deactivate it.
      const currentActive = document.querySelector(".eq-item.active");
      if (currentActive) {
        currentActive.classList.remove("active");
      }
      globalThis.__currentReport = null;
      isEewMapActive = true;
      renderEewInfoBox(msg, isCancelled, isWarning, isPlum, eews.length, carouselIndex + 1);
      updateMapForEew();
      updateWaves();
    });
  }

  // Render info box and map only if EEW is active and no normal report is currently active
  const currentActive = document.querySelector(".eq-item.active");
  if (isEewMapActive && !currentActive) {
    renderEewInfoBox(msg, isCancelled, isWarning, isPlum, eews.length, carouselIndex + 1);
    updateMapForEew();
  }
}

// ─── EEW Wave Animation ──────────────────────────────────────────────────────

let waveInterval = null;
const P_VEL = 7.0; // km/s
const S_VEL = 4.0; // km/s

function getCircleCoords(centerLat, centerLng, radiusKm, points = 64) {
  const coords = [];
  const R = 6371; // Earth radius in km
  const lat1 = (centerLat * Math.PI) / 180;
  const lon1 = (centerLng * Math.PI) / 180;
  const d = radiusKm / R;

  for (let i = 0; i <= points; i++) {
    const brng = (i / points) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
    );
    let lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
      );
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return coords;
}

function startWaveAnimation() {
  if (waveInterval) return;

  if (mapInstance && !mapInstance.getSource("eew-p-wave")) {
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
  if (mapInstance && !mapInstance.getSource("eew-s-wave")) {
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

  waveInterval = setInterval(updateWaves, 500);
  updateWaves();
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

function updateWaves() {
  if (!mapInstance) return;

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

    const pDist = P_VEL * t;
    const sDist = S_VEL * t;

    const pRad = pDist > depth ? Math.sqrt(pDist * pDist - depth * depth) : 0;
    const sRad = sDist > depth ? Math.sqrt(sDist * sDist - depth * depth) : 0;

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
  if (!mapInstance) return;
  if (!isEewMapActive || activeEews.size === 0 || document.querySelector(".eq-item.active")) {
    return;
  }

  for (const marker of eewEpicenterMarkers) marker.remove();
  eewEpicenterMarkers = [];

  clearEpicenter(mapInstance); // Clear normal epicenter
  updateCityAreasVisibility(mapInstance, false); // Force Cities off temporarily

  const mergedForecast = mergeForecasts(Array.from(activeEews.values()));

  // Create mock observations for map highlighter
  const mockObservations = [];
  if (mergedForecast.length > 0) {
    const prefMock = { areas: [] };
    for (const f of mergedForecast) {
      if (f.Intensity.To === "0" || f.Intensity.To === "over" || f.Intensity.To === "不明")
        continue;
      prefMock.areas.push({
        code: f.Code,
        maxInt: f.Intensity.To,
        cities: [],
      });
    }
    mockObservations.push(prefMock);
  }

  highlightObservations(mapInstance, mockObservations);

  // Add EEW epicenters
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  let hasValidEpicenter = false;

  let i = 0;
  const eews = Array.from(activeEews.values()).sort((a, b) => a.receivedAt - b.receivedAt);
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

  if (!isUserInteractingWithMap && featureBounds) {
    fitBoundsToObservations(
      mapInstance,
      mockObservations,
      featureBounds,
      false,
      "1",
      hasValidEpicenter ? { longitude: minLng, latitude: minLat } : null,
    );
  }
}
