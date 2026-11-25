/**
 * In-memory store for parsed IXAC41 meshes and report matching.
 */

import { PRUNE_MAX_AGE_MS } from "../constants.js";

const MAX_PENDING_MESHES = 20;
const EXPIRY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let _sweepTimer = null;

/** @type {Map<string, Object>} */
const meshesByEventId = new Map();

/** @type {Object[]} */
let pendingMeshes = [];

function haversineKm(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every((value) => Number.isFinite(value))) return null;
  const radius = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function meshTimeMs(mesh) {
  if (Number.isFinite(mesh?.originTimeMs)) return mesh.originTimeMs;
  if (Number.isFinite(mesh?.announcedTimeMs)) return mesh.announcedTimeMs;
  if (Number.isFinite(mesh?.receivedAt)) return mesh.receivedAt;
  return null;
}

function meshAnnouncedMs(mesh) {
  if (Number.isFinite(mesh?.announcedTimeMs)) return mesh.announcedTimeMs;
  const parsed = Date.parse(mesh?.announcedTime || "");
  if (Number.isFinite(parsed)) return parsed;
  return Number.isFinite(mesh?.receivedAt) ? mesh.receivedAt : 0;
}

/**
 * Drops meshes that are outside the sidebar's age window.
 * @param {number} [now]
 * @returns {number} Number of removed meshes.
 */
export function pruneExpiredIxac41Meshes(now = Date.now()) {
  const cutoff = now - PRUNE_MAX_AGE_MS;
  let removed = 0;

  for (const [eventId, mesh] of meshesByEventId) {
    const time = meshTimeMs(mesh);
    if (!Number.isFinite(time) || time < cutoff) {
      meshesByEventId.delete(eventId);
      removed += 1;
    }
  }

  const pendingBefore = pendingMeshes.length;
  pendingMeshes = pendingMeshes.filter((mesh) => {
    const time = meshTimeMs(mesh);
    return Number.isFinite(time) && time >= cutoff;
  });
  removed += pendingBefore - pendingMeshes.length;

  return removed;
}

/**
 * Starts a low-frequency sweep so old meshes are discarded even without UI
 * activity. Safe to call repeatedly.
 */
export function startIxac41ExpirySweeper(intervalMs = EXPIRY_SWEEP_INTERVAL_MS) {
  if (_sweepTimer || typeof setInterval === "undefined") return;
  _sweepTimer = setInterval(() => pruneExpiredIxac41Meshes(), intervalMs);
  if (typeof _sweepTimer?.unref === "function") _sweepTimer.unref();
}

export function stopIxac41ExpirySweeper() {
  if (!_sweepTimer) return;
  clearInterval(_sweepTimer);
  _sweepTimer = null;
}

export function scoreIxac41MeshForReport(mesh, report) {
  let score = 0;

  if (
    mesh.epicenterCode != null &&
    report?.hypocenterCode != null &&
    Number(mesh.epicenterCode) === Number(report.hypocenterCode)
  ) {
    score += 100;
  }

  const distance = haversineKm(
    mesh.epicenterLat,
    mesh.epicenterLon,
    report?.coordinates?.latitude,
    report?.coordinates?.longitude,
  );
  if (distance != null) score += Math.max(0, 50 - distance);

  if (mesh.originTimeMs != null && report?.originTime != null) {
    const deltaSec = Math.abs(mesh.originTimeMs / 1000 - report.originTime);
    if (deltaSec <= 60) score += 50;
    else if (deltaSec <= 180) score += 20;
  }

  return score;
}

/**
 * Returns the best matching mesh for a report. Exact event-ID matches win.
 * Otherwise a pending mesh with the same JST origin minute is reused when
 * unambiguous, or scored by epicenter information.
 *
 * @param {{eventId?: string, originTime?: number, hypocenterCode?: number,
 *   coordinates?: {latitude:number, longitude:number}}} report
 * @returns {Object|null}
 */
