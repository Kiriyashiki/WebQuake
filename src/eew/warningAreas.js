import { union } from "@turf/turf";
import { isWarningEew } from "../eewProviders.js";

const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] };

/**
 * Returns the forecast area codes covered by an EEW warning (警報).
 *
 * AXIS includes the warning areas in the warning message's Forecast array.
 * Providers without warning-area support never reach this function.
 *
 * @param {Object} msg Normalized EEW message.
 * @returns {number[]} Sorted forecast area codes.
 */
export function extractWarningAreaCodes(msg) {
  if (!isWarningEew(msg)) return [];

  const codes = new Set();
  for (const forecast of msg.Forecast || []) {
    const code = Number.parseInt(forecast?.Code, 10);
    if (Number.isFinite(code)) codes.add(code);
  }
  return Array.from(codes).sort((a, b) => a - b);
}

/**
 * Collects the union of warning area codes across active, non-cancelled EEWs.
 *
 * @param {Iterable<Object>} eews Active EEW entries.
 * @returns {number[]} Sorted forecast area codes.
 */
export function collectWarningAreaCodes(eews) {
  const codes = new Set();
  for (const eew of eews || []) {
    if (!eew || eew.isCancelled || !eew.isWarning) continue;
    for (const value of eew.warningAreaCodes || []) {
      const code = Number(value);
      if (Number.isFinite(code)) codes.add(code);
    }
  }
  return Array.from(codes).sort((a, b) => a - b);
}

/**
 * Builds a merged outline for the requested warning areas.
 *
 * The forecast area features are combined with a polygon union so shared
 * internal borders disappear and only the outer boundary remains. The result
 * is always a FeatureCollection suitable for a MapLibre line source.
 *
 * @param {Object} forecastAreas forecast_areas.geojson FeatureCollection.
 * @param {number[]} codes Forecast area codes to include.
 * @returns {Object} FeatureCollection containing the merged outline.
 */
export function buildWarningAreaOutline(forecastAreas, codes) {
  const codeSet = new Set((codes || []).map(String));
  const features = (forecastAreas?.features || []).filter((feature) =>
    codeSet.has(String(feature?.properties?.code)),
  );

  if (features.length === 0) return EMPTY_FEATURE_COLLECTION;

  if (features.length > 1) {
    try {
      const merged = union({ type: "FeatureCollection", features });
      if (merged) {
        return { type: "FeatureCollection", features: [merged] };
      }
    } catch (err) {
      console.warn("[EEW] Failed to merge warning areas; using unmerged outline:", err);
    }
  }

  return { type: "FeatureCollection", features };
}
