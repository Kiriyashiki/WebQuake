/**
 * Initialises the MapLibre GL map, loads GeoJSON layers, and wires up
 * the forecast-area hover tooltip.
 */
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { INTENSITY_CONFIG, MAP_COLORS, buildIntensityColorExpression } from "./constants.js";

// ─── Build the MapLibre style object ────────────────────────────────────────
function buildStyle(useCityAreas = true) {
  const C = MAP_COLORS;
  
  return {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      world: {
        type: "geojson",
        data: "/world.geojson",
      },
      forecast_areas: {
        type: "geojson",
        data: "/forecast_areas.geojson",
        // Promote the 'code' property as the feature id so setFeatureState works.
        promoteId: "code",
      },
      prefectures: {
        type: "geojson",
        data: "/prefectures.geojson",
      },
      cities: {
        type: "geojson",
        data: "/municipalities.geojson",
        promoteId: "regioncode",
      },
    },
    layers: [
      // Ocean / void background
      {
        id: "background",
        type: "background",
        paint: { "background-color": C.ocean },
      },

      // ── World countries (everything except Japan) ──────────────────────────
      {
        id: "world-fill",
        type: "fill",
        source: "world",
        paint: {
          "fill-color": C.land,
          "fill-antialias": true,
        },
      },
      {
        id: "world-line",
        type: "line",
        source: "world",
        paint: {
          "line-color": C.worldLine,
          "line-width": 0.6,
        },
      },

      // ── JMA forecast areas (Japan landmass) ───────────────────────────────
      {
        id: "forecast-base",
        type: "fill",
        source: "forecast_areas",
        paint: {
          "fill-color": C.japan,
          "fill-antialias": true,
        },
      },
      {
        id: "cities-base",
        type: "fill",
        source: "cities",
        layout: { visibility: useCityAreas ? 'visible' : 'none' },
        paint: {
          "fill-color": "transparent",
          "fill-antialias": false,
        },
      },
      {
        id: "prefecture-line",
        type: "line",
        source: "prefectures",
        paint: {
          "line-color": C.prefectureLine,
          "line-width": 0.8,
        },
      },
      {
        id: "forecast-fill",
        type: "fill",
        source: "forecast_areas",
        layout: { visibility: !useCityAreas ? 'visible' : 'none' },
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            [
              "case",
              ["boolean", ["feature-state", "hover"], false],
              // Highlighted + hovered: lighter intensity color
              [
                "coalesce",
                buildIntensityColorExpression(false),
                "transparent",
              ],
              // Highlighted + not hovered: intensity color at 40% opacity
              buildIntensityColorExpression(true),
            ],
            // Not highlighted
            "transparent",
          ],
          "fill-antialias": true,
        },
      },
      {
        id: "cities-fill",
        type: "fill",
        source: "cities",
        layout: { visibility: useCityAreas ? 'visible' : 'none' },
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            [
              "case",
              ["boolean", ["feature-state", "hover"], false],
              [
                "coalesce",
                buildIntensityColorExpression(false),
                "transparent",
              ],
              buildIntensityColorExpression(true),
            ],
            "transparent",
          ],
          "fill-antialias": true,
        },
      },
      {
        id: "cities-line",
        type: "line",
        source: "cities",
        layout: { visibility: useCityAreas ? 'visible' : 'none' },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            buildIntensityColorExpression(false, "#172538"),
            ["case", ["boolean", ["feature-state", "hover"], false], C.japanLine, "#172538"],
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            0.4,
            ["case", ["boolean", ["feature-state", "hover"], false], 1.2, 0.4],
          ],
        },
      },
      {
        id: "forecast-line",
        type: "line",
        source: "forecast_areas",
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            buildIntensityColorExpression(false, C.japanLine),
            ["case", ["boolean", ["feature-state", "hover"], false], "#2b4262", C.japanLine],
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            1,
            ["case", ["boolean", ["feature-state", "hover"], false], 1.4, 0.7],
          ],
        },
      },
    ],
  };
}

