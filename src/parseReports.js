/**
 * Fetches and parses JMA earthquake reports from the official JSON feed.
 * Handles duplicate detection and provides parsed report data.
 * Also handles VXSE61 special reports (顕著な地震の震源要素更新のお知らせ)
 * that provide updated magnitude/depth for major earthquakes.
 */

import { FEED_URL_LATEST, FEED_DATA_BASE_URL } from './constants.js';
import { fetchFeedEntries, parseReport, buildDisplayReport } from './reportUtils.js';

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
 * Parses updated magnitude and depth from a VXSE61 special report feed entry.
 * No JSON download is required — values are taken directly from the feed entry.
 * @param {Object} entry - Feed entry with ttl === SPECIAL_REPORT_TITLE
 * @returns {{ magnitude: number|null, depth: number|null }}
 */
export function parseSpecialReportOverrides(entry) {
  const magnitude = entry.mag ? Number.parseFloat(entry.mag) : null;
  const depth = parseDepthFromCod(entry.cod);
  return {
    magnitude: (magnitude !== null && !Number.isNaN(magnitude)) ? magnitude : null,
    depth,
  };
}

/**
 * Applies special report overrides to a report object (mutates in place).
 * Only overrides fields that have valid values.
 * @param {Object} report - The display-ready report object
 * @param {Object} overrides - { magnitude, depth } from parseSpecialReportOverrides
 */
export function applySpecialReportOverrides(report, overrides) {
  if (overrides.magnitude !== null) {
    report.magnitude = overrides.magnitude;
  }
  if (overrides.depth !== null) {
    report.depth = overrides.depth;
  }
}

/**
 * Fetches and parses earthquake reports from the JSON feed.
 * Returns array of parsed reports sorted by origin time (newest first).
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

    let processedCount = 0;
    const totalCount = targetEntries.length;

    if (onProgress) onProgress(0, totalCount);

    // Process entries in batches of up to 3 in parallel
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
  } catch (err) {
    console.error('Failed to fetch reports:', err);
  }

  // Sort by origin time, newest first
  reports.sort((a, b) => (b.originTime || 0) - (a.originTime || 0));
  return reports;
}

/**
 * Fetches and parses older static earthquake reports from /reports/list.txt.
 * Returns array of parsed reports sorted by origin time (newest first).
 * @param {Map} areaCodes - Area code name mappings from areaCodes.js
 * @param {Set} seenEventIds - Set of already processed event IDs
 * @returns {Promise<Array>} Array of parsed reports
 */
export async function fetchOlderReports(areaCodes = new Map(), seenEventIds = new Set(), onProgress = null) {
  const reports = [];
  try {
    const listRes = await fetch('/reports/list.txt');
    if (!listRes.ok) throw new Error('Failed to fetch /reports/list.txt');
    
    const listText = await listRes.text();
    const fileNames = listText.split('\n').map(line => line.trim()).filter(line => line.endsWith('.json'));
    
    let processedCount = 0;
    const totalCount = fileNames.length;
    if (onProgress) onProgress(processedCount, totalCount);

    for (let i = 0; i < fileNames.length; i += 3) {
      const batch = fileNames.slice(i, i + 3);
      const batchPromises = batch.map(async (fileName) => {
        try {
          const res = await fetch(`/reports/${fileName}`);
          if (!res.ok) return null;
          const jsonData = await res.json();
          const jmaReport = parseReport(jsonData);
          
          if (seenEventIds.has(jmaReport.eventId)) return null;
          seenEventIds.add(jmaReport.eventId);

          return buildDisplayReport(jmaReport, areaCodes);
        } catch (err) {
          console.warn(`Failed to process static report ${fileName}:`, err);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const report of batchResults) {
        if (report) reports.push(report);
        processedCount++;
        if (onProgress) onProgress(processedCount, totalCount);
      }
    }
  } catch (err) {
    console.error('Failed to fetch older reports:', err);
  }

  // Sort by origin time, newest first
  reports.sort((a, b) => (b.originTime || 0) - (a.originTime || 0));
  return reports;
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
