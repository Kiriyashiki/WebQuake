import {
  BUILTIN_PRESETS,
  SHINDO_KEYS,
  LPGM_KEYS,
  getAllPresetNames,
  getActivePresetName,
  setActivePresetName,
  getPreset,
  isBuiltinPreset,
  saveCustomPreset,
  deleteCustomPreset,
  exportPresetToCsv,
  parsePresetData,
  downloadFile,
  applyColorPreset,
  normalizeHexColor,
  clonePreset,
} from "./colorPresets.js";
import { renderIntensityBadge } from "./intensityBadge.js";
import { updateMapColorStyles } from "./map.js";
import { refreshAllReportBadges, getHomeLocation, getHomeIntensityState } from "./sidebarUI.js";
import { refreshInfoBoxColors } from "./mapInfoBox.js";
import {
  displayHomeLocationIntensity,
  displayHomeLocationDirectIntensity,
} from "./map/homeLocation.js";
import { eqdbIntensityToShindo } from "./constants.js";

let _editingPresetName = null;
let _promptResolve = null;

/**
 * Refreshes the home location intensity badge if currently displayed.
 */
function refreshHomeLocationIntensity() {
  try {
    if (getHomeIntensityState() && globalThis.__currentReport?.observations) {
      const homeLocation = getHomeLocation();
      if (homeLocation?.cityCode && globalThis.__cityNames) {
        displayHomeLocationIntensity(
          homeLocation.cityCode,
          globalThis.__currentReport.observations,
          globalThis.__cityNames,
        );
      }
    } else if (globalThis.__isPerCityModeActive && globalThis.__perCityMunicipalities) {
      const homeLocation = getHomeLocation();
      if (homeLocation?.cityCode && globalThis.__cityNames) {
        const homeCodeStr = String(homeLocation.cityCode).padStart(7, "0");
        const homeRecord = globalThis.__perCityMunicipalities.find(
          (c) => String(c.city_code).padStart(7, "0") === homeCodeStr
        );
        const homeMaxInt = homeRecord ? (eqdbIntensityToShindo(homeRecord.max_intensity) || "0") : "0";
        displayHomeLocationDirectIntensity(homeLocation.cityCode, homeMaxInt, globalThis.__cityNames);
      }
    }
  } catch (err) {
    console.warn("[colorPresetsUI] Error refreshing home location intensity:", err);
  }
}

/**
 * Applies the currently active preset and refreshes all UI and map components.
 */
export function applyActiveColorPreset() {
  const activeName = getActivePresetName();
  applyColorPreset(activeName, {
    updateMapStyles: updateMapColorStyles,
    refreshSidebar: refreshAllReportBadges,
    refreshInfoBox: refreshInfoBoxColors,
    refreshHomeIntensity: refreshHomeLocationIntensity,
  });
}

/**
 * Updates the preset select dropdown and button states.
 */
export function updatePresetDropdown() {
  const selectEl = document.getElementById("color-preset-select");
  const editBtn = document.getElementById("preset-edit-btn");
  const deleteBtn = document.getElementById("preset-delete-btn");
  if (!selectEl) return;

  const names = getAllPresetNames();
  const activeName = getActivePresetName();

  selectEl.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = isBuiltinPreset(name) ? `${name} (Built-in)` : name;
    selectEl.appendChild(opt);
  }

  selectEl.value = activeName;

  const isBuiltin = isBuiltinPreset(activeName);
  if (editBtn) editBtn.disabled = isBuiltin;
  if (deleteBtn) deleteBtn.disabled = isBuiltin;
}

/**
 * Opens a modal dialog prompting the user for a preset name.
 * @param {Object} options
 * @param {string} options.title - Modal title
 * @param {string} [options.defaultValue=""] - Initial input text
 * @param {string} [options.label="Enter preset name:"] - Input label
 * @param {boolean} [options.allowOverwrite=false] - Whether existing custom name can be overwritten
 * @returns {Promise<string|null>} Preset name or null if canceled
 */
