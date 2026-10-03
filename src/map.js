/**
 * Initialises the MapLibre GL map, loads GeoJSON layers, and wires up
 * the forecast-area hover tooltip.
 */
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

maplibregl.setWorkerUrl(workerUrl);
import {
  INTENSITY_CONFIG,
  LPGM_CONFIG,
  MAP_COLORS,
  buildIntensityColorExpression,
  buildLpgmColorExpression,
} from "./constants.js";
import { buildStyle } from "./map/mapStyle.js";

const C = MAP_COLORS;

// ─── Tooltip helpers ─────────────────────────────────────────────────────────
function showTooltip(tooltip, x, y, code, info, intensity = null, mode = "area") {
  const codeEl = tooltip.querySelector(".tooltip-code");
  let codeLabel = `AREA ${code}`;
  if (mode === "station") {
    codeLabel = "STATION";
  } else if (mode === "city") {
    codeLabel = `CITY ${code}`;
  }
  codeEl.textContent = codeLabel;
  tooltip.querySelector(".tooltip-ja").textContent = info?.ja ?? "—";
  tooltip.querySelector(".tooltip-en").textContent = info?.en ?? "";

  // Update intensity display if available
  const intensityContainer = tooltip.querySelector(".tooltip-intensity-container");

  let config = null;
  if (intensity) {
    if (_lpgmVisible) {
      config = LPGM_CONFIG[intensity];
    } else {
      config = INTENSITY_CONFIG[intensity];
    }
  }

  if (config) {
    const img = intensityContainer.querySelector("img");
    img.src = _lpgmVisible ? `/img/lpgm/${config.img}` : `/img/shindo/${config.img}`;
    img.alt = _lpgmVisible ? `LPGM ${intensity}` : `Intensity ${intensity}`;
    img.title = _lpgmVisible ? `LPGM: ${intensity}` : `Intensity: ${intensity}`;
    intensityContainer.classList.remove("hidden");

    tooltip.style.borderTopColor = config.color;
    codeEl.style.color = config.color;
  } else {
    if (intensityContainer) {
      intensityContainer.classList.add("hidden");
    }
    const defaultColor = "#1e2e44"; // C.japanLine
    tooltip.style.borderTopColor = defaultColor;
    codeEl.style.color = defaultColor;
  }

  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.classList.remove("hidden");
}

function hideTooltip(tooltip) {
  tooltip.classList.add("hidden");
}


// ─── Main map factory ────────────────────────────────────────────────────────
let _stationNamesCsv = null;

/**
 * @param {HTMLElement} container  - The #map element.
 * @param {Map<number, {ja:string, en:string}>} areaCodes
 * @param {Map<string, {ja:string, en:string}>} cityNames
 * @param {Object} stationNames - Contains byCode and byName maps for station resolution
 * @param {Function} getUseCityAreas - Returns current state of city areas toggle
 * @returns {maplibregl.Map}
 */
