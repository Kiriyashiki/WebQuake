import { DEBUG_SETTINGS_CHANGED_EVENT } from "./debugOptions.js";
import { playAudioEvent, EEW_AUDIO_EVENTS, getEewPlayLowAccuracy } from "./audio.js";
import { displayHomeMarker, setCustomHomeCoordinates } from "./map.js";
import { findCityForCoordinates } from "./areaCodes.js";
import { setHomeLocationUI, getHomeLocation } from "./sidebarUI.js";
import {
  getProvider,
  getEewSourceProvider,
  getShowTestEew,
  isWarningEew,
} from "./externalProviders.js";

import { eewState } from "./eew/state.js";
import { getIntVal } from "./eew/physics.js";
import { startWaveAnimation } from "./eew/waveAnimation.js";
import { onMapInteract, updateMapForEew } from "./eew/eewMap.js";
import { clearEewRemoval, scheduleEewRemoval } from "./eew/removal.js";
import { extractWarningAreaCodes } from "./eew/warningAreas.js";
import {
  updateEewUI,
  updateHomeIntensityForActiveEews,
} from "./eew/eewUI.js";

export { isPlumEew } from "./externalProviders.js";
export { clearEewMapDisplay, getIsEewMapActive, fitBoundsForActiveEew } from "./eew/eewMap.js";
export { getShowTestEew, setShowTestEew } from "./externalProviders.js";
export { updateHomeIntensityForActiveEews };

/**
 * Initializes the EEW runtime (shared state, map interaction handling and
 * debug-driven map updates). Connections and provider selection are handled by
 * the external services manager.
 */
