/**
 * Live mode controller: Polls the JMA XML Atom feed for new/updated earthquake
 * entries and also accepts reports pushed over the AXIS `jmx-seismology`
 * WebSocket channel.
 *
 * Both sources feed the same tracking maps, so a report received from one
 * source is not processed again when the other source delivers it.  Reports
 * are compared by their JMA report version (Head/ReportDateTime + Serial),
 * which is stable across the XML feed, JSON feed and AXIS.
 *
 * Also handles flash reports (震度速報/震源速報) for events without a normal
 * report.
 */

import { FEED_DATA_BASE_URL, POLL_INTERVAL } from "./constants.js";
import {
  parseSpecialReportOverrides,
  applySpecialReportOverrides,
} from "./parseReports.js";
import {
  buildDisplayReport,
  parseReport,
  FLASH_INTENSITY_TITLE,
  FLASH_EPICENTER_TITLE,
  NORMAL_TITLE,
  DISTANT_EARTHQUAKE_TITLE,
  SPECIAL_TITLE,
  LPGM_TITLE,
  buildFlashIntensityReport,
  buildFlashEpicenterReport,
  parseFlashIntensityJson,
} from "./reportUtils.js";
import { parseLpgmXml } from "./lpgmUtils.js";
import {
  normalizeAxisMessage,
  axisMessageToJmaJson,
  parseAxisIntensity,
  parseAxisLpgm,
} from "./axisReports.js";
import JMAEarthquakeReport from "./jmaEarthquakeReport.js";
import { fetchXmlFeedEntries, parseFlashIntensityXml } from "./xmlFeedParser.js";
import { isDesktop, desktopFetch } from "./desktopBridge.js";

/**
 * Tracks the last seen normal reports.
 * Map of eventId -> {
 *   version: { reportTime: string|null, serial: string|number|null },
 *   entry: Object|null,
 *   report: Object,
 *   jsonFile: string|null
 * }
 */
let _trackedEntries = new Map();

/**
 * Tracks flash report entries (震度速報/震源速報) we've processed.
 * Map of eventId -> {
 *   intensityVersion: { reportTime, serial }|null,
 *   epicenterVersion: { reportTime, serial }|null,
 *   intensityEntry: Object|null,
 *   epicenterEntry: Object|null,
 *   intensityData: { maxIntensity: string|null, observations: Array }|null
 * }
 *
 * `intensityData` is the parsed 震度速報 payload.  The source entry's XML DOM
 * is released after parsing (see _buildFlashReportForLive), so this parsed
 * copy must be kept around for later rebuilds when the 震源速報 arrives.
 */
let _trackedFlashEntries = new Map();

/**
 * Tracks VXSE61 special report versions we've already processed.
 * Map of eventId -> { version, entry }
 */
let _trackedSpecialEntries = new Map();

/**
 * Tracks LPGM report versions we've already processed.
 * Map of eventId -> { version, entry }
 */
let _trackedLpgmEntries = new Map();

/**
 * Latest special/LPGM entry seen for each event, even if its normal report has
 * not arrived yet.  They are applied when the normal report is built.
 */
let _latestSpecialEntries = new Map();
let _latestLpgmEntries = new Map();

/**
 * AXIS messages received while live mode is enabled but not initialized yet
 * (for example while the initial JSON reports are still loading).
 */
let _pendingAxisEntries = [];

let _pollingTimeoutId = null;
let _currentInterval = POLL_INTERVAL;
let _isActive = false;

let _areaCodes = null;
let _callbacks = null;

/** Serializes polling and AXIS ingestion so the two sources cannot race. */
let _taskQueue = Promise.resolve();

// ─── Version helpers ────────────────────────────────────────────────────────

/** Parses a timestamp, returning milliseconds or null. */
function _parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Normalizes a serial value for comparison. */
function _serialValue(value) {
  if (value == null || value === "") return null;
  const num = Number.parseInt(String(value), 10);
  return Number.isNaN(num) ? String(value) : num;
}

