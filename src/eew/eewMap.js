import * as maplibregl from "maplibre-gl";
import { eewState } from "./state.js";
import {
  haversineDistance,
  TEST_GMPE_OVERRIDE,
} from "../constants.js";
import {
  clearEpicenter,
  updateCityAreasVisibility,
  updateShakemapVisibility,
  updateLpgmVisibility,
  highlightObservations,
  fitBoundsToObservations,
  hideHomeLocationIntensity,
} from "../map.js";
import { updateMapLegend } from "../main.js";
import {
  mergeForecasts,
  calculateGmpe,
  floatToShindo,
  getIntVal,
  cityForecastMap,
  stationsData,
} from "./physics.js";
import { getActiveProvider, isPlumEew } from "../eewProviders.js";

/**
 * Tracks user map interaction to avoid snapping camera view.
 */
export function onMapInteract() {
  if (!eewState.isEewMapActive) return;
  eewState.isUserInteractingWithMap = true;
  if (eewState.mapInteractionTimeout) {
    clearTimeout(eewState.mapInteractionTimeout);
  }
  eewState.mapInteractionTimeout = setTimeout(() => {
    eewState.isUserInteractingWithMap = false;
  }, 10000);
}

/**
 * Returns whether the map is currently displaying EEW data.
 * @returns {boolean}
 */
export function getIsEewMapActive() {
  return eewState.isEewMapActive;
}

/**
 * Clears EEW visual elements from the map when a normal report is selected.
 */
export function clearEewMapDisplay() {
  eewState.isEewMapActive = false;
  eewState.isUserInteractingWithMap = false;

  const testBanner = document.getElementById("eew-test-banner");
  if (testBanner) {
    testBanner.classList.add("hidden");
  }

  if (eewState.mapInteractionTimeout) {
    clearTimeout(eewState.mapInteractionTimeout);
    eewState.mapInteractionTimeout = null;
  }

  hideHomeLocationIntensity();

  for (const marker of eewState.eewEpicenterMarkers) {
    marker.remove();
  }
  eewState.eewEpicenterMarkers = [];

  const infoBox = document.getElementById("map-info-box");
  if (infoBox) {
    const eewSerialRow = infoBox.querySelector(".eew-serial-row");
    if (eewSerialRow) eewSerialRow.remove();
    const eewSourceRow = infoBox.querySelector(".eew-source-row");
    if (eewSourceRow) eewSourceRow.remove();
    const eewSerial = infoBox.querySelector(".info-box-eew-serial");
    if (eewSerial) {
      eewSerial.textContent = "";
      eewSerial.classList.add("hidden");
    }
  }

  if (eewState.mapInstance) {
    const pSrc = eewState.mapInstance.getSource("eew-p-wave");
    const sSrc = eewState.mapInstance.getSource("eew-s-wave");
    if (pSrc) pSrc.setData({ type: "FeatureCollection", features: [] });
    if (sSrc) sSrc.setData({ type: "FeatureCollection", features: [] });
  }
}

/**
 * Updates the map display for active EEWs (epicenter markers, GMPE shindo predictions, camera framing).
 */
