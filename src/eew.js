import { USE_TEST_SERVER } from "./constants.js";
import { playAudio } from "./audio.js";
import {
  displayHomeMarker,
  setCustomHomeCoordinates,
} from "./map.js";
import { findCityForCoordinates } from "./areaCodes.js";
import { setHomeLocationUI, getHomeLocation } from "./sidebarUI.js";
import {
  getProvider,
  getAvailableProviders,
  getActiveProvider,
  setActiveProvider,
  isPlumEew,
  getShowTestEew,
  setShowTestEew,
} from "./eewProviders.js";

import { eewState } from "./eew/state.js";
import { loadEewDependencies, getIntVal } from "./eew/physics.js";
import { startWaveAnimation } from "./eew/waveAnimation.js";
import {
  clearEewMapDisplay,
  getIsEewMapActive,
  onMapInteract,
} from "./eew/eewMap.js";
import {
  updateEewUI,
  updateHomeIntensityForActiveEews,
} from "./eew/eewUI.js";

export { isPlumEew, getShowTestEew, setShowTestEew, clearEewMapDisplay, getIsEewMapActive, updateHomeIntensityForActiveEews };

/**
 * Initializes the EEW settings and connects if enabled.
 */
export function initEewSettings(map, bounds, cities, areas) {
  eewState.mapInstance = map;
  eewState.featureBounds = bounds;
  eewState.cityNames = cities;
  eewState.areaCodes = areas;

  const toggleEl = document.getElementById("eew-toggle");
  const providerSelectEl = document.getElementById("eew-provider-select");
  const tokenGroupEl = document.getElementById("eew-token-group");
  const tokenLabelEl = document.getElementById("eew-token-label");
  const tokenInputEl = document.getElementById("eew-token-input");
  const portGroupEl = document.getElementById("eew-port-group");
  const portInputEl = document.getElementById("eew-port-input");
  const homeSyncGroupEl = document.getElementById("eew-home-sync-group");
  const homeSyncToggleEl = document.getElementById("eew-home-sync-toggle");
  const testToggleEl = document.getElementById("eew-test-toggle");
  const axisInfoEl = document.getElementById("eew-axis-info");

  if (!toggleEl) return;

  const availableProviders = getAvailableProviders();

  // Populate provider selector dropdown
  if (providerSelectEl) {
    providerSelectEl.innerHTML = "";
    for (const provider of availableProviders) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.name;
      providerSelectEl.appendChild(option);
    }
  }

  // Determine active provider
  const savedProviderId = localStorage.getItem("eew-provider");
  let currentProvider = availableProviders.find((p) => p.id === savedProviderId);
  if (!currentProvider) {
    if (USE_TEST_SERVER && availableProviders.some((p) => p.id === "test")) {
      currentProvider = availableProviders.find((p) => p.id === "test");
    } else {
      currentProvider = availableProviders[0] || getProvider("axis");
    }
  }
  setActiveProvider(currentProvider);
  if (providerSelectEl) {
    providerSelectEl.value = currentProvider.id;
  }

  function updateProviderSettingsUI() {
    const p = getActiveProvider();
    if (!p) return;

    if (p.requiresToken) {
      if (tokenGroupEl) tokenGroupEl.classList.remove("hidden");
      if (tokenLabelEl) tokenLabelEl.textContent = p.tokenLabel || `${p.name} Token • トークン:`;
      if (tokenInputEl) {
        tokenInputEl.placeholder = p.tokenPlaceholder || "Bearer Token";
        tokenInputEl.value = p.getToken();
      }
    } else if (tokenGroupEl) {
      tokenGroupEl.classList.add("hidden");
    }

    if (p.requiresPort) {
      if (portGroupEl) portGroupEl.classList.remove("hidden");
      if (portInputEl) {
        portInputEl.value = p.getPort();
        portInputEl.placeholder = p.defaultPort || "11311";
      }
    } else if (portGroupEl) {
      portGroupEl.classList.add("hidden");
    }

    if (p.supportsHomeSync) {
      if (homeSyncGroupEl) homeSyncGroupEl.classList.remove("hidden");
      if (homeSyncToggleEl) homeSyncToggleEl.checked = p.getHomeSync();
    } else if (homeSyncGroupEl) {
      homeSyncGroupEl.classList.add("hidden");
    }

    if (axisInfoEl) {
      if (p.id === "axis") {
        axisInfoEl.classList.remove("hidden");
      } else {
        axisInfoEl.classList.add("hidden");
      }
    }
  }

  updateProviderSettingsUI();

  const savedEnabled = localStorage.getItem("eew-enabled") === "true";
  toggleEl.checked = savedEnabled;

  if (savedEnabled) {
    const p = getActiveProvider();
    if (!p.requiresToken || p.getToken()) {
      connectEew();
    }
  }

  toggleEl.addEventListener("change", (e) => {
    const isEnabled = e.target.checked;
    localStorage.setItem("eew-enabled", isEnabled ? "true" : "false");
    if (isEnabled) {
      const p = getActiveProvider();
      if (p.requiresToken && !p.getToken()) {
        alert(
          "Please enter a token in Settings before enabling EEW.\nEEWを有効にする前に、「設定」でトークンを入力してください。",
        );
        toggleEl.checked = false;
        localStorage.setItem("eew-enabled", "false");
        return;
      }
      connectEew();
    } else {
      disconnectEew();
    }
  });

  if (providerSelectEl) {
    providerSelectEl.addEventListener("change", (e) => {
      const newProviderId = e.target.value;
      const newProvider = getProvider(newProviderId);
      if (!newProvider) return;

      localStorage.setItem("eew-provider", newProviderId);
      const wasConnected = toggleEl.checked;

      if (wasConnected) {
        disconnectEew();
      }

      setActiveProvider(newProvider);
      updateProviderSettingsUI();

      if (!newProvider.supportsHomeSync || !newProvider.getHomeSync()) {
        setCustomHomeCoordinates(null);
        const homeLoc = getHomeLocation();
        if (homeLoc.showMarker && eewState.featureBounds) {
          displayHomeMarker(eewState.mapInstance, homeLoc.cityCode, eewState.featureBounds);
        }
      } else if (
        newProvider.supportsHomeSync &&
        newProvider.getHomeSync() &&
        newProvider.userPoint
      ) {
        applyEewClientUserPoint(newProvider.userPoint);
      }

      if (wasConnected) {
        if (!newProvider.requiresToken || newProvider.getToken()) {
          connectEew();
        } else {
          alert(
            `Please enter a token for ${newProvider.name} in Settings.\n「設定」で${newProvider.name}のトークンを入力してください。`,
          );
          toggleEl.checked = false;
          localStorage.setItem("eew-enabled", "false");
        }
      }
    });
  }

  if (tokenInputEl) {
    tokenInputEl.addEventListener("change", (e) => {
      const p = getActiveProvider();
      if (!p) return;
      const token = e.target.value.trim();
      p.setToken(token);
      p.resetTokenState?.();

      if (toggleEl.checked) {
        disconnectEew();
        if (token) {
          connectEew();
        }
      }
    });
  }

  if (portInputEl) {
    portInputEl.addEventListener("change", (e) => {
      const p = getActiveProvider();
      if (!p) return;
      const port = e.target.value.trim() || p.defaultPort || "11311";
      p.setPort(port);

      if (toggleEl.checked) {
        disconnectEew();
        connectEew();
      }
    });
  }

  if (homeSyncToggleEl) {
    homeSyncToggleEl.addEventListener("change", async (e) => {
      const p = getActiveProvider();
      if (!p?.supportsHomeSync) return;
      const enabled = e.target.checked;
      p.setHomeSync(enabled);

      if (!enabled) {
        setCustomHomeCoordinates(null);
        const homeLoc = getHomeLocation();
        if (homeLoc.showMarker && eewState.featureBounds) {
          displayHomeMarker(eewState.mapInstance, homeLoc.cityCode, eewState.featureBounds);
        }
      } else if (p.userPoint) {
        await applyEewClientUserPoint(p.userPoint);
      }

      if (eewState.isEewMapActive && eewState.activeEews.size > 0) {
        updateHomeIntensityForActiveEews();
      }
    });
  }

  if (testToggleEl) {
    testToggleEl.checked = getShowTestEew();
    testToggleEl.addEventListener("change", (e) => {
      const enabled = e.target.checked;
      setShowTestEew(enabled);
      if (!enabled) {
        let changed = false;
        for (const [id, eew] of eewState.activeEews.entries()) {
          if (eew.isTest) {
            eewState.activeEews.delete(id);
            changed = true;
          }
        }
        if (changed) {
          updateEewUI(false);
          if (eewState.isEewMapActive && eewState.activeEews.size > 0) {
            updateHomeIntensityForActiveEews();
          }
        }
      }
    });
  }

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
    text.textContent = " EEW: Connecting";
  } else if (state === "connected") {
    dot.className = "dot-live";
    text.textContent = " EEW: Connected";
  } else if (state === "upstream-disconnected") {
    dot.className = "dot-loading";
    text.textContent = " EEW: Upstream disconnected";
  } else if (state === "error") {
    dot.className = "dot-error";
    text.textContent = " EEW: Disconnected";
  }
}