/** Returns the comparable version of a normalized entry. */
function _versionFromEntry(entry) {
  if (!entry) return null;
  return {
    reportTime: entry.reportDateTime || entry.rdt || null,
    serial: entry.serial ?? entry.ser ?? null,
  };
}

/** Returns the comparable version of an initial JSON display report. */
function _versionFromReport(report) {
  if (!report) return null;
  return {
    reportTime: report.feedRdt || null,
    serial: report.feedSerial ?? null,
  };
}

/**
 * Compares two report versions.
 * @returns {number} negative if a is older, positive if a is newer, 0 if equal
 */
function _compareVersions(a, b) {
  const aMs = _parseTimestamp(a?.reportTime);
  const bMs = _parseTimestamp(b?.reportTime);
  if (aMs == null && bMs == null) return 0;
  if (aMs == null) return -1;
  if (bMs == null) return 1;
  if (aMs !== bMs) return aMs - bMs;

  const aSerial = _serialValue(a?.serial);
  const bSerial = _serialValue(b?.serial);
  if (aSerial == null || bSerial == null) return 0;
  if (typeof aSerial === "number" && typeof bSerial === "number") {
    return aSerial - bSerial;
  }
  return String(aSerial).localeCompare(String(bSerial));
}

function _isNewerVersion(incoming, tracked) {
  if (!incoming) return false;
  if (!tracked) return true;
  return _compareVersions(incoming, tracked) > 0;
}

/** Picks the newer of two entries (current source vs tracked entry). */
function _pickLatestEntry(current, tracked) {
  if (!current) return tracked || null;
  if (!tracked) return current;
  return _compareVersions(_versionFromEntry(current), _versionFromEntry(tracked)) >= 0
    ? current
    : tracked;
}

// ─── Task queue ─────────────────────────────────────────────────────────────

/**
 * Runs a live-mode task after all previously queued tasks.  The returned
 * promise never rejects; failures are logged so the queue keeps working.
 */
function _enqueueLiveTask(task) {
  const run = _taskQueue.then(task, task);
  _taskQueue = run.catch((err) => {
    console.warn("[live-mode] Live task failed:", err);
  });
  return _taskQueue;
}

// ─── Public lifecycle ───────────────────────────────────────────────────────

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
  _areaCodes = areaCodes;
  _callbacks = callbacks;

  // Initialize tracked entries with initial reports.  Do not overwrite entries
  // tracked from a previous live session, which may be newer.
  for (const report of initialReports) {
    if (!report.eventId || !report.feedRdt) continue;

    if (report.isFlashReport) {
      if (_trackedFlashEntries.has(report.eventId)) continue;
      const version = _versionFromReport(report);
      _trackedFlashEntries.set(report.eventId, {
        intensityVersion:
          report.flashType === "intensity" || report.maxIntensity
            ? version
            : null,
        epicenterVersion: report.flashType === "epicenter" ? version : null,
        intensityEntry: null,
        epicenterEntry: null,
        // Preserve observations from an initial JSON-sourced flash report so
        // they can be merged into a later epicenter flash report.
        intensityData:
          report.maxIntensity || report.observations?.length
            ? {
                maxIntensity: report.maxIntensity || null,
                observations: report.observations || [],
              }
            : null,
      });
    } else if (!_trackedEntries.has(report.eventId)) {
      _trackedEntries.set(report.eventId, {
        version: _versionFromReport(report),
        entry: null,
        report,
        jsonFile: report.feedJson || null,
      });
    }
  }

  _currentInterval = POLL_INTERVAL;

  // Process AXIS reports that arrived before the initial load finished.
  _flushPendingAxisEntries();

  if (_pollingTimeoutId === null) {
    if (isDesktop) {
      // Start immediately for Desktop to align timing with server right away
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
  _areaCodes = null;
  _callbacks = null;
  _pendingAxisEntries = [];
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
    _trackedLpgmEntries.delete(id);
    _latestSpecialEntries.delete(id);
    _latestLpgmEntries.delete(id);
  }
  if (_pendingAxisEntries.length > 0) {
    _pendingAxisEntries = _pendingAxisEntries.filter(
      (entry) => !eventIdsToRemove.has(entry.eid),
    );
  }
}

