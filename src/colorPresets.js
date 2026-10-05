import { INTENSITY_CONFIG, LPGM_CONFIG } from "./constants.js";

/**
 * Storage keys for color presets.
 */
export const STORAGE_KEY_CUSTOM_PRESETS = "color_presets_custom";
export const STORAGE_KEY_ACTIVE_PRESET = "color_preset_active";

/**
 * Built-in presets.
 * Built-in presets are never stored in localStorage and cannot be modified or deleted.
 */
export const BUILTIN_PRESETS = {
  Default: {
    shindo: {
      0: { color: "#1e2e44", fontColor: "#FFFFFF" },
      1: { color: "#6B7878", fontColor: "#FFFFFF" },
      2: { color: "#1E6EE6", fontColor: "#FFFFFF" },
      3: { color: "#32B464", fontColor: "#FFFFFF" },
      4: { color: "#FFE05D", fontColor: "#000000" },
      "5-": { color: "#FFAA13", fontColor: "#000000" },
      "5+": { color: "#EF6F12", fontColor: "#000000" },
      "6-": { color: "#E40000", fontColor: "#FFFFFF" },
      "6+": { color: "#A00000", fontColor: "#FFFFFF" },
      7: { color: "#5D0092", fontColor: "#FFFFFF" },
    },
    lpgm: {
      0: { color: "#1e2e44", fontColor: "#FFFFFF" },
      1: { color: "#32B464", fontColor: "#FFFFFF" },
      2: { color: "#FFE05D", fontColor: "#000000" },
      3: { color: "#FFAA13", fontColor: "#000000" },
      4: { color: "#E40000", fontColor: "#FFFFFF" },
    },
  },
  JMA: {
    shindo: {
      0: { color: "#777777", fontColor: "#000000" },
      1: { color: "#f2f2ff", fontColor: "#000000" },
      2: { color: "#b3eaed", fontColor: "#000000" },
      3: { color: "#0041ff", fontColor: "#FFFFFF" },
      4: { color: "#fae696", fontColor: "#000000" },
      "5-": { color: "#ffe600", fontColor: "#000000" },
      "5+": { color: "#ff9900", fontColor: "#000000" },
      "6-": { color: "#ff2800", fontColor: "#FFFFFF" },
      "6+": { color: "#a50021", fontColor: "#FFFFFF" },
      7: { color: "#b40068", fontColor: "#FFFFFF" },
    },
    lpgm: {
      0: { color: "#777777", fontColor: "#000000" },
      1: { color: "#0041ff", fontColor: "#FFFFFF" },
      2: { color: "#ffe600", fontColor: "#000000" },
      3: { color: "#ff2800", fontColor: "#FFFFFF" },
      4: { color: "#a50021", fontColor: "#FFFFFF" },
    },
  },
};

export const SHINDO_KEYS = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];
export const LPGM_KEYS = ["0", "1", "2", "3", "4"];

/**
 * Deep clones a preset object.
 * @param {Object} preset
 * @returns {Object}
 */
export function clonePreset(preset) {
  return structuredClone(preset);
}

/**
 * Checks if a preset name belongs to a built-in preset.
 * @param {string} name
 * @returns {boolean}
 */
export function isBuiltinPreset(name) {
  return Object.hasOwn(BUILTIN_PRESETS, name);
}

/**
 * Retrieves all custom presets from localStorage.
 * @returns {Object<string, Object>}
 */
export function getCustomPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_PRESETS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (err) {
    console.warn("[colorPresets] Failed to read custom presets from localStorage:", err);
    return {};
  }
}

/**
 * Saves all custom presets to localStorage.
 * Built-in presets are filtered out.
 * @param {Object<string, Object>} presets
 */
export function saveCustomPresets(presets) {
  const filtered = {};
  for (const [name, data] of Object.entries(presets)) {
    if (!isBuiltinPreset(name)) {
      filtered[name] = data;
    }
  }
  localStorage.setItem(STORAGE_KEY_CUSTOM_PRESETS, JSON.stringify(filtered));
}

/**
 * Retrieves all available preset names (built-ins first, then custom).
 * @returns {string[]}
 */
export function getAllPresetNames() {
  const custom = getCustomPresets();
  return [...Object.keys(BUILTIN_PRESETS), ...Object.keys(custom)];
}

/**
 * Retrieves preset data by name. Falls back to Default preset if not found.
 * @param {string} name
 * @returns {Object}
 */
export function getPreset(name) {
  if (isBuiltinPreset(name)) {
    return clonePreset(BUILTIN_PRESETS[name]);
  }
  const custom = getCustomPresets();
  if (custom[name]) {
    return clonePreset(custom[name]);
  }
  return clonePreset(BUILTIN_PRESETS.Default);
}

/**
 * Gets the active preset name. Defaults to "Default".
 * @returns {string}
 */
export function getActivePresetName() {
  const active = localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET);
  if (active && (isBuiltinPreset(active) || Object.hasOwn(getCustomPresets(), active))) {
    return active;
  }
  return "Default";
}

/**
 * Sets and persists the active preset name.
 * @param {string} name
 */
