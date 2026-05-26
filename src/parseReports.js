/**
 * Fetches and parses JMA earthquake reports from the official feeds.
 * Handles duplicate detection and provides parsed report data.
 */

import JMAEarthquakeReport from './jmaEarthquakeReport.js';
import { FEED_URL_LATEST, FEED_URL_HISTORY, TEST_REPORT_URL, doTestReport } from './constants.js';

/**
 * Fetches and parses earthquake reports from both feeds.
 * Returns array of parsed reports sorted by origin time (newest first).
 * @param {Map} areaCodes - Area code name mappings from areaCodes.js
 * @returns {Promise<Array>} Array of parsed reports
 */
export async function fetchEarthquakeReports(areaCodes = new Map(), onProgress = null) {
  const seenEventIds = new Set();
  const reports = [];

  try {
    // Fetch latest feed first (with CORS mode)
    const latestEntries = await _fetchFeedEntries(FEED_URL_LATEST);
    // Then fetch history feed (may have duplicates)
    const historyEntries = await _fetchFeedEntries(FEED_URL_HISTORY);

    // Combine and filter for target reports
    const targetEntries = [...latestEntries, ...historyEntries].filter(
      entry => entry.title === '震源・震度に関する情報' && entry.link
    );

    let processedCount = 0;
    const totalCount = targetEntries.length + (doTestReport ? 1 : 0);

    if (onProgress) onProgress(processedCount, totalCount);

    for (const entry of targetEntries) {
      const report = await _processEntry(entry, areaCodes, seenEventIds);
      if (report) reports.push(report);
      
      processedCount++;
      if (onProgress) onProgress(processedCount, totalCount);
    }

    // ──── TEST MODE: Fetch test report ────────────────────────────────
    if (doTestReport) {
      try {
        const testReport = await _fetchTestReport(TEST_REPORT_URL, areaCodes, seenEventIds);
        if (testReport) reports.push(testReport);
      } catch (err) {
        console.warn('Test report fetch failed:', err.message);
      }
      processedCount++;
      if (onProgress) onProgress(processedCount, totalCount);
    }
    // ──────────────────────────────────────────────────────────────────

  } catch (err) {
    console.error('Failed to fetch reports:', err);
  }

  // Sort by origin time, newest first
  reports.sort((a, b) => (b.originTime || 0) - (a.originTime || 0));
  return reports;
}

// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * Fetches and parses a feed XML, returning array of entry objects.
 * Each entry has { title, id, link, content, updated }.
 * Uses CORS mode to work with external feeds.
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

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error(`Feed XML parse error: ${parseError.textContent}`);
    }

    const entries = [];
    for (const entry of doc.getElementsByTagName('entry')) {
      const title = entry.getElementsByTagName('title')[0]?.textContent?.trim() || '';
      const id = entry.getElementsByTagName('id')[0]?.textContent?.trim() || '';
      const updated = entry.getElementsByTagName('updated')[0]?.textContent?.trim() || '';
      
      // Get link href (type="application/xml")
      let link = '';
      for (const l of entry.getElementsByTagName('link')) {
        if (l.getAttribute('type') === 'application/xml') {
          link = l.getAttribute('href') || '';
          break;
        }
      }

      const content = entry.getElementsByTagName('content')[0]?.textContent?.trim() || '';

      entries.push({ title, id, updated, link, content });
    }

    return entries;
  } catch (err) {
    console.error(`Error fetching feed ${feedUrl}:`, err);
    throw err;
  }
}

/**
 * Processes a single feed entry: checks if it's VXSE53, fetches the XML report,
 * parses it, and returns a display-ready report object.
 * Skips if already seen (by event ID).
 */
async function _processEntry(entry, areaCodes, seenEventIds) {
  // Check if this is a VXSE53 entry (震源・震度に関する情報)
  if (entry.title !== '震源・震度に関する情報' || !entry.link) {
    return null;
  }

  try {
    // Fetch the actual earthquake report XML with CORS mode
    const res = await fetch(entry.link, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache'
    });

    if (!res.ok) {
      console.warn(`Failed to fetch report: ${entry.link} (${res.status})`);
      return null;
    }

    const xmlText = await res.text();
    const jmaReport = new JMAEarthquakeReport(xmlText);

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
    };
  } catch (err) {
    console.warn('Error processing entry:', entry.id, err.message);
    return null;
  }
}

/**
 * Fetches and processes a single test report XML URL.
 * Used only for testing/development
 * 
 * @param {string} reportUrl - Direct URL to a JMA earthquake report XML
 * @param {Map} areaCodes - Area code name mappings
 * @param {Set} seenEventIds - Set of already-seen event IDs to prevent duplicates
 * @returns {Promise<Object|null>} Parsed report object or null if error
 */
async function _fetchTestReport(reportUrl, areaCodes, seenEventIds) {
  try {
    const res = await fetch(reportUrl, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache'
    });

    if (!res.ok) {
      console.warn(`Test report fetch failed: ${reportUrl} (${res.status})`);
      return null;
    }

    const xmlText = await res.text();
    const jmaReport = new JMAEarthquakeReport(xmlText);

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
      jmaReport,
    };
  } catch (err) {
    console.warn('Error fetching test report:', err.message);
    return null;
  }
}
