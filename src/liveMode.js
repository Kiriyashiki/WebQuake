/**
 * Live mode controller: Polls the latest JSON feed for new/updated earthquake entries.
 * Compares entries by their 'rdt' timestamp and triggers callbacks for changes.
 */

import { FEED_URL_LATEST, FEED_DATA_BASE_URL, POLL_INTERVAL } from "./constants.js";

/**
 * Tracks the last seen entries with their updated timestamps.
 * Map of eventId -> { rdt: ISO string, jsonFile: string }
 */
let _trackedEntries = new Map();

let _pollingIntervalId = null;
let _pollingTimeoutId = null;

/**
 * Starts live mode polling.
 * 
 * @param {Map} areaCodes - Area code name mappings
 * @param {Object} callbacks - Callback functions:
 *   - onNewEntry(entry, report): Called when a new entry is detected
 *   - onUpdatedEntry(entry, report): Called when an entry is updated
 *   - onError(err): Called if polling fails
 * @param {Array} initialReports - Initial reports already loaded (for tracking purposes)
 */
export function startLivePolling(areaCodes, callbacks = {}, initialReports = []) {
  if (_pollingIntervalId !== null) {
    console.warn("[live-mode] Polling already active");
    return;
  }

  console.log("[live-mode] Starting polling...");

  // Initialize tracked entries with initial reports
  for (const report of initialReports) {
    if (report.eventId && report.feedRdt && report.feedJson) {
      _trackedEntries.set(report.eventId, {
        rdt: report.feedRdt,
        jsonFile: report.feedJson,
      });
    }
  }

  // Delay first poll by POLL_INTERVAL, then set up interval polling
  _pollingTimeoutId = setTimeout(() => {
    _pollingTimeoutId = null;
    _pollLatestFeed(areaCodes, callbacks);
    _pollingIntervalId = setInterval(() => {
      _pollLatestFeed(areaCodes, callbacks);
    }, POLL_INTERVAL);
  }, POLL_INTERVAL);
}

/**
 * Stops live mode polling.
 */
export function stopLivePolling() {
  if (_pollingTimeoutId !== null) {
    clearTimeout(_pollingTimeoutId);
    _pollingTimeoutId = null;
  }
  if (_pollingIntervalId !== null) {
    clearInterval(_pollingIntervalId);
    _pollingIntervalId = null;
  }
  console.log("[live-mode] Polling stopped");
}

/**
 * Gets whether live mode is currently polling.
 * @returns {boolean}
 */
export function isPolling() {
  return _pollingTimeoutId !== null || _pollingIntervalId !== null;
}

// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * Fetches the latest feed and detects new/updated entries.
 */
async function _pollLatestFeed(areaCodes, callbacks = {}) {
  try {
    const entries = await _fetchFeedEntries(FEED_URL_LATEST);

    // Filter for target entries only (震源・震度情報)
    const targetEntries = entries.filter(
      (entry) =>
        entry.ttl === "震源・震度情報" &&
        entry.json &&
        entry.rdt
    );

    // Group entries by event ID and keep only the newest for each
    const latestEntriesByEventId = new Map();
    for (const entry of targetEntries) {
      const eventId = entry.eid;
      if (!eventId) continue;

      const current = latestEntriesByEventId.get(eventId);
      if (!current || new Date(entry.rdt) > new Date(current.rdt)) {
        latestEntriesByEventId.set(eventId, entry);
      }
    }

    // Process only the latest entry for each event ID
    for (const [eventId, entry] of latestEntriesByEventId) {
      const trackedEntry = _trackedEntries.get(eventId);

      if (!trackedEntry) {
        // NEW ENTRY
        console.log("[live-mode] New entry detected:", eventId);
        _trackedEntries.set(eventId, {
          rdt: entry.rdt,
          jsonFile: entry.json,
        });

        // Fetch and parse the report
        const report = await _fetchAndParseEntry(entry, areaCodes);
        if (report && callbacks.onNewEntry) {
          callbacks.onNewEntry(entry, report);
        }
      } else if (entry.rdt !== trackedEntry.rdt) {
        // UPDATED ENTRY
        console.log("[live-mode] Updated entry detected:", eventId);
        _trackedEntries.set(eventId, {
          rdt: entry.rdt,
          jsonFile: entry.json,
        });

        // Fetch and parse the updated report
        const report = await _fetchAndParseEntry(entry, areaCodes);
        if (report && callbacks.onUpdatedEntry) {
          callbacks.onUpdatedEntry(entry, report);
        }
      }
    }
  } catch (err) {
    console.error("[live-mode] Polling error:", err);
    if (callbacks.onError) callbacks.onError(err);
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * Fetches and parses the JSON feed, returning array of entry objects.
 * Each entry has { eid, rdt, ttl, ift, ser, at, anm, maxi, json, ... }
 */
async function _fetchFeedEntries(feedUrl) {
  try {
    const res = await fetch(feedUrl, {
      method: "GET",
      mode: "cors",
      cache: "no-cache",
    });

    if (!res.ok) {
      throw new Error(`Feed fetch failed: ${feedUrl} (${res.status})`);
    }

    const data = await res.json();
    
    // The feed is an array of entries
    if (!Array.isArray(data)) {
      throw new TypeError("Feed is not an array");
    }

    return data;
  } catch (err) {
    console.error(`Error fetching feed ${feedUrl}:`, err);
    throw err;
  }
}

/**
 * Fetches and parses a single report entry.
 * Returns a parsed report object with observations, or null if error.
 */

/**
 * Fetches and parses a single report entry.
 * Returns a parsed report object with observations, or null if error.
 */
async function _fetchAndParseEntry(entry, areaCodes) {
  try {
    // Import here to avoid circular dependency
    const JMAEarthquakeReport = (await import("./jmaEarthquakeReport.js")).default;

    const reportUrl = FEED_DATA_BASE_URL + entry.json;
    const res = await fetch(reportUrl, {
      method: "GET",
      mode: "cors",
      cache: "no-cache",
    });

    if (!res.ok) {
      console.warn(
        `[live-mode] Failed to fetch report: ${reportUrl} (${res.status})`
      );
      return null;
    }

    const jsonData = await res.json();
    const jmaReport = JMAEarthquakeReport.fromJSON(jsonData);

    // Get hypocenter name from area codes
    const hypocenterCodeEntry = areaCodes.get(jmaReport.hypocenterCode) || {};
    const hypocenterJa = hypocenterCodeEntry.ja || "不明";
    const hypocenterKana = hypocenterCodeEntry.kana || "ふめい";
    const hypocenterEn = hypocenterCodeEntry.en || "Unknown";

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
      // Store feed entry metadata for tracking
      feedRdt: entry.rdt,
      feedJson: entry.json,
    };
  } catch (err) {
    console.warn("[live-mode] Error processing entry:", entry.eid, err.message);
    return null;
  }
}
