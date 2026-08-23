/**
 * Manages the earthquake report sidebar display.
 * Shows reports with intensity images, colored borders, magnitude, and location.
 */

import { formatTimeJST, INTENSITY_CONFIG, PRUNE_MAX_AGE_MS, PRUNE_MAX_REPORTS } from "./constants.js";

/**
 * Current list of reports in the sidebar (for live mode updates).
 * Maintained as a reference to manage list updates.
 */
let _currentReports = [];

/**
 * Initializes sidebar with earthquake reports.
 * @param {Array} reports - Array of parsed earthquake reports
 * @param {Function} onReportSelect - Callback(report) when user clicks a report
 */
export function initSidebar(reports, onReportSelect) {
  const eqList = document.getElementById("eq-list");
  if (!eqList) return;

  // Clear existing items
  eqList.innerHTML = "";

  // Store reports in module state for live mode updates
  _currentReports = [...reports];

  if (!reports || reports.length === 0) {
    eqList.innerHTML = `
      <li class="eq-item placeholder">
        <span class="mono muted">No earthquake events</span>
      </li>
    `;
    return;
  }

  // Create an item for each report
  for (const report of reports) {
    const item = createReportItem(report, onReportSelect);
    eqList.appendChild(item);
  }
}

/**
 * Updates the sidebar to show loading progress.
 * @param {number|string} processed - Number of reports processed
 * @param {number|string} total - Total number of reports to process
 */
export function updateSidebarLoading(processed, total) {
  const eqList = document.getElementById("eq-list");
  if (!eqList) return;

  eqList.innerHTML = `
    <li class="eq-item placeholder">
      <span class="mono muted">Loading... ${processed}/${total} reports fetched</span>
    </li>
  `;
}

/**
 * Creates a DOM element for a single earthquake report.
 * Displays: intensity (image + colored border), magnitude, hypocenter name, time
 */
export function createReportItem(report, onReportSelect) {
  const item = document.createElement("li");
  item.className = "eq-item";
  item.dataset.eventId = report.eventId;

  const hasIntensity = !!(report.maxIntensity && INTENSITY_CONFIG[report.maxIntensity]);
  const intensityConfig = hasIntensity ? INTENSITY_CONFIG[report.maxIntensity] : null;
  const borderColor = intensityConfig ? intensityConfig.color : "#1e2e44";
  const intensityImg = intensityConfig ? intensityConfig.img : null;

  // Format time in JST
  const timeStr = report.originTime ? formatTimeJST(report.originTime * 1000) : "----/--/-- --:--";

  const intensityHtml = hasIntensity
    ? `<img 
        src="/img/shindo/${intensityImg}" 
        alt="Intensity ${report.maxIntensity}" 
        class="eq-intensity-img"
        title="Intensity: ${report.maxIntensity}"
      />`
    : `<div class="eq-intensity-placeholder">-</div>`;

  // Build HTML
  item.innerHTML = `
    <div class="eq-content">
      <div class="eq-left">
        <div class="eq-location-ja">${report.hypocenterJa}</div>
        <div class="eq-location-en" title="${report.hypocenterEn}">${report.hypocenterEn}</div>
        <div class="eq-footer">
          <div class="eq-mag">
            <span class="eq-mag-label">M</span>
            ${typeof report.magnitude === "number" ? report.magnitude.toFixed(1) : "--"}
          </div>
          <div class="eq-time">${timeStr}</div>
        </div>
      </div>
      <div class="eq-intensity-container">
        ${intensityHtml}
      </div>
    </div>
  `;

  // Set border color based on intensity
  item.style.borderColor = borderColor;
  item.style.borderWidth = "2px";

  // Add click handler
  item.addEventListener("click", () => {
    // Update active state
    document.querySelectorAll(".eq-item").forEach((el) => el.classList.remove("active"));
    item.classList.add("active");

    // Call callback
    if (onReportSelect) onReportSelect(report);
  });

  return item;
}

export function syncLiveModeToggleVisuals() {
  const toggleEl = document.getElementById("live-mode-toggle");
  if (!toggleEl) return;

  let savedState = localStorage.getItem("live-mode-enabled");
  if (savedState == null) {
    savedState = "true";
    localStorage.setItem("live-mode-enabled", "true");
  }
  toggleEl.checked = savedState === "true";
}

/**
 * Initializes the live mode toggle and sets up its event listener.
 * @param {Function} onToggle - Callback(enabled) when toggle state changes
 */
export function initLiveModeToggle(onToggle) {
  const toggleEl = document.getElementById("live-mode-toggle");
  if (!toggleEl) return;

  // State should already be synced by syncLiveModeToggleVisuals
  const savedState = toggleEl.checked;

  // Set initial callback
  if (onToggle) onToggle(savedState);

  // Listen for changes
  toggleEl.addEventListener("change", (e) => {
    const isEnabled = e.target.checked;
    localStorage.setItem("live-mode-enabled", isEnabled ? "true" : "false");
    if (onToggle) onToggle(isEnabled);
  });
}

