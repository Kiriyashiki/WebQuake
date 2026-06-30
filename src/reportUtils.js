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

// ─── Flash report title constants ────────────────────────────────────────────

/** Title for 震度速報 (intensity flash report — first report, area-level only) */
export const FLASH_INTENSITY_TITLE = '震度速報';

/** Title for 震源速報 (epicenter flash report — second report, epicenter details) */
export const FLASH_EPICENTER_TITLE = '震源に関する情報';

/**
 * Parses a 震度速報 JSON into area-level observations (no cities).
 * The JSON structure uses Body.Intensity.Observation.Pref[] → Area[].
 * @param {Object} jsonData - Parsed JSON from the 震度速報 report file
 * @returns {{ maxIntensity: string|null, observations: Array }}
 */
export function parseFlashIntensityJson(jsonData) {
  const maxInt = jsonData?.Body?.Intensity?.Observation?.MaxInt || null;
  const prefArray = jsonData?.Body?.Intensity?.Observation?.Pref;
  if (!prefArray || !Array.isArray(prefArray)) {
    return { maxIntensity: maxInt, observations: [] };
  }

  const observations = [];
  for (const pref of prefArray) {
    const prefEntry = {
      code: Number.parseInt(pref.Code, 10),
      name: pref.Name || null,
      maxInt: pref.MaxInt || null,
      areas: [],
    };

    const areaArray = pref.Area || [];
    for (const area of areaArray) {
      prefEntry.areas.push({
        code: Number.parseInt(area.Code, 10),
        name: area.Name || null,
        maxInt: area.MaxInt || null,
        cities: [], // No cities in 震度速報
      });
    }

    observations.push(prefEntry);
  }

  return { maxIntensity: maxInt, observations };
}

/**
 * Builds a display-ready flash report from a 震度速報 feed entry + fetched JSON.
 * Epicenter is unknown at this stage.
 *
 * @param {Object} feedEntry - The feed entry with ttl === '震度速報'
 * @param {Object} parsedJson - { maxIntensity, observations } from parseFlashIntensityJson
 * @returns {Object} Display-ready flash report object
 */
export function buildFlashIntensityReport(feedEntry, parsedJson) {
  const originTime = feedEntry.at
    ? Math.floor(Date.parse(feedEntry.at) / 1000)
    : null;

  return {
    eventId: feedEntry.eid,
    originTime,
    magnitude: null,
    maxIntensity: parsedJson.maxIntensity || feedEntry.maxi || null,
    hypocenterCode: null,
    hypocenterJa: '震源 調査中',
    hypocenterKana: 'しんげん ちょうさちゅう',
    hypocenterEn: 'Under Assessment',
    coordinates: null,
    depth: null,
    observations: parsedJson.observations,
    jmaReport: null,
    isFlashReport: true,
    flashType: 'intensity', // 震度速報
    feedRdt: feedEntry.rdt,
    feedJson: feedEntry.json,
  };
}

/**
 * Builds a display-ready flash report from a 震源速報 feed entry.
 * No JSON fetch needed — epicenter details are in the feed entry itself.
 * Observations from a prior 震度速報 can be carried over.
 *
 * @param {Object} feedEntry - The feed entry with ttl === '震源に関する情報'
 * @param {Map} areaCodes - Area code name mappings
 * @param {Array} [priorObservations] - Observations from a prior 震度速報 for this event
 * @param {string} [priorMaxIntensity] - Max intensity from a prior 震度速報
 * @returns {Object} Display-ready flash report object
 */
export function buildFlashEpicenterReport(feedEntry, areaCodes, priorObservations = [], priorMaxIntensity = null) {
  const originTime = feedEntry.at
    ? Math.floor(Date.parse(feedEntry.at) / 1000)
    : null;

  const magnitude = feedEntry.mag ? Number.parseFloat(feedEntry.mag) : null;

  // Parse coordinates from cod field
  let coordinates = null;
  let depth = null;
  if (feedEntry.cod) {
    const match = /^([+-]\d+\.?\d*)([+-]\d+\.?\d*)([+-]\d+\.?\d*)\/$/u.exec(feedEntry.cod);
    if (match) {
      coordinates = {
        latitude: Number.parseFloat(match[1]),
        longitude: Number.parseFloat(match[2]),
      };
      depth = Math.abs(Number.parseFloat(match[3])) / 1000;
    }
  }

  // Resolve hypocenter name from area code
  const hypocenterCode = feedEntry.acd ? Number.parseInt(feedEntry.acd, 10) : null;
  const hypocenterCodeEntry = areaCodes.get(hypocenterCode) || {};

  return {
    eventId: feedEntry.eid,
    originTime,
    magnitude: (magnitude !== null && !Number.isNaN(magnitude)) ? magnitude : null,
    maxIntensity: priorMaxIntensity || feedEntry.maxi || null,
    hypocenterCode,
    hypocenterJa: hypocenterCodeEntry.ja || feedEntry.anm || '不明',
    hypocenterKana: hypocenterCodeEntry.kana || '',
    hypocenterEn: hypocenterCodeEntry.en || feedEntry.en_anm || 'Unknown',
    coordinates,
    depth,
    observations: priorObservations,
    jmaReport: null,
    isFlashReport: true,
    flashType: 'epicenter', // 震源速報
    feedRdt: feedEntry.rdt,
    feedJson: feedEntry.json,
  };
}
