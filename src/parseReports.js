/**
 * Fetches and parses JMA earthquake reports from the official JSON feed.
 * Handles duplicate detection and provides parsed report data.
 */

import JMAEarthquakeReport from './jmaEarthquakeReport.js';
import { FEED_URL_LATEST, FEED_DATA_BASE_URL } from './constants.js';

/**
 * Fetches and parses earthquake reports from the JSON feed.
 * Returns array of parsed reports sorted by origin time (newest first).
 * @param {Map} areaCodes - Area code name mappings from areaCodes.js
 * @returns {Promise<Array>} Array of parsed reports
 */
export async function fetchEarthquakeReports(areaCodes = new Map(), onProgress = null) {
  const seenEventIds = new Set();
  const reports = [];

  try {
    // Fetch JSON feed
    const feedEntries = await _fetchFeedEntries(FEED_URL_LATEST);

    // Filter for target reports (震源・震度情報 only)
    const targetEntries = feedEntries.filter(
      entry => entry.ttl === '震源・震度情報' && entry.json
    );

    let processedCount = 0;
    const totalCount = targetEntries.length;

    if (onProgress) onProgress(processedCount, totalCount);

    // Process entries in batches of up to 3 in parallel
    for (let i = 0; i < targetEntries.length; i += 3) {
      const batch = targetEntries.slice(i, i + 3);
      const batchPromises = batch.map(entry => _processEntry(entry, areaCodes, seenEventIds));
      const batchResults = await Promise.all(batchPromises);
      
      for (const report of batchResults) {
        if (report) reports.push(report);
        
        processedCount++;
        if (onProgress) onProgress(processedCount, totalCount);
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
          const jmaReport = JMAEarthquakeReport.fromJSON(jsonData);
          
          if (seenEventIds.has(jmaReport.eventId)) return null;
          seenEventIds.add(jmaReport.eventId);

          const hypocenterCodeEntry = areaCodes.get(jmaReport.hypocenterCode) || {};
          const hypocenterJa = hypocenterCodeEntry.ja || '不明';
          const hypocenterKana = hypocenterCodeEntry.kana || 'ふめい';
          const hypocenterEn = hypocenterCodeEntry.en || 'Unknown';

          return {
            eventId: jmaReport.eventId,
            originTime: jmaReport.originTime,
            magnitude: jmaReport.magnitude,
            maxIntensity: jmaReport.maxIntensity,
            hypocenterCode: jmaReport.hypocenterCode,
            hypocenterJa,
            hypocenterKana,
            hypocenterEn,
            coordinates: jmaReport.coordinates,
            depth: jmaReport.depth,
            observations: jmaReport.observations,
            jmaReport,
          };
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

// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * Fetches and parses the JSON feed, returning array of entry objects.
 * Each entry has { eid, rdt, ttl, ift, ser, at, anm, maxi, json, ... }
 */
async function _fetchFeedEntries(feedUrl) {
  try {
    const res = await fetch(feedUrl, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache'
    });

    if (!res.ok) {
      throw new Error(`Feed fetch failed: ${feedUrl} (${res.status})`);
    }

    const data = await res.json();
    
    // The feed is an array of entries
    if (!Array.isArray(data)) {
      throw new TypeError('Feed is not an array');
    }

    return data;
  } catch (err) {
    console.error(`Error fetching feed ${feedUrl}:`, err);
    throw err;
  }
}

/**
 * Processes a single feed entry: checks if it's the target report type,
 * fetches the JSON report, parses it, and returns a display-ready report object.
 * Skips if already seen (by event ID).
 */
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
    const jmaReport = JMAEarthquakeReport.fromJSON(jsonData);

    // Skip if we've already seen this event
    if (seenEventIds.has(jmaReport.eventId)) {
      return null;
    }
    seenEventIds.add(jmaReport.eventId);

    // Get hypocenter name from area codes
    const hypocenterCodeEntry = areaCodes.get(jmaReport.hypocenterCode) || {};
    const hypocenterJa = hypocenterCodeEntry.ja || '不明';
    const hypocenterKana = hypocenterCodeEntry.kana || 'ふめい';
    const hypocenterEn = hypocenterCodeEntry.en || 'Unknown';

    // Build display-ready report object
    return {
      eventId: jmaReport.eventId,
      originTime: jmaReport.originTime,
      magnitude: jmaReport.magnitude,
      maxIntensity: jmaReport.maxIntensity,
      hypocenterCode: jmaReport.hypocenterCode,
      hypocenterJa,
      hypocenterKana,
      hypocenterEn,
      coordinates: jmaReport.coordinates,
      depth: jmaReport.depth,
      observations: jmaReport.observations,
      // Store original JMA report for reference
      jmaReport,
      // Store feed entry metadata for live mode tracking
      feedRdt: entry.rdt,
      feedJson: entry.json,
    };
  } catch (err) {
    console.warn('Error processing entry:', entry.eid, err.message);
    return null;
  }
}
