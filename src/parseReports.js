/**
 * Fetches and parses JMA earthquake reports from the official JSON feed.
 * Handles duplicate detection and provides parsed report data.
 * Also handles VXSE61 special reports (顕著な地震の震源要素更新のお知らせ)
 * that provide updated magnitude/depth for major earthquakes.
 */

import { FEED_URL_LATEST, FEED_DATA_BASE_URL } from './constants.js';
import {
  fetchFeedEntries,
  parseReport,
  buildDisplayReport,
  FLASH_INTENSITY_TITLE,
  FLASH_EPICENTER_TITLE,
  parseFlashIntensityJson,
  buildFlashIntensityReport,
  buildFlashEpicenterReport,
} from './reportUtils.js';

/** Title string identifying VXSE61 special update reports in the feed. */
export const SPECIAL_REPORT_TITLE = '顕著な地震の震源要素更新のお知らせ';

/**
 * Parses depth (in km) from a coordinate string like "+4012.6+14218.2-44000/".
 * The third component is depth in metres (negative = underground).
 * @param {string} cod - Coordinate string from feed entry
 * @returns {number|null} Depth in km, or null if unparseable
 */
export function parseDepthFromCod(cod) {
  if (!cod) return null;
  const match = /^[+-][\d.]+[+-][\d.]+([+-]\d+\.?\d*)\/$/u.exec(cod);
  if (!match) return null;
  return Math.abs(Number.parseFloat(match[1])) / 1000;
}

/**
 * Parses latitude and longitude from a coordinate string.
 * Supports both degree-minute format (±DDMM.M±DDDMM.M...) and decimal degrees (±DD.D±DDD.D...).
 * @param {string} cod - Coordinate string like "+3559.9+14005.7-68000/" or "+36.0+140.1-70000/"
 * @returns {{ latitude: number, longitude: number }|null}
 */
export function parseCoordinatesFromCod(cod) {
  if (!cod) return null;
  const match = /^([+-])(\d+)(\.\d+)?([+-])(\d+)(\.\d+)?([+-]\d+\.?\d*)\/$/u.exec(cod);
  if (!match) return null;

  const [, s1, int1, frac1 = '', s2, int2, frac2 = ''] = match;

  let latitude;
  if (int1.length === 4) {
    const deg = Number.parseInt(int1.slice(0, 2), 10);
    const min = Number.parseFloat(int1.slice(2) + frac1);
    latitude = (s1 === '-' ? -1 : 1) * (deg + min / 60);
  } else if (int1.length === 6) {
    const deg = Number.parseInt(int1.slice(0, 2), 10);
    const min = Number.parseInt(int1.slice(2, 4), 10);
    const sec = Number.parseFloat(int1.slice(4) + frac1);
    latitude = (s1 === '-' ? -1 : 1) * (deg + min / 60 + sec / 3600);
  } else {
    latitude = Number.parseFloat(s1 + int1 + frac1);
  }

  let longitude;
  if (int2.length === 5) {
    const deg = Number.parseInt(int2.slice(0, 3), 10);
    const min = Number.parseFloat(int2.slice(3) + frac2);
    longitude = (s2 === '-' ? -1 : 1) * (deg + min / 60);
  } else if (int2.length === 7) {
    const deg = Number.parseInt(int2.slice(0, 3), 10);
    const min = Number.parseInt(int2.slice(3, 5), 10);
    const sec = Number.parseFloat(int2.slice(5) + frac2);
    longitude = (s2 === '-' ? -1 : 1) * (deg + min / 60 + sec / 3600);
  } else {
    longitude = Number.parseFloat(s2 + int2 + frac2);
  }

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;

  return { latitude, longitude };
}

/**
 * Parses updated magnitude, depth, and coordinates from a VXSE61 special report feed entry.
 * No JSON download is required — values are taken directly from the feed entry.
 * @param {Object} entry - Feed entry with ttl === SPECIAL_REPORT_TITLE
 * @returns {{ magnitude: number|null, depth: number|null, coordinates: { latitude: number, longitude: number }|null }}
 */