export function setActivePresetName(name) {
  localStorage.setItem(STORAGE_KEY_ACTIVE_PRESET, name);
}

/**
 * Saves or updates a custom preset.
 * @param {string} name
 * @param {Object} presetData
 * @throws {Error} If name is a built-in preset name or empty
 */
export function saveCustomPreset(name, presetData) {
  const cleanName = name?.trim();
  if (!cleanName) {
    throw new Error("Preset name cannot be empty");
  }
  if (isBuiltinPreset(cleanName)) {
    throw new Error(`Cannot overwrite built-in preset '${cleanName}'`);
  }

  const custom = getCustomPresets();
  custom[cleanName] = clonePreset(presetData);
  saveCustomPresets(custom);
}

/**
 * Deletes a custom preset by name.
 * Built-in presets cannot be deleted.
 * @param {string} name
 * @returns {boolean} True if deleted, false otherwise
 */
export function deleteCustomPreset(name) {
  if (isBuiltinPreset(name)) {
    return false;
  }
  const custom = getCustomPresets();
  if (!Object.hasOwn(custom, name)) {
    return false;
  }
  delete custom[name];
  saveCustomPresets(custom);

  if (getActivePresetName() === name) {
    setActivePresetName("Default");
  }
  return true;
}

/**
 * Normalizes a hex color string into #RRGGBB format.
 * Accepts formats like "#123", "123", "#123456", "123456".
 * @param {string} val
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeHexColor(val, fallback = "#000000") {
  if (!val || typeof val !== "string") return fallback;
  let clean = val.trim().replace(/^#/, "");
  if (clean.length === 3) {
    clean = clean.split("").map((c) => c + c).join("");
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `#${clean.toUpperCase()}`;
  }
  return fallback;
}

/**
 * Exports a preset to CSV string format:
 * Int,BgColor,TextColor
 * 0,#1e2e44,#FFFFFF
 * 1,...
 * ...
 * L1,... (Lx -> LPGM)
 * @param {string} name
 * @returns {string}
 */
export function exportPresetToCsv(name) {
  const preset = getPreset(name);
  const rows = ["Int,BgColor,TextColor"];

  for (const k of SHINDO_KEYS) {
    const item = preset.shindo?.[k];
    if (item) {
      rows.push(`${k},${item.color},${item.fontColor}`);
    }
  }

  for (const k of LPGM_KEYS) {
    const item = preset.lpgm?.[k];
    if (item) {
      rows.push(`L${k},${item.color},${item.fontColor}`);
    }
  }

  return rows.join("\n");
}

/**
 * Parses preset data from a string (CSV or JSON).
 * Fills in any missing intensity keys using Default preset.
 * @param {string} content
 * @returns {Object} Preset object with { shindo, lpgm }
 */
export function parsePresetData(content) {
  if (!content || typeof content !== "string") {
    throw new Error("Empty preset content");
  }

  const trimmed = content.trim();

  // Try JSON first if content starts with '{'
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return sanitizePresetObject(parsed);
    } catch (err) {
      // If it looks like JSON but failed, throw error
      throw new Error(`Failed to parse JSON preset: ${err.message}`);
    }
  }

  // Parse as CSV
  return parsePresetCsv(trimmed);
}

function _isCsvHeaderLine(line) {
  const lower = line.toLowerCase();
  return lower.includes("int") && (lower.includes("color") || lower.includes("col") || lower.includes("bg"));
}

