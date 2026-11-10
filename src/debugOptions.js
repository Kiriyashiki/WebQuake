import { AXIS_REPORT_CHANNEL } from "./constants.js";
import {
  checkIsDesktop,
  desktopClearDebugLog,
  desktopDebugLog,
} from "./desktopBridge.js";

const DEBUG_OPTIONS_STORAGE_KEY = "debug-options-enabled";
const DEBUG_LOGGING_STORAGE_KEY = "debug-log-enabled";
const DEBUG_USE_TEST_SERVER_STORAGE_KEY = "debug-use-test-server";
const DEBUG_TEST_GMPE_OVERRIDE_STORAGE_KEY = "debug-test-gmpe-override";
const DEBUG_ENABLE_SM1999_GMPE_STORAGE_KEY = "debug-enable-sm1999-gmpe";

/**
 * The exact, case-sensitive preset name that toggles the debug menu.
 */
export const DEBUG_OPTIONS_TOGGLE_COMMAND = "debug_options";

/**
 * Event fired on `window` whenever a debug switch changes. Consumers use this
 * to re-read the setting and refresh any UI that depends on it.
 */
export const DEBUG_SETTINGS_CHANGED_EVENT = "debug-settings-changed";

let _debugUI = null;

function readFlag(key) {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(key) === "true";
}

function writeFlag(key, enabled) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, enabled ? "true" : "false");
}

function syncDebugToggle(id, enabled) {
  if (typeof document === "undefined") return;
  const toggle = document.getElementById(id);
  if (toggle) toggle.checked = Boolean(enabled);
}

function notifyDebugSettingsChanged(name, enabled) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  if (typeof CustomEvent === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(DEBUG_SETTINGS_CHANGED_EVENT, {
      detail: { name, enabled: Boolean(enabled) },
    }),
  );
}

function writeDebugSetting(key, toggleId, name, enabled) {
  writeFlag(key, enabled);
  syncDebugToggle(toggleId, enabled);
  notifyDebugSettingsChanged(name, enabled);
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
  syncDebugToggle("debug-log-toggle", Boolean(enabled) && isDebugOptionsEnabled());
}

/**
 * Whether the EEW TEST provider should be available.
 * @returns {boolean}
 */
export function isUseTestServerEnabled() {
  return readFlag(DEBUG_USE_TEST_SERVER_STORAGE_KEY);
}

/**
 * Enables or disables the EEW TEST provider.
 * @param {boolean} enabled
 */
export function setUseTestServerEnabled(enabled) {
  writeDebugSetting(
    DEBUG_USE_TEST_SERVER_STORAGE_KEY,
    "debug-use-test-server-toggle",
    "useTestServer",
    enabled,
  );
}

/**
 * Whether GMPE-calculated forecasts should override EEW-sourced intensities.
 * @returns {boolean}
 */
export function isTestGmpeOverrideEnabled() {
  return readFlag(DEBUG_TEST_GMPE_OVERRIDE_STORAGE_KEY);
}

/**
 * Enables or disables the GMPE forecast override.
 * @param {boolean} enabled
 */
export function setTestGmpeOverrideEnabled(enabled) {
  writeDebugSetting(
    DEBUG_TEST_GMPE_OVERRIDE_STORAGE_KEY,
    "debug-test-gmpe-override-toggle",
    "testGmpeOverride",
    enabled,
  );
}

/**
 * Whether the SM 1999 GMPE should be used instead of MF 2013.
 * @returns {boolean}
 */
export function isSm1999GmpeEnabled() {
  return readFlag(DEBUG_ENABLE_SM1999_GMPE_STORAGE_KEY);
}

/**
 * Enables or disables the SM 1999 GMPE.
 * @param {boolean} enabled
 */
export function setSm1999GmpeEnabled(enabled) {
  writeDebugSetting(
    DEBUG_ENABLE_SM1999_GMPE_STORAGE_KEY,
    "debug-enable-sm1999-gmpe-toggle",
    "enableSm1999Gmpe",
    enabled,
  );
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

function createToggleSetting({ id, tooltip, label, checked, onChange }) {
  const setting = document.createElement("label");
  setting.className = "live-mode-toggle popup-setting";
  if (tooltip) setting.setAttribute("data-tooltip", tooltip);

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.id = id;
  toggle.checked = Boolean(checked);

  const labelEl = document.createElement("span");
  labelEl.className = "toggle-label";
  labelEl.innerHTML = label;

  const toggleSwitch = document.createElement("span");
  toggleSwitch.className = "toggle-switch";

  setting.appendChild(toggle);
  setting.appendChild(labelEl);
  setting.appendChild(toggleSwitch);

  if (onChange) {
    toggle.addEventListener("change", (e) => onChange(e.target.checked));
  }

  return setting;
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

  const eewSection = document.createElement("div");
  eewSection.className = "debug-section";

  const eewTitle = document.createElement("div");
  eewTitle.className = "debug-section-title";
  eewTitle.textContent = "EEW · 緊急地震速報";

  const testServerSetting = createToggleSetting({
    id: "debug-use-test-server-toggle",
    tooltip:
      "Allow usage of the local EEW TEST server on port 8565 • ローカルのEEWテストサーバー（ポート8565）に接続する",
    label: "Use TEST Server<br>TESTサーバーを使用",
    checked: isUseTestServerEnabled(),
    onChange: setUseTestServerEnabled,
  });

  const gmpeOverrideSetting = createToggleSetting({
    id: "debug-test-gmpe-override-toggle",
    tooltip:
      "Show GMPE-calculated intensities instead of EEW-sourced forecasts • EEWの予測震度ではなくGMPEの計算結果を表示する",
    label: "Force GMPE Forecasts<br>GMPE予測を強制",
    checked: isTestGmpeOverrideEnabled(),
    onChange: setTestGmpeOverrideEnabled,
  });

  const sm1999Setting = createToggleSetting({
    id: "debug-enable-sm1999-gmpe-toggle",
    tooltip:
      "Use the Si & Midorikawa (1999) GMPE instead of Morikawa & Fujiwara (2013) • 森川・藤原（2013）ではなく司・翠川（1999）の震度計算を使用する",
    label: "Use SM 1999 GMPE<br>SM1999震度計算",
    checked: isSm1999GmpeEnabled(),
    onChange: setSm1999GmpeEnabled,
  });

  eewSection.appendChild(eewTitle);
  eewSection.appendChild(testServerSetting);
  eewSection.appendChild(gmpeOverrideSetting);
  eewSection.appendChild(sm1999Setting);

  const logSection = document.createElement("div");
  logSection.className = "debug-section";

  const logTitle = document.createElement("div");
  logTitle.className = "debug-section-title";
  logTitle.textContent = "Logging · ログ";

  const logSetting = createToggleSetting({
    id: "debug-log-toggle",
    tooltip:
      "Append raw EEW websocket messages to debug.log • 受信したEEWの生データをdebug.logに保存",
    label: "Log EEW Data<br>EEWデータを記録",
    checked: isDebugLoggingEnabled(),
  });
  const logToggle = logSetting.querySelector("input");

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

  logSection.appendChild(logTitle);
  logSection.appendChild(logSetting);
  logSection.appendChild(note);
  logSection.appendChild(clearBtn);
  logSection.appendChild(status);
  body.appendChild(eewSection);
  body.appendChild(logSection);

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
    // Turn off every debug switch so nothing keeps running without a visible UI.
    setUseTestServerEnabled(false);
    setTestGmpeOverrideEnabled(false);
    setSm1999GmpeEnabled(false);
    setDebugLoggingEnabled(false);
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
