/**
 * One-shot IXAC41 archive loader.
 *
 * At app start (after the initial report list is ready) the hosted proxy's
 * read-only API is queried once for recent IXAC41 meshes. Only meshes that
 * match an existing report are kept, and an older IXAC41 never replaces a
 * newer one for the same event. Network failures are ignored.
 */

import { PRUNE_MAX_AGE_MS } from "../constants.js";
import { getAllReports } from "../sidebarUI.js";
import { ingestIxac41Message } from "./parser.js";
import {
  attachIxac41ToEvent,
  findBestIxac41EventId,
  pruneExpiredIxac41Meshes,
  startIxac41ExpirySweeper,
} from "./store.js";

export const IXAC41_API_BASE_URL = "https://ws.kyoquake.hainaut.xyz/api/ixac41";

let _loadStarted = false;

function isExpired(timeMs, now) {
  return !Number.isFinite(timeMs) || timeMs < now - PRUNE_MAX_AGE_MS;
}

/**
 * Processes an API message list against a set of reports.
 *
 * @param {Array<Object>} messages Messages from the API list endpoint.
 * @param {Object} options
 * @param {Array<Object>} options.reports Current sidebar reports.
 * @param {(message: Object) => Promise<Array<Object>>} options.fetchParts
 * @param {number} [options.now]
 * @returns {Promise<{matchedEventIds: string[]}>}
 */
export async function processIxac41ArchiveMessages(messages, {
  reports = [],
  fetchParts,
  now = Date.now(),
} = {}) {
  if (!Array.isArray(messages) || !Array.isArray(reports) || typeof fetchParts !== "function") {
    return { matchedEventIds: [] };
  }

  const reportById = new Map(
    reports.filter((report) => report?.eventId).map((report) => [report.eventId, report]),
  );
  if (reportById.size === 0) return { matchedEventIds: [] };

  const ordered = [...messages].sort(
    (a, b) => (Date.parse(b?.time) || 0) - (Date.parse(a?.time) || 0),
  );
  const handled = new Set();

  for (const message of ordered) {
    if (!message?.id || message.complete === false) continue;
    if (isExpired(Date.parse(message.time), now)) continue;

    let parts;
    try {
      parts = await fetchParts(message);
    } catch {
      continue;
    }
    if (!Array.isArray(parts) || parts.length === 0) continue;

    let mesh = null;
    for (const part of parts) {
      const result = ingestIxac41Message(part);
      if (result.status === "parsed") mesh = result.mesh;
    }
    if (!mesh) continue;
    if (isExpired(mesh.originTimeMs ?? mesh.announcedTimeMs, now)) continue;

    const eventId = findBestIxac41EventId(
      mesh,
      reportById.keys(),
      (id) => reportById.get(id),
    );
    if (!eventId) continue;
    if (handled.has(eventId)) continue;

    attachIxac41ToEvent(eventId, mesh);
    handled.add(eventId);
  }

  return { matchedEventIds: [...handled] };
}

/**
 * Loads archived IXAC41 meshes once per app session. Unmatched or older
 * messages are dropped. Must be called after the initial report list is ready.
 */
export async function loadIxac41Archive() {
  if (_loadStarted) return;
  _loadStarted = true;

  startIxac41ExpirySweeper();
  pruneExpiredIxac41Meshes();

  const reports = getAllReports();
  if (reports.length === 0) return;

  let payload;
  try {
    const response = await fetch(IXAC41_API_BASE_URL, { cache: "no-store" });
    if (!response.ok) return;
    payload = await response.json();
  } catch {
    return;
  }

  if (!Array.isArray(payload?.messages)) return;

  const result = await processIxac41ArchiveMessages(payload.messages, {
    reports,
    fetchParts: async (message) => {
      const response = await fetch(
        `${IXAC41_API_BASE_URL}/${encodeURIComponent(message.id)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
  });

  pruneExpiredIxac41Meshes();

  if (result.matchedEventIds.length > 0 && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("ixac41-mesh-available", {
        detail: { eventIds: result.matchedEventIds },
      }),
    );
  }
}