document.addEventListener("reports-pruned", (e) => {
  if (e.detail?.removedIds) {
    pruneTrackedEntries(e.detail.removedIds);
  }
});

// ─── AXIS ingestion ─────────────────────────────────────────────────────────

/**
 * Ingests a `jmx-seismology` AXIS message into live mode.
 *
 * The EEW module only calls this when the AXIS reports setting and Live Mode
 * are both enabled.  Messages received before live mode has finished starting
 * are buffered briefly and processed during startLivePolling().
 *
 * @param {Object} message - AXIS `message` payload
 * @returns {boolean} True when the message was accepted for processing
 */
export function ingestAxisMessage(message) {
  const entry = normalizeAxisMessage(message);
  if (!entry) return false;

  if (!_isActive || !_areaCodes || !_callbacks) {
    _pendingAxisEntries.push(entry);
    if (_pendingAxisEntries.length > 100) _pendingAxisEntries.shift();
    return true;
  }

  const areaCodes = _areaCodes;
  const callbacks = _callbacks;
  _enqueueLiveTask(() => _processExternalEntry(entry, areaCodes, callbacks));
  return true;
}

function _flushPendingAxisEntries() {
  if (!_pendingAxisEntries.length || !_isActive || !_areaCodes || !_callbacks) {
    return;
  }
  const areaCodes = _areaCodes;
  const callbacks = _callbacks;
  const pending = _pendingAxisEntries.splice(0);
  for (const entry of pending) {
    _enqueueLiveTask(() => _processExternalEntry(entry, areaCodes, callbacks));
  }
}

async function _processExternalEntry(entry, areaCodes, callbacks) {
  if (!_isActive) return;
  const eventId = entry.eid;
  if (!eventId) return;

  switch (entry.ttl) {
    case NORMAL_TITLE:
    case DISTANT_EARTHQUAKE_TITLE: {
      const tracked = _trackedEntries.get(eventId);
      const version = _versionFromEntry(entry);
      if (tracked && !_isNewerVersion(version, tracked.version)) return;

      await _handleNormalEntry({
        eventId,
        entry,
        version,
        isNew: !tracked,
        hadFlashReport: _trackedFlashEntries.has(eventId),
        areaCodes,
        callbacks,
      });
      return;
    }

    case FLASH_INTENSITY_TITLE:
      if (_trackedEntries.has(eventId)) return;
      await _handleSingleFlashEvent(eventId, entry, null, areaCodes, callbacks);
      return;

    case FLASH_EPICENTER_TITLE:
      if (_trackedEntries.has(eventId)) return;
      await _handleSingleFlashEvent(eventId, null, entry, areaCodes, callbacks);
      return;

    case SPECIAL_TITLE:
      _storeLatestSpecial(entry);
      await _processSpecialOverrides([entry], callbacks);
      return;

    case LPGM_TITLE:
      _storeLatestLpgm(entry);
      await _processStandaloneLpgm(new Map([[eventId, entry]]), callbacks);
      return;

    default:
      console.debug("[live-mode] Ignoring unsupported AXIS report type:", entry.ttl);
  }
}

// ─── Poll cycle ─────────────────────────────────────────────────────────────

