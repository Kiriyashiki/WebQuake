import * as maplibregl from "maplibre-gl";
import { INTENSITY_CONFIG } from "../constants.js";
import { renderIntensityBadge } from "../intensityBadge.js";

let customHomeCoordinates = null;

/**
 * Sets custom coordinates for the home marker (in-memory only).
 * @param {Array<number>|null} coords - [lon, lat] or null
 */
export function setCustomHomeCoordinates(coords) {
  customHomeCoordinates = Array.isArray(coords) && coords.length >= 2 ? coords : null;
}

/**
 * Gets custom coordinates for the home marker.
 * @returns {Array<number>|null}
 */
export function getCustomHomeCoordinates() {
  return customHomeCoordinates;
}

/**
 * Creates and adds the home location marker to the map.
 * @param {maplibregl.Map} map
 * @param {string} cityCode - The city code (7-digit string)
 * @param {Object} featureBounds - The loaded bounds.json object
 * @returns {maplibregl.Marker|null}
 */
export function addHomeMarker(map, cityCode, featureBounds) {
  if (!cityCode) {
    return null;
  }

  if (map._homeMarker) {
    map._homeMarker.remove();
  }

  let centerLng, centerLat;
  if (customHomeCoordinates) {
    [centerLng, centerLat] = customHomeCoordinates;
  } else {
    if (!featureBounds?.cities) return null;
    const bounds = featureBounds.cities[cityCode];
    if (!bounds) {
      return null;
    }
    centerLng = (bounds[0] + bounds[2]) / 2;
    centerLat = (bounds[1] + bounds[3]) / 2;
  }

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
export function removeHomeMarker(map) {
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

/**
 * Finds the intensity for a given city code in the observations.
 * @param {Array} observations - From JMAEarthquakeReport.observations
 * @param {string} cityCode - The city code (7-digit string)
 * @returns {string|null} The intensity string (e.g., "5+", "4") or null
 */
export function findIntensityForCity(observations, cityCode) {
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
export function findCityInfoForCode(cityCode, observations, cityNames) {
  if (!observations || !cityCode) return null;

  if (cityNames) {
    const cityData = cityNames.get(cityCode);
    if (cityData) {
      return { ja: cityData.ja, en: cityData.en };
    }
  }

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

  display.querySelector(".tooltip-ja").textContent = cityInfo.ja;
  display.querySelector(".tooltip-en").textContent = cityInfo.en;

  const intensity = findIntensityForCity(observations, cityCode);
  const intensityContainer = display.querySelector(".tooltip-intensity-container");

  const hasIntensity = Boolean(intensity && intensity !== "0" && INTENSITY_CONFIG[intensity]);
  const displayIntensity = hasIntensity ? intensity : "0";
  const config = INTENSITY_CONFIG[displayIntensity] || INTENSITY_CONFIG[0];

  if (intensityContainer) {
    renderIntensityBadge(intensityContainer, displayIntensity, {
      title: hasIntensity ? `Intensity: ${intensity}` : undefined,
    });
    intensityContainer.classList.remove("hidden");
  }

  display.style.borderTopColor = config.color;
  display.querySelector(".tooltip-code").style.color = config.color;

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
