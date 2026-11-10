/**
 * Audio playback, configurable audio sources, and event sound routing.
 *
 * Audio sources can be:
 * - built-in: the WAV files bundled with the app
 * - upload: a file stored in IndexedDB (web only)
 * - local: a file from the desktop audio/ folder
 * - remote: an HTTP(S) URL loaded by the browser every time it plays
 *
 * Playback is intentionally non-blocking.  Each trigger uses its own key, so
 * different sounds may overlap while a repeated trigger restarts its own sound.
 */

import { checkIsDesktop, desktopListAudioFiles, desktopReadAudioFile } from "./desktopBridge.js";
import {
  FLASH_INTENSITY_TITLE,
  FLASH_EPICENTER_TITLE,
  NORMAL_TITLE,
  DISTANT_EARTHQUAKE_TITLE,
  SPECIAL_TITLE,
  LPGM_TITLE,
} from "./reportUtils.js";

const AUDIO_SOURCES_KEY = "audio-sources-v1";
const AUDIO_EVENT_SETTINGS_KEY = "audio-event-settings-v1";

const AUDIO_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".ogg",
  ".oga",
  ".m4a",
  ".aac",
  ".flac",
  ".opus",
  ".webm",
  ".weba",
];

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_UPLOAD_DURATION_SEC = 30;

// ─── Event definitions ──────────────────────────────────────────────────────

/** Report audio event identifiers. */
export const REPORT_AUDIO_EVENTS = Object.freeze({
  FLASH_INTENSITY: "report.flashIntensity",
  FLASH_EPICENTER: "report.flashEpicenter",
  NORMAL: "report.normal",
  LPGM: "report.lpgm",
  SPECIAL: "report.special",
});

/** EEW audio event identifiers. */
export const EEW_AUDIO_EVENTS = Object.freeze({
  FORECAST: "eew.forecast",
  WARNING: "eew.warning",
  UPDATE: "eew.update",
  CANCEL: "eew.cancel",
});

/**
 * All configurable audio events.
 * Report events support a separate "update" source that plays when another
 * report of the same type arrives for the same earthquake event.
 */
export const AUDIO_EVENT_DEFS = [
  {
    id: REPORT_AUDIO_EVENTS.FLASH_INTENSITY,
    label: "震度速報 · Intensity Flash",
    category: "report",
    defaultSourceId: "builtin:flash",
    hasUpdate: true,
  },
  {
    id: REPORT_AUDIO_EVENTS.FLASH_EPICENTER,
    label: "震源情報 · Epicenter Flash",
    category: "report",
    defaultSourceId: "builtin:flash",
    hasUpdate: true,
  },
  {
    id: REPORT_AUDIO_EVENTS.NORMAL,
    label: "震源・震度情報 · Normal Report",
    category: "report",
    defaultSourceId: "builtin:ping",
    hasUpdate: true,
  },
  {
    id: REPORT_AUDIO_EVENTS.LPGM,
    label: "長周期地震動 · LPGM Report",
    category: "report",
    defaultSourceId: null,
    hasUpdate: true,
  },
  {
    id: REPORT_AUDIO_EVENTS.SPECIAL,
    label: "顕著な地震 · Notable Epicenter Update",
    category: "report",
    defaultSourceId: null,
    hasUpdate: true,
  },
  {
    id: EEW_AUDIO_EVENTS.FORECAST,
    label: "EEW (予報) · Forecast",
    category: "eew",
    defaultSourceId: "builtin:eew",
    hasUpdate: false,
  },
  {
    id: EEW_AUDIO_EVENTS.WARNING,
    label: "EEW (警報) · Warning",
    category: "eew",
    defaultSourceId: null,
    hasUpdate: false,
  },
  {
    id: EEW_AUDIO_EVENTS.UPDATE,
    label: "EEW (更新) · Update",
    category: "eew",
    defaultSourceId: null,
    hasUpdate: false,
  },
  {
    id: EEW_AUDIO_EVENTS.CANCEL,
    label: "EEW (取消) · Cancelled",
    category: "eew",
    defaultSourceId: null,
    hasUpdate: false,
  },
];