export function initEewRuntime(map, bounds, cities, areas) {
  eewState.mapInstance = map;
  eewState.featureBounds = bounds;
  eewState.cityNames = cities;
  eewState.areaCodes = areas;

  const handleDebugSettingsChanged = (event) => {
    const { name } = event.detail || {};

    if (
      (name === "enableSm1999Gmpe" || name === "testGmpeOverride") &&
      eewState.isEewMapActive &&
      eewState.activeEews.size > 0
    ) {
      updateMapForEew();
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener(DEBUG_SETTINGS_CHANGED_EVENT, handleDebugSettingsChanged);
  }

  // Track map interactions to pause fitBounds
  map.on("mousedown", onMapInteract);
  map.on("wheel", onMapInteract);
  map.on("touchstart", onMapInteract);
  map.on("drag", onMapInteract);
  map.on("dragend", onMapInteract);
  map.on("movestart", (e) => {
    if (e.originalEvent) onMapInteract();
  });
  map.on("moveend", (e) => {
    if (e.originalEvent) onMapInteract();
  });
}

/**
 * Updates home-location state when the EEW source changes.
 */
export function onEewSourceChanged(provider) {
  const homeSyncOn = Boolean(provider?.supportsHomeSync && provider.getHomeSync());

  if (!homeSyncOn) {
    setCustomHomeCoordinates(null);
    const homeLoc = getHomeLocation();
    if (homeLoc.showMarker && eewState.featureBounds) {
      displayHomeMarker(eewState.mapInstance, homeLoc.cityCode, eewState.featureBounds);
    }
  } else if (provider.userPoint) {
    applyEewClientUserPoint(provider.userPoint);
  }

  if (eewState.isEewMapActive && eewState.activeEews.size > 0) {
    updateHomeIntensityForActiveEews();
  }
}

/**
 * Applies the provider's home-location sync setting.
 */
export async function setEewHomeSync(provider, enabled) {
  if (!provider?.supportsHomeSync) return;
  provider.setHomeSync(enabled);

  if (!enabled) {
    setCustomHomeCoordinates(null);
    const homeLoc = getHomeLocation();
    if (homeLoc.showMarker && eewState.featureBounds) {
      displayHomeMarker(eewState.mapInstance, homeLoc.cityCode, eewState.featureBounds);
    }
  } else if (provider.userPoint) {
    await applyEewClientUserPoint(provider.userPoint);
  }

  if (eewState.isEewMapActive && eewState.activeEews.size > 0) {
    updateHomeIntensityForActiveEews();
  }
}

/**
 * Clears all active EEWs, used when the EEW source is disabled or changed.
 */
export function clearEewState() {
  // Only restore the normal report when the EEW UI was actually showing
  // something. Re-rendering unconditionally can re-render the open report's
  // observations list a second time.
  const shouldUpdateUi = eewState.activeEews.size > 0 || eewState.isEewMapActive;

  for (const eew of eewState.activeEews.values()) {
    clearEewRemoval(eew);
  }
  eewState.activeEews.clear();

  if (shouldUpdateUi) {
    updateEewUI(false);
  }
}

/**
 * Removes all test/drill EEWs from the active list.
 */
export function clearTestEews() {
  let changed = false;
  for (const [id, eew] of eewState.activeEews.entries()) {
    if (eew.isTest) {
      clearEewRemoval(eew);
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

function _eewSerialNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function _isSerialIncreased(current, previous) {
  const currentSerial = _eewSerialNumber(current);
  const previousSerial = _eewSerialNumber(previous);
  if (currentSerial == null || previousSerial == null) return false;
  return currentSerial > previousSerial;
}

function _isEewAudioSuppressed(msg) {
  return Boolean(msg?.isLowAccuracy) && !getEewPlayLowAccuracy();
}

function _ensureEewAudioState(eew) {
  if (!eew.audio || typeof eew.audio !== "object") {
    eew.audio = {
      forecastPlayed: false,
      forecastSuppressed: false,
      warningPlayed: false,
    };
  }
  return eew.audio;
}

function _playEewAudio(eventId, eventType) {
  playAudioEvent(eventType, { key: `eew:${eventId}:${eventType}` });
}

function _handleNewEewAudio(eventId, msg, audioState) {
  if (_isEewAudioSuppressed(msg)) {
    audioState.forecastSuppressed = true;
    return;
  }

  audioState.forecastPlayed = true;
  audioState.forecastSuppressed = false;
  _playEewAudio(eventId, EEW_AUDIO_EVENTS.FORECAST);
}

function _handleUpdatedEewAudio(
  eventId,
  msg,
  eew,
  audioState,
  { previousSerial, wasWarning, wasCancelled },
) {
  if (wasCancelled) return;

  if (_isEewAudioSuppressed(msg)) {
    if (!audioState.forecastPlayed) audioState.forecastSuppressed = true;
    return;
  }

  // A low-accuracy first report had its forecast sound suppressed.  Play it
  // as soon as the EEW becomes accurate enough.
  if (!audioState.forecastPlayed) {
    audioState.forecastPlayed = true;
    audioState.forecastSuppressed = false;
    _playEewAudio(eventId, EEW_AUDIO_EVENTS.FORECAST);
  }

  if (_isSerialIncreased(msg.Serial, previousSerial)) {
    _playEewAudio(eventId, EEW_AUDIO_EVENTS.UPDATE);
  }

  if (eew.isWarning && !wasWarning) {
    audioState.warningPlayed = true;
    _playEewAudio(eventId, EEW_AUDIO_EVENTS.WARNING);
  }
}

export function handleEewMessage(msg, providerInfo = null) {
  if (!msg?.Title) return;

  const eventId = msg.EventID;
  const activeProv = getEewSourceProvider();
  let srcName = "";
  let providerId = "";
  let disableGmpe = false;
  let supportsWarningAreas = false;

  if (providerInfo && typeof providerInfo === "object") {
    srcName = providerInfo.name;
    providerId = providerInfo.id;
    disableGmpe = Boolean(providerInfo.disableGmpe);
    supportsWarningAreas = Boolean(providerInfo.supportsWarningAreas);
  } else if (typeof providerInfo === "string") {
    srcName = providerInfo;
    const matched =
      getProvider(providerInfo) || (activeProv?.name === providerInfo ? activeProv : null);
    if (matched) {
      providerId = matched.id;
      disableGmpe = Boolean(matched.disableGmpe);
      supportsWarningAreas = Boolean(matched.supportsWarningAreas);
    } else if (
      providerInfo.toLowerCase().includes("eewclient") ||
      providerInfo.toLowerCase().includes("client")
    ) {
      providerId = "eewclient";
      disableGmpe = true;
    }
  } else if (activeProv) {
    srcName = activeProv.name;
    providerId = activeProv.id;
    disableGmpe = Boolean(activeProv.disableGmpe);
    supportsWarningAreas = Boolean(activeProv.supportsWarningAreas);
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
      const wasCancelled = Boolean(eew.isCancelled);
      eew.isCancelled = true;
      eew.warningAreaCodes = [];
      eew.msg = msg;
      eew.providerName = srcName;
      eew.providerId = providerId;
      eew.disableGmpe = disableGmpe;
      eew.isTest = isTest;

      if (!wasCancelled) {
        _playEewAudio(eventId, EEW_AUDIO_EVENTS.CANCEL);
      }

      scheduleEewRemoval(eew, msg, () => removeEew(eventId));
      updateEewUI(false);
      if (eewState.isEewMapActive && eewState.activeEews.size > 0) {
        updateHomeIntensityForActiveEews();
      }
    }
  } else {
    // Forecast or Warning
    const existing = eewState.activeEews.get(eventId);
    const isNew = !existing;
    const eew = existing || { receivedAt: Date.now() };
    const audioState = _ensureEewAudioState(eew);
    const previousSerial = existing?.msg?.Serial;
    const wasWarning = Boolean(existing?.isWarning);
    const wasCancelled = Boolean(existing?.isCancelled);

    // A warning can be followed by further forecast messages for the same
    // EventID (AXIS does this). Once an event has been warned, later forecast
    // updates must not downgrade its UI back to "forecast".
    const msgIsWarning = isWarningEew(msg);
    eew.isWarning = msgIsWarning || Boolean(eew.isWarning);
    // Warning areas come from the warning message itself. Keep the last known
    // set when later forecast updates for the same event arrive.
    if (msgIsWarning) {
      eew.warningAreaCodes = supportsWarningAreas ? extractWarningAreaCodes(msg) : [];
    }
    eew.msg = msg;
    eew.providerName = srcName;
    eew.providerId = providerId;
    eew.disableGmpe = disableGmpe;
    eew.isTest = isTest;
    eewState.activeEews.set(eventId, eew);

    // Final reports are removed after 3 minutes; otherwise the EEW is kept for
    // 8 minutes since the last non-final, non-cancel message as a fallback for
    // when the final report never arrives. A cancelled EEW keeps its short
    // removal timer, so a late forecast cannot extend its lifetime.
    if (!eew.isCancelled) {
      scheduleEewRemoval(eew, msg, () => removeEew(eventId));
    }

    if (isNew) {
      console.debug(`[EEW] New EEW recieved: ${eventId}`);
      // Auto open logic
      const liveTab = document.querySelector('[data-tab="live"]');
      if (liveTab && !liveTab.classList.contains("active")) {
        liveTab.click();
      }
      _handleNewEewAudio(eventId, msg, audioState);
    } else {
      _handleUpdatedEewAudio(eventId, msg, eew, audioState, {
        previousSerial,
        wasWarning,
        wasCancelled,
      });
    }

    updateEewUI(isNew);
    startWaveAnimation();
  }
}

function removeEew(eventId) {
  const eew = eewState.activeEews.get(eventId);
  if (eew) {
    clearEewRemoval(eew);
    eewState.activeEews.delete(eventId);
    updateEewUI(false);
    if (eewState.isEewMapActive && eewState.activeEews.size > 0) {
      updateHomeIntensityForActiveEews();
    }
  }
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