function _runPollCycle(areaCodes, callbacks) {
  _pollingTimeoutId = null;
  if (!_isActive) return;

  _enqueueLiveTask(() => _pollLatestFeed(areaCodes, callbacks))
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
 * Groups entries by event ID, keeping only the newest entry based on its JMA
 * report version.
 * @param {Array<Object>} entries
 * @returns {Map<string, Object>}
 */
function _groupLatestByEid(entries) {
  const map = new Map();
  for (const entry of entries) {
    const eventId = entry.eid;
    if (!eventId) continue;

    const current = map.get(eventId);
    if (
      !current ||
      _compareVersions(_versionFromEntry(entry), _versionFromEntry(current)) > 0
    ) {
      map.set(eventId, entry);
    }
  }
  return map;
}

/**
 * Categorizes feed entries into specific target, special, LPGM, and flash collections.
 * @param {Array<Object>} entries
 * @returns {Object}
 */
function _categorizeFeedEntries(entries) {
  const targetEntries = entries.filter(
    (entry) =>
      (entry.ttl === NORMAL_TITLE || entry.ttl === DISTANT_EARTHQUAKE_TITLE) &&
      (entry.json || entry._xmlDoc || entry._xmlUrl) &&
      entry.rdt,
  );
  const specialEntries = entries.filter(
    (entry) => entry.ttl === SPECIAL_TITLE && entry.eid && entry.rdt,
  );
  const lpgmEntries = entries.filter(
    (entry) => entry.ttl === LPGM_TITLE && entry.eid && entry.rdt,
  );
  const flashIntensityEntries = entries.filter(
    (entry) => entry.ttl === FLASH_INTENSITY_TITLE && entry.eid && entry.rdt,
  );
  const flashEpicenterEntries = entries.filter(
    (entry) => entry.ttl === FLASH_EPICENTER_TITLE && entry.eid && entry.rdt,
  );

  return {
    latestTargetByEid: _groupLatestByEid(targetEntries),
    specialEntries,
    latestLpgmByEid: _groupLatestByEid(lpgmEntries),
    latestFlashIntensityByEid: _groupLatestByEid(flashIntensityEntries),
    latestFlashEpicenterByEid: _groupLatestByEid(flashEpicenterEntries),
  };
}

// ─── Special / LPGM state ───────────────────────────────────────────────────

function _storeLatestSpecial(entry) {
  const current = _latestSpecialEntries.get(entry.eid);
  if (
    !current ||
    _isNewerVersion(_versionFromEntry(entry), _versionFromEntry(current))
  ) {
    _latestSpecialEntries.set(entry.eid, entry);
  }
}

function _storeLatestLpgm(entry) {
  const current = _latestLpgmEntries.get(entry.eid);
  if (
    !current ||
    _isNewerVersion(_versionFromEntry(entry), _versionFromEntry(current))
  ) {
    _latestLpgmEntries.set(entry.eid, entry);
  }
}

function _markSpecialProcessed(entry) {
  _trackedSpecialEntries.set(entry.eid, {
    version: _versionFromEntry(entry),
    entry,
  });
}

function _markLpgmProcessed(entry) {
  _trackedLpgmEntries.set(entry.eid, {
    version: _versionFromEntry(entry),
    entry,
  });
}

/** Parses and caches LPGM observation data from an XML or AXIS entry. */
function _getLpgmInfo(lpgmEntry) {
  if (!lpgmEntry) return null;
  if (lpgmEntry._lpgmInfo) return lpgmEntry._lpgmInfo;

  let info = null;
  try {
    if (lpgmEntry._xmlDoc) {
      info = parseLpgmXml(lpgmEntry._xmlDoc);
      lpgmEntry._xmlDoc = null;
    } else if (lpgmEntry._axisMessage) {
      info = parseAxisLpgm(lpgmEntry._axisMessage);
      lpgmEntry._axisMessage = null;
    }
  } catch (err) {
    console.warn("[live-mode] Failed to parse LPGM report:", lpgmEntry.eid, err.message);
  }

  if (info) lpgmEntry._lpgmInfo = info;
  return info;
}

/**
 * Applies the latest known special/LPGM data to a newly-built normal report.
 * A special report older than the normal report itself is ignored because a
 * newer normal report already supersedes it.
 */
function _applyLatestOverridesToReport(report, eventId, baseVersion) {
  const special = _latestSpecialEntries.get(eventId);
  if (special) {
    const specialVersion = _versionFromEntry(special);
    if (!baseVersion || _compareVersions(specialVersion, baseVersion) >= 0) {
      const overrides = parseSpecialReportOverrides(special);
      applySpecialReportOverrides(report, overrides);
      console.debug(
        `[live-mode] Applied VXSE61 overrides to report ${eventId}: M${overrides.magnitude}, ${overrides.depth}km`,
      );
    }
    _markSpecialProcessed(special);
  }

  const lpgm = _latestLpgmEntries.get(eventId);
  if (lpgm) {
    const info = _getLpgmInfo(lpgm);
    if (info) {
      report.lpgmInfo = info;
      _markLpgmProcessed(lpgm);
    }
  }

  return report;
}

/** Shallow-clones a display report so updates do not mutate the sidebar copy. */
function _cloneDisplayReport(report) {
  return {
    ...report,
    observations: Array.isArray(report.observations)
      ? [...report.observations]
      : report.observations,
  };
}

// ─── Normal reports ─────────────────────────────────────────────────────────

/**
 * Handles a single new or updated normal report entry.
 */
async function _handleNormalEntry({
  eventId,
  entry,
  version,
  isNew,
  hadFlashReport,
  areaCodes,
  callbacks,
}) {
  const logPrefix = isNew ? "New entry detected:" : "Updated entry detected:";
  console.info(`[live-mode] ${logPrefix}`, eventId);

  const report = await _fetchAndParseEntry(entry, areaCodes);
  if (!report) return;

  _applyLatestOverridesToReport(report, eventId, version);

  _trackedEntries.set(eventId, {
    version,
    entry,
    report,
    jsonFile: entry.json || null,
  });

  if (hadFlashReport) {
    console.debug("[live-mode] Normal report overwrites flash for:", eventId);
    _trackedFlashEntries.delete(eventId);
    if (callbacks.onUpdatedEntry) {
      callbacks.onUpdatedEntry(entry, report);
    }
  } else if (isNew) {
    if (callbacks.onNewEntry) {
      callbacks.onNewEntry(entry, report);
    }
  } else if (callbacks.onUpdatedEntry) {
    callbacks.onUpdatedEntry(entry, report);
  }
}

/**
 * Processes normal report entries from the feed.
 * @returns {Promise<Set<string>>} Set of event IDs that received a normal report this cycle.
 */
async function _processNormalEntries(latestTargetByEid, areaCodes, callbacks) {
  const normalReportEventIds = new Set();

  for (const [eventId, entry] of latestTargetByEid) {
    const trackedEntry = _trackedEntries.get(eventId);
    const version = _versionFromEntry(entry);
    const isNew = !trackedEntry;

    if (trackedEntry && !_isNewerVersion(version, trackedEntry.version)) continue;

    normalReportEventIds.add(eventId);
    await _handleNormalEntry({
      eventId,
      entry,
      version,
      isNew,
      hadFlashReport: _trackedFlashEntries.has(eventId),
      areaCodes,
      callbacks,
    });
  }

  return normalReportEventIds;
}

/**
 * Processes standalone VXSE61 special reports for already-tracked events.
 */
async function _processSpecialOverrides(specialEntries, callbacks) {
  for (const specialEntry of specialEntries) {
    const eventId = specialEntry.eid;
    _storeLatestSpecial(specialEntry);

    const version = _versionFromEntry(specialEntry);
    const trackedSpecial = _trackedSpecialEntries.get(eventId);
    if (trackedSpecial && !_isNewerVersion(version, trackedSpecial.version)) {
      continue;
    }

    const trackedNormal = _trackedEntries.get(eventId);
    if (!trackedNormal?.report) continue;

    _markSpecialProcessed(specialEntry);

    if (_compareVersions(version, trackedNormal.version) < 0) {
      console.debug("[live-mode] Ignoring stale VXSE61 for:", eventId);
      continue;
    }

    console.info("[live-mode] VXSE61 special report detected for:", eventId);
    const report = _cloneDisplayReport(trackedNormal.report);
    const overrides = parseSpecialReportOverrides(specialEntry);
    applySpecialReportOverrides(report, overrides);
    trackedNormal.report = report;
    console.debug(
      `[live-mode] Applied VXSE61 overrides for ${eventId}: M${overrides.magnitude}, ${overrides.depth}km`,
    );

    if (callbacks.onUpdatedEntry) {
      callbacks.onUpdatedEntry(specialEntry, report);
    }
  }
}

/**
 * Processes standalone LPGM reports for already-tracked events.
 */
async function _processStandaloneLpgm(latestLpgmEntriesByEid, callbacks) {
  for (const lpgmEntry of latestLpgmEntriesByEid.values()) {
    const eventId = lpgmEntry.eid;
    _storeLatestLpgm(lpgmEntry);

    const version = _versionFromEntry(lpgmEntry);
    const trackedLpgm = _trackedLpgmEntries.get(eventId);
    if (trackedLpgm && !_isNewerVersion(version, trackedLpgm.version)) {
      continue;
    }

    const trackedNormal = _trackedEntries.get(eventId);
    if (!trackedNormal?.report) continue;

    const info = _getLpgmInfo(lpgmEntry);
    if (!info) continue;

    _markLpgmProcessed(lpgmEntry);
    console.info("[live-mode] LPGM report detected for:", eventId);

    const report = _cloneDisplayReport(trackedNormal.report);
    report.lpgmInfo = info;
    trackedNormal.report = report;

    if (callbacks.onUpdatedEntry) {
      callbacks.onUpdatedEntry(lpgmEntry, report);
    }
  }
}

// ─── Flash reports ──────────────────────────────────────────────────────────

/**
 * Handles a single flash event (new or updated).
 */
async function _handleSingleFlashEvent(
  eid,
  currentIntensityEntry,
  currentEpicenterEntry,
  areaCodes,
  callbacks,
) {
  const trackedFlash = _trackedFlashEntries.get(eid);
  const intensityEntry = _pickLatestEntry(
    currentIntensityEntry,
    trackedFlash?.intensityEntry,
  );
  const epicenterEntry = _pickLatestEntry(
    currentEpicenterEntry,
    trackedFlash?.epicenterEntry,
  );
  const bestEntry = epicenterEntry || intensityEntry;
  const bestType = epicenterEntry ? "epicenter" : "intensity";
  const cachedIntensityData = trackedFlash?.intensityData || null;

  const intensityVersion = _versionFromEntry(intensityEntry);
  const epicenterVersion = _versionFromEntry(epicenterEntry);

  if (!trackedFlash) {
    console.info(`[live-mode] New flash report detected (${bestType}):`, eid);
    const flashReport = await _buildFlashReportForLive(
      eid,
      intensityEntry,
      epicenterEntry,
      areaCodes,
      cachedIntensityData,
    );
    if (flashReport) {
      _trackedFlashEntries.set(eid, {
        intensityVersion,
        epicenterVersion,
        intensityEntry,
        epicenterEntry,
        intensityData: intensityEntry?._flashIntensityData || cachedIntensityData,
      });
      if (callbacks.onNewEntry) {
        callbacks.onNewEntry(bestEntry, flashReport);
      }
    }
    return;
  }

  const isNewIntensity =
    intensityEntry &&
    _isNewerVersion(intensityVersion, trackedFlash.intensityVersion);
  const isNewEpicenter =
    epicenterEntry &&
    _isNewerVersion(epicenterVersion, trackedFlash.epicenterVersion);

  if (isNewIntensity || isNewEpicenter) {
    console.debug(`[live-mode] Updated flash report detected for ${eid}:`, {
      isNewIntensity,
      isNewEpicenter,
    });
    const flashReport = await _buildFlashReportForLive(
      eid,
      intensityEntry,
      epicenterEntry,
      areaCodes,
      cachedIntensityData,
    );
    if (flashReport) {
      _trackedFlashEntries.set(eid, {
        intensityVersion:
          intensityVersion || trackedFlash.intensityVersion || null,
        epicenterVersion:
          epicenterVersion || trackedFlash.epicenterVersion || null,
        intensityEntry,
        epicenterEntry,
        intensityData: intensityEntry?._flashIntensityData || cachedIntensityData,
      });
      if (callbacks.onUpdatedEntry) {
        callbacks.onUpdatedEntry(bestEntry, flashReport);
      }
    }
  }
}

/**
 * Processes flash reports for events without a normal report.
 */
async function _processFlashReports(
  latestFlashIntensityByEid,
  latestFlashEpicenterByEid,
  normalReportEventIds,
  areaCodes,
  callbacks,
) {
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
    await _handleSingleFlashEvent(
      eid,
      latestFlashIntensityByEid.get(eid),
      latestFlashEpicenterByEid.get(eid),
      areaCodes,
      callbacks,
    );
  }
}

