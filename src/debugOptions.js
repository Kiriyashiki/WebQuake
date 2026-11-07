import { AXIS_REPORT_CHANNEL } from "./constants.js";
import {
  checkIsDesktop,
  desktopClearDebugLog,
  desktopDebugLog,
} from "./desktopBridge.js";

const DEBUG_OPTIONS_STORAGE_KEY = "debug-options-enabled";
const DEBUG_LOGGING_STORAGE_KEY = "debug-log-enabled";

/**
 * The exact, case-sensitive preset name that toggles the debug menu.
 */
export const DEBUG_OPTIONS_TOGGLE_COMMAND = "debug_options";

let _debugUI = null;

function readFlag(key) {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(key) === "true";
}

function writeFlag(key, enabled) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, enabled ? "true" : "false");
}

/**
 * Whether the hidden debug options menu has been enabled.
 * Debug options are only available in desktop builds where files can be written.
 * @returns {boolean}
 */
export function isDebugOptionsEnabled() {
  return checkIsDesktop() && readFlag(DEBUG_OPTIONS_STORAGE_KEY);
}

/**
 * Whether raw EEW messages should currently be appended to debug.log.
 * @returns {boolean}
 */
export function isDebugLoggingEnabled() {
  return isDebugOptionsEnabled() && readFlag(DEBUG_LOGGING_STORAGE_KEY);
}

/**
 * Enables or disables raw EEW message logging.
 * @param {boolean} enabled
 */
export function setDebugLoggingEnabled(enabled) {
  writeFlag(DEBUG_LOGGING_STORAGE_KEY, enabled);
  const toggle = document.getElementById("debug-log-toggle");
  if (toggle) toggle.checked = Boolean(enabled) && isDebugOptionsEnabled();
}

/**
 * Returns true when the parsed websocket payload is an EEW message or an AXIS
 * jmx-seismology earthquake report.
 * @param {*} data
 * @returns {boolean}
 */
function isLoggableEewMessage(data) {
  if (!data || typeof data !== "object") return false;
  if (data.channel === "eew" && data.message) return true;
  if (data.channel === AXIS_REPORT_CHANNEL && data.message) return true;
  // DMDSS EEW Client sends its EEW payloads directly as { type: "eew", ... }.
  if (data.type === "eew") return true;
  return false;
}

/**
 * Appends a raw EEW websocket message to debug.log as minified JSON.
 * Messages are written one per line. Errors are intentionally swallowed so
 * debug logging can never interfere with message handling.
 * @param {Object|string} raw Parsed payload or raw JSON string.
 */
export function logEewDebugMessage(raw) {
  if (!isDebugLoggingEnabled()) return;

  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
  }

  if (!isLoggableEewMessage(data)) return;

  let line;
  try {
    line = JSON.stringify(data);
  } catch {
    return;
  }

  if (!line) return;
  Promise.resolve(desktopDebugLog(line)).catch((err) => {
    console.warn("[debug] Failed to write debug.log:", err);
  });
}

/**
 * Clears debug.log, without touching the regular rotating logs.
 * @returns {Promise<void>}
 */
export async function clearDebugLog() {
  try {
    await desktopClearDebugLog();
  } catch (err) {
    console.warn("[debug] Failed to clear debug.log:", err);
    throw err;
  }
}

function createDebugButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "debug-open-btn";
  btn.className = "debug-open-btn";
  btn.textContent = "Debug";
  btn.title = "Open debug options • デバッグ設定を開く";
  return btn;
}

