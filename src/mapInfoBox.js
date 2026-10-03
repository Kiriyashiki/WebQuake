import { createRubyHtml } from "./areaCodes.js";
import {
  formatTimeJST,
  formatTimeJSTWithSeconds,
  INTENSITY_CONFIG,
  LPGM_CONFIG,
} from "./constants.js";
import { renderObservationsList } from "./observationsList.js";
import {
  updateLpgmVisibility,
  updateCityAreasVisibility,
  highlightObservations,
  updateShakemapVisibility,
  clearShakemapHighlights,
  highlightShakemapObservations,
} from "./map.js";
import { getCityAreasState } from "./sidebarUI.js";

/**
 * Checks if a report contains station-level observation data.
 */
function _reportHasStations(report) {
  if (!report.observations) return false;
  for (const pref of report.observations) {
    for (const area of pref.areas) {
      for (const city of area.cities) {
        if (city.stations && city.stations.length > 0) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Updates the map legend display between normal intensity and LPGM scale.
 * @param {boolean} isLpgm
 */
export function updateMapLegend(isLpgm) {
  const intensityLegend = document.getElementById("intensity-legend");
  const lpgmLegend = document.getElementById("lpgm-legend");
  if (!intensityLegend || !lpgmLegend) return;

  if (isLpgm) {
    intensityLegend.classList.add("hidden");
    lpgmLegend.classList.remove("hidden");
  } else {
    intensityLegend.classList.remove("hidden");
    lpgmLegend.classList.add("hidden");
  }
}

/**
 * Displays the earthquake report details in the map info box.
 * Handles flash reports with appropriate badges and restricted data display.
 * @param {Object} report
 * @param {Object} map
 */
export function displayMapInfoBox(report, map) {
  const infoBox = document.getElementById("map-info-box");
  if (!infoBox) return;

  // Populate location
  const locationJa = infoBox.querySelector(".info-box-location-ja");
  const locationEn = infoBox.querySelector(".info-box-location-en");
  const flashBadge = infoBox.querySelector(".info-box-flash-badge");
  const intensityImg = infoBox.querySelector(".info-box-intensity-img");
  const magnitude = infoBox.querySelector(".info-magnitude");
  const depth = infoBox.querySelector(".info-depth");
  const coordinates = infoBox.querySelector(".info-coordinates");
  const timeEl = infoBox.querySelector(".info-time");

  if (locationJa)
    locationJa.innerHTML = createRubyHtml(report.hypocenterJa, report.hypocenterKana) || "不明";
  if (locationEn) locationEn.textContent = report.hypocenterEn || "Unknown";

  // Clean up EEW specific DOM alterations & placeholders
  const eewSerialRow = infoBox.querySelector(".eew-serial-row");
  if (eewSerialRow) eewSerialRow.remove();

  const eewSourceRow = infoBox.querySelector(".eew-source-row");
  if (eewSourceRow) eewSourceRow.remove();

  const eewSerial = infoBox.querySelector(".info-box-eew-serial");
  if (eewSerial) {
    eewSerial.textContent = "";
    eewSerial.classList.add("hidden");
  }

  const eewIntensityPlaceholder = infoBox.querySelector(".eew-intensity-placeholder");
  if (eewIntensityPlaceholder) eewIntensityPlaceholder.remove();

  const existingPlaceholder = infoBox.querySelector(".info-box-intensity-placeholder");
  if (existingPlaceholder) existingPlaceholder.remove();

  const intensityContainer = infoBox.querySelector(".info-box-intensity-container");

  // Restore flash badge styling
  if (flashBadge) {
    flashBadge.style.backgroundColor = "";
    flashBadge.style.borderColor = "";
    const badgeText = flashBadge.querySelector(".flash-badge-text");
    if (badgeText) {
      badgeText.textContent = "速報 · Flash Report";
      badgeText.style.color = "";
    }

    if (report.isFlashReport) {
      flashBadge.classList.remove("hidden");
    } else {
      flashBadge.classList.add("hidden");
    }
  }

  // Set intensity image / placeholder
  const hasIntensity = !!(report.maxIntensity && INTENSITY_CONFIG[report.maxIntensity]);
  if (hasIntensity) {
    if (intensityImg) {
      intensityImg.style.display = "block";
      const intensityConfig = INTENSITY_CONFIG[report.maxIntensity];
      intensityImg.src = `/img/shindo/${intensityConfig.img}`;
      intensityImg.alt = `Intensity ${report.maxIntensity}`;
      intensityImg.title = `Intensity: ${report.maxIntensity}`;
    }
  } else {
    if (intensityImg) {
      intensityImg.style.display = "none";
    }
    if (intensityContainer) {
      const placeholder = document.createElement("div");
      placeholder.className = "info-box-intensity-placeholder";
      placeholder.textContent = "-";
      intensityContainer.appendChild(placeholder);
    }
  }

  // Handle volcano report: remove/hide magnitude and depth rows, replace with volcano notice
  const magRow = infoBox.querySelector(".info-box-magnitude-row") || magnitude?.closest(".info-box-row");
  const depthRow = infoBox.querySelector(".info-box-depth-row") || depth?.closest(".info-box-row");
  let volcanoRow = infoBox.querySelector(".info-box-volcano-row");

  if (report.isVolcano) {
    if (magRow) magRow.classList.add("hidden");
    if (depthRow) depthRow.classList.add("hidden");
    if (!volcanoRow) {
      volcanoRow = document.createElement("div");
      volcanoRow.className = "info-box-row info-box-volcano-row";
      if (magRow) {
        magRow.parentNode.insertBefore(volcanoRow, magRow);
      }
    }
    volcanoRow.innerHTML = `<span class="info-label info-bold-label">LARGE VOLCANIC ERUPTION • 大規模な噴火</span>`;
    volcanoRow.classList.remove("hidden");
  } else {
    if (magRow) magRow.classList.remove("hidden");
    if (depthRow) depthRow.classList.remove("hidden");
    if (volcanoRow) volcanoRow.classList.add("hidden");
  }

  // Populate details
  if (magnitude) {
    magnitude.textContent =
      typeof report.magnitude === "number" ? "M " + report.magnitude.toFixed(1) : "--";
  }

  if (depth) {
    depth.textContent = typeof report.depth === "number" ? `${report.depth.toFixed(0)} km` : "--";
  }

  if (coordinates && report.coordinates) {
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "Coordinates • 北緯東経";
    const { latitude, longitude } = report.coordinates;
    const precision = report.isHistory || report.hasSpecialReport ? 3 : 1;
    coordinates.textContent = `${latitude.toFixed(precision)} ; ${longitude.toFixed(precision)}`;
  } else if (coordinates) {
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "Coordinates • 北緯東経";
    coordinates.textContent = "--";
  }

  // Restore observations label
  const obsLabel = infoBox.querySelector(".observations-list-label");
  if (obsLabel) obsLabel.textContent = "Observations • 観測";

  const obsWrapper = infoBox.querySelector(".observations-list-wrapper");
  if (obsWrapper) {
    const toggleBtn = obsWrapper.querySelector(".observations-list-toggle");
    if (toggleBtn) toggleBtn.style.display = "";
  }

  if (timeEl) {
    if (report.isHistory) {
      timeEl.textContent = report.originTime
        ? formatTimeJSTWithSeconds(report.originTime * 1000)
        : "--";
    } else {
      timeEl.textContent = report.originTime
        ? formatTimeJST(report.originTime * 1000) + " ごろ"
        : "--";
    }
  }

  // Render observations list
  const observationsContainer = infoBox.querySelector("#observations-list-container");
  if (observationsContainer && report.observations) {
    renderObservationsList(
      observationsContainer,
      report.observations,
      globalThis.__areaCodes || new Map(),
      globalThis.__prefectureCodes || new Map(),
      { isFlashReport: !!report.isFlashReport },
    );
  }

  // Setup LPGM row in details
  const lpgmRow = infoBox.querySelector(".info-box-lpgm-row");
  const lpgmValue = infoBox.querySelector(".info-lpgm");
  if (lpgmRow && lpgmValue) {
    if (report.lpgmInfo?.maxLgInt) {
      const maxLg = report.lpgmInfo.maxLgInt;
      lpgmValue.textContent = `CLASS ${maxLg}`;
      const lpgmConfig = LPGM_CONFIG[maxLg];
      if (lpgmConfig) {
        lpgmValue.style.backgroundColor = lpgmConfig.color;
        lpgmValue.style.color = lpgmConfig.fontColor;
        lpgmValue.style.padding = "2px 6px";
        lpgmValue.style.borderRadius = "4px";
      }
      lpgmRow.classList.remove("hidden");
    } else {
      lpgmRow.classList.add("hidden");
      lpgmValue.textContent = "";
      lpgmValue.style.backgroundColor = "";
    }
  }

  // Hide map-toggles-wrapper by default, show if either child is active
  const mapTogglesWrapper = infoBox.querySelector(".map-toggles-wrapper");

  // Setup LPGM toggle button
  const lpgmWrapper = infoBox.querySelector(".lpgm-toggle-wrapper");
  let lpgmAvailable = false;
  if (lpgmWrapper) {
    const lpgmHeader = lpgmWrapper.querySelector(".lpgm-toggle-header");

    if (
      !report.lpgmInfo?.observations ||
      report.lpgmInfo.observations.length === 0
    ) {
      lpgmWrapper.classList.add("hidden");
    } else {
      lpgmAvailable = true;
      lpgmWrapper.classList.remove("hidden", "active");

      const newLpgmHeader = lpgmHeader.cloneNode(true);
      lpgmHeader.parentNode.replaceChild(newLpgmHeader, lpgmHeader);

      newLpgmHeader.addEventListener("click", () => {
        const isCurrentlyActive = lpgmWrapper.classList.contains("active");

        if (isCurrentlyActive) {
          lpgmWrapper.classList.remove("active");
          updateLpgmVisibility(map, false);

          if (report.isFlashReport) {
            updateCityAreasVisibility(map, false);
          } else {
            updateCityAreasVisibility(map, getCityAreasState());
          }

          updateMapLegend(false);
          renderObservationsList(
            observationsContainer,
            report.observations,
            globalThis.__areaCodes || new Map(),
            globalThis.__prefectureCodes || new Map(),
            { isFlashReport: !!report.isFlashReport },
          );

          setTimeout(() => {
            highlightObservations(map, report.observations, false);
          }, 50);
        } else {
          const shakemapWrapper = infoBox.querySelector(".shakemap-toggle-wrapper");
          if (shakemapWrapper?.classList.contains("active")) {
            shakemapWrapper.querySelector(".shakemap-toggle-header").click();
          }

          lpgmWrapper.classList.add("active");
          updateLpgmVisibility(map, true);

          updateMapLegend(true);
          renderObservationsList(
            observationsContainer,
            report.lpgmInfo.observations,
            globalThis.__areaCodes || new Map(),
            globalThis.__prefectureCodes || new Map(),
            { isFlashReport: false, isLpgm: true },
          );

          setTimeout(() => {
            highlightObservations(map, report.lpgmInfo.observations, true);
          }, 50);
        }
      });
    }
  }

  // Setup shakemap toggle button
  const shakemapWrapper = infoBox.querySelector(".shakemap-toggle-wrapper");
  let shakemapAvailable = false;
  if (shakemapWrapper) {
    const shakemapHeader = shakemapWrapper.querySelector(".shakemap-toggle-header");

    const hasStations = _reportHasStations(report);
    if (!hasStations || report.isFlashReport) {
      shakemapWrapper.classList.add("hidden");
    } else {
      shakemapAvailable = true;
      shakemapWrapper.classList.remove("hidden", "active");

      const newShakemapHeader = shakemapHeader.cloneNode(true);
      shakemapHeader.parentNode.replaceChild(newShakemapHeader, shakemapHeader);

      newShakemapHeader.addEventListener("click", () => {
        const isCurrentlyActive = shakemapWrapper.classList.contains("active");

        if (isCurrentlyActive) {
          shakemapWrapper.classList.remove("active");
          updateShakemapVisibility(map, false);
          clearShakemapHighlights(map);

          if (report.isFlashReport) {
            updateCityAreasVisibility(map, false);
          } else {
            updateCityAreasVisibility(map, getCityAreasState());
          }

          setTimeout(() => {
            highlightObservations(map, report.observations);
          }, 50);
        } else {
          const lpgmWrapper = infoBox.querySelector(".lpgm-toggle-wrapper");
          if (lpgmWrapper?.classList.contains("active")) {
            lpgmWrapper.querySelector(".lpgm-toggle-header").click();
          }

          shakemapWrapper.classList.add("active");
          updateShakemapVisibility(map, true);

          setTimeout(() => {
            highlightShakemapObservations(map, report.observations);
          }, 50);
        }
      });
    }
  }

  if (mapTogglesWrapper) {
    if (!shakemapAvailable && !lpgmAvailable) {
      mapTogglesWrapper.classList.add("hidden");
    } else {
      mapTogglesWrapper.classList.remove("hidden");
    }
  }

  // Setup observations list toggle
  const observationsWrapper = infoBox.querySelector(".observations-list-wrapper");
  if (observationsWrapper) {
    const header = observationsWrapper.querySelector(".observations-list-header");
    const toggle = observationsWrapper.querySelector(".observations-list-toggle");
    const container = observationsWrapper.querySelector(".observations-list-container");

    if (header && toggle && container) {
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        container.classList.add("collapsed");
        toggle.classList.remove("rotated");
      } else {
        container.classList.remove("collapsed");
        toggle.classList.add("rotated");
      }

      const newHeader = header.cloneNode(true);
      header.parentNode.replaceChild(newHeader, header);

      newHeader.addEventListener("click", () => {
        container.classList.toggle("collapsed");
        toggle.classList.toggle("rotated");
      });
    }
  }

  infoBox.classList.remove("hidden");
}