export function promptPresetName(options = {}) {
  const {
    title = "Preset Name · プリセット名",
    defaultValue = "",
    label = "Enter preset name · プリセット名を入力:",
    allowOverwrite = false,
  } = options;

  const modal = document.getElementById("preset-prompt-modal");
  const titleEl = document.getElementById("preset-prompt-title");
  const labelEl = document.getElementById("preset-prompt-label");
  const inputEl = document.getElementById("preset-name-input");
  const errorEl = document.getElementById("preset-prompt-error");
  const confirmBtn = document.getElementById("preset-prompt-confirm-btn");
  const cancelBtn = document.getElementById("preset-prompt-cancel-btn");
  const closeBtn = document.getElementById("preset-prompt-close-btn");

  if (!modal || !inputEl) return Promise.resolve(null);

  titleEl.textContent = title;
  labelEl.textContent = label;
  inputEl.value = defaultValue;
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
  modal.classList.remove("hidden");
  inputEl.focus();
  inputEl.select();

  return new Promise((resolve) => {
    const cleanup = () => {
      confirmBtn?.removeEventListener("click", onConfirm);
      cancelBtn?.removeEventListener("click", onCancel);
      closeBtn?.removeEventListener("click", onCancel);
      modal?.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKeyDown);
      modal.classList.add("hidden");
    };

    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.classList.remove("hidden");
      inputEl.focus();
    };

    const onConfirm = () => {
      const val = inputEl.value.trim();
      if (!val) {
        showError("Preset name cannot be empty. · 名前を入力してください。");
        return;
      }

      if (isBuiltinPreset(val)) {
        showError("Cannot use reserved name 'Default' or 'JMA'. · 'Default' または 'JMA' は使用できません。");
        return;
      }

      const existingNames = getAllPresetNames();
      if (!allowOverwrite && existingNames.includes(val)) {
        showError("A preset with this name already exists. · 同名のプリセットが既に存在します。");
        return;
      }

      cleanup();
      resolve(val);
    };

    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    const onBackdrop = (e) => {
      if (e.target === modal) onCancel();
    };

    const onKeyDown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };

    confirmBtn?.addEventListener("click", onConfirm);
    cancelBtn?.addEventListener("click", onCancel);
    closeBtn?.addEventListener("click", onCancel);
    modal?.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onKeyDown);
  });
}

/**
 * Opens the Preset Editor popup for a specified custom preset name.
 * @param {string} presetName
 */
export function openPresetEditor(presetName) {
  if (isBuiltinPreset(presetName)) {
    console.warn("[colorPresetsUI] Built-in presets cannot be edited.");
    return;
  }

  const editorModal = document.getElementById("preset-editor-popup");
  const titleEl = document.getElementById("preset-editor-title");
  const shindoTable = document.getElementById("preset-shindo-table");
  const lpgmTable = document.getElementById("preset-lpgm-table");
  if (!editorModal || !shindoTable || !lpgmTable) return;

  _editingPresetName = presetName;
  titleEl.textContent = `Edit Preset · ${presetName}`;

  const presetData = getPreset(presetName);

  // Populate Shindo table
  shindoTable.innerHTML = "";
  for (const rank of SHINDO_KEYS) {
    const item = presetData.shindo[rank] || BUILTIN_PRESETS.Default.shindo[rank];
    const row = createColorRow(rank, "shindo", item.color, item.fontColor);
    shindoTable.appendChild(row);
  }

  // Populate LPGM table
  lpgmTable.innerHTML = "";
  for (const rank of LPGM_KEYS) {
    const item = presetData.lpgm[rank] || BUILTIN_PRESETS.Default.lpgm[rank];
    const row = createColorRow(rank, "lpgm", item.color, item.fontColor);
    lpgmTable.appendChild(row);
  }

  editorModal.classList.remove("hidden");
}

/**
 * Creates a single table row for an intensity level inside the editor.
 * @param {string} rank - "0", "1", "5-", etc.
 * @param {'shindo' | 'lpgm'} mode
 * @param {string} initialBg
 * @param {string} initialFont
 * @returns {HTMLElement}
 */