function _parseCsvColorLine(line) {
  const parts = line.includes(",")
    ? line.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
    : line.split(/\s+/).map((s) => s.trim().replace(/^["']|["']$/g, ""));

  if (parts.length < 3) return null;
  const [rawInt, rawBg, rawText] = parts;
  const bg = normalizeHexColor(rawBg, null);
  const font = normalizeHexColor(rawText, null);
  if (!bg || !font) return null;

  return { intLabel: rawInt.trim(), bg, font };
}

/**
 * Parses CSV formatted preset text.
 * @param {string} text
 * @returns {Object} { shindo, lpgm }
 */
function parsePresetCsv(text) {
  const lines = text.split(/\r?\n/);
  const defaultPreset = BUILTIN_PRESETS.Default;
  const shindo = clonePreset(defaultPreset.shindo);
  const lpgm = clonePreset(defaultPreset.lpgm);

  let parsedCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//") || _isCsvHeaderLine(line)) {
      continue;
    }

    const entry = _parseCsvColorLine(line);
    if (!entry) continue;

    if (/^[Ll][0-4]$/.test(entry.intLabel)) {
      lpgm[entry.intLabel.slice(1)] = { color: entry.bg, fontColor: entry.font };
      parsedCount++;
    } else if (SHINDO_KEYS.includes(entry.intLabel)) {
      shindo[entry.intLabel] = { color: entry.bg, fontColor: entry.font };
      parsedCount++;
    }
  }

  if (parsedCount === 0) {
    throw new Error("No valid color definitions found in CSV");
  }

  return { shindo, lpgm };
}

function _sanitizePresetGroup(rawGroup, keys, defaultGroup) {
  const result = {};
  if (rawGroup && typeof rawGroup === "object") {
    for (const k of keys) {
      if (rawGroup[k]?.color && rawGroup[k]?.fontColor) {
        result[k] = {
          color: normalizeHexColor(rawGroup[k].color, defaultGroup[k].color),
          fontColor: normalizeHexColor(rawGroup[k].fontColor, defaultGroup[k].fontColor),
        };
      }
    }
  }
  return result;
}

function _sanitizeFlatPresetEntry(key, val, shindo, lpgm, defaultPreset) {
  if (!val || typeof val !== "object" || !val.color || !val.fontColor) return;
  if (/^[Ll][0-4]$/.test(key)) {
    const num = key.slice(1);
    lpgm[num] = {
      color: normalizeHexColor(val.color, defaultPreset.lpgm[num].color),
      fontColor: normalizeHexColor(val.fontColor, defaultPreset.lpgm[num].fontColor),
    };
  } else if (SHINDO_KEYS.includes(key)) {
    shindo[key] = {
      color: normalizeHexColor(val.color, defaultPreset.shindo[key].color),
      fontColor: normalizeHexColor(val.fontColor, defaultPreset.shindo[key].fontColor),
    };
  }
}

/**
 * Validates and completes a preset object.
 * @param {Object} raw
 * @returns {Object} { shindo, lpgm }
 */
function sanitizePresetObject(raw) {
  const defaultPreset = BUILTIN_PRESETS.Default;
  const shindo = clonePreset(defaultPreset.shindo);
  const lpgm = clonePreset(defaultPreset.lpgm);

  Object.assign(shindo, _sanitizePresetGroup(raw.shindo, SHINDO_KEYS, defaultPreset.shindo));
  Object.assign(lpgm, _sanitizePresetGroup(raw.lpgm, LPGM_KEYS, defaultPreset.lpgm));

  for (const [key, val] of Object.entries(raw)) {
    _sanitizeFlatPresetEntry(key, val, shindo, lpgm, defaultPreset);
  }

  return { shindo, lpgm };
}

/**
 * Triggers a file download in the browser.
 * @param {string} filename
 * @param {string} content
 * @param {string} [mimeType="text/csv;charset=utf-8;"]
 */
export function downloadFile(filename, content, mimeType = "text/csv;charset=utf-8;") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Refreshes all badges in the map legend with current INTENSITY_CONFIG and LPGM_CONFIG.
 */
export function refreshLegendBadges() {
  const intensityBadges = document.querySelectorAll("#intensity-legend .intensity-badge");
  intensityBadges.forEach((badge) => {
    const match = badge.title?.match(/Intensity:\s*([\d+-]+)/);
    if (match && INTENSITY_CONFIG[match[1]]) {
      badge.style.backgroundColor = INTENSITY_CONFIG[match[1]].color;
      badge.style.color = INTENSITY_CONFIG[match[1]].fontColor;
    }
  });

  const lpgmBadges = document.querySelectorAll("#lpgm-legend .intensity-badge");
  lpgmBadges.forEach((badge) => {
    const match = badge.title?.match(/LPGM:\s*(\d+)/);
    if (match && LPGM_CONFIG[match[1]]) {
      badge.style.backgroundColor = LPGM_CONFIG[match[1]].color;
      badge.style.color = LPGM_CONFIG[match[1]].fontColor;
    }
  });
}

/**
 * Applies a color preset by name to INTENSITY_CONFIG and LPGM_CONFIG,
 * and refreshes all relevant map layers and DOM elements.
 * @param {string} presetName
 * @param {Object} [options={}]
 * @param {Function} [options.updateMapStyles] - Function(map) to re-paint map layers
 * @param {Function} [options.refreshSidebar] - Function() to refresh sidebar list items
 * @param {Function} [options.refreshInfoBox] - Function() to refresh infobox colors
 * @param {Function} [options.refreshHomeIntensity] - Function() to refresh home location intensity
 */
export function applyColorPreset(presetName, options = {}) {
  const preset = getPreset(presetName);

  // 1. Mutate INTENSITY_CONFIG in place
  for (const [k, v] of Object.entries(preset.shindo)) {
    INTENSITY_CONFIG[k] = { color: v.color, fontColor: v.fontColor };
  }

  // 2. Mutate LPGM_CONFIG in place
  for (const [k, v] of Object.entries(preset.lpgm)) {
    LPGM_CONFIG[k] = { color: v.color, fontColor: v.fontColor };
  }

  // 3. Update map legend badges
  refreshLegendBadges();

  // 4. Update map style layers if map is available
  if (options.updateMapStyles) {
    options.updateMapStyles(globalThis.__eqMap);
  }

  // 5. Update sidebar badges and item borders
  if (options.refreshSidebar) {
    options.refreshSidebar();
  }

  // 6. Update active report info box
  if (options.refreshInfoBox) {
    options.refreshInfoBox();
  }

  // 7. Update home location intensity display
  if (options.refreshHomeIntensity) {
    options.refreshHomeIntensity();
  }

  // 8. Dispatch event for any other external subscribers
  document.dispatchEvent(
    new CustomEvent("color-preset-applied", {
      detail: { name: presetName, preset },
    }),
  );
}