export function initMap(
  container,
  areaCodes,
  cityNames,
  stationNames,
  getUseCityAreas = () => true,
) {
  _stationNamesCsv = stationNames;

  const map = new maplibregl.Map({
    container,
    style: buildStyle(getUseCityAreas()),
    center: [137, 37.5], // Centre on Japan
    zoom: 4.4,
    minZoom: 2,
    maxZoom: 10,
    fadeDuration: 0,
    attributionControl: false,
    pitchWithRotate: false,
  });

  const tooltip = document.getElementById("area-tooltip");

  // ── Wire hover interactions once the style is ready ──────────────────────
  map.on("load", () => {
    const canvas = map.getCanvas();

    const layers = ["forecast-fill", "cities-fill"];

    layers.forEach((layerName) => {
      const isCityLayer = layerName === "cities-fill";
      const sourceName = isCityLayer ? "cities" : "forecast_areas";
      let hoveredId = null; // Per-layer hover tracking

      // ── Mouse move on areas ──────────────────────────────────────
      map.on("mousemove", layerName, (e) => {
        const isActiveLayer = _lpgmVisible
          ? !isCityLayer
          : isCityLayer === _currentCityAreasVisible;
        if (!isActiveLayer) return;

        canvas.style.cursor = "crosshair";

        const feature = e.features[0];
        if (!feature) return;

        const newId = feature.id; // promoted from property
        if (!newId) return; // Skip features without an ID
        if (newId === hoveredId) {
          // Just update tooltip position with current intensity
          const state = map.getFeatureState({ source: sourceName, id: newId });
          showTooltip(
            tooltip,
            e.point.x,
            e.point.y,
            newId,
            isCityLayer ? cityNames?.get(String(newId)) : areaCodes.get(Number(newId)),
            _lpgmVisible ? state?.lpgmIntensity : state?.intensity,
            isCityLayer ? "city" : "area",
          );
          return;
        }

        // Clear old hover state
        if (hoveredId !== null) {
          map.setFeatureState({ source: sourceName, id: hoveredId }, { hover: false });
        }

        hoveredId = newId;

        map.setFeatureState({ source: sourceName, id: hoveredId }, { hover: true });

        const state = map.getFeatureState({ source: sourceName, id: hoveredId });
        showTooltip(
          tooltip,
          e.point.x,
          e.point.y,
          hoveredId,
          isCityLayer ? cityNames?.get(String(hoveredId)) : areaCodes.get(Number(hoveredId)),
          _lpgmVisible ? state?.lpgmIntensity : state?.intensity,
          isCityLayer ? "city" : "area",
        );
      });

      // ── Mouse leave ──────────────────────────────────────────────────────
      map.on("mouseleave", layerName, () => {
        const isActiveLayer = _lpgmVisible
          ? !isCityLayer
          : isCityLayer === _currentCityAreasVisible;
        if (!isActiveLayer) return;

        canvas.style.cursor = "";

        if (hoveredId !== null) {
          map.setFeatureState({ source: sourceName, id: hoveredId }, { hover: false });
          hoveredId = null;
        }

        hideTooltip(tooltip);
      });
    });

    // ── Shakemap layer hover interactions ─────────────────────────────────
    {
      let hoveredShakemapId = null;

      map.on("mousemove", "shakemap-fill", (e) => {
        if (!_shakemapVisible) return;

        canvas.style.cursor = "crosshair";

        const feature = e.features[0];
        if (!feature) return;

        const newId = feature.id;
        if (newId === undefined || newId === null) return;

        if (newId === hoveredShakemapId) {
          const state = map.getFeatureState({ source: "shakemap", id: newId });
          const stationName = feature.properties?.name || "";
          showTooltip(
            tooltip,
            e.point.x,
            e.point.y,
            newId,
            _getShakemapTooltipInfo(stationName),
            state?.intensity,
            "station",
          );
          return;
        }

        if (hoveredShakemapId !== null) {
          map.setFeatureState({ source: "shakemap", id: hoveredShakemapId }, { hover: false });
        }

        hoveredShakemapId = newId;
        map.setFeatureState({ source: "shakemap", id: hoveredShakemapId }, { hover: true });

        const state = map.getFeatureState({ source: "shakemap", id: hoveredShakemapId });
        const stationName = feature.properties?.name || "";
        showTooltip(
          tooltip,
          e.point.x,
          e.point.y,
          hoveredShakemapId,
          _getShakemapTooltipInfo(stationName),
          state?.intensity,
          "station",
        );
      });

      map.on("mouseleave", "shakemap-fill", () => {
        if (!_shakemapVisible) return;

        canvas.style.cursor = "";

        if (hoveredShakemapId !== null) {
          map.setFeatureState({ source: "shakemap", id: hoveredShakemapId }, { hover: false });
          hoveredShakemapId = null;
        }

        hideTooltip(tooltip);
      });
    }
  });

  return map;
}

