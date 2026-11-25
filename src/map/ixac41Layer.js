/**
 * MapLibre raster overlay for the IXAC41 250 m estimated intensity mesh.
 */

import { INTENSITY_CONFIG, MAP_COLORS } from "../constants.js";
import { shindoFromIntensity } from "../ixac41/parser.js";

const SOURCE_ID = "ixac41-mesh";
const LAYER_ID = "ixac41-mesh-layer";
const MAX_CANVAS_SIZE = 4096;

const BOUNDARY_LAYERS = {
  forecast: {
    id: "ixac41-forecast-line",
    source: "forecast_areas",
    color: MAP_COLORS.forecastLine,
    width: 0.6,
  },
  cities: {
    id: "ixac41-cities-line",
    source: "cities",
    color: MAP_COLORS.cityLine,
    width: 0.4,
  },
  prefecture: {
    id: "ixac41-prefecture-line",
    source: "prefectures",
    color: MAP_COLORS.prefectureLine,
    width: 0.8,
  },
};

/**
 * Renders mesh cells into a canvas covering the mesh bounds.
 *
 * @param {Object} mesh Parsed IXAC41 mesh.
 * @returns {{image: HTMLCanvasElement, coordinates: number[][]}|null}
 */
export function buildIxac41Image(mesh) {
  if (!mesh?.cellCount || !mesh.bounds || typeof document === "undefined") return null;

  const { minLat, maxLat, minLon, maxLon } = mesh.bounds;
  const cellLat = mesh.cellSize?.lat || 1 / 480;
  const cellLon = mesh.cellSize?.lon || 1 / 320;
  const cols = Math.max(1, Math.round((maxLon - minLon) / cellLon));
  const rows = Math.max(1, Math.round((maxLat - minLat) / cellLat));
  const scale = Math.min(1, MAX_CANVAS_SIZE / cols, MAX_CANVAS_SIZE / rows);
  const width = Math.max(1, Math.round(cols * scale));
  const height = Math.max(1, Math.round(rows * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = false;

  // MapLibre image sources are interpolated in Web Mercator, not latitude.
  const mercatorY = (lat) =>
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const mercNorth = mercatorY(minLat + rows * cellLat);
  const mercSouth = mercatorY(minLat);
  const mercSpan = mercNorth - mercSouth || 1e-9;
  const scaleX = width / cols;

  for (let i = 0; i < mesh.cellCount; i += 1) {
    const shindo = shindoFromIntensity(mesh.intensity[i], mesh.classes);
    const config = INTENSITY_CONFIG[shindo];
    if (!config) continue;

    // Derive integer grid indices so adjacent cells share exactly the same
    // floating-point boundary. Using the Float32Array coordinates directly can
    // round shared edges differently and leave transparent seams.
    const col = Math.max(
      0,
      Math.min(cols - 1, Math.round((mesh.lon[i] - minLon) / cellLon)),
    );
    const row = Math.max(
      0,
      Math.min(rows - 1, Math.round((mesh.lat[i] - minLat) / cellLat)),
    );

    const southLat = minLat + row * cellLat;
    const northLat = minLat + (row + 1) * cellLat;
    const yTop = ((mercNorth - mercatorY(northLat)) / mercSpan) * height;
    const yBottom = ((mercNorth - mercatorY(southLat)) / mercSpan) * height;

    const x0 = Math.round(col * scaleX);
    const x1 = Math.round((col + 1) * scaleX);
    const y0 = Math.round(yTop);
    const y1 = Math.round(yBottom);

    ctx.fillStyle = config.color;
    ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  }

  return {
    image: canvas,
    coordinates: [
      [minLon, maxLat],
      [maxLon, maxLat],
      [maxLon, minLat],
      [minLon, minLat],
    ],
  };
}

function _ensureLayer(map, coordinates) {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: "image",
      coordinates,
    });
  }

  if (!map.getLayer(LAYER_ID)) {
    const beforeId = map.getLayer("epicenter-box-line")
      ? "epicenter-box-line"
      : undefined;
    map.addLayer(
      {
        id: LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        paint: {
          "raster-opacity": 0.95,
          "raster-resampling": "nearest",
          "raster-fade-duration": 0,
        },
      },
      beforeId,
    );
  }
}

function _ensureBoundaryLayers(map) {
  const beforeId = map.getLayer("epicenter-box-line")
    ? "epicenter-box-line"
    : undefined;

  for (const layer of Object.values(BOUNDARY_LAYERS)) {
    if (map.getLayer(layer.id)) continue;
    map.addLayer(
      {
        id: layer.id,
        type: "line",
        source: layer.source,
        layout: { visibility: "none" },
        paint: {
          "line-color": layer.color,
          "line-width": layer.width,
        },
      },
      beforeId,
    );
  }
}

/**
 * Updates the boundary overlays that sit above the mesh. Forecast-area and
 * prefecture boundaries are always shown; city boundaries follow the Cities
 * toggle.
 */
export function updateIxac41BoundaryVisibility(map, showCityAreas = true) {
  if (!map) return;
  const visibility = {
    forecast: "visible",
    prefecture: "visible",
    cities: showCityAreas ? "visible" : "none",
  };
  for (const [key, layer] of Object.entries(BOUNDARY_LAYERS)) {
    if (map.getLayer(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", visibility[key]);
    }
  }
}

function _hideBoundaryLayers(map) {
  if (!map) return;
  for (const layer of Object.values(BOUNDARY_LAYERS)) {
    if (map.getLayer(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }
}

/**
 * Creates or updates the mesh raster and shows it.
 * @param {maplibregl.Map} map
 * @param {Object} mesh
 */
export function showIxac41Mesh(map, mesh, { cityAreas = true } = {}) {
  if (!map || !mesh) return;

  if (!map.isStyleLoaded()) {
    map.once("idle", () => showIxac41Mesh(map, mesh, { cityAreas }));
    return;
  }

  const rendered = buildIxac41Image(mesh);
  if (!rendered) return;

  _ensureLayer(map, rendered.coordinates);
  _ensureBoundaryLayers(map);
  const source = map.getSource(SOURCE_ID);
  source?.updateImage?.({ image: rendered.image, coordinates: rendered.coordinates });
  map.setLayoutProperty(LAYER_ID, "visibility", "visible");
  updateIxac41BoundaryVisibility(map, cityAreas);
}

/**
 * Hides the mesh raster and its boundary overlays without removing them.
 * @param {maplibregl.Map} map
 */
export function hideIxac41Mesh(map) {
  if (!map) return;
  if (map.getLayer?.(LAYER_ID)) {
    map.setLayoutProperty(LAYER_ID, "visibility", "none");
  }
  _hideBoundaryLayers(map);
}