function createColorRow(rank, mode, initialBg, initialFont) {
  const row = document.createElement("div");
  row.className = "preset-color-row";
  row.dataset.rank = rank;
  row.dataset.mode = mode;

  const previewCell = document.createElement("div");
  previewCell.className = "preset-badge-preview-cell";
  renderIntensityBadge(previewCell, rank, { isLpgm: mode === "lpgm" });

  const badge = previewCell.querySelector(".intensity-badge");
  if (badge) {
    badge.style.backgroundColor = initialBg;
    badge.style.color = initialFont;
  }

  const rankLabel = document.createElement("div");
  rankLabel.className = "preset-rank-label";
  rankLabel.textContent = mode === "lpgm" ? `L${rank}` : rank;

  // Background color controls
  const bgField = document.createElement("div");
  bgField.className = "preset-color-field";
  const bgLabel = document.createElement("span");
  bgLabel.className = "preset-color-field-label";
  bgLabel.textContent = "BG";

  const bgPicker = document.createElement("input");
  bgPicker.type = "color";
  bgPicker.className = "preset-picker-input bg-picker";
  bgPicker.value = initialBg.toLowerCase();

  const bgHex = document.createElement("input");
  bgHex.type = "text";
  bgHex.className = "preset-hex-input bg-hex mono";
  bgHex.value = initialBg.toUpperCase();
  bgHex.maxLength = 7;

  bgField.appendChild(bgLabel);
  bgField.appendChild(bgPicker);
  bgField.appendChild(bgHex);

  // Text color controls
  const fontField = document.createElement("div");
  fontField.className = "preset-color-field";
  const fontLabel = document.createElement("span");
  fontLabel.className = "preset-color-field-label";
  fontLabel.textContent = "Text";

  const fontPicker = document.createElement("input");
  fontPicker.type = "color";
  fontPicker.className = "preset-picker-input font-picker";
  fontPicker.value = initialFont.toLowerCase();

  const fontHex = document.createElement("input");
  fontHex.type = "text";
  fontHex.className = "preset-hex-input font-hex mono";
  fontHex.value = initialFont.toUpperCase();
  fontHex.maxLength = 7;

  fontField.appendChild(fontLabel);
  fontField.appendChild(fontPicker);
  fontField.appendChild(fontHex);

  // Synchronization event listeners
  const updateBg = (hex) => {
    if (badge) badge.style.backgroundColor = hex;
  };
  const updateFont = (hex) => {
    if (badge) badge.style.color = hex;
  };

  bgPicker.addEventListener("input", (e) => {
    const val = e.target.value.toUpperCase();
    bgHex.value = val;
    bgHex.classList.remove("invalid");
    updateBg(val);
  });

  bgHex.addEventListener("input", (e) => {
    let val = e.target.value.trim();
    if (val && !val.startsWith("#")) val = `#${val}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      bgPicker.value = val.toLowerCase();
      bgHex.classList.remove("invalid");
      updateBg(val);
    } else {
      bgHex.classList.add("invalid");
    }
  });

  bgHex.addEventListener("blur", () => {
    let val = bgHex.value.trim();
    if (val && !val.startsWith("#")) val = `#${val}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      bgHex.value = val.toUpperCase();
      bgHex.classList.remove("invalid");
    } else {
      bgHex.value = bgPicker.value.toUpperCase();
      bgHex.classList.remove("invalid");
      updateBg(bgHex.value);
    }
  });

  fontPicker.addEventListener("input", (e) => {
    const val = e.target.value.toUpperCase();
    fontHex.value = val;
    fontHex.classList.remove("invalid");
    updateFont(val);
  });

  fontHex.addEventListener("input", (e) => {
    let val = e.target.value.trim();
    if (val && !val.startsWith("#")) val = `#${val}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      fontPicker.value = val.toLowerCase();
      fontHex.classList.remove("invalid");
      updateFont(val);
    } else {
      fontHex.classList.add("invalid");
    }
  });

  fontHex.addEventListener("blur", () => {
    let val = fontHex.value.trim();
    if (val && !val.startsWith("#")) val = `#${val}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      fontHex.value = val.toUpperCase();
      fontHex.classList.remove("invalid");
    } else {
      fontHex.value = fontPicker.value.toUpperCase();
      fontHex.classList.remove("invalid");
      updateFont(fontHex.value);
    }
  });

  row.appendChild(previewCell);
  row.appendChild(rankLabel);
  row.appendChild(bgField);
  row.appendChild(fontField);

  return row;
}

/**
 * Initializes the Preset Editor popup controls (save, cancel, reset).
 */
function initPresetEditorPopup() {
  const modal = document.getElementById("preset-editor-popup");
  const closeBtn = document.getElementById("preset-editor-close-btn");
  const cancelBtn = document.getElementById("preset-editor-cancel-btn");
  const saveBtn = document.getElementById("preset-editor-save-btn");
  const resetBtn = document.getElementById("preset-editor-reset-btn");

  if (!modal) return;

  const closeModal = () => {
    modal.classList.add("hidden");
    _editingPresetName = null;
  };

  closeBtn?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // Reset to Default button
  resetBtn?.addEventListener("click", () => {
    const def = BUILTIN_PRESETS.Default;
    const rows = modal.querySelectorAll(".preset-color-row");
    for (const row of rows) {
      const mode = row.dataset.mode;
      const rank = row.dataset.rank;
      const cfg = mode === "lpgm" ? def.lpgm[rank] : def.shindo[rank];
      if (!cfg) continue;

      const bgPicker = row.querySelector(".bg-picker");
      const bgHex = row.querySelector(".bg-hex");
      const fontPicker = row.querySelector(".font-picker");
      const fontHex = row.querySelector(".font-hex");
      const badge = row.querySelector(".intensity-badge");

      if (bgPicker) bgPicker.value = cfg.color.toLowerCase();
      if (bgHex) {
        bgHex.value = cfg.color.toUpperCase();
        bgHex.classList.remove("invalid");
      }
      if (fontPicker) fontPicker.value = cfg.fontColor.toLowerCase();
      if (fontHex) {
        fontHex.value = cfg.fontColor.toUpperCase();
        fontHex.classList.remove("invalid");
      }
      if (badge) {
        badge.style.backgroundColor = cfg.color;
        badge.style.color = cfg.fontColor;
      }
    }
  });

  // Save changes button
  saveBtn?.addEventListener("click", () => {
    if (!_editingPresetName) return;

    const shindo = {};
    const lpgm = {};

    const rows = modal.querySelectorAll(".preset-color-row");
    for (const row of rows) {
      const mode = row.dataset.mode;
      const rank = row.dataset.rank;
      const bgPicker = row.querySelector(".bg-picker");
      const fontPicker = row.querySelector(".font-picker");

      const color = normalizeHexColor(bgPicker?.value, "#1e2e44");
      const fontColor = normalizeHexColor(fontPicker?.value, "#FFFFFF");

      if (mode === "lpgm") {
        lpgm[rank] = { color, fontColor };
      } else {
        shindo[rank] = { color, fontColor };
      }
    }

    saveCustomPreset(_editingPresetName, { shindo, lpgm });

    // If currently editing the active preset, apply changes immediately
    if (getActivePresetName() === _editingPresetName) {
      applyActiveColorPreset();
    }

    closeModal();
  });
}

