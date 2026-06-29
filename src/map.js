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
        id: "cities-line-bg",
        type: "line",
        source: "cities",
        layout: { visibility: useCityAreas ? 'visible' : 'none' },
        paint: {
          "line-color": C.cityLine,
          "line-width": 0.4,
        },
      },
      {
        id: "forecast-line-bg",
        type: "line",
        source: "forecast_areas",
        paint: {
          "line-color": C.forecastLine,
          "line-width": 0.6,
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
        layout: { visibility: useCityAreas ? 'none' : 'visible' },
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
            buildIntensityColorExpression(false, C.cityLine),
            ["case", ["boolean", ["feature-state", "hover"], false], C.japanLine, "#172538"],
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            0.4,
            ["case", ["boolean", ["feature-state", "hover"], false], 1.4, 0],
          ],
        },
      },
      {
        id: "forecast-line",
        type: "line",
        source: "forecast_areas",
        layout: { visibility: useCityAreas ? 'none' : 'visible' },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            buildIntensityColorExpression(false, C.forecastLine),
            ["case", ["boolean", ["feature-state", "hover"], false], "#2b4262", C.japanLine],
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            1,
            ["case", ["boolean", ["feature-state", "hover"], false], 1.6, 0],
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

    const layers = ["forecast-fill", "cities-fill"];

    layers.forEach(layerName => {
      const isCityLayer = layerName === "cities-fill";
      const sourceName = isCityLayer ? "cities" : "forecast_areas";

      // ── Mouse move on areas ──────────────────────────────────────
      map.on("mousemove", layerName, (e) => {
        if (isCityLayer !== getUseCityAreas()) return;

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
  const invVisibility = useCityAreas ? 'none' : 'visible';

  map.setLayoutProperty("cities-fill", "visibility", visibility);
  map.setLayoutProperty("cities-line", "visibility", visibility);
  map.setLayoutProperty("cities-line-bg", "visibility", visibility);
  
  map.setLayoutProperty("forecast-fill", "visibility", invVisibility);
  map.setLayoutProperty("forecast-line", "visibility", invVisibility);
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
 * @param {string} maxInt
 * @param {{latitude: number, longitude: number}} [coordinates]
 */
export function fitBoundsToObservations(map, observations, featureBounds, useCityAreas, maxInt, coordinates) {
  if (!map.isStyleLoaded() || !observations || !featureBounds) return;

  if (document.getElementById('map-container').offsetWidth <= 250) {
    return false;
  }

  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
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

  if (coordinates && typeof coordinates.longitude === "number" && typeof coordinates.latitude === "number") {
    if (coordinates.longitude < minLng) minLng = coordinates.longitude;
    if (coordinates.latitude < minLat) minLat = coordinates.latitude;
    if (coordinates.longitude > maxLng) maxLng = coordinates.longitude;
    if (coordinates.latitude > maxLat) maxLat = coordinates.latitude;
    hasBounds = true;
  }

  if (hasBounds) {
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
      padding: {top: 30, bottom:30, left: 150, right: 30},
      essential: true,
      maxZoom: 7.5
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

// ─── Home Location marker helpers ────────────────────────────────────────────
/**
 * Adds or updates the home location marker at the center of a city bounds.
 * @param {maplibregl.Map} map
 * @param {string} cityCode - The city code (7-digit string)
 * @param {Object} featureBounds - The loaded bounds.json object
 * @returns {maplibregl.Marker|null}
 */
function addHomeMarker(map, cityCode, featureBounds) {
  if (!cityCode || !featureBounds?.cities) {
    return null;
  }

  const bounds = featureBounds.cities[cityCode];
  if (!bounds) {
    return null;
  }

  // Calculate center of bounds: [minLng, minLat, maxLng, maxLat]
  const centerLng = (bounds[0] + bounds[2]) / 2;
  const centerLat = (bounds[1] + bounds[3]) / 2;

  // Remove existing home marker if any
  if (map._homeMarker) {
    map._homeMarker.remove();
  }

  // Create marker element
  const markerEl = document.createElement("div");
  markerEl.className = "home-marker";
  markerEl.innerHTML = `<img src="/img/home.png" alt="Home" title="Home Location · ホーム場所" />`;

  const marker = new maplibregl.Marker({ element: markerEl })
    .setLngLat([centerLng, centerLat])
    .addTo(map);

  map._homeMarker = marker;
  return marker;
}

/**
 * Removes the home location marker from the map.
 * @param {maplibregl.Map} map
 */
function removeHomeMarker(map) {
  if (map._homeMarker) {
    map._homeMarker.remove();
    map._homeMarker = null;
  }
}

/**
 * Display or update the home location marker on the map.
 * @param {maplibregl.Map} map
 * @param {string} cityCode - The city code (7-digit string)
 * @param {Object} featureBounds - The loaded bounds.json object
 * @returns {maplibregl.Marker|null}
 */
export function displayHomeMarker(map, cityCode, featureBounds) {
  return addHomeMarker(map, cityCode, featureBounds);
}

/**
 * Remove the home location marker from the map.
 * @param {maplibregl.Map} map
 */
export function clearHomeMarker(map) {
  removeHomeMarker(map);
}

// ─── Home Location Intensity Display helpers ────────────────────────────────
/**
 * Finds the intensity for a given city code in the observations.
 * @param {Array} observations - From JMAEarthquakeReport.observations
 * @param {string} cityCode - The city code (7-digit string)
 * @returns {string|null} The intensity string (e.g., "5+", "4") or null
 */
function findIntensityForCity(observations, cityCode) {
  if (!observations || !cityCode) return null;

  for (const pref of observations) {
    for (const area of pref.areas) {
      for (const city of area.cities) {
        const cityCodeStr = String(city.code).padStart(7, "0");
        if (cityCodeStr === cityCode) {
          return city.maxInt || null;
        }
      }
    }
  }

  return null;
}

/**
 * Finds the city name information for a given city code.
 * @param {string} cityCode - The city code (7-digit string)
 * @param {Array} observations - From JMAEarthquakeReport.observations
 * @param {Map} cityNames - City name mappings
 * @returns {{ja: string, en: string}|null}
 */
function findCityInfoForCode(cityCode, observations, cityNames) {
  if (!observations || !cityCode) return null;

  // First try to get from cityNames map
  if (cityNames) {
    const cityData = cityNames.get(cityCode);
    if (cityData) {
      return { ja: cityData.ja, en: cityData.en };
    }
  }

  // Fallback to finding in observations
  for (const pref of observations) {
    for (const area of pref.areas) {
      for (const city of area.cities) {
        const cityCodeStr = String(city.code).padStart(7, "0");
        if (cityCodeStr === cityCode) {
          return { ja: city.name, en: city.name };
        }
      }
    }
  }

  return null;
}

/**
 * Display the home location intensity in a fixed box above the legend.
 * @param {string} cityCode - The city code (7-digit string)
 * @param {Array} observations - From JMAEarthquakeReport.observations
 * @param {Map} cityNames - City name mappings
 */
export function displayHomeLocationIntensity(cityCode, observations, cityNames) {
  const display = document.getElementById("home-intensity-display");
  if (!display) return;

  const cityInfo = findCityInfoForCode(cityCode, observations, cityNames);
  if (!cityInfo) {
    display.classList.add("hidden");
    return;
  }

  // Update content
  display.querySelector(".tooltip-ja").textContent = cityInfo.ja;
  display.querySelector(".tooltip-en").textContent = cityInfo.en;

  // Update intensity display (may be null if no observation recorded)
  const intensity = findIntensityForCity(observations, cityCode);
  const intensityContainer = display.querySelector(".tooltip-intensity-container");
  
  if (intensity && INTENSITY_CONFIG[intensity]) {
    const config = INTENSITY_CONFIG[intensity];
    const img = intensityContainer.querySelector("img");
    if (img) {
      img.style.display = "";
      img.src = `/img/shindo/${config.img}`;
      img.alt = `Intensity ${intensity}`;
      img.title = `Intensity: ${intensity}`;
    }

    // Hide any placeholder if present
    const placeholder = intensityContainer.querySelector(".tooltip-intensity-placeholder");
    if (placeholder) placeholder.style.display = "none";

    intensityContainer.classList.remove("hidden");

    display.style.borderTopColor = config.color;
    display.querySelector(".tooltip-code").style.color = config.color;
  } else {
    // No intensity recorded for this location — show a placeholder box with '-'
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

/**
 * Hide the home location intensity display.
 */
export function hideHomeLocationIntensity() {
  const display = document.getElementById("home-intensity-display");
  if (display) {
    display.classList.add("hidden");
  }
}