/**
 * Initializes the auto-open toggle and sets up its event listener.
 * @param {Function} onToggle - Callback(enabled) when toggle state changes
 */
export function initAutoOpenToggle(onToggle) {
  const toggleEl = document.getElementById("auto-open-toggle");
  if (!toggleEl) return;

  // Load saved state from localStorage
  const savedState = localStorage.getItem("auto-open-enabled") === "true";
  toggleEl.checked = savedState;

  // Set initial callback
  if (onToggle) onToggle(savedState);

  // Listen for changes
  toggleEl.addEventListener("change", (e) => {
    const isEnabled = e.target.checked;
    localStorage.setItem("auto-open-enabled", isEnabled ? "true" : "false");
    if (onToggle) onToggle(isEnabled);
  });
}

/**
 * Initializes the city areas toggle and sets up its event listener.
 * @param {Function} onToggle - Callback(enabled) when toggle state changes
 */
export function initCityAreasToggle(onToggle) {
  const toggleEl = document.getElementById("city-areas-toggle");
  if (!toggleEl) return;

  // Load saved state from localStorage, default to true
  const savedState = localStorage.getItem("city-areas-enabled") === "true";
  toggleEl.checked = savedState;

  // Set initial callback
  if (onToggle) onToggle(savedState);

  // Listen for changes
  toggleEl.addEventListener("change", (e) => {
    const isEnabled = e.target.checked;
    localStorage.setItem("city-areas-enabled", isEnabled ? "true" : "false");
    if (onToggle) onToggle(isEnabled);
  });
}

/**
 * Gets the current auto-open state.
 * @returns {boolean} Whether auto-open is enabled
 */
export function getAutoOpenState() {
  const toggleEl = document.getElementById("auto-open-toggle");
  return toggleEl ? toggleEl.checked : false;
}

/**
 * Gets the current city areas state.
 * @returns {boolean} Whether city areas are enabled
 */
export function getCityAreasState() {
  const toggleEl = document.getElementById("city-areas-toggle");
  return toggleEl ? toggleEl.checked : true;
}

/**
 * Gets the current live mode state.
 * @returns {boolean} Whether live mode is enabled
 */
export function getLiveModeState() {
  const toggleEl = document.getElementById("live-mode-toggle");
  return toggleEl ? toggleEl.checked : false;
}

/**
 * Adds a new report to the sidebar list in chronological order (newest first).
 * Stores reference in _currentReports for future lookups.
 * @param {Object} report - The report to add
 * @param {Function} onReportSelect - Callback(report) when user clicks a report
 * @returns {boolean} True if added, false if it was a duplicate
 */