export function parseSpecialReportOverrides(entry) {
  const magnitude = entry.mag ? Number.parseFloat(entry.mag) : null;
  const depth = parseDepthFromCod(entry.cod);
  const coordinates = parseCoordinatesFromCod(entry.cod);
  return {
    magnitude: (magnitude !== null && !Number.isNaN(magnitude)) ? magnitude : null,
    depth,
    coordinates,
  };
}

/**
 * Applies special report overrides to a report object (mutates in place).
 * Only overrides fields that have valid values.
 * @param {Object} report - The display-ready report object
 * @param {Object} overrides - { magnitude, depth, coordinates } from parseSpecialReportOverrides
 */
export function applySpecialReportOverrides(report, overrides) {
  if (overrides.magnitude !== null) {
    report.magnitude = overrides.magnitude;
  }
  if (overrides.depth !== null) {
    report.depth = overrides.depth;
  }
  if (overrides.coordinates !== null) {
    report.coordinates = overrides.coordinates;
  }
  report.hasSpecialReport = true;
}

/**
 * Fetches and parses earthquake reports from the JSON feed.
 * Returns array of parsed reports sorted by origin time (newest first).
 * Includes flash reports (震度速報/震源速報) for events that don't yet have a normal report.
 * @param {Map} areaCodes - Area code name mappings from areaCodes.js
 * @param {Function} onReportFetched - Callback(report) called when each report is fetched
 * @param {Function} onProgress - Callback(processed, total) called to report progress
 * @returns {Promise<Array>} Array of parsed reports
 */
export async function fetchEarthquakeReports(areaCodes = new Map(), onReportFetched = null, onProgress = null) {
  const seenEventIds = new Set();
  const reports = [];

  try {
    // Fetch JSON feed
    const feedEntries = await fetchFeedEntries(FEED_URL_LATEST);

    // Filter for target reports (震源・震度情報 only)
    const targetEntries = feedEntries.filter(
      entry => entry.ttl === '震源・震度情報' && entry.json
    );

    // Collect VXSE61 special report entries, grouped by event ID.
    // If multiple special reports exist for the same event, keep the newest (by rdt).
    const specialEntriesByEid = new Map();
    for (const entry of feedEntries) {
      if (entry.ttl === SPECIAL_REPORT_TITLE && entry.eid) {
        const existing = specialEntriesByEid.get(entry.eid);
        if (!existing || (entry.rdt && (!existing.rdt || entry.rdt > existing.rdt))) {
          specialEntriesByEid.set(entry.eid, entry);
        }
      }
    }

    // Collect flash report entries, grouped by event ID
    // 震度速報 entries (intensity flash — area-level observations, no epicenter)
    const flashIntensityByEid = new Map();
    // 震源速報 entries (epicenter flash — epicenter details, no per-city observations)
    const flashEpicenterByEid = new Map();

    for (const entry of feedEntries) {
      if (entry.ttl === FLASH_INTENSITY_TITLE && entry.eid) {
        const existing = flashIntensityByEid.get(entry.eid);
        if (!existing || (entry.rdt && (!existing.rdt || entry.rdt > existing.rdt))) {
          flashIntensityByEid.set(entry.eid, entry);
        }
      } else if (entry.ttl === FLASH_EPICENTER_TITLE && entry.eid) {
        const existing = flashEpicenterByEid.get(entry.eid);
        if (!existing || (entry.rdt && (!existing.rdt || entry.rdt > existing.rdt))) {
          flashEpicenterByEid.set(entry.eid, entry);
        }
      }
    }

    let processedCount = 0;
    const totalCount = targetEntries.length;

    if (onProgress) onProgress(0, totalCount);

    // Process normal entries in batches of up to 3 in parallel
    for (let i = 0; i < targetEntries.length; i += 3) {
      const batch = targetEntries.slice(i, i + 3);
      const batchPromises = batch.map(entry => _processEntry(entry, areaCodes, seenEventIds));
      const batchResults = await Promise.all(batchPromises);
      
      for (const report of batchResults) {
        if (report) {
          // Apply VXSE61 special report overrides if one exists for this event
          const specialEntry = specialEntriesByEid.get(report.eventId);
          if (specialEntry) {
            const overrides = parseSpecialReportOverrides(specialEntry);
            applySpecialReportOverrides(report, overrides);
            console.log(`[parseReports] Applied VXSE61 overrides for ${report.eventId}: M${overrides.magnitude}, ${overrides.depth}km`);
          }

          reports.push(report);
          // Emit callback for each report as it's fetched
          if (onReportFetched) onReportFetched(report);
        }
        
        processedCount++;
      }
      if (onProgress) onProgress(processedCount, totalCount);
    }

    // ─── Process flash reports for events without a normal report ──────────
    // Collect all event IDs that have flash reports but no normal report
    const flashEventIds = new Set();
    for (const eid of flashIntensityByEid.keys()) {
      if (!seenEventIds.has(eid)) flashEventIds.add(eid);
    }
    for (const eid of flashEpicenterByEid.keys()) {
      if (!seenEventIds.has(eid)) flashEventIds.add(eid);
    }

    for (const eid of flashEventIds) {
      try {
        const flashReport = await _buildFlashReport(
          eid,
          flashIntensityByEid.get(eid),
          flashEpicenterByEid.get(eid),
          areaCodes,
        );
        if (flashReport) {
          seenEventIds.add(eid);
          reports.push(flashReport);
          if (onReportFetched) onReportFetched(flashReport);
        }
      } catch (err) {
        console.warn('[parseReports] Error processing flash report for', eid, err.message);
      }
    }
  } catch (err) {
    console.error('Failed to fetch reports:', err);
  }

  // Sort by origin time, newest first
  reports.sort((a, b) => (b.originTime || 0) - (a.originTime || 0));
  return reports;
}

