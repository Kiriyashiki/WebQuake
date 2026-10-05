import { initColorPresetsUI } from "./colorPresetsUI.js";

/**
 * Initializes the Settings & Credits modal popup event handlers.
 */
export function initSettingsModal() {
  const settingsBtn = document.getElementById("settings-btn");
  const settingsPopup = document.getElementById("settings-popup");
  const settingsCloseBtn = document.getElementById("settings-close-btn");

  if (settingsBtn && settingsPopup) {
    settingsBtn.addEventListener("click", () => {
      settingsPopup.classList.toggle("hidden");
    });

    if (settingsCloseBtn) {
      settingsCloseBtn.addEventListener("click", () => {
        settingsPopup.classList.add("hidden");
      });
    }

    settingsPopup.addEventListener("click", (e) => {
      if (e.target === settingsPopup) {
        settingsPopup.classList.add("hidden");
      }
    });
  }

  // Initialize color presets settings controls
  initColorPresetsUI();
}
