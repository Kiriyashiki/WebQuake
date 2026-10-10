import "../styles/index.css";
import "maplibre-gl/dist/maplibre-gl.css";
import { initLogger } from "./logger.js";
import { fetchEarthquakeReports } from "./parseReports.js";
import {
  loadAreaCodes,
  loadPrefectureCodes,
  loadBoundsData,
  loadCityNames,
  loadStationNames,
} from "./areaCodes.js";
import {
  initMap,
  highlightObservations,
  fitBoundsToObservations,
  displayEpicenter,
  clearEpicenter,
  displayHomeMarker,
  clearHomeMarker,
  displayHomeLocationIntensity,
  displayHomeLocationDirectIntensity,
  hideHomeLocationIntensity,
  updateCityAreasVisibility,
  updateShakemapVisibility,
  clearShakemapHighlights,
  clearAllEpicenters,
  isShakemapVisible,
  isLpgmVisible,
  updateLpgmVisibility,
  paintCitiesMaxIntensity,
} from "./map.js";
import { eqdbIntensityToShindo } from "./constants.js";
import {
  addReportToSidebar,
  updateReportInSidebar,
  initAutoOpenToggle,
  getAutoOpenState,
  initCityAreasToggle,
  getCityAreasState,
  initLiveModeToggle,
  initHomeLocationSettings,
  getHomeLocation,
  initHomeIntensityToggle,
  getHomeIntensityState,
  updateSidebarLoading,
  updateSidebarLoadingPopup,
  hideSidebarLoadingPopup,
  syncLiveModeToggleVisuals,
} from "./sidebarUI.js";
import { startLivePolling, stopLivePolling } from "./liveMode.js";
import { playAudio, preloadAudio } from "./audio.js";
import {
  initEewSettings,
  handlePossibleEewReport,
  clearEewMapDisplay,
  updateHomeIntensityForActiveEews,
  getIsEewMapActive,
} from "./eew.js";
import { initHistoryController } from "./historyController.js";
import { initSettingsModal } from "./settingsManager.js";
import { displayMapInfoBox, updateMapLegend } from "./mapInfoBox.js";
import { isDesktop, desktopOpenUrl } from "./desktopBridge.js";
import { applyActiveColorPreset } from "./colorPresetsUI.js";

// In desktop apps (Tauri and Electron), external links launch in the system browser
if (isDesktop) {
  document.addEventListener("click", (e) => {
    const anchor = e.target.closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
      e.preventDefault();
      desktopOpenUrl(href);
    }
  });
}

export { updateMapLegend };

/**
 * Updates the status indicator in the top-right.
 * @param {'idle' | 'loading' | 'live' | 'error'} state
 */
function _updateStatus(state) {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  if (!dot || !text) return;

  dot.className = `dot-${state}`;
  const labels = {
    idle: "Idle",
    loading: "Fetching reports...",
    live: "Loaded",
    error: "Error",
  };
  text.textContent = labels[state] || state;
}

/**
 * Main application bootstrap function.
 */