async function connectEew() {
  const provider = getActiveProvider();
  if (!provider) return;

  if (provider.requiresToken && !provider.getToken()) {
    console.warn(`[EEW] Provider ${provider.name} requires a token, but none is set.`);
    return;
  }

  disconnectEew();

  await loadEewDependencies();

  updateEewStatus("connecting");

  provider.connect({
    onStatusChange: (status) => {
      updateEewStatus(status);
    },
    onMessage: (normalizedMsg) => {
      handleEewMessage(normalizedMsg, provider);
    },
    onUserPoint: async (location) => {
      const p = getActiveProvider();
      if (p?.supportsHomeSync && p.getHomeSync()) {
        await applyEewClientUserPoint(location);
      }
    },
    onAuthError: (errorMessage) => {
      alert(errorMessage);
      disconnectEew();
      const toggleEl = document.getElementById("eew-toggle");
      if (toggleEl) {
        toggleEl.checked = false;
        localStorage.setItem("eew-enabled", "false");
        updateEewStatus("error");
      }
    },
    onTokenUpdated: (newToken) => {
      const tokenInputEl = document.getElementById("eew-token-input");
      if (tokenInputEl && provider.requiresToken) {
        tokenInputEl.value = newToken;
      }
    },
  });
}

function disconnectEew() {
  updateEewStatus("error");
  const provider = getActiveProvider();
  if (provider) {
    provider.disconnect();
  }
  clearAllEews();
}

