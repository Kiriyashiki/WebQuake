/**
 * Live mode controller: Polls the latest feed for new/updated earthquake entries.
 * Compares entries by their 'updated' timestamp and triggers callbacks for changes.
 */

import { FEED_URL_LATEST, POLL_INTERVAL } from "./constants.js";

/**
 * Tracks the last seen entries with their updated timestamps.
 * Map of eventId -> { updated: ISO string, linkUrl: string }
 */
let _trackedEntries = new Map();

let _pollingIntervalId = null;

/**
 * Starts live mode polling.
 * 
 * @param {Map} areaCodes - Area code name mappings
 * @param {Object} callbacks - Callback functions:
 *   - onNewEntry(entry, report): Called when a new entry is detected
 *   - onUpdatedEntry(entry, report): Called when an entry is updated
 *   - onError(err): Called if polling fails
 */
export function startLivePolling(areaCodes, callbacks = {}) {
  if (_pollingIntervalId !== null) {
    console.warn("[live-mode] Polling already active");
    return;
  }

  console.log("[live-mode] Starting polling...");

  // Do initial poll immediately
  _pollLatestFeed(areaCodes, callbacks);

  // Then set up interval polling
  _pollingIntervalId = setInterval(() => {
    _pollLatestFeed(areaCodes, callbacks);
  }, POLL_INTERVAL);
}

/**
 * Stops live mode polling.
 */
export function stopLivePolling() {
  if (_pollingIntervalId !== null) {
    clearInterval(_pollingIntervalId);
    _pollingIntervalId = null;
    console.log("[live-mode] Polling stopped");
  }
}

/**
 * Gets whether live mode is currently polling.
 * @returns {boolean}
 */
export function isPolling() {
  return _pollingIntervalId !== null;
}

// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * Fetches the latest feed and detects new/updated entries.
 */
async function _pollLatestFeed(areaCodes, callbacks = {}) {
  try {
    const entries = await _fetchFeedEntries(FEED_URL_LATEST);

    // Filter for VXSE53 entries only
    const targetEntries = entries.filter(
      (entry) =>
        entry.title === "震源・震度に関する情報" &&
        entry.link &&
        entry.updated
    );

    for (const entry of targetEntries) {
      // Parse event ID from link URL or id field
      const eventId = _extractEventIdFromEntry(entry);
      if (!eventId) continue;

      const trackedEntry = _trackedEntries.get(eventId);

      if (!trackedEntry) {
        // NEW ENTRY
        console.log("[live-mode] New entry detected:", eventId);
        _trackedEntries.set(eventId, {
          updated: entry.updated,
          linkUrl: entry.link,
        });

        // Fetch and parse the report
        const report = await _fetchAndParseEntry(entry, areaCodes);
        if (report && callbacks.onNewEntry) {
          callbacks.onNewEntry(entry, report);
        }
      } else if (entry.updated !== trackedEntry.updated) {
        // UPDATED ENTRY
        console.log("[live-mode] Updated entry detected:", eventId);
        _trackedEntries.set(eventId, {
          updated: entry.updated,
          linkUrl: entry.link,
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

/**
 * Fetches and parses a feed XML, returning array of entry objects.
 * Each entry has { title, id, link, content, updated }.
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

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "application/xml");

    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      throw new Error(`Feed XML parse error: ${parseError.textContent}`);
    }

    const entries = [];
    for (const entry of doc.getElementsByTagName("entry")) {
      const title =
        entry.getElementsByTagName("title")[0]?.textContent?.trim() || "";
      const id =
        entry.getElementsByTagName("id")[0]?.textContent?.trim() || "";
      const updated =
        entry.getElementsByTagName("updated")[0]?.textContent?.trim() || "";

      // Get link href (type="application/xml")
      let link = "";
      for (const l of entry.getElementsByTagName("link")) {
        if (l.getAttribute("type") === "application/xml") {
          link = l.getAttribute("href") || "";
          break;
        }
      }

      const content =
        entry.getElementsByTagName("content")[0]?.textContent?.trim() || "";

      entries.push({ title, id, updated, link, content });
    }

    return entries;
  } catch (err) {
    console.error(`Error fetching feed ${feedUrl}:`, err);
    throw err;
  }
}

/**
 * Extracts event ID from a feed entry (from the XML report filename in the link).
 * Example: https://...20260525081825_0_VXSE53_010000.xml -> "20260525081825"
 */
function _extractEventIdFromEntry(entry) {
  if (!entry.link) return null;
  const match = entry.link.match(/(\d{14})_0_VXSE53_/);
  return match ? match[1] : null;
}

/**
 * Fetches and parses a single report entry.
 * Returns a parsed report object with observations, or null if error.
 */
async function _fetchAndParseEntry(entry, areaCodes) {
  try {
    // Import here to avoid circular dependency
    const JMAEarthquakeReport = (await import("./jmaEarthquakeReport.js")).default;

    const res = await fetch(entry.link, {
      method: "GET",
      mode: "cors",
      cache: "no-cache",
    });

    if (!res.ok) {
      console.warn(
        `[live-mode] Failed to fetch report: ${entry.link} (${res.status})`
      );
      return null;
    }

    const xmlText = await res.text();
    const jmaReport = new JMAEarthquakeReport(xmlText);

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
    };
  } catch (err) {
    console.warn("[live-mode] Error processing entry:", entry.id, err.message);
    return null;
  }
}
