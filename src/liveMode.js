/**
 * Live mode controller: Polls the JMA XML Atom feed for new/updated earthquake entries.
 * Compares entries by their 'rdt' timestamp and triggers callbacks for changes.
 * Also handles flash reports (震度速報/震源速報) for events without a normal report.
 *
 * Initial load uses JSON (via parseReports.js). Periodic live polling uses the
 * XML feed (eqvol.xml) and fetches individual XML reports (VXSE51/52/53/61).
 */

import { FEED_DATA_BASE_URL, POLL_INTERVAL, XML_FEED_URL } from "./constants.js";
import {
  SPECIAL_REPORT_TITLE,
  parseSpecialReportOverrides,
  applySpecialReportOverrides,
} from "./parseReports.js";
import {
  buildDisplayReport,
  parseReport,
  FLASH_INTENSITY_TITLE,
  FLASH_EPICENTER_TITLE,
  buildFlashIntensityReport,
  buildFlashEpicenterReport,
  parseFlashIntensityJson,
} from "./reportUtils.js";
import JMAEarthquakeReport from "./jmaEarthquakeReport.js";
import { fetchXmlFeedEntries, parseFlashIntensityXml } from "./xmlFeedParser.js";

const IS_TAURI = Boolean(window.__TAURI_INTERNALS__);
let tauriFetch = null;
if (IS_TAURI) {
  import("@tauri-apps/plugin-http").then((mod) => {
    tauriFetch = mod.fetch;
  }).catch((err) => {
    console.warn("[live-mode] Failed to load Tauri HTTP plugin.", err);
  });
}

/**
 * Tracks the last seen normal report entries with their updated timestamps.
 * Map of eventId -> { rdt: ISO string, jsonFile: string }
 */
let _trackedEntries = new Map();

/**
 * Tracks flash report entries (震度速報/震源速報) we've processed.
 * Map of eventId -> {
 *   intensityRdt: ISO string|null,
 *   epicenterRdt: ISO string|null,
 *   intensityEntry: Object|null,
 *   epicenterEntry: Object|null
 * }
 */
let _trackedFlashEntries = new Map();

/**
 * Tracks VXSE61 special report entries we've already processed.
 * Map of eventId -> { rdt: ISO string }
 */
let _trackedSpecialEntries = new Map();

let _pollingTimeoutId = null;
let _syncTimeoutId = null;
let _currentInterval = POLL_INTERVAL;
let _isActive = false;

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
  if (_isActive) {
    console.warn("[live-mode] Polling already active");
    return;
  }

  console.info("[live-mode] Starting polling...");
  _isActive = true;

  // Initialize tracked entries with initial reports
  for (const report of initialReports) {
    if (report.eventId && report.feedRdt) {
      if (report.isFlashReport) {
        _trackedFlashEntries.set(report.eventId, {
          intensityRdt: report.flashType === 'intensity' ? report.feedRdt : (report.maxIntensity ? report.feedRdt : null),
          epicenterRdt: report.flashType === 'epicenter' ? report.feedRdt : null,
          intensityEntry: null,
          epicenterEntry: null,
        });
      } else {
        _trackedEntries.set(report.eventId, {
          rdt: report.feedRdt,
          jsonFile: report.feedJson || null,
        });
      }
    }
  }

  _currentInterval = POLL_INTERVAL;
  if (_pollingTimeoutId === null) {
    if (IS_TAURI) {
      // Start immediately for Tauri to align timing with server right away
      _runPollCycle(areaCodes, callbacks);
    } else {
      _pollingTimeoutId = setTimeout(() => {
        _runPollCycle(areaCodes, callbacks);
      }, _currentInterval);
    }
  }
}

/**
 * Stops live mode polling.
 */
export function stopLivePolling() {
  _isActive = false;
  if (_pollingTimeoutId !== null) {
    clearTimeout(_pollingTimeoutId);
    _pollingTimeoutId = null;
  }
  console.info("[live-mode] Polling stopped");
}

/**
 * Gets whether live mode is currently polling.
 * @returns {boolean}
 */
export function isPolling() {
  return _isActive;
}

/**
 * Removes tracked entries for the given event IDs.
 * Called when the sidebar prunes old reports to keep tracking Maps in sync.
 * @param {Set<string>} eventIdsToRemove
 */
export function pruneTrackedEntries(eventIdsToRemove) {
  for (const id of eventIdsToRemove) {
    _trackedEntries.delete(id);
    _trackedFlashEntries.delete(id);
    _trackedSpecialEntries.delete(id);
  }
}