function createDebugPopup() {
  const popup = document.createElement("div");
  popup.id = "debug-popup";
  popup.className = "hidden";

  const content = document.createElement("div");
  content.className = "debug-popup-content";

  const header = document.createElement("div");
  header.className = "settings-popup-header";

  const title = document.createElement("span");
  title.className = "mono";
  title.textContent = "Debug Options · デバッグ設定";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.id = "debug-close-btn";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";

  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "debug-popup-body";

  const section = document.createElement("div");
  section.className = "debug-section";

  const logSetting = document.createElement("label");
  logSetting.className = "live-mode-toggle popup-setting";
  logSetting.setAttribute(
    "data-tooltip",
    "Append raw EEW websocket messages to debug.log • 受信したEEWの生データをdebug.logに保存",
  );

  const logToggle = document.createElement("input");
  logToggle.type = "checkbox";
  logToggle.id = "debug-log-toggle";
  logToggle.checked = isDebugLoggingEnabled();

  const logLabel = document.createElement("span");
  logLabel.className = "toggle-label";
  logLabel.innerHTML = "Log EEW Data<br>EEWデータを記録";

  const toggleSwitch = document.createElement("span");
  toggleSwitch.className = "toggle-switch";

  logSetting.appendChild(logToggle);
  logSetting.appendChild(logLabel);
  logSetting.appendChild(toggleSwitch);

  const note = document.createElement("p");
  note.className = "debug-note";
  note.textContent =
    "Raw EEW websocket messages and AXIS jmx-seismology reports are written as minified JSON to debug.log in the logs folder, one message per line. · 受信したEEWの生データをログフォルダのdebug.logに1行ずつ保存します。";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.id = "debug-clear-btn";
  clearBtn.className = "preset-action-btn debug-clear-btn";
  clearBtn.textContent = "Clear debug.log";

  const status = document.createElement("div");
  status.id = "debug-status";
  status.className = "debug-status";

  section.appendChild(logSetting);
  section.appendChild(note);
  section.appendChild(clearBtn);
  section.appendChild(status);
  body.appendChild(section);

  content.appendChild(header);
  content.appendChild(body);
  popup.appendChild(content);

  const close = () => {
    popup.classList.add("hidden");
  };

  logToggle.addEventListener("change", (e) => {
    setDebugLoggingEnabled(e.target.checked);
    status.textContent = e.target.checked
      ? "Logging enabled • 記録を開始しました"
      : "Logging disabled • 記録を停止しました";
  });

  clearBtn.addEventListener("click", async () => {
    clearBtn.disabled = true;
    status.textContent = "Clearing… • 削除中…";
    try {
      await clearDebugLog();
      status.textContent = "debug.log cleared • debug.logを消去しました";
    } catch {
      status.textContent = "Failed to clear debug.log • 消去に失敗しました";
    } finally {
      clearBtn.disabled = false;
    }
  });

  closeBtn.addEventListener("click", close);
  popup.addEventListener("click", (e) => {
    if (e.target === popup) close();
  });

  return { popup, close };
}

/**
 * Adds the debug button to Settings and the debug popup to the DOM.
 * Both elements are created here, never present in index.html.
 */
function mountDebugUI() {
  if (_debugUI) return;

  const settingsPopup = document.getElementById("settings-popup");
  const settingsHeader = settingsPopup?.querySelector(".settings-popup-header");
  const settingsCloseBtn = document.getElementById("settings-close-btn");
  if (!settingsHeader) return;

  const button = createDebugButton();
  settingsHeader.insertBefore(button, settingsCloseBtn);

  const { popup } = createDebugPopup();
  document.body.appendChild(popup);

  button.addEventListener("click", () => {
    popup.classList.remove("hidden");
  });

  _debugUI = { button, popup };
}

/**
 * Removes the debug button and popup from the DOM.
 */
function unmountDebugUI() {
  if (!_debugUI) return;
  _debugUI.popup.remove();
  _debugUI.button.remove();
  _debugUI = null;
}

/**
 * Toggles the hidden debug menu. Returns the new enabled state.
 * Does nothing outside desktop builds.
 * @returns {boolean}
 */
export function toggleDebugOptions() {
  if (!checkIsDesktop()) return false;

  const enabled = !isDebugOptionsEnabled();
  writeFlag(DEBUG_OPTIONS_STORAGE_KEY, enabled);

  if (enabled) {
    mountDebugUI();
  } else {
    // Stop logging too, so no file writes continue without any visible UI.
    writeFlag(DEBUG_LOGGING_STORAGE_KEY, false);
    unmountDebugUI();
  }

  return enabled;
}

/**
 * Restores the debug UI at startup when it was previously enabled.
 */
export function initDebugOptions() {
  if (isDebugOptionsEnabled()) {
    mountDebugUI();
  }
}