let _currentCityAreasVisible = true;
let _pendingCityAreasUpdate = null;
let _shakemapVisible = false;

/**
 * Map of shakemap station name (JP, clean) → { ja, en, intensity }.
 * Populated by highlightShakemapObservations and used for tooltips.
 * @type {Map<string, {ja: string, en: string}>}
 */
let _shakemapStationInfo = new Map();

/**
 * Updates the visibility of city areas vs forecast areas layers.
 * Also tracks internal state for mouse interactions.
 * @param {maplibregl.Map} map
 * @param {boolean} useCityAreas
 */
export function updateCityAreasVisibility(map, useCityAreas) {
  _currentCityAreasVisible = useCityAreas;

  if (!map.isStyleLoaded()) {
    // Style not ready — defer the layout change until the map is idle.
    // Cancel any earlier pending update so only the latest value applies.
    if (_pendingCityAreasUpdate) {
      map.off("idle", _pendingCityAreasUpdate);
    }
    _pendingCityAreasUpdate = () => {
      _pendingCityAreasUpdate = null;
      _applyCityAreasVisibility(map, _currentCityAreasVisible);
    };
    map.once("idle", _pendingCityAreasUpdate);
    return;
  }

  // Cancel any pending deferred update since we're applying directly now
  if (_pendingCityAreasUpdate) {
    map.off("idle", _pendingCityAreasUpdate);
    _pendingCityAreasUpdate = null;
  }

  _applyCityAreasVisibility(map, useCityAreas);
}

function _applyCityAreasVisibility(map, useCityAreas) {
  if (_shakemapVisible) {
    // If shakemap is active, force both city and forecast layers off
    map.setLayoutProperty("cities-fill", "visibility", "none");
    map.setLayoutProperty("cities-line", "visibility", "none");
    map.setLayoutProperty("cities-line-bg", "visibility", "none");

    map.setLayoutProperty("forecast-fill", "visibility", "none");
    map.setLayoutProperty("forecast-line", "visibility", "none");

    map.setLayoutProperty("forecast-line-bg", "visibility", "none");
    map.setLayoutProperty("prefecture-line", "visibility", "none");
    return;
  }

  // LPGM mode overrides user preference and forces city layers OFF,
  // ensuring forecast layers are visible.
  const isCityVisible = _lpgmVisible ? false : useCityAreas;

  const visibility = isCityVisible ? "visible" : "none";
  const invVisibility = isCityVisible ? "none" : "visible";

  map.setLayoutProperty("cities-fill", "visibility", visibility);
  map.setLayoutProperty("cities-line", "visibility", visibility);
  map.setLayoutProperty("cities-line-bg", "visibility", visibility);

  map.setLayoutProperty("forecast-fill", "visibility", invVisibility);
  map.setLayoutProperty("forecast-line", "visibility", invVisibility);

  map.setLayoutProperty("forecast-line-bg", "visibility", "visible");
  map.setLayoutProperty("prefecture-line", "visibility", "visible");
}

// ─── LPGM mode ─────────────────────────────────────────────────────────────

let _lpgmVisible = false;

export function isLpgmVisible() {
  return _lpgmVisible;
}

/**
 * Toggles LPGM layer colors and forces forecast mode.
 * @param {maplibregl.Map} map
 * @param {boolean} show
 */
