import * as maplibregl from "maplibre-gl";

export const EPICENTER_BOX_SOURCE_ID = "epicenter-box";
export const EPICENTER_BOX_LAYER_ID = "epicenter-box-line";

/**
 * Determines coordinate accuracy (decimal places).
 * Prefers explicitly stored `coordinates.accuracy`.
 * Otherwise infers from the decimal representation of latitude and longitude.
 *
 * @param {{latitude: number, longitude: number, accuracy?: number}|null} coordinates
 * @returns {number|null} Number of decimal places (e.g. 1, 2, 3), or null
 */
export function getCoordinateAccuracy(coordinates) {
  if (!coordinates) return null;
  if (typeof coordinates.accuracy === "number") {
    return coordinates.accuracy;
  }

  const getDigits = (val) => {
    if (val === null || val === undefined || Number.isNaN(val)) return 0;
    const s = String(val);
    if (s.includes("e-")) {
      const [base, exp] = s.split("e-");
      const baseDec = (base.split(".")[1] || "").length;
      return baseDec + Number.parseInt(exp, 10);
    }
    const dot = s.indexOf(".");
    return dot === -1 ? 0 : s.length - dot - 1;
  };

  const latDigits = getDigits(coordinates.latitude);
  const lonDigits = getDigits(coordinates.longitude);
  return Math.max(latDigits, lonDigits);
}

/**
 * Calculates the bounding box polygon and zoom visibility threshold
 * for an epicenter based on coordinate accuracy.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} accuracy - Number of decimal digits (1, 2, 3)
 * @returns {{
 *   minLat: number,
 *   maxLat: number,
 *   minLng: number,
 *   maxLng: number,
 *   minzoom: number,
 *   coordinates: number[][][]
 * } | null}
 */
export function calculateEpicenterAccuracyBox(latitude, longitude, accuracy) {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    Number.isNaN(latitude) ||
    Number.isNaN(longitude)
  ) {
    return null;
  }

  if (typeof accuracy !== "number" || accuracy < 1 || accuracy >= 4) {
    return null;
  }

  // Delta calculation:
  // 1 digit: ±0.05
  // 2 digits: ±0.005
  // 3 digits: ±0.0005
  const delta = 0.5 * Math.pow(10, -accuracy);
  const decimals = accuracy + 1;

  const minLat = Number((latitude - delta).toFixed(decimals));
  const maxLat = Number((latitude + delta).toFixed(decimals));
  const minLng = Number((longitude - delta).toFixed(decimals));
  const maxLng = Number((longitude + delta).toFixed(decimals));

  // Zoom visibility threshold:
  const minzoom = 7.5 + accuracy * 0.5;

  // Closed GeoJSON Polygon ring: [[lon, lat], ...]
  const coordinates = [
    [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat],
    ],
  ];

  return {
    minLat,
    maxLat,
    minLng,
    maxLng,
    minzoom,
    coordinates,
  };
}

/**
 * Ensures the epicenter accuracy box GeoJSON source and layer exist on the map.
 * @param {maplibregl.Map} map
 */
export function ensureEpicenterBoxLayers(map) {
  if (!map?.getSource) return;

  if (!map.getSource(EPICENTER_BOX_SOURCE_ID)) {
    map.addSource(EPICENTER_BOX_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer(EPICENTER_BOX_LAYER_ID)) {
    map.addLayer({
      id: EPICENTER_BOX_LAYER_ID,
      type: "line",
      source: EPICENTER_BOX_SOURCE_ID,
      minzoom: 10,
      paint: {
        "line-color": "#74849a",
        "line-width": 1.5,
        "line-dasharray": [3, 4],
      },
    });
  }
}

/**
 * Updates or clears the epicenter accuracy box on the map.
 * @param {maplibregl.Map} map
 * @param {Object|null} box - Result from calculateEpicenterAccuracyBox, or null
 */
export function updateEpicenterBox(map, box) {
  if (!map) return;

  const apply = () => {
    try {
      ensureEpicenterBoxLayers(map);
      const source = map.getSource(EPICENTER_BOX_SOURCE_ID);
      if (!source) return;

      if (!box) {
        source.setData({
          type: "FeatureCollection",
          features: [],
        });
        return;
      }

      source.setData({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: box.coordinates,
            },
            properties: {
              minzoom: box.minzoom,
            },
          },
        ],
      });

      if (map.getLayer(EPICENTER_BOX_LAYER_ID)) {
        map.setLayerZoomRange(EPICENTER_BOX_LAYER_ID, box.minzoom, 24);
      }
    } catch (err) {
      console.error("[eq-viewer] Error updating epicenter box:", err);
    }
  };

  if (map.isStyleLoaded()) {
    apply();
  } else {
    map.once("load", apply);
  }
}

/**
 * Clears the epicenter accuracy box from the map.
 * @param {maplibregl.Map} map
 */
export function clearEpicenterBox(map) {
  updateEpicenterBox(map, null);
}

/**
 * Creates and attaches the active report's epicenter marker on the map.
 * Also displays the dashed coordinate accuracy box when accuracy is 1 to 3 digits.
 * @param {maplibregl.Map} map
 * @param {{latitude: number, longitude: number, accuracy?: number}} coordinates
 * @returns {maplibregl.Marker|null}
 */
export function addEpicenterMarker(map, coordinates) {
  if (
    !coordinates ||
    typeof coordinates.latitude !== "number" ||
    typeof coordinates.longitude !== "number"
  ) {
    removeEpicenterMarker(map);
    return null;
  }

  // Remove existing epicenter marker if any
  if (map._epicenterMarker) {
    map._epicenterMarker.remove();
  }

  // Display accuracy box if applicable (1 to 3 digit accuracy)
  const accuracy = getCoordinateAccuracy(coordinates);
  const box = accuracy !== null
    ? calculateEpicenterAccuracyBox(coordinates.latitude, coordinates.longitude, accuracy)
    : null;
  updateEpicenterBox(map, box);

  if (typeof document === "undefined") {
    return null;
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
 * Removes the epicenter marker and accuracy box from the map.
 * @param {maplibregl.Map} map
 */
export function removeEpicenterMarker(map) {
  if (map._epicenterMarker) {
    map._epicenterMarker.remove();
    map._epicenterMarker = null;
  }
  clearEpicenterBox(map);
}

/**
 * Displays an epicenter marker at the given coordinates.
 */
export function displayEpicenter(map, coordinates) {
  return addEpicenterMarker(map, coordinates);
}

/**
 * Removes the epicenter marker and accuracy box from the map.
 * @param {maplibregl.Map} map
 */
export function clearEpicenter(map) {
  removeEpicenterMarker(map);
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
