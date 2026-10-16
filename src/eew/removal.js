/**
 * Timing policy for removing EEWs from the active list.
 *
 * An EEW is removed once it is cancelled, or shortly after its final report.
 * If the final report never arrives (e.g. due to a network drop), the EEW is
 * removed 8 minutes after the last non-final, non-cancel message.
 */

export const EEW_CANCEL_REMOVE_MS = 15 * 1000;
export const EEW_FINAL_REMOVE_MS = 3 * 60 * 1000;
export const EEW_STALE_REMOVE_MS = 8 * 60 * 1000;

/**
 * Returns how long an EEW should remain visible after the given message.
 *
 * @param {Object} msg Normalized EEW message.
 * @returns {number} Delay in milliseconds.
 */
export function getEewRemovalDelay(msg) {
  if (msg?.Flag?.is_cancel) return EEW_CANCEL_REMOVE_MS;
  if (msg?.Flag?.is_final) return EEW_FINAL_REMOVE_MS;
  return EEW_STALE_REMOVE_MS;
}

/**
 * Cancels a pending removal timer on an active EEW entry.
 *
 * @param {Object} eew Active EEW entry.
 */
export function clearEewRemoval(eew) {
  if (eew?.removalTimer) {
    clearTimeout(eew.removalTimer);
    eew.removalTimer = null;
  }
}

/**
 * (Re)schedules the removal timer stored on an active EEW entry.
 * Every message replaces the previous timer, so the deadline is always measured
 * from the most recent message.
 *
 * @param {Object} eew Active EEW entry.
 * @param {Object} msg Normalized EEW message.
 * @param {Function} onRemove Called when the timer fires.
 * @returns {*} The timer handle, or null when there is no EEW entry.
 */
export function scheduleEewRemoval(eew, msg, onRemove) {
  if (!eew) return null;
  clearEewRemoval(eew);
  eew.removalTimer = setTimeout(() => {
    eew.removalTimer = null;
    onRemove();
  }, getEewRemovalDelay(msg));
  return eew.removalTimer;
}