/** Audio sources bundled with the app.  These can never be deleted. */
export const BUILTIN_AUDIO_SOURCES = Object.freeze([
  {
    id: "builtin:flash",
    name: "flash.wav",
    type: "builtin",
    url: "/sfx/flash.wav",
    builtin: true,
  },
  {
    id: "builtin:eew",
    name: "eew.wav",
    type: "builtin",
    url: "/sfx/eew.wav",
    builtin: true,
  },
  {
    id: "builtin:ping",
    name: "ping.wav",
    type: "builtin",
    url: "/sfx/ping.wav",
    builtin: true,
  },
]);

const EVENT_DEFAULTS = Object.freeze(
  Object.fromEntries(
    AUDIO_EVENT_DEFS.map((def) => [
      def.id,
      {
        sourceId: def.defaultSourceId ?? null,
        updateSourceId: null,
      },
    ]),
  ),
);

// ─── Small storage helpers ──────────────────────────────────────────────────

function _readJson(key, fallback) {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function _writeJson(key, value) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`[audio] Failed to save ${key}:`, err);
  }
}

function _newSourceId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function _extname(fileName) {
  const value = String(fileName || "");
  const dot = value.lastIndexOf(".");
  return dot >= 0 ? value.slice(dot).toLowerCase() : "";
}

/** Returns true for supported audio file names (no path components). */
export function isValidAudioFileName(fileName) {
  if (typeof fileName !== "string" || !fileName || fileName !== fileName.split(/[\\/]/).pop()) {
    return false;
  }
  return AUDIO_EXTENSIONS.includes(_extname(fileName));
}

function _mimeForFileName(fileName) {
  switch (_extname(fileName)) {
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
    case ".oga":
    case ".opus":
      return "audio/ogg";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".webm":
    case ".weba":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

// ─── Audio source registry ──────────────────────────────────────────────────

function _normalizeStoredSource(source) {
  if (!source || typeof source !== "object" || !source.id) return null;
  if (!["upload", "local", "remote"].includes(source.type)) return null;
  const normalized = {
    id: String(source.id),
    name: String(source.name || source.fileName || source.url || "Audio"),
    type: source.type,
    builtin: false,
  };
  if (source.type === "upload") {
    normalized.fileName = String(source.fileName || "");
  } else if (source.type === "local") {
    normalized.fileName = String(source.fileName || "");
  } else if (source.type === "remote") {
    normalized.url = String(source.url || "");
  }
  return normalized;
}

/**
 * Returns all configured sources, with the bundled sources always present.
 * @returns {Array<Object>}
 */
export function getAudioSources() {
  const stored = _readJson(AUDIO_SOURCES_KEY, []);
  const sources = new Map();

  for (const source of BUILTIN_AUDIO_SOURCES) {
    sources.set(source.id, { ...source });
  }

  if (Array.isArray(stored)) {
    for (const item of stored) {
      if (!item?.id) continue;
      if (String(item.id).startsWith("builtin:")) {
        const builtin = sources.get(item.id);
        if (builtin && item.name) builtin.name = String(item.name);
        continue;
      }
      const normalized = _normalizeStoredSource(item);
      if (normalized) sources.set(normalized.id, normalized);
    }
  }

  return [...sources.values()];
}

/** Returns one source by id, or null. */
export function getAudioSource(sourceId) {
  return getAudioSources().find((source) => source.id === sourceId) || null;
}

function _persistAudioSources(sources) {
  _writeJson(
    AUDIO_SOURCES_KEY,
    sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: source.type,
      url: source.url,
      fileName: source.fileName,
      builtin: Boolean(source.builtin || source.type === "builtin"),
    })),
  );
}

/** Adds a custom source.  Throws when the source id already exists. */
export function addAudioSource(source) {
  const sources = getAudioSources();
  if (sources.some((item) => item.id === source.id)) {
    throw new Error("An audio source with this id already exists.");
  }
  const normalized = _normalizeStoredSource(source);
  if (!normalized) throw new Error("Invalid audio source.");
  sources.push(normalized);
  _persistAudioSources(sources);
  return normalized;
}

/** Renames a source.  Works for built-in sources too. */
export function renameAudioSource(sourceId, name) {
  const sources = getAudioSources();
  const source = sources.find((item) => item.id === sourceId);
  if (!source) throw new Error("Audio source not found.");
  source.name = String(name || "").trim() || source.name;
  _persistAudioSources(sources);
  return source;
}