export function handleEewMessage(msg, providerInfo = null) {
  if (!msg?.Title) return;

  const eventId = msg.EventID;
  const activeProv = getActiveProvider();
  let srcName = "";
  let providerId = "";
  let disableGmpe = false;

  if (providerInfo && typeof providerInfo === "object") {
    srcName = providerInfo.name;
    providerId = providerInfo.id;
    disableGmpe = Boolean(providerInfo.disableGmpe);
  } else if (typeof providerInfo === "string") {
    srcName = providerInfo;
    const matched =
      getProvider(providerInfo) || (activeProv?.name === providerInfo ? activeProv : null);
    if (matched) {
      providerId = matched.id;
      disableGmpe = Boolean(matched.disableGmpe);
    } else if (
      providerInfo.toLowerCase().includes("dmdss") ||
      providerInfo.toLowerCase().includes("client")
    ) {
      providerId = "dmdss";
      disableGmpe = true;
    }
  } else if (activeProv) {
    srcName = activeProv.name;
    providerId = activeProv.id;
    disableGmpe = Boolean(activeProv.disableGmpe);
  }

  const isTest = Boolean(
    msg.isTest ||
    msg.Flag?.is_training ||
    msg.Title?.includes("訓練") ||
    msg.Title?.includes("テスト") ||
    (eventId && eewState.activeEews.get(eventId)?.isTest)
  );

  if (isTest && !getShowTestEew()) {
    console.debug(`[EEW] Ignored test EEW (test EEWs disabled): ${eventId}`);
    return;
  }

  // Check if cancel
  if (msg.Flag?.is_cancel) {
    if (eewState.activeEews.has(eventId)) {
      const eew = eewState.activeEews.get(eventId);
      eew.isCancelled = true;
      eew.msg = msg;
      eew.providerName = srcName;
      eew.providerId = providerId;
      eew.disableGmpe = disableGmpe;
      eew.isTest = isTest;

      setTimeout(() => {
        removeEew(eventId);
      }, 15000);
      updateEewUI(false);
      if (eewState.isEewMapActive && eewState.activeEews.size > 0) {
        updateHomeIntensityForActiveEews();
      }
    }
  } else {
    // Forecast or Warning
    const isNew = !eewState.activeEews.has(eventId);
    const eew = eewState.activeEews.get(eventId) || { receivedAt: Date.now() };
    eew.msg = msg;
    eew.isFinal = msg.Flag?.is_final;
    eew.providerName = srcName;
    eew.providerId = providerId;
    eew.disableGmpe = disableGmpe;
    eew.isTest = isTest;
    eewState.activeEews.set(eventId, eew);

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
  if (eewState.activeEews.has(eventId)) {
    eewState.activeEews.delete(eventId);
    updateEewUI(false);
    if (eewState.isEewMapActive && eewState.activeEews.size > 0) {
      updateHomeIntensityForActiveEews();
    }
  }
}

function clearAllEews() {
  eewState.activeEews.clear();
  updateEewUI(false);
}

export function handlePossibleEewReport(report) {
  if (eewState.activeEews.has(report.eventId)) {
    let isHighest = true;
    const thisEewMsg = eewState.activeEews.get(report.eventId).msg;
    const thisInt = getIntVal(thisEewMsg.Intensity);

    for (const [id, eew] of eewState.activeEews.entries()) {
      if (id !== report.eventId && !eew.isCancelled) {
        const otherInt = getIntVal(eew.msg.Intensity);
        if (otherInt > thisInt) {
          isHighest = false;
        }
      }
    }

    return isHighest;
  }
  return null;
}

export async function applyEewClientUserPoint(location) {
  if (!Array.isArray(location) || location.length < 2) return;
  const [lon, lat] = location;
  if (typeof lon !== "number" || typeof lat !== "number" || Number.isNaN(lon) || Number.isNaN(lat))
    return;

  setCustomHomeCoordinates([lon, lat]);

  const match = await findCityForCoordinates(lon, lat);
  if (match) {
    setHomeLocationUI(match.prefCode, match.cityCode);
  }

  const homeLoc = getHomeLocation();
  if (homeLoc.showMarker && eewState.featureBounds && eewState.mapInstance) {
    displayHomeMarker(eewState.mapInstance, homeLoc.cityCode, eewState.featureBounds);
  }

  if (eewState.isEewMapActive && eewState.activeEews.size > 0) {
    updateHomeIntensityForActiveEews();
  }
}