export function updateLpgmVisibility(map, show) {
  _lpgmVisible = show;

  if (show) {
    map.setPaintProperty("forecast-fill", "fill-color", [
      "case",
      ["boolean", ["feature-state", "highlighted"], false],
      [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        ["coalesce", buildLpgmColorExpression(false), "transparent"],
        buildLpgmColorExpression(true),
      ],
      "transparent",
    ]);
    map.setPaintProperty("forecast-line", "line-color", [
      "case",
      ["boolean", ["feature-state", "highlighted"], false],
      buildLpgmColorExpression(false, C.forecastLine),
      ["case", ["boolean", ["feature-state", "hover"], false], "#2b4262", C.japanLine],
    ]);
  } else {
    map.setPaintProperty("forecast-fill", "fill-color", [
      "case",
      ["boolean", ["feature-state", "highlighted"], false],
      [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        ["coalesce", buildIntensityColorExpression(false), "transparent"],
        buildIntensityColorExpression(true),
      ],
      "transparent",
    ]);
    map.setPaintProperty("forecast-line", "line-color", [
      "case",
      ["boolean", ["feature-state", "highlighted"], false],
      buildIntensityColorExpression(false, C.forecastLine),
      ["case", ["boolean", ["feature-state", "hover"], false], "#2b4262", C.japanLine],
    ]);
  }

  // Update layout properties to enforce forecast areas only
  _applyCityAreasVisibility(map, _currentCityAreasVisible);
}

// ─── Shakemap mode ─────────────────────────────────────────────────────────

/**
 * Strip fullwidth and ASCII asterisks from a station name for clean display
 * and matching against the shakemap GeoJSON.
 * @param {string} name
 * @returns {string}
 */
function _cleanStationName(name) {
  if (!name) return "";
  return name.replace(/[＊*]/g, "");
}

/**
 * Returns tooltip info for a shakemap station, falling back to CSV data if unhighlighted.
 * @param {string} name
 * @returns {{ja: string, en: string}}
 */
function _getShakemapTooltipInfo(name) {
  if (!name) return { ja: "", en: "" };
  const cleanName = _cleanStationName(name);
  let info = _shakemapStationInfo.get(cleanName);
  if (info) return info;

  const csvMatch = _stationNamesCsv?.byName?.get(cleanName);
  return csvMatch ? { ja: csvMatch.ja, en: csvMatch.en } : { ja: cleanName, en: "" };
}

let _pendingShakemapUpdate = null;

/**
 * Toggles shakemap layer visibility and hides/shows the normal intensity layers.
 * When shakemap is shown, both city and forecast layers are hidden.
 * When shakemap is hidden, the appropriate city/forecast layers are restored.
 * @param {maplibregl.Map} map
 * @param {boolean} show
 */
export function updateShakemapVisibility(map, show) {
  _shakemapVisible = show;

  if (!map.isStyleLoaded()) {
    if (_pendingShakemapUpdate) {
      map.off("idle", _pendingShakemapUpdate);
    }
    _pendingShakemapUpdate = () => {
      _pendingShakemapUpdate = null;
      updateShakemapVisibility(map, _shakemapVisible);
    };
    map.once("idle", _pendingShakemapUpdate);
    return;
  }

  if (_pendingShakemapUpdate) {
    map.off("idle", _pendingShakemapUpdate);
    _pendingShakemapUpdate = null;
  }

  if (show) {
    // Show shakemap layers
    map.setLayoutProperty("shakemap-fill", "visibility", "visible");
    map.setLayoutProperty("shakemap-line", "visibility", "visible");
  } else {
    // Hide shakemap layers
    map.setLayoutProperty("shakemap-fill", "visibility", "none");
    map.setLayoutProperty("shakemap-line", "visibility", "none");
  }

  // Update underlying layers - this will hide them if shakemap is active,
  // or restore them if shakemap is inactive.
  _applyCityAreasVisibility(map, _currentCityAreasVisible);
}

/**
 * Returns whether the shakemap layer is currently visible.
 * @returns {boolean}
 */
export function isShakemapVisible() {
  return _shakemapVisible;
}

/**
 * Highlights shakemap features by matching station names from observations.
 * Stations are matched by Japanese name (with ＊/* stripped).
 *
 * @param {maplibregl.Map} map
 * @param {Array|null} observations - Parsed observations (Pref → Area → City → stations)
 */