export function getIxac41MeshForReport(report) {
  if (!report?.eventId) return null;
  pruneExpiredIxac41Meshes();

  const exact = meshesByEventId.get(report.eventId);
  if (exact) return exact;

  const prefix = String(report.eventId).slice(0, 12);
  const candidates = pendingMeshes.filter((mesh) => mesh.originTimeJstPrefix === prefix);
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    meshesByEventId.set(report.eventId, candidates[0]);
    pendingMeshes = pendingMeshes.filter((mesh) => mesh !== candidates[0]);
    return candidates[0];
  }

  const ranked = candidates
    .map((mesh) => ({ mesh, score: scoreIxac41MeshForReport(mesh, report) }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length > 0) {
    meshesByEventId.set(report.eventId, ranked[0].mesh);
    pendingMeshes = pendingMeshes.filter((mesh) => mesh !== ranked[0].mesh);
    return ranked[0].mesh;
  }
  return null;
}

/**
 * Returns all event IDs whose origin minute matches the mesh.
 * @param {Object} mesh
 * @param {Iterable<string>} eventIds
 * @returns {string[]}
 */
export function findIxac41EventIds(mesh, eventIds) {
  if (!mesh?.originTimeJstPrefix) return [];
  return [...eventIds].filter(
    (eventId) => typeof eventId === "string" && eventId.startsWith(mesh.originTimeJstPrefix),
  );
}

/**
 * Picks the best event ID for a mesh, using epicenter/origin-time scoring when
 * more than one event shares the same origin minute.
 *
 * @param {Object} mesh
 * @param {Iterable<string>} eventIds
 * @param {(eventId: string) => Object|undefined|null} [getReport]
 * @returns {string|null}
 */
export function findBestIxac41EventId(mesh, eventIds, getReport = null) {
  const matches = findIxac41EventIds(mesh, eventIds);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  return matches
    .map((eventId) => {
      const report = getReport?.(eventId);
      return {
        eventId,
        score: report ? scoreIxac41MeshForReport(mesh, report) : 0,
      };
    })
    .sort((a, b) => b.score - a.score)[0].eventId;
}

/**
 * Stores a mesh for a known event. Older IXAC41 messages never replace a newer
 * one for the same event.
 *
 * @param {string} eventId
 * @param {Object} mesh
 * @returns {Object} The mesh that remains stored.
 */
export function attachIxac41ToEvent(eventId, mesh) {
  if (!eventId || !mesh) return null;
  pruneExpiredIxac41Meshes();

  const existing = meshesByEventId.get(eventId);
  if (existing && meshAnnouncedMs(existing) >= meshAnnouncedMs(mesh)) {
    pendingMeshes = pendingMeshes.filter((item) => item !== mesh);
    return existing;
  }

  meshesByEventId.set(eventId, mesh);
  pendingMeshes = pendingMeshes.filter((item) => item !== mesh);
  return mesh;
}

/**
 * Keeps a mesh until a matching report appears.
 * @param {Object} mesh
 */
export function addPendingIxac41Mesh(mesh) {
  if (!mesh) return;
  pruneExpiredIxac41Meshes();
  if (pendingMeshes.includes(mesh)) return;
  pendingMeshes.push(mesh);
  if (pendingMeshes.length > MAX_PENDING_MESHES) pendingMeshes.shift();
  if (pendingMeshes.length > 1) {
    pendingMeshes.sort((a, b) => meshAnnouncedMs(b) - meshAnnouncedMs(a));
  }
}

/**
 * Whether a report has a displayable mesh.
 * @param {Object} report
 * @returns {boolean}
 */
export function hasIxac41MeshForReport(report) {
  return Boolean(getIxac41MeshForReport(report));
}

/**
 * Removes meshes for pruned reports.
 * @param {Set<string>} eventIds
 */
export function pruneIxac41Meshes(eventIds) {
  if (!eventIds?.size) return;
  for (const eventId of eventIds) {
    meshesByEventId.delete(eventId);
  }
  pendingMeshes = pendingMeshes.filter((mesh) => {
    if (!mesh?.originTimeJstPrefix) return true;
    for (const eventId of eventIds) {
      if (String(eventId).startsWith(mesh.originTimeJstPrefix)) return false;
    }
    return true;
  });
}

/**
 * Clears all meshes. Intended for tests.
 */
export function resetIxac41Store() {
  meshesByEventId.clear();
  pendingMeshes = [];
  stopIxac41ExpirySweeper();
}
