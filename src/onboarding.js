/**
 * First-run onboarding dialog.
 *
 * Shown once per browser profile. It introduces the main display modes and
 * offers the configuration-free external services, then stores a completion
 * flag so it does not appear again.
 */

import {
  EXTERNAL_CAPABILITY,
  getExternalSourceId,
  isExternalSourceEnabled,
  wasLegacyEewEnabledBeforeMigration,
} from "./externalProviders.js";
import { setExternalEnabled, setExternalSource } from "./externalServices.js";

const ONBOARDING_COMPLETED_KEY = "kyoquake-onboarding-completed";
const RECOMMENDED_EEW_PROVIDER = "wolfx";
const RECOMMENDED_REPORTS_PROVIDER = "kyoquake-service";

const CORE_TOGGLES = [
  {
    onboardingId: "onboarding-auto-toggle",
    appToggleId: "auto-open-toggle",
    storageKey: "auto-open-enabled",
  },
  {
    onboardingId: "onboarding-cities-toggle",
    appToggleId: "city-areas-toggle",
    storageKey: "city-areas-enabled",
  },
  {
    onboardingId: "onboarding-live-toggle",
    appToggleId: "live-mode-toggle",
    storageKey: "live-mode-enabled",
  },
];

let initialized = false;

function _storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function _storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; onboarding still works for this session.
  }
}

/**
 * Reads a display-mode setting. A missing value means the onboarding default:
 * enabled.
 */
function _readSetting(storageKey) {
  const value = _storageGet(storageKey);
  return value == null ? true : value === "true";
}

/**
 * Persists a display-mode setting and keeps the matching control in the main
 * UI in sync. Dispatching "change" lets already-initialised modules react
 * immediately (for example by starting or stopping live polling).
 */
function _applySetting(setting, enabled) {
  _storageSet(setting.storageKey, enabled ? "true" : "false");

  const appToggle = document.getElementById(setting.appToggleId);
  if (!appToggle || appToggle.checked === enabled) return;

  appToggle.checked = enabled;
  appToggle.dispatchEvent(new Event("change", { bubbles: true }));
}

function _recommendedServicesEnabled() {
  return (
    getExternalSourceId(EXTERNAL_CAPABILITY.EEW) === RECOMMENDED_EEW_PROVIDER &&
    isExternalSourceEnabled(EXTERNAL_CAPABILITY.EEW) &&
    getExternalSourceId(EXTERNAL_CAPABILITY.REPORTS) === RECOMMENDED_REPORTS_PROVIDER &&
    isExternalSourceEnabled(EXTERNAL_CAPABILITY.REPORTS)
  );
}

function _renderExternalButton() {
  const button = document.getElementById("onboarding-enable-external-btn");
  if (!button) return;

  const enabled = _recommendedServicesEnabled();
  button.disabled = enabled;
  button.classList.toggle("is-enabled", enabled);
  button.textContent = enabled
    ? "Recommended Services Enabled · 推奨サービスは有効です"
    : "Enable Recommended Services · 推奨サービスを有効にする";
}

function _enableRecommendedServices() {
  setExternalSource(EXTERNAL_CAPABILITY.EEW, RECOMMENDED_EEW_PROVIDER);
  setExternalEnabled(EXTERNAL_CAPABILITY.EEW, true);

  setExternalSource(EXTERNAL_CAPABILITY.REPORTS, RECOMMENDED_REPORTS_PROVIDER);
  setExternalEnabled(EXTERNAL_CAPABILITY.REPORTS, true);

  _renderExternalButton();
}

/**
 * Shows the onboarding dialog unless it has already been completed.
 */
export function initOnboarding() {
  if (initialized) return;

  const popup = document.getElementById("onboarding-popup");
  if (!popup) return;

  initialized = true;
  if (_storageGet(ONBOARDING_COMPLETED_KEY) === "true") return;

  // Detection must use the snapshot taken before the legacy keys were migrated.
  const hadLegacyEew = wasLegacyEewEnabledBeforeMigration();
  const externalSection = document.getElementById("onboarding-external-section");
  const legacyNotice = document.getElementById("onboarding-external-legacy");

  externalSection?.classList.toggle("hidden", hadLegacyEew);
  legacyNotice?.classList.toggle("hidden", !hadLegacyEew);

  for (const setting of CORE_TOGGLES) {
    const toggle = document.getElementById(setting.onboardingId);
    if (!toggle) continue;

    toggle.checked = _readSetting(setting.storageKey);
    toggle.addEventListener("change", () => {
      _applySetting(setting, toggle.checked);
    });
  }

  const enableExternalButton = document.getElementById("onboarding-enable-external-btn");
  if (enableExternalButton) {
    enableExternalButton.addEventListener("click", _enableRecommendedServices);
    _renderExternalButton();
  }

  const completeButton = document.getElementById("onboarding-complete-btn");
  completeButton?.addEventListener("click", () => {
    for (const setting of CORE_TOGGLES) {
      const toggle = document.getElementById(setting.onboardingId);
      if (toggle) _applySetting(setting, toggle.checked);
    }

    _storageSet(ONBOARDING_COMPLETED_KEY, "true");
    popup.classList.add("hidden");
    completeButton.blur();
  });

  popup.classList.remove("hidden");
  completeButton?.focus();
}