/**
 * Builds the best available flash report for a given event ID.
 * Prefers 震源速報 (has epicenter data) over 震度速報 (area-only),
 * but carries observations from 震度速報 into the epicenter report.
 *
 * @param {string} eid - Event ID
 * @param {Object|undefined} intensityEntry - 震度速報 feed entry (may be undefined)
 * @param {Object|undefined} epicenterEntry - 震源速報 feed entry (may be undefined)
 * @param {Map} areaCodes - Area code name mappings
 * @returns {Promise<Object|null>} Flash report or null
 */
async function _buildFlashReport(eid, intensityEntry, epicenterEntry, areaCodes) {
  let intensityData = null;

  // If we have a 震度速報, fetch its JSON to get area-level observations
  if (intensityEntry?.json) {
    try {
      const reportUrl = FEED_DATA_BASE_URL + intensityEntry.json;
      const res = await fetch(reportUrl, { method: 'GET', mode: 'cors', cache: 'no-cache' });
      if (res.ok) {
        const jsonData = await res.json();
        intensityData = parseFlashIntensityJson(jsonData);
      }
    } catch (err) {
      console.warn('[parseReports] Failed to fetch 震度速報 JSON for', eid, err.message);
    }
  }

  // If we have a 震源速報 (epicenter details), build from that + carry observations
  if (epicenterEntry) {
    return buildFlashEpicenterReport(
      epicenterEntry,
      areaCodes,
      intensityData?.observations || [],
      intensityData?.maxIntensity || null,
    );
  }

  // Otherwise fall back to 震度速報 only
  if (intensityEntry && intensityData) {
    return buildFlashIntensityReport(intensityEntry, intensityData);
  }

  return null;
}

async function _processEntry(entry, areaCodes, seenEventIds) {
  // Check if this is a target entry (震源・震度情報)
  if (entry.ttl !== '震源・震度情報' || !entry.json) {
    return null;
  }

  try {
    // Fetch the actual earthquake report JSON
    const reportUrl = FEED_DATA_BASE_URL + entry.json;
    const res = await fetch(reportUrl, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache'
    });

    if (!res.ok) {
      console.warn(`Failed to fetch report: ${reportUrl} (${res.status})`);
      return null;
    }

    const jsonData = await res.json();
    const jmaReport = parseReport(jsonData);

    // Skip if we've already seen this event
    if (seenEventIds.has(jmaReport.eventId)) {
      return null;
    }
    seenEventIds.add(jmaReport.eventId);

    return buildDisplayReport(jmaReport, areaCodes, {
      feedRdt: entry.rdt,
      feedJson: entry.json,
    });
  } catch (err) {
    console.warn('Error processing entry:', entry.eid, err.message);
    return null;
  }
}
