/**
 * Manages the earthquake report sidebar display.
 * Shows reports with intensity images, colored borders, magnitude, and location.
 */

import { formatTimeJST, INTENSITY_CONFIG } from "./constants.js";

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
    const item = _createReportItem(report, onReportSelect);
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
function _createReportItem(report, onReportSelect) {
  const item = document.createElement("li");
  item.className = "eq-item";
  item.dataset.eventId = report.eventId;

  const intensityConfig = INTENSITY_CONFIG[report.maxIntensity] || INTENSITY_CONFIG["1"];
  const borderColor = intensityConfig.color;
  const intensityImg = intensityConfig.img;

  // Format time in JST
  const timeStr = report.originTime ? formatTimeJST(report.originTime * 1000) : "----/--/-- --:--";

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
        <img 
          src="/img/shindo/${intensityImg}" 
          alt="Intensity ${report.maxIntensity}" 
          class="eq-intensity-img"
          title="Intensity: ${report.maxIntensity}"
        />
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

/**
 * Initializes the live mode toggle and sets up its event listener.
 * @param {Function} onToggle - Callback(enabled) when toggle state changes
 */
export function initLiveModeToggle(onToggle) {
  const toggleEl = document.getElementById("live-mode-toggle");
  if (!toggleEl) return;

  // Load saved state from localStorage
  const savedState = localStorage.getItem("live-mode-enabled") === "true";
  toggleEl.checked = savedState;

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
  const item = _createReportItem(report, onReportSelect);

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
      eqList.insertBefore(item, existingItem);
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

  // Find and replace the DOM element
  const item = eqList.querySelector(`[data-event-id="${updatedReport.eventId}"]`);
  if (item) {
    const newItem = _createReportItem(updatedReport, onReportSelect);
    item.replaceWith(newItem);
  }

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