async function boot() {
  await initLogger();
  syncLiveModeToggleVisuals();
  _updateStatus("loading");

  // Apply saved color preset to INTENSITY_CONFIG / LPGM_CONFIG and update legend
  applyActiveColorPreset();

  // Setup settings modal and color presets controls
  initSettingsModal();

  // Setup sidebar toggle button
  const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
  const sidebar = document.getElementById("sidebar");
  const toggleArrow = sidebarToggleBtn?.querySelector(".toggle-arrow");
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener("click", () => {
      sidebar.classList.toggle("hidden");
      sidebarToggleBtn.classList.toggle("closed");
      toggleArrow?.classList.toggle("rotated");
    });
  }

  const mapEl = document.getElementById("map");
  if (!mapEl) {
    console.error("[eq-viewer] Map element not found");
    _updateStatus("error");
    return;
  }

  // Load geographic and code data concurrently
  let areaCodes, prefectureCodes, cityNames, stationNames, featureBounds;
  try {
    [areaCodes, prefectureCodes, cityNames, stationNames, featureBounds] =
      await Promise.all([
        loadAreaCodes(),
        loadPrefectureCodes(),
        loadCityNames(),
        loadStationNames(),
        loadBoundsData(),
      ]);
  } catch (err) {
    console.error("[eq-viewer] Failed to load essential metadata:", err);
    _updateStatus("error");
    return;
  }

  // Initialize MapLibre map instance
  const map = initMap(mapEl, areaCodes, cityNames, stationNames, getCityAreasState);

  // Expose for later modules / debugging
  globalThis.__eqMap = map;
  globalThis.__areaCodes = areaCodes;
  globalThis.__prefectureCodes = prefectureCodes;
  globalThis.__cityNames = cityNames;

  // Handler for when an earthquake report is selected from sidebar
  let reportSelectTimer = null;
  const onReportSelect = (report) => {
    console.debug("[eq-viewer] Selected report:", report.eventId, report.hypocenterJa);
    console.debug("[eq-viewer] Map style loaded:", map.isStyleLoaded());

    if (reportSelectTimer) {
      clearTimeout(reportSelectTimer);
      reportSelectTimer = null;
    }

    clearEewMapDisplay();
    globalThis.__isPerCityModeActive = false;
    globalThis.__currentReport = report;
    clearAllEpicenters(map);

    clearShakemapHighlights(map);
    if (isShakemapVisible()) {
      updateShakemapVisibility(map, false);
    }

    if (isLpgmVisible()) {
      updateLpgmVisibility(map, false);
      updateMapLegend(false);
    }

    if (report.isFlashReport) {
      updateCityAreasVisibility(map, false);
    } else {
      updateCityAreasVisibility(map, getCityAreasState());
    }

    displayMapInfoBox(report, map);

    reportSelectTimer = setTimeout(() => {
      reportSelectTimer = null;
      if (globalThis.__isPerCityModeActive || globalThis.__currentReport !== report) {
        return;
      }
      try {
        console.debug("[eq-viewer] Map update: clearing old highlights");
        highlightObservations(map, report.observations);
        console.debug("[eq-viewer] Map update: highlights applied");

        requestAnimationFrame(() => {
          try {
            console.debug("[eq-viewer] Map update: fitting bounds");
            const isDistant = !!(
              report.isDistantEarthquake ||
              report.headTitle?.includes("遠地地震に関する情報") ||
              report.title?.includes("遠地地震に関する情報") ||
              report.ttl?.includes("遠地地震に関する情報")
            );
            const zoom = isDistant ? 4.5 : 7.5;
            const boundsFitted = fitBoundsToObservations(
              map,
              report.observations,
              featureBounds,
              report.isFlashReport ? false : getCityAreasState(),
              report.maxIntensity,
              report.coordinates,
              zoom,
            );
            console.debug("[eq-viewer] Map update: bounds fitted =", boundsFitted);

            if (report.coordinates) {
              displayEpicenter(map, report.coordinates);
              console.debug("[eq-viewer] Map update: epicenter placed");
              if (!boundsFitted) {
                map.flyTo({
                  center: [report.coordinates.longitude, report.coordinates.latitude],
                  zoom: isDistant ? 4.5 : 6,
                  essential: true,
                });
                console.debug("[eq-viewer] Map update: flyTo issued");
              }
            } else {
              clearEpicenter(map);
            }

            if (getHomeIntensityState()) {
              const homeLocation = getHomeLocation();
              if (homeLocation.cityCode && report.observations) {
                displayHomeLocationIntensity(homeLocation.cityCode, report.observations, cityNames);
              }
            } else {
              hideHomeLocationIntensity();
            }
            console.debug("[eq-viewer] Map update: complete");
          } catch (err) {
            console.error("[eq-viewer] Error in map camera update:", err);
          }
        });
      } catch (err) {
        console.error("[eq-viewer] Error in map highlight update:", err);
      }
    }, 50);
  };

  // Initialize History tab controller
  initHistoryController({
    map,
    areaCodes,
    cityNames,
    prefectureCodes,
    featureBounds,
    onReportSelect,
  });

  // Initialize auto-open toggle
  initAutoOpenToggle((isEnabled) => {
    console.debug("[eq-viewer] Auto-open:", isEnabled ? "enabled" : "disabled");
  });

  // Initialize city areas toggle
  initCityAreasToggle((isEnabled) => {
    console.debug("[eq-viewer] City areas:", isEnabled ? "enabled" : "disabled");
    if (globalThis.__currentReport?.isFlashReport) return;

    updateCityAreasVisibility(map, isEnabled);

    if (globalThis.__currentReport) {
      setTimeout(() => {
        if (!map.isStyleLoaded()) return;
        highlightObservations(map, globalThis.__currentReport.observations);
      }, 50);
    } else if (globalThis.__isPerCityModeActive && globalThis.__perCityMunicipalities) {
      if (isEnabled) {
        setTimeout(() => {
          if (!map.isStyleLoaded()) return;
          paintCitiesMaxIntensity(map, globalThis.__perCityMunicipalities);
        }, 50);
      }
    }
  });

  // Initialize home location settings
  initHomeLocationSettings(prefectureCodes, cityNames, (homeLocation) => {
    console.debug("[eq-viewer] Home location updated:", homeLocation);

    if (homeLocation.showMarker) {
      displayHomeMarker(map, homeLocation.cityCode, featureBounds);
    } else {
      clearHomeMarker(map);
    }

    const activeItem = document.querySelector(".eq-item.active");
    if (activeItem) {
      const activeReport = globalThis.__currentReport;
      if (activeReport && getHomeIntensityState()) {
        displayHomeLocationIntensity(homeLocation.cityCode, activeReport.observations, cityNames);
      } else {
        hideHomeLocationIntensity();
      }
    } else if (globalThis.__isPerCityModeActive && globalThis.__perCityMunicipalities) {
      if (homeLocation.cityCode) {
        const homeCodeStr = String(homeLocation.cityCode).padStart(7, "0");
        const homeRecord = globalThis.__perCityMunicipalities.find(
          (c) => String(c.city_code).padStart(7, "0") === homeCodeStr
        );
        const homeMaxInt = homeRecord ? (eqdbIntensityToShindo(homeRecord.max_intensity) || "0") : "0";
        displayHomeLocationDirectIntensity(homeLocation.cityCode, homeMaxInt, cityNames);
      } else {
        hideHomeLocationIntensity();
      }
    } else if (getIsEewMapActive() && getHomeIntensityState()) {
      updateHomeIntensityForActiveEews();
    }
  });

  // Initialize home intensity toggle
  initHomeIntensityToggle((isEnabled) => {
    console.debug("[eq-viewer] Home intensity:", isEnabled ? "enabled" : "disabled");

    const activeItem = document.querySelector(".eq-item.active");
    if (!isEnabled) {
      hideHomeLocationIntensity();
      return;
    }

    if (activeItem) {
      const activeReport = globalThis.__currentReport;
      if (activeReport) {
        const homeLocation = getHomeLocation();
        if (homeLocation.cityCode) {
          displayHomeLocationIntensity(homeLocation.cityCode, activeReport.observations, cityNames);
        }
      }
    } else if (globalThis.__isPerCityModeActive && globalThis.__perCityMunicipalities) {
      const homeLocation = getHomeLocation();
      if (homeLocation?.cityCode) {
        const homeCodeStr = String(homeLocation.cityCode).padStart(7, "0");
        const homeRecord = globalThis.__perCityMunicipalities.find(
          (c) => String(c.city_code).padStart(7, "0") === homeCodeStr
        );
        const homeMaxInt = homeRecord ? (eqdbIntensityToShindo(homeRecord.max_intensity) || "0") : "0";
        displayHomeLocationDirectIntensity(homeLocation.cityCode, homeMaxInt, cityNames);
      }
    } else if (getIsEewMapActive()) {
      updateHomeIntensityForActiveEews();
    }
  });

  // Display initial home marker if enabled
  const initialHomeLocation = getHomeLocation();
  if (initialHomeLocation.showMarker) {
    displayHomeMarker(map, initialHomeLocation.cityCode, featureBounds);
  }

  // Initialize EEW
  initEewSettings(map, featureBounds, cityNames, areaCodes);

  // Preload audio files so they don't hang fetch() during OS sleep/resume
  preloadAudio("/sfx/ping.wav");
  preloadAudio("/sfx/eew.wav");
  preloadAudio("/sfx/flash.wav");

  // Fetch initial reports
  _updateStatus("loading");
  updateSidebarLoading(0, "...");
  updateSidebarLoadingPopup(0, "...");

  try {
    let initialAutoOpenTriggered = false;
    const reports = await fetchEarthquakeReports(
      areaCodes,
      (report) => {
        addReportToSidebar(report, onReportSelect);

        if (!initialAutoOpenTriggered && getAutoOpenState()) {
          initialAutoOpenTriggered = true;
          const item = document.querySelector(`[data-event-id="${report.eventId}"]`);
          if (item) item.click();
        }
      },
      (processed, total) => {
        updateSidebarLoadingPopup(processed, total);
      },
    );

    hideSidebarLoadingPopup();
    _updateStatus("live");

    const playedNormalReports = new Set();
    for (const report of reports) {
      if (!report.isFlashReport) {
        playedNormalReports.add(report.eventId);
      }
    }

    // Initialize live mode
    initLiveModeToggle((isEnabled) => {
      if (isEnabled) {
        console.info("[eq-viewer] Live mode enabled");
        let mostRecentNewReport = null;

        startLivePolling(
          areaCodes,
          {
            onNewEntry: (entry, report) => {
              console.info("[eq-viewer] New entry:", report.eventId);

              if (report.isFlashReport) {
                playAudio("/sfx/flash.wav");
              } else if (!playedNormalReports.has(report.eventId)) {
                playedNormalReports.add(report.eventId);
                playAudio("/sfx/ping.wav");
              }

              const added = addReportToSidebar(report, onReportSelect);
              if (added) {
                if (report.coordinates) {
                  displayEpicenter(map, report.coordinates);
                }

                if (!mostRecentNewReport || report.feedRdt >= mostRecentNewReport.feedRdt) {
                  mostRecentNewReport = report;
                }

                const eewCheck = handlePossibleEewReport(report);
                const shouldAutoOpen = Boolean(
                  getAutoOpenState() && eewCheck !== false && mostRecentNewReport,
                );

                if (shouldAutoOpen) {
                  const targetReport = mostRecentNewReport || report;
                  console.debug("[eq-viewer] Auto-opening report:", targetReport.eventId);
                  const item = document.querySelector(`[data-event-id="${targetReport.eventId}"]`);
                  if (item) {
                    item.classList.remove("active");
                    item.click();
                  }
                }
              }
            },
            onUpdatedEntry: (entry, report) => {
              console.info("[eq-viewer] Updated entry:", report.eventId);

              if (report.isFlashReport) {
                playAudio("/sfx/flash.wav");
              } else if (!playedNormalReports.has(report.eventId)) {
                playedNormalReports.add(report.eventId);
                playAudio("/sfx/ping.wav");
              }

              const updated = updateReportInSidebar(report, onReportSelect);
              if (updated) {
                const activeItem = document.querySelector(".eq-item.active");
                if (activeItem && activeItem.dataset.eventId === report.eventId) {
                  console.debug("[eq-viewer] Reloading active report on map");
                  onReportSelect(report);
                }
              }
            },
            onError: (err) => {
              console.warn("[eq-viewer] Live polling error:", err);
            },
          },
          reports,
        );
      } else {
        console.info("[eq-viewer] Live mode disabled");
        stopLivePolling();
      }
    });
  } catch (err) {
    console.error("[eq-viewer] Failed to fetch initial reports:", err);
    _updateStatus("error");
    hideSidebarLoadingPopup();
  }
}

try {
  await boot();
} catch (err) {
  console.error(err);
}