export function updateMapForEew() {
  console.debug("[eq-viewer-eew] updateMapForEew: START");
  if (!eewState.mapInstance) return;
  if (!eewState.isEewMapActive || eewState.activeEews.size === 0 || document.querySelector(".eq-item.active")) {
    console.debug("[eq-viewer-eew] updateMapForEew: aborted early (not active)");
    return;
  }

  console.debug("[eq-viewer-eew] updateMapForEew: removing old markers");
  for (const marker of eewState.eewEpicenterMarkers) marker.remove();
  eewState.eewEpicenterMarkers = [];

  console.debug("[eq-viewer-eew] updateMapForEew: clearing normal UI elements");
  clearEpicenter(eewState.mapInstance); // Clear normal epicenter
  updateCityAreasVisibility(eewState.mapInstance, false); // Force Cities off temporarily
  updateShakemapVisibility(eewState.mapInstance, false); // Force Shakemap off temporarily
  updateLpgmVisibility(eewState.mapInstance, false); // Force LPGM off temporarily
  updateMapLegend(false); // Restore standard legend

  console.debug("[eq-viewer-eew] updateMapForEew: scheduling phase 2 via setTimeout");
  // Give MapLibre a moment to apply layout property changes before setting feature states.
  setTimeout(() => {
    console.debug("[eq-viewer-eew] updateMapForEew Phase 2: START");
    // Guard: EEW state may have changed during the delay
    if (!eewState.isEewMapActive || eewState.activeEews.size === 0 || document.querySelector(".eq-item.active")) {
      return;
    }

    console.debug("[eq-viewer-eew] updateMapForEew Phase 2: preparing map intensities");
    const mergedForecast = mergeForecasts(Array.from(eewState.activeEews.values()));
    const eews = Array.from(eewState.activeEews.values()).sort((a, b) => a.receivedAt - b.receivedAt);

    const activeProv = getActiveProvider();
    const isGmpeDisabled = Boolean(
      activeProv?.disableGmpe ||
      activeProv?.id === "dmdss" ||
      (eews.length > 0 &&
        eews.every((e) => e.disableGmpe || e.providerId === "dmdss" || e.isCancelled)),
    );

    const localPredictions = new Map();

    if (!isGmpeDisabled) {
      console.debug("[eq-viewer-eew] updateMapForEew Phase 2: calculating GMPE");
      // Track the highest estimated intensity for each individual station across all EEWs
      const stationMaxInts = new Int32Array(stationsData.length).fill(0);

      for (const eew of eews) {
        if (eew.isCancelled || eew.disableGmpe || eew.providerId === "dmdss") continue;
        const msg = eew.msg;
        if (!msg.Hypocenter?.Coordinate) continue;

        const isPlum = isPlumEew(msg);
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
      for (const [areaCodeStr, vals] of areaInts.entries()) {
        if (vals.length >= 2) {
          vals.sort((a, b) => b - a); // descending
          const secondHighestVal = vals[1];
          if (secondHighestVal > 0) {
            localPredictions.set(areaCodeStr, getIntStr(secondHighestVal));
          }
        }
      }
    } else {
      console.debug(
        "[eq-viewer-eew] updateMapForEew Phase 2: skipping GMPE calculation (disabled for provider)",
      );
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
    highlightObservations(eewState.mapInstance, mockObservations);
    console.debug("[eq-viewer-eew] updateMapForEew Phase 2: highlights applied");

    console.debug("[eq-viewer-eew] updateMapForEew: scheduling phase 3 via rAF");
    // Defer marker placement and camera movement to the next animation frame
    // to avoid overwhelming WebKit2GTK's WebGL context
    requestAnimationFrame(() => {
      console.debug("[eq-viewer-eew] updateMapForEew Phase 3: START");
      // Guard: EEW state may have changed by the time this frame fires
      if (!eewState.isEewMapActive || eewState.activeEews.size === 0 || document.querySelector(".eq-item.active")) {
        return;
      }

      if (eewState.updateHomeIntensity) {
        eewState.updateHomeIntensity();
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

          const isPlum = isPlumEew(msg);
          const isCancel = eew.isCancelled;

          let icon = "epicenter-eew.png";
          if (isCancel) icon = "epicenter-cancel.png";
          else if (isPlum) icon = "epicenter-plum.png";

          const markerEl = document.createElement("div");
          markerEl.className = "epicenter-eew-marker";
          markerEl.style.width = "32px";
          markerEl.style.height = "32px";
          markerEl.innerHTML = `<img src="/img/${icon}" style="width:32px; height:32px; display:block;" />`;
          if (eews.length > 1) {
            const labelPositions = [
              "bottom: 100%; left: 50%; transform: translateX(-50%);", // 1: top
              "top: 100%; left: 50%; transform: translateX(-50%);", // 2: bottom
              "right: 100%; top: 50%; transform: translateY(-50%);", // 3: left
              "left: 100%; top: 50%; transform: translateY(-50%);", // 4: right
            ];
            const posStyle = labelPositions[(i - 1) % labelPositions.length];
            markerEl.innerHTML += `<div style="position:absolute; ${posStyle} background:rgba(0,0,0,0.7); color:#fff; padding:2px 6px; border-radius:4px; font-size:14px; font-weight:bold; line-height:1; white-space:nowrap; pointer-events:none;">${i}</div>`;
          }

          const marker = new maplibregl.Marker({ element: markerEl })
            .setLngLat([lon, lat])
            .addTo(eewState.mapInstance);
          eewState.eewEpicenterMarkers.push(marker);
        }
      }

      console.debug("[eq-viewer-eew] updateMapForEew Phase 3: fitting bounds");
      if (!eewState.isUserInteractingWithMap && eewState.featureBounds) {
        fitBoundsToObservations(
          eewState.mapInstance,
          mockObservations,
          eewState.featureBounds,
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