// ─── Tooltip helpers ─────────────────────────────────────────────────────────
function showTooltip(tooltip, x, y, code, info, intensity = null, isCity = false) {
  const codeEl = tooltip.querySelector(".tooltip-code");
  codeEl.textContent = isCity ? `CITY ${code}` : `AREA ${code}`;
  tooltip.querySelector(".tooltip-ja").textContent = info?.ja ?? "—";
  tooltip.querySelector(".tooltip-en").textContent = info?.en ?? "";

  // Update intensity display if available
  const intensityContainer = tooltip.querySelector(".tooltip-intensity-container");
  if (intensity && INTENSITY_CONFIG[intensity]) {
    const config = INTENSITY_CONFIG[intensity];
    const img = intensityContainer.querySelector("img");
    img.src = `/img/shindo/${config.img}`;
    img.alt = `Intensity ${intensity}`;
    img.title = `Intensity: ${intensity}`;
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

// ─── Epicenter marker helpers ────────────────────────────────────────────────
/**
 * Adds or updates an epicenter marker at the given coordinates.
 * @param {maplibregl.Map} map
 * @param {{latitude: number, longitude: number}} coordinates
 * @returns {maplibregl.Marker}
 */
function addEpicenterMarker(map, coordinates) {
  if (
    !coordinates ||
    typeof coordinates.latitude !== "number" ||
    typeof coordinates.longitude !== "number"
  ) {
    return null;
  }

  // Remove existing epicenter marker if any
  if (map._epicenterMarker) {
    map._epicenterMarker.remove();
  }

  // Create marker element
  const markerEl = document.createElement("div");
  markerEl.className = "epicenter-marker";
  markerEl.innerHTML = `<img src="/img/epicenter.png" alt="Epicenter" title="Epicenter" />`;

  const marker = new maplibregl.Marker({ element: markerEl })
    .setLngLat([coordinates.longitude, coordinates.latitude])
    .addTo(map);

  map._epicenterMarker = marker;
  return marker;
}

/**
 * Removes the epicenter marker from the map.
 * @param {maplibregl.Map} map
 */
function removeEpicenterMarker(map) {
  if (map._epicenterMarker) {
    map._epicenterMarker.remove();
    map._epicenterMarker = null;
  }
}

// ─── Main map factory ────────────────────────────────────────────────────────
/**
 * @param {HTMLElement} container  - The #map element.
 * @param {Map<number, {ja:string, en:string}>} areaCodes
 * @param {Map<string, {ja:string, en:string}>} cityNames
 * @param {Function} getUseCityAreas - Returns current state of city areas toggle
 * @returns {maplibregl.Map}
 */
export function initMap(container, areaCodes, cityNames, getUseCityAreas = () => true) {
  const map = new maplibregl.Map({
    container,
    style: buildStyle(getUseCityAreas()),
    center: [137, 37.5], // Centre on Japan
    zoom: 4.4,
    minZoom: 2,
    maxZoom: 10,
    attributionControl: false,
    pitchWithRotate: false,
  });

  const tooltip = document.getElementById("area-tooltip");
  let hoveredId = null;

  // ── Wire hover interactions once the style is ready ──────────────────────
  map.on("load", () => {
    const canvas = map.getCanvas();

    const layers = ["forecast-base", "cities-base"];

    layers.forEach(layerName => {
      const isCityLayer = layerName === "cities-base";
      const sourceName = isCityLayer ? "cities" : "forecast_areas";

      // ── Mouse move on areas ──────────────────────────────────────
      map.on("mousemove", layerName, (e) => {
        if (isCityLayer !== getUseCityAreas()) return;

        canvas.style.cursor = "crosshair";

        const feature = e.features[0];
        if (!feature) return;

        const newId = feature.id; // promoted from property
        if (newId === hoveredId) {
          // Just update tooltip position with current intensity
          const state = map.getFeatureState({ source: sourceName, id: newId });
          showTooltip(
            tooltip,
            e.originalEvent.clientX - container.getBoundingClientRect().left,
            e.originalEvent.clientY - container.getBoundingClientRect().top,
            newId,
            isCityLayer ? cityNames?.get(String(newId)) : areaCodes.get(Number(newId)),
            state?.intensity,
            isCityLayer
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
          e.originalEvent.clientX - container.getBoundingClientRect().left,
          e.originalEvent.clientY - container.getBoundingClientRect().top,
          hoveredId,
          isCityLayer ? cityNames?.get(String(hoveredId)) : areaCodes.get(Number(hoveredId)),
          state?.intensity,
          isCityLayer
        );
      });

      // ── Mouse leave ──────────────────────────────────────────────────────
      map.on("mouseleave", layerName, () => {
        if (isCityLayer !== getUseCityAreas()) return;
        
        canvas.style.cursor = "";

        if (hoveredId !== null) {
          map.setFeatureState({ source: sourceName, id: hoveredId }, { hover: false });
          hoveredId = null;
        }

        hideTooltip(tooltip);
      });
    });
  });

  return map;
}

/**
 * Updates the visibility of city areas vs forecast areas layers.
 * @param {maplibregl.Map} map 
 * @param {boolean} useCityAreas 
 */
export function updateCityAreasVisibility(map, useCityAreas) {
  if (!map.isStyleLoaded()) return;

  const visibility = useCityAreas ? 'visible' : 'none';
  const invVisibility = !useCityAreas ? 'visible' : 'none';

  map.setLayoutProperty("cities-base", "visibility", visibility);
  map.setLayoutProperty("cities-fill", "visibility", visibility);
  map.setLayoutProperty("cities-line", "visibility", visibility);
  
  map.setLayoutProperty("forecast-fill", "visibility", invVisibility);
}

/**
 * Highlight the forecast areas that appear in a given earthquake's observation
 * list, colour-coded by intensity. Pass null to clear.
 *
 * @param {maplibregl.Map} map
 * @param {Array|null} observations  - Parsed observations from JMAEarthquakeReport
 */
export function highlightObservations(map, observations) {
  if (!map.isStyleLoaded()) return;

  // Reset every currently highlighted feature first
  // MapLibre does not provide a bulk-reset, so we track them.
  highlightObservations._active?.forEach(({ source, id }) => {
    map.setFeatureState({ source, id }, { intensity: null, highlighted: false });
  });
  highlightObservations._active = [];

  if (!observations) return;

  for (const pref of observations) {
    for (const area of pref.areas) {
      // Highlight forecast areas
      const areaId = area.code;
      map.setFeatureState(
        { source: "forecast_areas", id: areaId },
        { highlighted: true, intensity: area.maxInt },
      );
      highlightObservations._active.push({ source: "forecast_areas", id: areaId });

      // Highlight city areas
      for (const city of area.cities) {
        const cityId = String(city.code).padStart(7, "0");
        map.setFeatureState(
          { source: "cities", id: cityId },
          { highlighted: true, intensity: city.maxInt },
        );
        highlightObservations._active.push({ source: "cities", id: cityId });
      }
    }
  }
}

/**
 * Display an epicenter marker on the map.
 * @param {maplibregl.Map} map
 * @param {{latitude: number, longitude: number}} coordinates
 * @returns {maplibregl.Marker|null}
 */
export function displayEpicenter(map, coordinates) {
  return addEpicenterMarker(map, coordinates);
}

/**
 * Fits the map bounds to all observation areas with intensity 1 or higher.
 * @param {maplibregl.Map} map
 * @param {Array|null} observations
 * @param {Object} featureBounds - The loaded bounds.json object
 * @param {boolean} useCityAreas
 * @param {{latitude: number, longitude: number}} [coordinates]
 */
export function fitBoundsToObservations(map, observations, featureBounds, useCityAreas, coordinates) {
  if (!map.isStyleLoaded() || !observations || !featureBounds) return;

  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  let hasBounds = false;

  for (const pref of observations) {
    for (const area of pref.areas) {
      if (useCityAreas) {
        for (const city of area.cities) {
          if (Number.parseInt(city.maxInt, 10) >= 1) {
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
      } else if (Number.parseInt(area.maxInt, 10) >= 1) {
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

  if (coordinates && typeof coordinates.longitude === "number" && typeof coordinates.latitude === "number") {
    if (coordinates.longitude < minLng) minLng = coordinates.longitude;
    if (coordinates.latitude < minLat) minLat = coordinates.latitude;
    if (coordinates.longitude > maxLng) maxLng = coordinates.longitude;
    if (coordinates.latitude > maxLat) maxLat = coordinates.latitude;
    hasBounds = true;
  }

  if (hasBounds) {
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
      padding: 50,
      essential: true,
      maxZoom: 8
    });
  }
  
  return hasBounds;
}

/**
 * Remove the epicenter marker from the map.
 * @param {maplibregl.Map} map
 */
export function clearEpicenter(map) {
  removeEpicenterMarker(map);
}

/**
 * Display all epicenters on the map colorized by their intensity.
 * @param {maplibregl.Map} map
 * @param {Array} reports
 */
export function displayAllEpicenters(map, reports) {
  clearAllEpicenters(map);
  map._allEpicenters = [];

  if (!reports) return;

  for (const report of reports) {
    if (!report.coordinates) continue;

    const markerEl = document.createElement("div");
    markerEl.className = "epicenter-all-marker";

    const intensityConfig = INTENSITY_CONFIG[report.maxIntensity] || INTENSITY_CONFIG["1"];

    // Use CSS mask to colorize the bw epicenter image
    markerEl.style.width = "24px";  
    markerEl.style.height = "24px";
    markerEl.style.backgroundColor = intensityConfig.color;
    markerEl.style.maskImage = "url(/img/epicenter-bw.png)";
    markerEl.style.webkitMaskImage = "url(/img/epicenter-bw.png)";
    markerEl.style.maskSize = "contain";
    markerEl.style.webkitMaskSize = "contain";
    markerEl.style.maskRepeat = "no-repeat";
    markerEl.style.webkitMaskRepeat = "no-repeat";
    markerEl.style.maskPosition = "center";
    markerEl.style.webkitMaskPosition = "center";
    markerEl.style.cursor = "pointer";

    // When clicking an epicenter, emulate clicking the sidebar entry
    markerEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const el = document.querySelector(`.eq-item[data-event-id="${report.eventId}"]`);
      if (el) {
        el.click();
      }
    });

    const marker = new maplibregl.Marker({ element: markerEl })
      .setLngLat([report.coordinates.longitude, report.coordinates.latitude])
      .addTo(map);

    map._allEpicenters.push(marker);
  }
}

/**
 * Clear all initial epicenters from the map.
 * @param {maplibregl.Map} map
 */
export function clearAllEpicenters(map) {
  if (map._allEpicenters) {
    for (const marker of map._allEpicenters) {
      marker.remove();
    }
    map._allEpicenters = [];
  }
}
