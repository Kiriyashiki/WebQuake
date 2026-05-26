/**
 * Manages the earthquake report sidebar display.
 * Shows reports with intensity images, colored borders, magnitude, and location.
 */

import { formatTimeJST, INTENSITY_CONFIG } from "./constants.js";

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