/** Deletes a custom source and clears any event references to it. */
export async function deleteAudioSource(sourceId) {
  const source = getAudioSource(sourceId);
  if (!source) return;
  if (source.builtin) throw new Error("Built-in audio sources cannot be deleted.");

  _persistAudioSources(getAudioSources().filter((item) => item.id !== sourceId));
  _clearEventSourceReferences(sourceId);

  if (source.type === "upload") {
    try {
      await _deleteAudioBlob(sourceId);
    } catch (err) {
      console.warn("[audio] Failed to delete uploaded audio:", err);
    }
  }
}

function _clearEventSourceReferences(sourceId) {
  if (typeof localStorage === "undefined") return;
  const stored = _readJson(AUDIO_EVENT_SETTINGS_KEY, {});
  if (!stored.events || typeof stored.events !== "object") return;
  for (const eventSettings of Object.values(stored.events)) {
    if (!eventSettings || typeof eventSettings !== "object") continue;
    if (eventSettings.sourceId === sourceId) eventSettings.sourceId = null;
    if (eventSettings.updateSourceId === sourceId) eventSettings.updateSourceId = null;
  }
  _writeJson(AUDIO_EVENT_SETTINGS_KEY, stored);
}

// ─── IndexedDB (uploaded audio) ─────────────────────────────────────────────

const IDB_NAME = "kyoquake-audio-sources";
const IDB_VERSION = 1;
const IDB_STORE = "files";
let _idbPromise = null;

function _openIdb() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable in this environment."));
  }
  if (!_idbPromise) {
    _idbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
    });
  }
  return _idbPromise;
}

async function _putAudioBlob(id, blob) {
  const db = await _openIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to store audio."));
    tx.onabort = () => reject(tx.error || new Error("Failed to store audio."));
  });
}

async function _getAudioBlob(id) {
  const db = await _openIdb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const request = tx.objectStore(IDB_STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Failed to read audio."));
  });
}

async function _deleteAudioBlob(id) {
  const db = await _openIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to delete audio."));
    tx.onabort = () => reject(tx.error || new Error("Failed to delete audio."));
  });
}

// ─── Source creation ────────────────────────────────────────────────────────

function _mediaErrorMessage(media) {
  const error = media?.error;
  if (!error) return "Unknown audio playback error.";
  const labels = {
    1: "Playback aborted.",
    2: "Network error while loading audio.",
    3: "Audio decoding failed.",
    4: "The audio format is not supported.",
  };
  return `${labels[error.code] || "Audio playback failed."}${error.message ? ` ${error.message}` : ""}`;
}

function _readMediaDuration(blob) {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("Audio duration cannot be checked in this environment."));
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = document.createElement("audio");
    let settled = false;

    const finish = (err, duration) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute("src");
      audio.load?.();
      URL.revokeObjectURL(url);
      if (err) reject(err);
      else resolve(duration);
    };

    const timer = setTimeout(
      () => finish(new Error("Timed out while reading the audio file.")),
      15000,
    );

    audio.preload = "metadata";
    audio.addEventListener(
      "loadedmetadata",
      () => {
        const duration = Number(audio.duration);
        if (Number.isFinite(duration) && duration > 0) finish(null, duration);
        else finish(new Error("Could not determine the audio duration."));
      },
      { once: true },
    );
    audio.addEventListener("error", () => finish(new Error(_mediaErrorMessage(audio))), {
      once: true,
    });
    audio.src = url;
  });
}

/**
 * Validates an uploaded file and stores it in IndexedDB.
 * @param {File} file
 * @param {string} [name]
 * @returns {Promise<Object>} The new source description
 */
export async function createUploadedAudioSource(file, name = "") {
  if (!file) throw new Error("No audio file was selected.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Audio files must be 3 MB or smaller.");
  }

  const duration = await _readMediaDuration(file);
  if (duration > MAX_UPLOAD_DURATION_SEC + 0.05) {
    throw new Error(`Audio files must be ${MAX_UPLOAD_DURATION_SEC} seconds or shorter.`);
  }

  const id = _newSourceId("upload");
  await _putAudioBlob(id, file);
  return addAudioSource({
    id,
    name: String(name || "").trim() || file.name || "Uploaded audio",
    type: "upload",
    fileName: file.name || "",
    builtin: false,
  });
}

/**
 * Creates a source that references a file in the desktop audio/ folder.
 * @param {string} fileName
 * @param {string} [name]
 * @returns {Object}
 */