/**
 * Initializes the Color Presets UI section inside Settings.
 */
export function initColorPresetsUI() {
  const selectEl = document.getElementById("color-preset-select");
  const newBtn = document.getElementById("preset-new-btn");
  const editBtn = document.getElementById("preset-edit-btn");
  const deleteBtn = document.getElementById("preset-delete-btn");
  const exportBtn = document.getElementById("preset-export-btn");
  const importBtn = document.getElementById("preset-import-btn");
  const fileInput = document.getElementById("preset-import-file");

  if (!selectEl) return;

  // Initialize editor modal
  initPresetEditorPopup();

  // Populate dropdown
  updatePresetDropdown();

  // 1. Preset change listener
  selectEl.addEventListener("change", (e) => {
    const name = e.target.value;
    setActivePresetName(name);
    applyActiveColorPreset();
    updatePresetDropdown();
  });

  // 2. New Preset button
  newBtn?.addEventListener("click", async () => {
    const name = await promptPresetName({
      title: "New Preset · 新規プリセット",
      label: "Preset name · プリセット名:",
      defaultValue: "",
    });

    if (!name) return;

    // Copies Default preset
    const def = clonePreset(BUILTIN_PRESETS.Default);
    saveCustomPreset(name, def);
    setActivePresetName(name);
    applyActiveColorPreset();
    updatePresetDropdown();

    // Open editor for the newly created preset
    openPresetEditor(name);
  });

  // 3. Edit Preset button
  editBtn?.addEventListener("click", () => {
    const active = getActivePresetName();
    if (isBuiltinPreset(active)) return;
    openPresetEditor(active);
  });

  // 4. Delete Preset button
  deleteBtn?.addEventListener("click", () => {
    const active = getActivePresetName();
    if (isBuiltinPreset(active)) return;

    const confirmed = window.confirm(`Are you sure you want to delete preset "${active}"?\nプリセット "${active}" を削除してもよろしいですか？`);
    if (!confirmed) return;

    deleteCustomPreset(active);
    applyActiveColorPreset();
    updatePresetDropdown();
  });

  // 5. Export Preset button
  exportBtn?.addEventListener("click", () => {
    const active = getActivePresetName();
    const csv = exportPresetToCsv(active);
    const cleanFilename = `${active.toLowerCase().replace(/[^a-z0-9_-]+/g, "_")}_colors.csv`;
    downloadFile(cleanFilename, csv);
  });

  // 6. Import Preset button & file input
  importBtn?.addEventListener("click", () => {
    if (fileInput) {
      fileInput.value = "";
      fileInput.click();
    }
  });

  fileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsedData = parsePresetData(text);

      // Suggest name from file name
      const suggestedName = file.name.replace(/\.[^/.]+$/, "").replace(/_colors$/, "").trim();

      const name = await promptPresetName({
        title: "Import Preset · プリセットのインポート",
        label: "Preset name · プリセット名:",
        defaultValue: suggestedName,
        allowOverwrite: true,
      });

      if (!name) return;

      const existingNames = getAllPresetNames();
      if (existingNames.includes(name) && !isBuiltinPreset(name)) {
        const overwrite = window.confirm(`A preset named "${name}" already exists. Overwrite?\n同名のプリセット "${name}" が既に存在します。上書きしますか？`);
        if (!overwrite) return;
      }

      saveCustomPreset(name, parsedData);
      setActivePresetName(name);
      applyActiveColorPreset();
      updatePresetDropdown();
    } catch (err) {
      console.error("[colorPresetsUI] Import failed:", err);
      window.alert(`Failed to import preset: ${err.message}\nプリセットのインポートに失敗しました。`);
    } finally {
      fileInput.value = "";
    }
  });
}
