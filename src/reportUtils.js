/**
 * Shared utilities for fetching and building earthquake report objects.
 * Eliminates duplication between parseReports.js, liveMode.js, and historyMode.js.
 */

import JMAEarthquakeReport from './jmaEarthquakeReport.js';

/**
 * Fetches and parses a JSON feed, returning an array of entry objects.
 * Each entry has { eid, rdt, ttl, ift, ser, at, anm, maxi, json, ... }
 * @param {string} feedUrl - URL of the JSON feed
 * @returns {Promise<Array>} Array of feed entry objects
 */
export async function fetchFeedEntries(feedUrl) {
  const res = await fetch(feedUrl, {
    method: 'GET',
    mode: 'cors',
    cache: 'no-cache',
  });

  if (!res.ok) {
    throw new Error(`Feed fetch failed: ${feedUrl} (${res.status})`);
  }

  const data = await res.json();

  if (!Array.isArray(data)) {
    throw new TypeError('Feed is not an array');
  }

  return data;
}

/**
 * Parses raw JSON data into a JMAEarthquakeReport instance.
 * @param {Object} jsonData - Raw JSON report data
 * @returns {JMAEarthquakeReport}
 */
export function parseReport(jsonData) {
  return JMAEarthquakeReport.fromJSON(jsonData);
}

/**
 * Builds a display-ready report object from a JMAEarthquakeReport instance.
 * Resolves hypocenter names from area codes and merges any extra fields.
 *
 * @param {JMAEarthquakeReport} jmaReport - Parsed JMA report
 * @param {Map} areaCodes - Area code name mappings
 * @param {Object} [extraFields] - Additional fields to merge (e.g. feedRdt, feedJson, isHistory).
 *   Special key `fallbackName` is used as a secondary fallback for hypocenterJa
 *   (after areaCodes lookup, before the default '不明').
 * @returns {Object} Display-ready report object
 */
export function buildDisplayReport(jmaReport, areaCodes, extraFields = {}) {
  const { fallbackName, ...rest } = extraFields;
  const hypocenterCodeEntry = areaCodes.get(jmaReport.hypocenterCode) || {};

  return {
    eventId: jmaReport.eventId,
    originTime: jmaReport.originTime,
    magnitude: jmaReport.magnitude,
    maxIntensity: jmaReport.maxIntensity,
    hypocenterCode: jmaReport.hypocenterCode,
    hypocenterJa: hypocenterCodeEntry.ja || fallbackName || '不明',
    hypocenterKana: hypocenterCodeEntry.kana || 'ふめい',
    hypocenterEn: hypocenterCodeEntry.en || 'Unknown',
    coordinates: jmaReport.coordinates,
    depth: jmaReport.depth,
    observations: jmaReport.observations,
    jmaReport,
    ...rest,
  };
}