// ─── Feed polling ───────────────────────────────────────────────────────────

/**
 * Fetches the latest XML feed and detects new/updated entries.
 * Uses the JMA Atom XML feed (eqvol.xml) instead of the JSON feed.
 */
async function _pollLatestFeed(areaCodes, callbacks = {}) {
  if (!_isActive) return;
  try {
    const options = {};
    if (isDesktop) {
      options.desktopFetch = desktopFetch;
      options.tauriFetch = desktopFetch; // backward compatibility
    }

    const { entries, nextIntervalMs, notModified } = await fetchXmlFeedEntries(options);

    if (!_isActive) return nextIntervalMs;
    if (notModified) {
      return nextIntervalMs;
    }

    const categorized = _categorizeFeedEntries(entries);

    // Remember special/LPGM reports before normal reports are built, so a
    // normal report in the same poll can include them.
    for (const entry of categorized.specialEntries) _storeLatestSpecial(entry);
    for (const entry of categorized.latestLpgmByEid.values()) _storeLatestLpgm(entry);

    const normalReportEventIds = await _processNormalEntries(
      categorized.latestTargetByEid,
      areaCodes,
      callbacks,
    );

    await _processSpecialOverrides(categorized.specialEntries, callbacks);
    await _processStandaloneLpgm(categorized.latestLpgmByEid, callbacks);
    await _processFlashReports(
      categorized.latestFlashIntensityByEid,
      categorized.latestFlashEpicenterByEid,
      normalReportEventIds,
      areaCodes,
      callbacks,
    );

    return nextIntervalMs;
  } catch (err) {
    console.error("[live-mode] Polling error:", err);
    if (callbacks.onError) callbacks.onError(err);
  }
}