export function createLocalAudioSource(fileName, name = "") {
  if (!checkIsDesktop()) throw new Error("Local audio files are only available in the desktop app.");
  if (!isValidAudioFileName(fileName)) throw new Error("Please select a valid audio file.");

  return addAudioSource({
    id: _newSourceId("local"),
    name: String(name || "").trim() || fileName,
    type: "local",
    fileName,
    builtin: false,
  });
}

/**
 * Creates a source that loads an audio file from a remote URL.
 * @param {string} url
 * @param {string} [name]
 * @returns {Object}
 */
export function createRemoteAudioSource(url, name = "") {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    throw new Error("Please enter a valid audio URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS audio URLs are supported.");
  }
  if (!parsed.hostname) throw new Error("Please enter a valid audio URL.");

  const fileName = (() => {
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    if (!segment) return parsed.hostname;
    try {
      return decodeURIComponent(segment) || parsed.hostname;
    } catch {
      return segment;
    }
  })();

  return addAudioSource({
    id: _newSourceId("remote"),
    name: String(name || "").trim() || fileName,
    type: "remote",
    url: parsed.href,
    builtin: false,
  });
}

/**
 * Lists playable files in the desktop audio/ folder.
 * @returns {Promise<string[]>}
 */
export async function listLocalAudioFiles() {
  if (!checkIsDesktop()) return [];
  try {
    const files = await desktopListAudioFiles();
    return (Array.isArray(files) ? files : []).filter(isValidAudioFileName).sort();
  } catch (err) {
    console.warn("[audio] Failed to list desktop audio files:", err);
    return [];
  }
}

// ─── Event settings ─────────────────────────────────────────────────────────

/**
 * Returns the full event audio configuration.
 * @returns {{events: Object<string, {sourceId: string|null, updateSourceId: string|null}>, eewPlayLowAccuracy: boolean}}
 */
export function getAudioEventSettings() {
  const stored = _readJson(AUDIO_EVENT_SETTINGS_KEY, {});
  const storedEvents =
    stored.events && typeof stored.events === "object" ? stored.events : {};
  const events = {};

  for (const def of AUDIO_EVENT_DEFS) {
    const current =
      storedEvents[def.id] && typeof storedEvents[def.id] === "object"
        ? storedEvents[def.id]
        : {};
    events[def.id] = {
      sourceId:
        Object.prototype.hasOwnProperty.call(current, "sourceId")
          ? current.sourceId || null
          : EVENT_DEFAULTS[def.id].sourceId,
      updateSourceId:
        Object.prototype.hasOwnProperty.call(current, "updateSourceId")
          ? current.updateSourceId || null
          : EVENT_DEFAULTS[def.id].updateSourceId,
    };
  }

  return {
    events,
    eewPlayLowAccuracy: stored.eewPlayLowAccuracy !== false,
  };
}

/**
 * Updates one audio event's source selection.
 * @param {string} eventId
 * @param {{sourceId?: string|null, updateSourceId?: string|null}} patch
 */
export function updateAudioEventSetting(eventId, patch) {
  const settings = getAudioEventSettings();
  if (!settings.events[eventId]) return;

  if (Object.prototype.hasOwnProperty.call(patch, "sourceId")) {
    settings.events[eventId].sourceId = patch.sourceId || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "updateSourceId")) {
    settings.events[eventId].updateSourceId = patch.updateSourceId || null;
  }
  _writeJson(AUDIO_EVENT_SETTINGS_KEY, settings);
}

/** Whether EEW audio should play while an EEW is low-accuracy. */
export function getEewPlayLowAccuracy() {
  return getAudioEventSettings().eewPlayLowAccuracy;
}

/** Enables or disables audio for low-accuracy EEWs. */
export function setEewPlayLowAccuracy(enabled) {
  const settings = getAudioEventSettings();
  settings.eewPlayLowAccuracy = Boolean(enabled);
  _writeJson(AUDIO_EVENT_SETTINGS_KEY, settings);
}

// ─── Playback ───────────────────────────────────────────────────────────────

/** @type {Map<string, {audio: HTMLAudioElement, objectUrl: string|null, key: string|null}>} */
const _activeByKey = new Map();
/** @type {Map<string, number>} */
const _playSequence = new Map();