export function addReportToSidebar(report, onReportSelect) {
  const eqList = document.getElementById("eq-list");
  if (!eqList) return false;

  // Check if already exists
  if (_currentReports.some((r) => r.eventId === report.eventId)) {
    return false;
  }

  // Remove placeholder if present
  const placeholder = eqList.querySelector(".eq-item.placeholder");
  if (placeholder) placeholder.remove();

  // Create and insert item
  const item = createReportItem(report, onReportSelect);

  // Find correct insertion position (sorted by originTime, newest first)
  let inserted = false;
  const existingItems = eqList.querySelectorAll(".eq-item:not(.placeholder)");
  for (const existingItem of existingItems) {
    const existingReport = _currentReports.find(
      (r) => r.eventId === existingItem.dataset.eventId
    );
    if (
      existingReport &&
      (report.originTime || 0) > (existingReport.originTime || 0)
    ) {
      existingItem.before(item);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    eqList.appendChild(item);
  }

  // Track in current reports
  _currentReports.push(report);
  _currentReports.sort((a, b) => (b.originTime || 0) - (a.originTime || 0));

  _pruneReports();

  return true;
}

/**
 * Updates an existing report in the sidebar.
 * @param {Object} updatedReport - The updated report data
 * @param {Function} onReportSelect - Callback(report) when user clicks a report
 * @returns {boolean} True if updated, false if report not found
 */
export function updateReportInSidebar(updatedReport, onReportSelect) {
  const eqList = document.getElementById("eq-list");
  if (!eqList) return false;

  // Find and update in current reports
  const idx = _currentReports.findIndex((r) => r.eventId === updatedReport.eventId);
  if (idx === -1) return false;

  _currentReports[idx] = updatedReport;
  // Re-sort current reports because originTime might have changed (e.g. from flash to normal)
  _currentReports.sort((a, b) => (b.originTime || 0) - (a.originTime || 0));

  // Find and replace the DOM element
  const item = eqList.querySelector(`[data-event-id="${updatedReport.eventId}"]`);
  if (item) {
    const isActive = item.classList.contains("active");
    const newItem = createReportItem(updatedReport, onReportSelect);
    
    // Preserve active state
    if (isActive) {
      newItem.classList.add("active");
    }
    
    item.replaceWith(newItem);

    // Re-insert into the correct position if necessary (originTime may have changed)
    const existingItems = Array.from(eqList.querySelectorAll(".eq-item:not(.placeholder)"));
    // Since we replaced it in place, it might be in the wrong order now.
    // We can just append and then use standard DOM sorting or just re-insert.
    let inserted = false;
    for (const existingItem of existingItems) {
      if (existingItem === newItem) continue;
      const existingReport = _currentReports.find(
        (r) => r.eventId === existingItem.dataset.eventId
      );
      if (
        existingReport &&
        (updatedReport.originTime || 0) > (existingReport.originTime || 0)
      ) {
        existingItem.before(newItem);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      eqList.appendChild(newItem);
    }
  }

  _pruneReports();

  return true;
}

/**
 * Gets a report from the sidebar by event ID.
 * @param {string} eventId - The event ID to look up
 * @returns {Object|null} The report or null if not found
 */
export function getReportById(eventId) {
  return _currentReports.find((r) => r.eventId === eventId) || null;
}

/**
 * Gets all current reports.
 * @returns {Array} All reports
 */
export function getAllReports() {
  return _currentReports;
}

/**
 * Initializes the home location settings with prefecture and city dropdowns.
 * @param {Map<number, {name, kana, enName}>} prefectureCodes - Prefecture code mappings
 * @param {Map<string, {ja, en}>} cityNames - City name mappings
 * @param {Function} onHomeLocationChange - Callback({prefectureCode, cityCode, showMarker}) when settings change
 */
export function initHomeLocationSettings(prefectureCodes, cityNames, onHomeLocationChange) {
  const prefSelectEl = document.getElementById("home-prefecture-select");
  const citySelectEl = document.getElementById("home-city-select");
  const markerToggleEl = document.getElementById("home-marker-toggle");

  if (!prefSelectEl || !citySelectEl || !markerToggleEl) return;

  // Load saved home location from localStorage, default to Tokyo Shinjuku (1310400)
  const savedPref = localStorage.getItem("home-prefecture") || "13";
  const savedCity = localStorage.getItem("home-city") || "1310400";
  const savedShowMarker = localStorage.getItem("home-marker-enabled") === "true";

  // Populate prefecture dropdown
  prefSelectEl.innerHTML = "";
  for (const [code, info] of Array.from(prefectureCodes.entries()).sort((a, b) => a[0] - b[0])) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = `${info.name} • ${info.enName}`;
    prefSelectEl.appendChild(option);
  }
  prefSelectEl.value = savedPref;

  // Function to populate city dropdown based on selected prefecture
  const updateCityOptions = (prefCode) => {
    const prefixStr = String(prefCode).padStart(2, "0");
    const citiesInPref = Array.from(cityNames.entries())
      .filter(([code]) => code.startsWith(prefixStr))
      .sort((a, b) => a[0].localeCompare(b[0]));

    citySelectEl.innerHTML = "";
    for (const [code, info] of citiesInPref) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = `${info.ja} • ${info.en}`;
      citySelectEl.appendChild(option);
    }

    // Set city selection to saved value if it still exists, or first available
    if (savedCity && citiesInPref.some(([code]) => code === savedCity)) {
      citySelectEl.value = savedCity;
    } else if (citiesInPref.length > 0) {
      citySelectEl.value = citiesInPref[0][0];
    }
  };

  // Initial city population
  updateCityOptions(savedPref);

  // Set marker toggle
  markerToggleEl.checked = savedShowMarker;

  // Handle prefecture change
  prefSelectEl.addEventListener("change", () => {
    const prefCode = prefSelectEl.value;
    localStorage.setItem("home-prefecture", prefCode);
    updateCityOptions(prefCode);

    if (onHomeLocationChange) {
      onHomeLocationChange({
        prefectureCode: Number(prefCode),
        cityCode: citySelectEl.value,
        showMarker: markerToggleEl.checked,
      });
    }
  });

  // Handle city change
  citySelectEl.addEventListener("change", () => {
    const cityCode = citySelectEl.value;
    localStorage.setItem("home-city", cityCode);

    if (onHomeLocationChange) {
      onHomeLocationChange({
        prefectureCode: Number(prefSelectEl.value),
        cityCode: cityCode,
        showMarker: markerToggleEl.checked,
      });
    }
  });

  // Handle marker toggle
  markerToggleEl.addEventListener("change", () => {
    const isEnabled = markerToggleEl.checked;
    localStorage.setItem("home-marker-enabled", isEnabled ? "true" : "false");

    if (onHomeLocationChange) {
      onHomeLocationChange({
        prefectureCode: Number(prefSelectEl.value),
        cityCode: citySelectEl.value,
        showMarker: isEnabled,
      });
    }
  });

  // Return initial state
  return {
    prefectureCode: Number(savedPref),
    cityCode: savedCity || (citySelectEl.value ? citySelectEl.value : ""),
    showMarker: savedShowMarker,
  };
}