export function highlightShakemapObservations(map, observations) {
  // Clear previous shakemap highlights
  clearShakemapHighlights(map);
  _shakemapStationInfo.clear();

  if (!observations) return;

  // 1. Collect all stations from the observations into a name→{int, enName} map
  const stationsByName = new Map();
  for (const pref of observations) {
    for (const area of pref.areas) {
      for (const city of area.cities) {
        if (!city.stations) continue;
        for (const station of city.stations) {
          if (!station.name) continue;

          const cleanName = _cleanStationName(station.name);
          let finalJa = cleanName;
          let finalEn = station.enName ? station.enName.replaceAll('*', "") : "";

          // Use CSV names if available (match by code first, then by JP name)
          if (_stationNamesCsv) {
            let csvMatch = null;
            if (station.code) csvMatch = _stationNamesCsv.byCode.get(station.code);
            if (!csvMatch) csvMatch = _stationNamesCsv.byName.get(cleanName);

            if (csvMatch) {
              finalJa = csvMatch.ja;
              finalEn = csvMatch.en;
            }
          }

          stationsByName.set(cleanName, {
            int: station.int,
            ja: finalJa,
            en: finalEn,
          });
        }
      }
    }
  }

  if (stationsByName.size === 0) return;

  if (!highlightShakemapObservations._active) {
    highlightShakemapObservations._active = [];
  }

  // 2. Set feature state directly using the station name as the ID
  for (const [cleanName, stationData] of stationsByName.entries()) {
    map.setFeatureState(
      { source: "shakemap", id: cleanName },
      { highlighted: true, intensity: stationData.int },
    );

    // Store info for tooltip lookups
    _shakemapStationInfo.set(cleanName, { ja: stationData.ja, en: stationData.en });
  }
}

/**
 * Clears all shakemap feature highlights.
 * @param {maplibregl.Map} map
 */
export function clearShakemapHighlights(map) {
  if (map?.isStyleLoaded?.()) {
    try {
      if (map.getSource("shakemap")) {
        map.removeFeatureState({ source: "shakemap" });
      }
    } catch (_) {}
  }
  highlightShakemapObservations._active = [];
  _shakemapStationInfo.clear();
}

/**
 * Highlight the forecast areas that appear in a given earthquake's observation
 * list, colour-coded by intensity. Pass null to clear.
 *
 * @param {maplibregl.Map} map
 * @param {Array|null} observations  - Parsed observations from JMAEarthquakeReport or lpgmInfo
 * @param {boolean} isLpgm - If true, uses maxLgInt instead of maxInt
 */
export function highlightObservations(map, observations, isLpgm = false) {
  // Guard: do not touch feature states if the style hasn't fully loaded yet.
  if (!map.isStyleLoaded()) {
    // Defer until the map is idle (style loaded + rendered)
    const handler = () => {
      highlightObservations(map, observations, isLpgm);
    };
    map.once("idle", handler);
    return;
  }

  // Bulk-reset every currently highlighted feature across forecast_areas and cities
  try {
    if (map.getSource("forecast_areas")) {
      map.removeFeatureState({ source: "forecast_areas" });
    }
    if (map.getSource("cities")) {
      map.removeFeatureState({ source: "cities" });
    }
  } catch (_) {
    // Sources may not yet be initialized in custom styles
  }
  highlightObservations._active = [];

  if (!observations) return;

  for (const pref of observations) {
    for (const area of pref.areas) {
      // Highlight forecast areas
      const areaId = String(area.code);
      const intensityVal = isLpgm ? area.maxLgInt : area.maxInt;

      const featureState = { highlighted: true };
      if (isLpgm) {
        featureState.lpgmIntensity = intensityVal;
      } else {
        featureState.intensity = intensityVal;
      }

      try {
        map.setFeatureState({ source: "forecast_areas", id: areaId }, featureState);
      } catch (_) {
        // Feature may not exist in the source
      }

      // Highlight city areas
      if (area.cities) {
        for (const city of area.cities) {
          const cityId = String(city.code).padStart(7, "0");
          try {
            map.setFeatureState(
              { source: "cities", id: cityId },
              { highlighted: true, intensity: city.maxInt },
            );
          } catch (_) {
            // Feature may not exist in the source
          }
        }
      }
    }
  }
}