async function _resolveSourceUrl(source) {
  if (!source) throw new Error("Audio source is not configured.");

  if (source.type === "builtin") {
    return { url: source.url || BUILTIN_AUDIO_SOURCES.find((item) => item.id === source.id)?.url, objectUrl: false };
  }

  if (source.type === "remote") {
    if (!source.url) throw new Error("Remote audio URL is not configured.");
    return { url: source.url, objectUrl: false };
  }

  if (source.type === "upload") {
    const blob = await _getAudioBlob(source.id);
    if (!blob) {
      throw new Error("The uploaded audio file could not be found in IndexedDB.");
    }
    return { url: URL.createObjectURL(blob), objectUrl: true };
  }

  if (source.type === "local") {
    if (!isValidAudioFileName(source.fileName)) {
      throw new Error("The local audio file name is invalid.");
    }
    const bytes = await desktopReadAudioFile(source.fileName);
    if (!bytes) throw new Error("The local audio file could not be read.");
    const blob = new Blob([bytes], { type: _mimeForFileName(source.fileName) });
    return { url: URL.createObjectURL(blob), objectUrl: true };
  }

  throw new Error(`Unknown audio source type: ${source.type}`);
}

function _stopEntry(entry) {
  if (!entry) return;
  try {
    entry.audio.pause();
    entry.audio.currentTime = 0;
  } catch {
    // The media element may already be in an invalid state.
  }
  if (entry.objectUrl) {
    try {
      URL.revokeObjectURL(entry.objectUrl);
    } catch {
      // Ignore revoke failures.
    }
  }
  if (entry.key && _activeByKey.get(entry.key) === entry) {
    _activeByKey.delete(entry.key);
  }
}

/**
 * Plays an audio source.  Playback errors reject; callers decide whether to
 * log them (event triggers) or show them to the user (test button).
 *
 * @param {Object} source
 * @param {{key?: string|null, waitForStart?: boolean, logErrors?: boolean}} [options]
 * @returns {Promise<void>}
 */
export async function playAudioSource(source, options = {}) {
  const { key = null, waitForStart = false, logErrors = false } = options;
  const sequence = key ? (_playSequence.get(key) || 0) + 1 : 0;
  if (key) _playSequence.set(key, sequence);

  let resolved;
  try {
    resolved = await _resolveSourceUrl(source);
  } catch (err) {
    if (logErrors) {
      console.warn(`[audio] Failed to prepare "${source?.name || source?.id || "audio"}":`, err);
    }
    throw err;
  }

  if (key && _playSequence.get(key) !== sequence) {
    if (resolved.objectUrl) URL.revokeObjectURL(resolved.url);
    return;
  }

  if (key) {
    const previous = _activeByKey.get(key);
    if (previous) _stopEntry(previous);
  }

  const audio = new Audio(resolved.url);
  audio.preload = "auto";

  const entry = {
    audio,
    objectUrl: resolved.objectUrl ? resolved.url : null,
    key,
  };
  if (key) _activeByKey.set(key, entry);

  const cleanup = () => {
    if (entry.objectUrl) {
      try {
        URL.revokeObjectURL(entry.objectUrl);
      } catch {
        // Ignore revoke failures.
      }
      entry.objectUrl = null;
    }
    if (entry.key && _activeByKey.get(entry.key) === entry) {
      _activeByKey.delete(entry.key);
    }
  };

  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener(
    "error",
    () => {
      cleanup();
      if (logErrors) {
        console.warn(`[audio] Failed to play "${source?.name || source?.id || "audio"}":`, _mediaErrorMessage(audio));
      }
    },
    { once: true },
  );

  if (waitForStart) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.removeEventListener("playing", onPlaying);
        audio.removeEventListener("error", onError);
        if (err) {
          _stopEntry(entry);
          reject(err);
        } else {
          resolve();
        }
      };
      const onPlaying = () => finish(null);
      const onError = () => finish(new Error(_mediaErrorMessage(audio)));
      const timer = setTimeout(
        () => finish(new Error("Timed out while loading the audio file.")),
        15000,
      );
      audio.addEventListener("playing", onPlaying, { once: true });
      audio.addEventListener("error", onError, { once: true });
      Promise.resolve(audio.play()).catch((err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });
    });
    return;
  }

  try {
    await audio.play();
  } catch (err) {
    cleanup();
    if (logErrors) {
      console.warn(`[audio] Failed to play "${source?.name || source?.id || "audio"}":`, err);
    }
    throw err;
  }
}