/**
 * Gets the current home location settings.
 * @returns {{prefectureCode: number, cityCode: string, showMarker: boolean}}
 */
export function getHomeLocation() {
  const prefSelectEl = document.getElementById("home-prefecture-select");
  const citySelectEl = document.getElementById("home-city-select");
  const markerToggleEl = document.getElementById("home-marker-toggle");

  return {
    prefectureCode: prefSelectEl ? Number(prefSelectEl.value) : 13,
    cityCode: citySelectEl ? citySelectEl.value : "",
    showMarker: markerToggleEl ? markerToggleEl.checked : false,
  };
}

/**
 * Initializes the home intensity toggle and sets up its event listener.
 * @param {Function} onToggle - Callback(enabled) when toggle state changes
 */
export function initHomeIntensityToggle(onToggle) {
  const toggleEl = document.getElementById("home-intensity-toggle");
  if (!toggleEl) return;

  // Load saved state from localStorage
  const savedState = localStorage.getItem("home-intensity-enabled") === "true";
  toggleEl.checked = savedState;

  // Set initial callback
  if (onToggle) onToggle(savedState);

  // Listen for changes
  toggleEl.addEventListener("change", (e) => {
    const isEnabled = e.target.checked;
    localStorage.setItem("home-intensity-enabled", isEnabled ? "true" : "false");
    if (onToggle) onToggle(isEnabled);
  });
}

/**
 * Gets the current home intensity display state.
 * @returns {boolean} Whether home intensity display is enabled
 */
export function getHomeIntensityState() {
  const toggleEl = document.getElementById("home-intensity-toggle");
  return toggleEl ? toggleEl.checked : false;
}

/**
 * Updates the fixed loading popup in the sidebar.
 * @param {number|string} processed - Number of reports processed
 * @param {number|string} total - Total number of reports to process
 */
export function updateSidebarLoadingPopup(processed, total) {
  const container = document.getElementById("sidebar-loading-container");
  const progressEl = document.getElementById("sidebar-loading-progress");
  if (!container || !progressEl) return;

  progressEl.textContent = `${processed}/${total}`;
  container.classList.remove("hidden");
}

/**
 * Hides the fixed loading popup in the sidebar.
 */
export function hideSidebarLoadingPopup() {
  const container = document.getElementById("sidebar-loading-container");
  if (container) {
    container.classList.add("hidden");
  }
}

/**
 * Prunes the sidebar reports list.
 * 1. Discards reports older than 30 days.
 * 2. If there are more than 300 reports, discards the oldest ones if they have Intensity <= 2 or unknown.
 */
function _pruneReports() {
  const eqList = document.getElementById("eq-list");
  if (!eqList) return;

  const now = Date.now();
  const toKeep = [];
  const toRemoveIds = new Set();
  
  let keptCount = 0;

  for (const report of _currentReports) {
    let reportTimeMs = 0;
    if (report.originTime) {
      reportTimeMs = report.originTime * 1000;
    } else if (report.feedRdt) {
      reportTimeMs = Date.parse(report.feedRdt);
    }
    
    if (!reportTimeMs || Number.isNaN(reportTimeMs)) {
      reportTimeMs = now;
    }

    const ageMs = now - reportTimeMs;

    // 1. Older than max age -> discard
    if (ageMs > PRUNE_MAX_AGE_MS) {
      toRemoveIds.add(report.eventId);
      continue;
    }

    // 2. Beyond max reports limit -> discard if Intensity 2 or less (or unknown)
    if (keptCount >= PRUNE_MAX_REPORTS) {
      const maxInt = report.maxIntensity || "";
      if (!maxInt || maxInt === "1" || maxInt === "2") {
        toRemoveIds.add(report.eventId);
        continue;
      }
    }

    toKeep.push(report);
    keptCount++;
  }

  if (toRemoveIds.size > 0) {
    _currentReports = toKeep;
    for (const id of toRemoveIds) {
      const item = eqList.querySelector(`[data-event-id="${id}"]`);
      if (item) {
        item.remove();
      }
    }
    
    document.dispatchEvent(new CustomEvent('reports-pruned', {
      detail: { removedIds: toRemoveIds }
    }));
  }
}