/**
 * Fits the map bounds to all observation areas with intensity 1 or higher.
 * @param {maplibregl.Map} map
 * @param {Array|null} observations
 * @param {Object} featureBounds - The loaded bounds.json object
 * @param {boolean} useCityAreas
 * @param {string} maxInt
 * @param {{latitude: number, longitude: number}} [coordinates]
 * @param {number} zoom
 */
export function fitBoundsToObservations(
  map,
  observations,
  featureBounds,
  useCityAreas,
  maxInt,
  coordinates,
  zoom = 7.5,
) {
  if (!observations || !featureBounds) return false;

  if (document.getElementById("map-container").offsetWidth <= 400) {
    return false;
  }

  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  let hasBounds = false;

  for (const pref of observations) {
    for (const area of pref.areas) {
      const areaInt = Number.parseInt(area.maxInt, 10);
      if (useCityAreas) {
        for (const city of area.cities) {
          const cityInt = Number.parseInt(city.maxInt, 10);
          if ((cityInt >= 1 && Number.parseInt(maxInt) <= 5) || cityInt >= 2) {
            const cityId = String(city.code).padStart(7, "0");
            const bounds = featureBounds.cities[cityId];
            if (bounds) {
              if (bounds[0] < minLng) minLng = bounds[0];
              if (bounds[1] < minLat) minLat = bounds[1];
              if (bounds[2] > maxLng) maxLng = bounds[2];
              if (bounds[3] > maxLat) maxLat = bounds[3];
              hasBounds = true;
            }
          }
        }
      } else if ((areaInt >= 1 && Number.parseInt(maxInt) <= 5) || areaInt >= 2) {
        const bounds = featureBounds.forecast[area.code];
        if (bounds) {
          if (bounds[0] < minLng) minLng = bounds[0];
          if (bounds[1] < minLat) minLat = bounds[1];
          if (bounds[2] > maxLng) maxLng = bounds[2];
          if (bounds[3] > maxLat) maxLat = bounds[3];
          hasBounds = true;
        }
      }
    }
  }

  if (
    coordinates &&
    typeof coordinates.longitude === "number" &&
    typeof coordinates.latitude === "number"
  ) {
    if (coordinates.longitude < minLng) minLng = coordinates.longitude;
    if (coordinates.latitude < minLat) minLat = coordinates.latitude;
    if (coordinates.longitude > maxLng) maxLng = coordinates.longitude;
    if (coordinates.latitude > maxLat) maxLat = coordinates.latitude;
    hasBounds = true;
  }

  if (hasBounds) {
    // Prevent degenerate bounds (point) from causing NaN zoom
    if (minLng === maxLng && minLat === maxLat) {
      minLng -= 0.05;
      maxLng += 0.05;
      minLat -= 0.05;
      maxLat += 0.05;
    }

    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      {
        padding: { top: 30, bottom: 30, left: 300, right: 30 },
        essential: true,
        maxZoom: zoom,
      },
    );
  }

  return hasBounds;
}

// ─── Re-exports from modular map sub-modules ─────────────────────────────────
export {
  addEpicenterMarker,
  removeEpicenterMarker,
  displayEpicenter,
  clearEpicenter,
  displayAllEpicenters,
  clearAllEpicenters,
} from "./map/mapMarkers.js";

export {
  setCustomHomeCoordinates,
  getCustomHomeCoordinates,
  addHomeMarker,
  removeHomeMarker,
  displayHomeMarker,
  clearHomeMarker,
  findIntensityForCity,
  findCityInfoForCode,
  displayHomeLocationIntensity,
  hideHomeLocationIntensity,
} from "./map/homeLocation.js";