/** Plays a configured event sound.  Errors are logged as warnings. */
export function playAudioEvent(eventId, { key = eventId, variant = "main" } = {}) {
  const settings = getAudioEventSettings();
  const eventSettings = settings.events[eventId];
  if (!eventSettings) return;

  const sourceId =
    variant === "update" ? eventSettings.updateSourceId : eventSettings.sourceId;
  if (!sourceId) return;

  const source = getAudioSource(sourceId);
  if (!source) {
    console.warn(`[audio] Audio source "${sourceId}" for ${eventId} no longer exists.`);
    return;
  }

  playAudioSource(source, { key, logErrors: true }).catch(() => {
    // playAudioSource() already logged the warning.
  });
}

/** Tests a source and rejects with the playback error. */
export async function testAudioSource(source) {
  await playAudioSource(source, {
    key: `test:${source?.id || "unknown"}`,
    waitForStart: true,
    logErrors: false,
  });
}

/** Maps a live-mode entry / display report to its report audio event. */
export function getReportAudioEventId(entry, report) {
  const ttl = entry?.ttl;

  if (ttl === LPGM_TITLE) return REPORT_AUDIO_EVENTS.LPGM;
  if (ttl === SPECIAL_TITLE) return REPORT_AUDIO_EVENTS.SPECIAL;

  if (report?.isFlashReport) {
    return report.flashType === "epicenter"
      ? REPORT_AUDIO_EVENTS.FLASH_EPICENTER
      : REPORT_AUDIO_EVENTS.FLASH_INTENSITY;
  }

  if (ttl === FLASH_INTENSITY_TITLE) return REPORT_AUDIO_EVENTS.FLASH_INTENSITY;
  if (ttl === FLASH_EPICENTER_TITLE) return REPORT_AUDIO_EVENTS.FLASH_EPICENTER;
  if (ttl === NORMAL_TITLE || ttl === DISTANT_EARTHQUAKE_TITLE) {
    return REPORT_AUDIO_EVENTS.NORMAL;
  }

  if (report && !report.isFlashReport) return REPORT_AUDIO_EVENTS.NORMAL;
  return null;
}

const REPORT_AUDIO_STATE_SEPARATOR = "\u0000";
/** @type {Map<string, {mainPlayed: boolean}>} */
const _reportAudioState = new Map();

function _reportStateKey(eventType, eventId) {
  return `${eventType}${REPORT_AUDIO_STATE_SEPARATOR}${eventId || ""}`;
}

/**
 * Plays the configured sound for a received live report.
 * The main sound is played once per report type and earthquake event.  Later
 * reports of the same type use the optional update sound.
 */
export function playReportAudio(entry, report) {
  const eventType = getReportAudioEventId(entry, report);
  if (!eventType) return;

  const stateKey = _reportStateKey(eventType, report?.eventId);
  const state = _reportAudioState.get(stateKey) || { mainPlayed: false };
  const eventSettings = getAudioEventSettings().events[eventType];
  if (!eventSettings) return;

  if (!state.mainPlayed) {
    state.mainPlayed = true;
    _reportAudioState.set(stateKey, state);
    playAudioEvent(eventType, { key: eventType });
    return;
  }

  if (eventSettings.updateSourceId) {
    playAudioEvent(eventType, { key: eventType, variant: "update" });
  }
}

/**
 * Marks reports loaded at startup as already heard, so their first live update
 * does not play the main sound again.  Reports that already include VXSE61 or
 * VXSE62 data seed those event types too; live mode reprocesses the underlying
 * feed entries once after startup and would otherwise replay their main sound.
 */
export function seedReportAudioState(report) {
  if (!report) return;
  const seed = (eventType) => {
    if (!eventType) return;
    _reportAudioState.set(_reportStateKey(eventType, report.eventId), {
      mainPlayed: true,
    });
  };

  seed(getReportAudioEventId(null, report));
  if (report.hasSpecialReport) seed(REPORT_AUDIO_EVENTS.SPECIAL);
  if (report.lpgmInfo || report.isLpgm) seed(REPORT_AUDIO_EVENTS.LPGM);
}

if (typeof document !== "undefined") {
  document.addEventListener("reports-pruned", (event) => {
    const removedIds = event.detail?.removedIds;
    if (!removedIds) return;
    for (const key of [..._reportAudioState.keys()]) {
      const [, eventId] = key.split(REPORT_AUDIO_STATE_SEPARATOR);
      if (removedIds.has(eventId)) _reportAudioState.delete(key);
    }
  });
}
