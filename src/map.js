/**
 * Initialises the MapLibre GL map, loads GeoJSON layers, and wires up
 * the forecast-area hover tooltip.
 */
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { INTENSITY_CONFIG, MAP_COLORS, buildIntensityColorExpression } from "./constants.js";

// ─── Build the MapLibre style object ────────────────────────────────────────
function buildStyle() {
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
            1.2,
            ["case", ["boolean", ["feature-state", "hover"], false], 1.4, 0.7],
          ],
        },
      },
    ],
  };
}

// ─── Tooltip helpers ─────────────────────────────────────────────────────────
function showTooltip(tooltip, x, y, code, info, intensity = null) {
  const codeEl = tooltip.querySelector(".tooltip-code");
  codeEl.textContent = `AREA ${code}`;
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
 * @returns {maplibregl.Map}
 */
export function initMap(container, areaCodes) {
  const map = new maplibregl.Map({
    container,
    style: buildStyle(),
    center: [137, 37.5], // Centre on Japan
    zoom: 4.4,
    minZoom: 2,
    maxZoom: 14,
    attributionControl: false,
    pitchWithRotate: false,
  });

  const tooltip = document.getElementById("area-tooltip");
  let hoveredId = null;

  // ── Wire hover interactions once the style is ready ──────────────────────
  map.on("load", () => {
    const canvas = map.getCanvas();

    // ── Mouse move on forecast areas ──────────────────────────────────────
    map.on("mousemove", "forecast-base", (e) => {
      canvas.style.cursor = "crosshair";

      const feature = e.features[0];
      if (!feature) return;

      const newId = feature.id; // promoted from 'code' property
      if (newId === hoveredId) {
        // Just update tooltip position with current intensity
        const state = map.getFeatureState({ source: "forecast_areas", id: newId });
        showTooltip(
          tooltip,
          e.originalEvent.clientX - container.getBoundingClientRect().left,
          e.originalEvent.clientY - container.getBoundingClientRect().top,
          newId,
          areaCodes.get(Number(newId)),
          state?.intensity,
        );
        return;
      }

      // Clear old hover state
      if (hoveredId !== null) {
        map.setFeatureState({ source: "forecast_areas", id: hoveredId }, { hover: false });
      }

      hoveredId = newId;

      map.setFeatureState({ source: "forecast_areas", id: hoveredId }, { hover: true });

      const state = map.getFeatureState({ source: "forecast_areas", id: hoveredId });
      showTooltip(
        tooltip,
        e.originalEvent.clientX - container.getBoundingClientRect().left,
        e.originalEvent.clientY - container.getBoundingClientRect().top,
        hoveredId,
        areaCodes.get(Number(hoveredId)),
        state?.intensity,
      );
    });

    // ── Mouse leave ──────────────────────────────────────────────────────
    map.on("mouseleave", "forecast-base", () => {
      canvas.style.cursor = "";

      if (hoveredId !== null) {
        map.setFeatureState({ source: "forecast_areas", id: hoveredId }, { hover: false });
        hoveredId = null;
      }

      hideTooltip(tooltip);
    });
  });

  return map;
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
      const id = area.code;
      map.setFeatureState(
        { source: "forecast_areas", id },
        { highlighted: true, intensity: area.maxInt },
      );
      highlightObservations._active.push({ source: "forecast_areas", id });
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
  map.flyTo({
    center: [coordinates.longitude, coordinates.latitude],
    zoom: 6,
    essential: true,
  });
  return addEpicenterMarker(map, coordinates);
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
