import * as maplibregl from "maplibre-gl";
import { INTENSITY_CONFIG } from "../constants.js";

/**
 * Creates and attaches the active report's epicenter marker on the map.
 * @param {maplibregl.Map} map
 * @param {{latitude: number, longitude: number}} coordinates
 * @returns {maplibregl.Marker|null}
 */
export function addEpicenterMarker(map, coordinates) {
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
export function removeEpicenterMarker(map) {
  if (map._epicenterMarker) {
    map._epicenterMarker.remove();
    map._epicenterMarker = null;
  }
}

/**
 * Displays an epicenter marker at the given coordinates.
 */
export function displayEpicenter(map, coordinates) {
  return addEpicenterMarker(map, coordinates);
}

/**
 * Removes the epicenter marker from the map.
 * @param {maplibregl.Map} map
 */
export function clearEpicenter(map) {
  removeEpicenterMarker(map);
}

/**
 * Displays all epicenters on the map colorized by their intensity.
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

    const intensityConfig = (report.maxIntensity && INTENSITY_CONFIG[report.maxIntensity]) || {
      color: "#1e2e44",
    };

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
 * Clears all initial epicenters from the map.
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