// ─── Report building ────────────────────────────────────────────────────────

/**
 * Builds the best available flash report for live mode.
 * Supports XML-sourced entries (with _xmlDoc), AXIS entries (with
 * _axisMessage) and JSON entries.
 *
 * Parsed 震度速報 data is cached on the entry (and passed in as
 * `cachedIntensityData`) because the XML DOM is released after parsing.  A
 * later 震源速報 must rebuild this report while keeping the observations.
 */
async function _buildFlashReportForLive(
  eid,
  intensityEntry,
  epicenterEntry,
  areaCodes,
  cachedIntensityData = null,
) {
  let intensityData = intensityEntry?._flashIntensityData || null;

  // If we have a 震度速報, extract area-level observations
  if (intensityEntry?._xmlDoc) {
    // XML path: parse directly from the already-fetched XML doc
    try {
      intensityData = parseFlashIntensityXml(intensityEntry._xmlDoc);
      intensityEntry._flashIntensityData = intensityData;
    } catch (err) {
      console.warn("[live-mode] Failed to parse 震度速報 XML for", eid, err.message);
    }
    intensityEntry._xmlDoc = null;
  } else if (!intensityData && intensityEntry?._axisMessage) {
    // AXIS path: parse the transposed JSON report
    try {
      intensityData = parseAxisIntensity(intensityEntry._axisMessage);
      intensityEntry._flashIntensityData = intensityData;
    } catch (err) {
      console.warn("[live-mode] Failed to parse 震度速報 AXIS for", eid, err.message);
    }
    intensityEntry._axisMessage = null;
  } else if (!intensityData && intensityEntry?.json) {
    // JSON fallback path
    try {
      const reportUrl = FEED_DATA_BASE_URL + intensityEntry.json;
      const res = await fetch(reportUrl, { method: "GET", mode: "cors", cache: "no-cache" });
      if (res.ok) {
        const jsonData = await res.json();
        intensityData = parseFlashIntensityJson(jsonData);
        intensityEntry._flashIntensityData = intensityData;
      }
    } catch (err) {
      console.warn("[live-mode] Failed to fetch 震度速報 JSON for", eid, err.message);
    }
  }

  // Keep observations from the previously processed intensity flash if the
  // current entry no longer carries (or never had) a parseable source.
  if (!intensityData && cachedIntensityData) {
    intensityData = cachedIntensityData;
  }

  // If we have a 震源速報, build from that + carry observations
  if (epicenterEntry) {
    const latestRdt =
      intensityEntry &&
      (!epicenterEntry.rdt ||
        _compareVersions(
          _versionFromEntry(intensityEntry),
          _versionFromEntry(epicenterEntry),
        ) > 0)
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
 * Supports XML entries (with _xmlDoc), AXIS entries (with _axisMessage) and
 * JSON entries (with json field).
 * Returns a parsed report object with observations, or null if error.
 */
async function _fetchAndParseEntry(entry, areaCodes) {
  try {
    let displayReport = null;

    // XML path: the entry already carries the parsed XML document
    if (entry._xmlDoc) {
      const jmaReport = JMAEarthquakeReport.fromXmlDoc(entry._xmlDoc);
      displayReport = buildDisplayReport(jmaReport, areaCodes, {
        feedRdt: entry.rdt,
        feedSerial: entry.serial ?? entry.ser ?? null,
        feedJson: entry.json || null,
        ttl: entry.ttl,
        fallbackName: entry.anm,
      });
      entry._xmlDoc = null;
    }

    // AXIS path: convert the XML-transposed JSON to the flattened JMA schema
    if (!displayReport && entry._axisMessage) {
      const jsonData = axisMessageToJmaJson(entry._axisMessage);
      if (jsonData) {
        const jmaReport = JMAEarthquakeReport.fromJSON(jsonData);
        displayReport = buildDisplayReport(jmaReport, areaCodes, {
          feedRdt: entry.rdt,
          feedSerial: entry.serial ?? entry.ser ?? null,
          feedJson: null,
          ttl: entry.ttl,
          fallbackName: entry.anm,
        });
        entry._axisMessage = null;
      }
    }

    // JSON fallback path
    if (!displayReport && entry.json) {
      const reportUrl = FEED_DATA_BASE_URL + entry.json;
      const res = await fetch(reportUrl, {
        method: "GET",
        mode: "cors",
        cache: "no-cache",
      });

      if (!res.ok) {
        console.warn(`[live-mode] Failed to fetch report: ${reportUrl} (${res.status})`);
        return null;
      }

      const jsonData = await res.json();
      const jmaReport = parseReport(jsonData);

      displayReport = buildDisplayReport(jmaReport, areaCodes, {
        feedRdt: entry.rdt,
        feedSerial: entry.serial ?? entry.ser ?? null,
        feedJson: entry.json,
        ttl: entry.ttl,
        fallbackName: entry.anm,
      });
    }

    if (!displayReport) {
      console.warn("[live-mode] Entry has neither _xmlDoc, _axisMessage nor json:", entry.eid);
      return null;
    }

    return displayReport;
  } catch (err) {
    console.warn("[live-mode] Error processing entry:", entry.eid, err.message);
    return null;
  }
}
