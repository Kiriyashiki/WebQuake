/**
 * Live mode controller: Polls the latest JSON feed for new/updated earthquake entries.
 * Compares entries by their 'rdt' timestamp and triggers callbacks for changes.
 */

import { FEED_URL_LATEST, FEED_DATA_BASE_URL, POLL_INTERVAL } from "./constants.js";
import {
  SPECIAL_REPORT_TITLE,
  parseSpecialReportOverrides,
  applySpecialReportOverrides,
} from "./parseReports.js";
import { fetchFeedEntries, parseReport, buildDisplayReport } from "./reportUtils.js";

/**
 * Tracks the last seen entries with their updated timestamps.
 * Map of eventId -> { rdt: ISO string, jsonFile: string }
 */
let _trackedEntries = new Map();

/**
 * Tracks VXSE61 special report entries we've already processed.
 * Map of eventId -> { rdt: ISO string }
 */
let _trackedSpecialEntries = new Map();

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
    const entries = await fetchFeedEntries(FEED_URL_LATEST);

    // Filter for target entries only (震源・震度情報)
    const targetEntries = entries.filter(
      (entry) =>
        entry.ttl === "震源・震度情報" &&
        entry.json &&
        entry.rdt
    );

    // Collect VXSE61 special report entries from the feed
    const specialEntries = entries.filter(
      (entry) => entry.ttl === SPECIAL_REPORT_TITLE && entry.eid && entry.rdt
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
        if (report) {
          // Check if a VXSE61 special report already exists for this event
          const matchingSpecial = specialEntries.find((s) => s.eid === eventId);
          if (matchingSpecial) {
            const overrides = parseSpecialReportOverrides(matchingSpecial);
            applySpecialReportOverrides(report, overrides);
            console.log(
              `[live-mode] Applied VXSE61 overrides to new report ${eventId}: M${overrides.magnitude}, ${overrides.depth}km`
            );
            _trackedSpecialEntries.set(eventId, { rdt: matchingSpecial.rdt });
          }

          if (callbacks.onNewEntry) {
            callbacks.onNewEntry(entry, report);
          }
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
        if (report) {
          // Check if a VXSE61 special report exists for this event
          const matchingSpecial = specialEntries.find((s) => s.eid === eventId);
          if (matchingSpecial) {
            const overrides = parseSpecialReportOverrides(matchingSpecial);
            applySpecialReportOverrides(report, overrides);
            console.log(
              `[live-mode] Applied VXSE61 overrides to updated report ${eventId}: M${overrides.magnitude}, ${overrides.depth}km`
            );
            _trackedSpecialEntries.set(eventId, { rdt: matchingSpecial.rdt });
          }

          if (callbacks.onUpdatedEntry) {
            callbacks.onUpdatedEntry(entry, report);
          }
        }
      }
    }

    // Process VXSE61 special reports that didn't coincide with a normal report update.
    // These update magnitude/depth for an already-tracked event.
    for (const specialEntry of specialEntries) {
      const eventId = specialEntry.eid;
      const trackedSpecial = _trackedSpecialEntries.get(eventId);

      // Skip if we've already processed this exact special report
      if (trackedSpecial && trackedSpecial.rdt === specialEntry.rdt) continue;

      // Skip if we already processed it above as part of a new/updated normal entry
      // (check if it was just set in this poll cycle above)
      const justTracked = _trackedSpecialEntries.get(eventId);
      if (justTracked && justTracked.rdt === specialEntry.rdt) continue;

      // Only process if there's a tracked normal report for this event
      const trackedNormal = _trackedEntries.get(eventId);
      if (!trackedNormal) continue;

      console.log("[live-mode] VXSE61 special report detected for:", eventId);
      _trackedSpecialEntries.set(eventId, { rdt: specialEntry.rdt });

      // Re-fetch the original report and apply overrides
      const originalEntry = latestEntriesByEventId.get(eventId) || {
        eid: eventId,
        json: trackedNormal.jsonFile,
        rdt: trackedNormal.rdt,
      };

      const report = await _fetchAndParseEntry(originalEntry, areaCodes);
      if (report) {
        const overrides = parseSpecialReportOverrides(specialEntry);
        applySpecialReportOverrides(report, overrides);
        console.log(
          `[live-mode] Applied VXSE61 overrides for ${eventId}: M${overrides.magnitude}, ${overrides.depth}km`
        );

        if (callbacks.onUpdatedEntry) {
          callbacks.onUpdatedEntry(specialEntry, report);
        }
      }
    }
  } catch (err) {
    console.error("[live-mode] Polling error:", err);
    if (callbacks.onError) callbacks.onError(err);
  }
}


/**
 * Fetches and parses a single report entry.
 * Returns a parsed report object with observations, or null if error.
 */
async function _fetchAndParseEntry(entry, areaCodes) {
  try {
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
    const jmaReport = parseReport(jsonData);

    return buildDisplayReport(jmaReport, areaCodes, {
      feedRdt: entry.rdt,
      feedJson: entry.json,
    });
  } catch (err) {
    console.warn("[live-mode] Error processing entry:", entry.eid, err.message);
    return null;
  }
}
