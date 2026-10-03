import {
  MAP_COLORS,
  buildIntensityColorExpression,
} from "../constants.js";

const C = MAP_COLORS;

/**
 * Builds the MapLibre GL style specification object for the seismic map.
 * @param {boolean} useCityAreas - Whether city-level boundaries are initially visible
 * @returns {Object} MapLibre style JSON specification
 */
export function buildStyle(useCityAreas = true) {
  return {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      world: {
        type: "geojson",
        data: "/world.geojson",
      },
      lake: {
        type: "geojson",
        data: "/lake.geojson",
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
      shakemap: {
        type: "geojson",
        data: "/shakemap.geojson",
        promoteId: "name",
      },
      "eew-p-wave": {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      "eew-s-wave": {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
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
        layout: { visibility: useCityAreas ? "visible" : "none" },
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
        layout: { visibility: useCityAreas ? "none" : "visible" },
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            [
              "case",
              ["boolean", ["feature-state", "hover"], false],
              // Highlighted + hovered: lighter intensity color
              ["coalesce", buildIntensityColorExpression(false), "transparent"],
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
        layout: { visibility: useCityAreas ? "visible" : "none" },
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            [
              "case",
              ["boolean", ["feature-state", "hover"], false],
              ["coalesce", buildIntensityColorExpression(false), "transparent"],
              buildIntensityColorExpression(true),
            ],
            "transparent",
          ],
          "fill-antialias": true,
        },
      },
      {
        id: "shakemap-fill",
        type: "fill",
        source: "shakemap",
        layout: { visibility: "none" },
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            [
              "case",
              ["boolean", ["feature-state", "hover"], false],
              ["coalesce", buildIntensityColorExpression(false), "transparent"],
              buildIntensityColorExpression(true),
            ],
            "transparent",
          ],
          "fill-antialias": true,
        },
      },
      {
        id: "lake-fill",
        type: "fill",
        source: "lake",
        paint: {
          "fill-color": C.lake,
          "fill-antialias": true,
        },
      },
      {
        id: "cities-line",
        type: "line",
        source: "cities",
        layout: { visibility: useCityAreas ? "visible" : "none" },
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
        id: "shakemap-line",
        type: "line",
        source: "shakemap",
        layout: { visibility: "none" },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            buildIntensityColorExpression(false, C.cityLine),
            ["case", ["boolean", ["feature-state", "hover"], false], C.japanLine, C.forecastLine],
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "highlighted"], false],
            0.4,
            ["case", ["boolean", ["feature-state", "hover"], false], 1.4, 0.5],
          ],
        },
      },
      {
        id: "forecast-line",
        type: "line",
        source: "forecast_areas",
        layout: { visibility: useCityAreas ? "none" : "visible" },
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
      {
        id: "eew-p-wave-layer",
        type: "line",
        source: "eew-p-wave",
        paint: {
          "line-color": "#3498db", // Blue for P wave
          "line-width": 2,
          "line-opacity": ["get", "opacity"],
        },
      },
      {
        id: "eew-s-wave-layer",
        type: "line",
        source: "eew-s-wave",
        paint: {
          "line-color": "#e74c3c", // Red for S wave
          "line-width": 2,
          "line-opacity": ["get", "opacity"],
        },
      },
    ],
  };
}