document.addEventListener('reports-pruned', (e) => {
  if (e.detail?.removedIds) {
    pruneTrackedEntries(e.detail.removedIds);
  }
});

// ─── Private helpers ──────────────────────────────────────────────────────

function _runPollCycle(areaCodes, callbacks) {
  _pollingTimeoutId = null;
  if (!_isActive) return;

  _pollLatestFeed(areaCodes, callbacks)
    .then((nextIntervalMs) => {
      if (nextIntervalMs) {
        _currentInterval = nextIntervalMs;
      }
    })
    .catch((err) => {
      // In case of error, default back to POLL_INTERVAL
      _currentInterval = POLL_INTERVAL;
      console.warn("[live-mode] Error during poll, falling back to static interval", err);
    })
    .finally(() => {
      if (_isActive && _pollingTimeoutId === null) {
        _pollingTimeoutId = setTimeout(() => {
          _runPollCycle(areaCodes, callbacks);
        }, _currentInterval);
      }
    });
}

/**
 * Fetches the latest XML feed and detects new/updated entries.
 * Uses the JMA Atom XML feed (eqvol.xml) instead of the JSON feed.
 */
async function _pollLatestFeed(areaCodes, callbacks = {}) {
  try {
    const options = {};
    if (IS_TAURI) {
      if (!tauriFetch) {
        const mod = await import("@tauri-apps/plugin-http");
        tauriFetch = mod.fetch;
      }
      options.tauriFetch = tauriFetch;
    }

    const { entries, nextIntervalMs, notModified } = await fetchXmlFeedEntries(options);

    if (notModified) {
      return nextIntervalMs;
    }

    // Filter for target entries only (震源・震度情報)
    // In XML mode, entries have _xmlDoc instead of json
    const targetEntries = entries.filter(
      (entry) =>
        entry.ttl === "震源・震度情報" &&
        (entry.json || entry._xmlDoc) &&
        entry.rdt
    );

    // Collect VXSE61 special report entries from the feed
    const specialEntries = entries.filter(
      (entry) => entry.ttl === SPECIAL_REPORT_TITLE && entry.eid && entry.rdt
    );

    // Collect flash report entries from the feed
    const flashIntensityEntries = entries.filter(
      (entry) => entry.ttl === FLASH_INTENSITY_TITLE && entry.eid && entry.rdt
    );
    const flashEpicenterEntries = entries.filter(
      (entry) => entry.ttl === FLASH_EPICENTER_TITLE && entry.eid && entry.rdt
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

    // Group flash entries by event ID, keep newest of each type
    const latestFlashIntensityByEid = new Map();
    for (const entry of flashIntensityEntries) {
      if (!entry.eid) continue;
      const current = latestFlashIntensityByEid.get(entry.eid);
      if (!current || new Date(entry.rdt) > new Date(current.rdt)) {
        latestFlashIntensityByEid.set(entry.eid, entry);
      }
    }
    const latestFlashEpicenterByEid = new Map();
    for (const entry of flashEpicenterEntries) {
      if (!entry.eid) continue;
      const current = latestFlashEpicenterByEid.get(entry.eid);
      if (!current || new Date(entry.rdt) > new Date(current.rdt)) {
        latestFlashEpicenterByEid.set(entry.eid, entry);
      }
    }

    // Track which event IDs got a normal report in this cycle
    const normalReportEventIds = new Set();

    // Process only the latest entry for each event ID
    for (const [eventId, entry] of latestEntriesByEventId) {
      const trackedEntry = _trackedEntries.get(eventId);
      const hadFlashReport = _trackedFlashEntries.has(eventId);

      if (!trackedEntry) {
        // NEW ENTRY (normal report)
        console.info("[live-mode] New entry detected:", eventId);
        _trackedEntries.set(eventId, {
          rdt: entry.rdt,
          jsonFile: entry.json || null,
        });
        normalReportEventIds.add(eventId);

        // Parse the report (XML doc is already fetched)
        const report = await _fetchAndParseEntry(entry, areaCodes);
        if (report) {
          // Check if a VXSE61 special report already exists for this event
          const matchingSpecial = specialEntries.find((s) => s.eid === eventId);
          if (matchingSpecial) {
            const overrides = parseSpecialReportOverrides(matchingSpecial);
            applySpecialReportOverrides(report, overrides);
            console.debug(
              `[live-mode] Applied VXSE61 overrides to new report ${eventId}: M${overrides.magnitude}, ${overrides.depth}km`
            );
            _trackedSpecialEntries.set(eventId, { rdt: matchingSpecial.rdt });
          }

          if (hadFlashReport) {
            // Normal report overwrites a prior flash report
            console.debug("[live-mode] Normal report overwrites flash for:", eventId);
            _trackedFlashEntries.delete(eventId);
            if (callbacks.onUpdatedEntry) {
              callbacks.onUpdatedEntry(entry, report);
            }
          } else if (callbacks.onNewEntry) {
              callbacks.onNewEntry(entry, report);
            }
        }
      } else if (entry.rdt !== trackedEntry.rdt) {
        // UPDATED ENTRY
        console.info("[live-mode] Updated entry detected:", eventId);
        _trackedEntries.set(eventId, {
          rdt: entry.rdt,
          jsonFile: entry.json || null,
        });
        normalReportEventIds.add(eventId);

        // Fetch and parse the updated report
        const report = await _fetchAndParseEntry(entry, areaCodes);
        if (report) {
          // Check if a VXSE61 special report exists for this event
          const matchingSpecial = specialEntries.find((s) => s.eid === eventId);
          if (matchingSpecial) {
            const overrides = parseSpecialReportOverrides(matchingSpecial);
            applySpecialReportOverrides(report, overrides);
            console.debug(
              `[live-mode] Applied VXSE61 overrides to updated report ${eventId}: M${overrides.magnitude}, ${overrides.depth}km`
            );
            _trackedSpecialEntries.set(eventId, { rdt: matchingSpecial.rdt });
          }

          // Clear flash tracking since normal report takes over
          if (_trackedFlashEntries.has(eventId)) {
            _trackedFlashEntries.delete(eventId);
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

      console.info("[live-mode] VXSE61 special report detected for:", eventId);
      _trackedSpecialEntries.set(eventId, { rdt: specialEntry.rdt });

      // Re-fetch the original report and apply overrides
      // For standalone special reports, we need to re-fetch the original report.
      // In XML mode this may require re-fetching if the xmlDoc is not available.
      const originalEntry = latestEntriesByEventId.get(eventId) || {
        eid: eventId,
        json: trackedNormal.jsonFile,
        rdt: trackedNormal.rdt,
      };

      const report = await _fetchAndParseEntry(originalEntry, areaCodes);
      if (report) {
        const overrides = parseSpecialReportOverrides(specialEntry);
        applySpecialReportOverrides(report, overrides);
        console.debug(
          `[live-mode] Applied VXSE61 overrides for ${eventId}: M${overrides.magnitude}, ${overrides.depth}km`
        );

        if (callbacks.onUpdatedEntry) {
          callbacks.onUpdatedEntry(specialEntry, report);
        }
      }
    }

    // ─── Process flash reports for events without a normal report ──────────
    // Collect all event IDs that have flash entries but no normal report
    const flashEventIds = new Set();
    for (const eid of latestFlashIntensityByEid.keys()) {
      if (!_trackedEntries.has(eid) && !normalReportEventIds.has(eid)) {
        flashEventIds.add(eid);
      }
    }
    for (const eid of latestFlashEpicenterByEid.keys()) {
      if (!_trackedEntries.has(eid) && !normalReportEventIds.has(eid)) {
        flashEventIds.add(eid);
      }
    }

    for (const eid of flashEventIds) {
      const currentIntensityEntry = latestFlashIntensityByEid.get(eid);
      const currentEpicenterEntry = latestFlashEpicenterByEid.get(eid);

      // Check if we already tracked this flash report
      const trackedFlash = _trackedFlashEntries.get(eid);

      // Merge current entries with cached tracked entries in case one dropped out of the immediate feed window
      const intensityEntry = currentIntensityEntry || trackedFlash?.intensityEntry || null;
      const epicenterEntry = currentEpicenterEntry || trackedFlash?.epicenterEntry || null;

      // Determine the "best" flash entry and type
      const bestEntry = epicenterEntry || intensityEntry;
      const bestType = epicenterEntry ? 'epicenter' : 'intensity';

      if (!trackedFlash) {
        // New flash report
        console.info(`[live-mode] New flash report detected (${bestType}):`, eid);
        const flashReport = await _buildFlashReportForLive(
          eid, intensityEntry, epicenterEntry, areaCodes
        );
        if (flashReport) {
          _trackedFlashEntries.set(eid, {
            intensityRdt: intensityEntry?.rdt || null,
            epicenterRdt: epicenterEntry?.rdt || null,
            intensityEntry,
            epicenterEntry,
          });
          if (callbacks.onNewEntry) {
            callbacks.onNewEntry(bestEntry, flashReport);
          }
        }
      } else {
        // Check if there is new/updated information:
        // 1. A new or updated intensity report has arrived (e.g., arrived after epicenter)
        const isNewIntensity =
          currentIntensityEntry &&
          currentIntensityEntry.rdt !== trackedFlash.intensityRdt;
        // 2. A new or updated epicenter report has arrived (e.g., arrived after intensity)
        const isNewEpicenter =
          currentEpicenterEntry &&
          currentEpicenterEntry.rdt !== trackedFlash.epicenterRdt;

        if (isNewIntensity || isNewEpicenter) {
          console.debug(`[live-mode] Updated flash report detected for ${eid}:`, {
            isNewIntensity,
            isNewEpicenter,
          });
          const flashReport = await _buildFlashReportForLive(
            eid, intensityEntry, epicenterEntry, areaCodes
          );
          if (flashReport) {
            _trackedFlashEntries.set(eid, {
              intensityRdt: intensityEntry?.rdt || trackedFlash.intensityRdt || null,
              epicenterRdt: epicenterEntry?.rdt || trackedFlash.epicenterRdt || null,
              intensityEntry,
              epicenterEntry,
            });
            if (callbacks.onUpdatedEntry) {
              callbacks.onUpdatedEntry(bestEntry, flashReport);
            }
          }
        }
      }
    }

    return nextIntervalMs;
  } catch (err) {
    console.error("[live-mode] Polling error:", err);
    if (callbacks.onError) callbacks.onError(err);
  }
}

/**
 * Builds the best available flash report for live mode.
 * Supports both XML-sourced entries (with _xmlDoc) and JSON entries.
 */
async function _buildFlashReportForLive(eid, intensityEntry, epicenterEntry, areaCodes) {
  let intensityData = null;

  // If we have a 震度速報, extract area-level observations
  if (intensityEntry?._xmlDoc) {
    // XML path: parse directly from the already-fetched XML doc
    try {
      intensityData = parseFlashIntensityXml(intensityEntry._xmlDoc);
    } catch (err) {
      console.warn('[live-mode] Failed to parse 震度速報 XML for', eid, err.message);
    }
  } else if (intensityEntry?.json) {
    // JSON fallback path
    try {
      const reportUrl = FEED_DATA_BASE_URL + intensityEntry.json;
      const res = await fetch(reportUrl, { method: 'GET', mode: 'cors', cache: 'no-cache' });
      if (res.ok) {
        const jsonData = await res.json();
        intensityData = parseFlashIntensityJson(jsonData);
      }
    } catch (err) {
      console.warn('[live-mode] Failed to fetch 震度速報 JSON for', eid, err.message);
    }
  }

  // If we have a 震源速報, build from that + carry observations
  if (epicenterEntry) {
    const latestRdt = (intensityEntry?.rdt && (!epicenterEntry.rdt || intensityEntry.rdt > epicenterEntry.rdt))
      ? intensityEntry.rdt
      : epicenterEntry.rdt;

    const report = buildFlashEpicenterReport(
      epicenterEntry,
      areaCodes,
      intensityData?.observations || [],
      intensityData?.maxIntensity || null,
    );
    if (latestRdt) report.feedRdt = latestRdt;
    return report;
  }

  // Otherwise fall back to 震度速報 only
  if (intensityEntry && intensityData) {
    return buildFlashIntensityReport(intensityEntry, intensityData);
  }

  return null;
}


/**
 * Parses a single report entry into a display-ready report.
 * Supports both XML-sourced entries (with _xmlDoc) and JSON entries (with json field).
 * Returns a parsed report object with observations, or null if error.
 */
async function _fetchAndParseEntry(entry, areaCodes) {
  try {
    // XML path: the entry already carries the parsed XML document
    if (entry._xmlDoc) {
      const jmaReport = JMAEarthquakeReport.fromXmlDoc(entry._xmlDoc);
      return buildDisplayReport(jmaReport, areaCodes, {
        feedRdt: entry.rdt,
        feedJson: entry.json || null,
      });
    }

    // JSON fallback path (used when re-fetching tracked entries that
    // were originally loaded from JSON during initial load)
    if (entry.json) {
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
    }

    console.warn("[live-mode] Entry has neither _xmlDoc nor json:", entry.eid);
    return null;
  } catch (err) {
    console.warn("[live-mode] Error processing entry:", entry.eid, err.message);
    return null;
  }
}
