import "../styles/index.css";
import { formatTimeJST, INTENSITY_CONFIG } from "./constants.js";
import { createRubyHtml, loadAreaCodes, loadPrefectureCodes, loadCityNames } from "./areaCodes.js";
import {
  initMap,
  highlightObservations,
  displayEpicenter,
  clearEpicenter,
  displayAllEpicenters,
  clearAllEpicenters,
  updateCityAreasVisibility,
  fitBoundsToObservations,
  displayHomeMarker,
  clearHomeMarker,
  displayHomeLocationIntensity,
  hideHomeLocationIntensity,
} from "./map.js";
import { fetchEarthquakeReports, fetchOlderReports } from "./parseReports.js";
import {
  initSidebar,
  updateSidebarLoading,
  updateSidebarLoadingPopup,
  hideSidebarLoadingPopup,
  initLiveModeToggle,
  initAutoOpenToggle,
  initCityAreasToggle,
  initHomeLocationSettings,
  getHomeLocation,
  addReportToSidebar,
  updateReportInSidebar,
  getAutoOpenState,
  getCityAreasState,
  initHomeIntensityToggle,
  getHomeIntensityState,
  getAllReports,
} from "./sidebarUI.js";
import { renderObservationsList } from "./observationsList.js";
import { startLivePolling, stopLivePolling } from "./liveMode.js";

async function boot() {
  // Load area code name mappings
  let areaCodes = new Map();
  try {
    areaCodes = await loadAreaCodes();
    console.info(`[eq-viewer] Loaded ${areaCodes.size} area code entries.`);
  } catch (err) {
    console.warn("[eq-viewer] Could not load area codes CSV:", err.message);
  }

  // Load prefecture code name mappings
  let prefectureCodes = new Map();
  try {
    prefectureCodes = await loadPrefectureCodes();
    console.info(`[eq-viewer] Loaded ${prefectureCodes.size} prefecture code entries.`);
  } catch (err) {
    console.warn("[eq-viewer] Could not load prefecture codes CSV:", err.message);
  }

  // Load city name mappings
  let cityNames = new Map();
  try {
    cityNames = await loadCityNames();
    console.info(`[eq-viewer] Loaded ${cityNames.size} city names.`);
  } catch (err) {
    console.warn("[eq-viewer] Could not load city.json:", err.message);
  }

  // Load feature bounds
  let featureBounds = null;
  try {
    const res = await fetch("/bounds.json");
    if (res.ok) {
      featureBounds = await res.json();
      console.info(`[eq-viewer] Loaded feature bounds.`);
    }
  } catch (err) {
    console.warn("[eq-viewer] Could not load bounds.json:", err.message);
  }

  // Boot the map
  const mapEl = document.getElementById("map");
  const map = initMap(mapEl, areaCodes, cityNames, getCityAreasState);

  // Expose for later modules / debugging
  globalThis.__eqMap = map;
  globalThis.__areaCodes = areaCodes;
  globalThis.__prefectureCodes = prefectureCodes;

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

  // Setup settings modal
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

  // Initialize sidebar with earthquake reports
  const onReportSelect = (report) => {
    console.log("[eq-viewer] Selected report:", report.eventId, report.hypocenterJa);

    // Store current report in global for settings changes
    globalThis.__currentReport = report;

    // Clear all initial epicenters when a report is opened
    clearAllEpicenters(map);

    // Show info box on map
    _displayMapInfoBox(report);

    // Highlight areas on map based on observation intensity
    highlightObservations(map, report.observations);
    const boundsFitted = fitBoundsToObservations(
      map,
      report.observations,
      featureBounds,
      getCityAreasState(),
      report.maxIntensity,
      report.coordinates,
    );

    // Display epicenter marker
    if (report.coordinates) {
      displayEpicenter(map, report.coordinates);
      if (!boundsFitted) {
        map.flyTo({
          center: [report.coordinates.longitude, report.coordinates.latitude],
          zoom: 6,
          essential: true,
        });
      }
    } else {
      clearEpicenter(map);
    }

    // Display home location intensity if enabled
    if (getHomeIntensityState()) {
      const homeLocation = getHomeLocation();
      if (homeLocation.cityCode && report.observations) {
        displayHomeLocationIntensity(homeLocation.cityCode, report.observations, cityNames);
      }
    } else {
      hideHomeLocationIntensity();
    }
  };

  // Initialize auto-open toggle
  initAutoOpenToggle((isEnabled) => {
    console.log("[eq-viewer] Auto-open:", isEnabled ? "enabled" : "disabled");
  });

  // Initialize city areas toggle
  initCityAreasToggle((isEnabled) => {
    console.log("[eq-viewer] City areas:", isEnabled ? "enabled" : "disabled");
    updateCityAreasVisibility(map, isEnabled);
  });

  // Initialize home location settings
  initHomeLocationSettings(prefectureCodes, cityNames, (homeLocation) => {
    console.log("[eq-viewer] Home location updated:", homeLocation);

    if (homeLocation.showMarker) {
      displayHomeMarker(map, homeLocation.cityCode, featureBounds);
    } else {
      clearHomeMarker(map);
    }

    // Update home intensity display if a report is currently open
    const activeItem = document.querySelector(".eq-item.active");
    if (activeItem) {
      const activeReport = globalThis.__currentReport;
      if (activeReport && getHomeIntensityState()) {
        displayHomeLocationIntensity(homeLocation.cityCode, activeReport.observations, cityNames);
      } else {
        hideHomeLocationIntensity();
      }
    }
  });

  // Initialize home intensity toggle
  initHomeIntensityToggle((isEnabled) => {
    console.log("[eq-viewer] Home intensity:", isEnabled ? "enabled" : "disabled");

    const activeItem = document.querySelector(".eq-item.active");
    if (!activeItem || !isEnabled) {
      hideHomeLocationIntensity();
      return;
    }

    // If there's an active report, display the home intensity
    const activeReport = globalThis.__currentReport;
    if (activeReport) {
      const homeLocation = getHomeLocation();
      if (homeLocation.cityCode) {
        displayHomeLocationIntensity(homeLocation.cityCode, activeReport.observations, cityNames);
      }
    }
  });

  // Display initial home marker if enabled
  const initialHomeLocation = getHomeLocation();
  if (initialHomeLocation.showMarker) {
    displayHomeMarker(map, initialHomeLocation.cityCode, featureBounds);
  }

  // Fetch initial reports
  _updateStatus("loading");
  updateSidebarLoading(0, "...");
  updateSidebarLoadingPopup(0, "...");

  try {
    const reports = await fetchEarthquakeReports(
      areaCodes,
      (report) => {
        // Add each report to sidebar as it's fetched (maintains newest-first order)
        addReportToSidebar(report, onReportSelect);
      },
      (processed, total) => {
        updateSidebarLoadingPopup(processed, total);
      }
    );

    hideSidebarLoadingPopup();

    // Display all epicenters on the map only if no report is currently open
    const activeItem = document.querySelector(".eq-item.active");
    if (!activeItem) {
      displayAllEpicenters(map, reports);
    }

    _updateStatus("live");

    // Setup load older reports button
    const loadOlderBtn = document.getElementById("load-older-reports-btn");
    if (loadOlderBtn) {
      loadOlderBtn.style.display = "block";
      loadOlderBtn.addEventListener("click", async () => {
        if (loadOlderBtn.classList.contains("loading")) return;

        loadOlderBtn.classList.add("loading");
        loadOlderBtn.textContent = "Loading...";

        try {
          const currentReports = getAllReports();
          const currentEventIds = new Set(currentReports.map((r) => r.eventId));

          const olderReports = await fetchOlderReports(
            areaCodes,
            currentEventIds,
            (processed, total) => {
              loadOlderBtn.textContent = `Loading... ${processed}/${total}`;
            },
          );

          for (const report of olderReports) {
            addReportToSidebar(report, onReportSelect);
          }

          // Only update all epicenters if no specific report is active
          if (!document.querySelector(".eq-item.active")) {
            displayAllEpicenters(map, getAllReports());
          }

          loadOlderBtn.style.display = "none"; // Hide when done
        } catch (err) {
          console.error("[eq-viewer] Error loading older reports:", err);
          loadOlderBtn.textContent = "Error loading";
          loadOlderBtn.classList.remove("loading");
        }
      });
    }

    // Initialize live mode
    initLiveModeToggle((isEnabled) => {
      if (isEnabled) {
        console.log("[eq-viewer] Live mode enabled");
        let mostRecentNewReport = null;

        startLivePolling(
          areaCodes,
          {
            onNewEntry: (entry, report) => {
              console.log("[eq-viewer] New entry:", report.eventId);

              // Play notification sound
              const audio = new Audio("/sfx/ping.wav");
              audio.play().catch((err) => console.warn("[eq-viewer] Failed to play sound:", err));

              const added = addReportToSidebar(report, onReportSelect);
              if (added && report.coordinates) {
                // Add new epicenter to map
                displayEpicenter(map, report.coordinates);

                // Track most recent new report for auto-open
                if (
                  !mostRecentNewReport ||
                  (report.originTime || 0) > (mostRecentNewReport.originTime || 0)
                ) {
                  mostRecentNewReport = report;
                }

                // Auto-open the most recent new report if enabled
                if (getAutoOpenState() && mostRecentNewReport) {
                  console.log("[eq-viewer] Auto-opening report:", mostRecentNewReport.eventId);
                  const item = document.querySelector(
                    `[data-event-id="${mostRecentNewReport.eventId}"]`,
                  );
                  if (item) {
                    item.classList.remove("active");
                    item.click();
                  }
                }
              }
            },
            onUpdatedEntry: (entry, report) => {
              console.log("[eq-viewer] Updated entry:", report.eventId);
              const updated = updateReportInSidebar(report, onReportSelect);
              if (updated) {
                // If the report is currently displayed on the map, refresh it
                const activeItem = document.querySelector(".eq-item.active");
                if (activeItem && activeItem.dataset.eventId === report.eventId) {
                  console.log("[eq-viewer] Reloading active report on map");
                  globalThis.__currentReport = report;
                  _displayMapInfoBox(report);
                  highlightObservations(map, report.observations);
                  const boundsFitted = fitBoundsToObservations(
                    map,
                    report.observations,
                    featureBounds,
                    getCityAreasState(),
                    report.maxIntensity,
                    report.coordinates,
                  );
                  if (report.coordinates) {
                    displayEpicenter(map, report.coordinates);
                    if (!boundsFitted) {
                      map.flyTo({
                        center: [report.coordinates.longitude, report.coordinates.latitude],
                        zoom: 6,
                        essential: true,
                      });
                    }
                  } else {
                    clearEpicenter(map);
                  }

                  // Update home location intensity display if enabled
                  if (getHomeIntensityState()) {
                    const homeLocation = getHomeLocation();
                    if (homeLocation.cityCode && report.observations) {
                      displayHomeLocationIntensity(
                        homeLocation.cityCode,
                        report.observations,
                        cityNames,
                      );
                    }
                  } else {
                    hideHomeLocationIntensity();
                  }
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
        console.log("[eq-viewer] Live mode disabled");
        stopLivePolling();
      }
    });
  } catch (err) {
    console.error("[eq-viewer] Failed to fetch initial reports:", err);
    _updateStatus("error");
    hideSidebarLoadingPopup();
  }
}

/**
 * Updates the status indicator in the top-right.
 */
function _updateStatus(state) {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");

  if (dot) {
    dot.className = `dot-${state}`;
  }
  if (text) {
    const labels = {
      idle: "Idle",
      loading: "Loading…",
      live: "Loaded",
      error: "Error",
    };
    text.textContent = labels[state] || "Unknown";
  }
}

/**
 * Displays report information in the top-left info box on the map.
 * Shows magnitude, depth, coordinates, time, intensity, and observations list.
 */
function _displayMapInfoBox(report) {
  const infoBox = document.getElementById("map-info-box");
  if (!infoBox) return;

  // Populate location
  const locationJa = infoBox.querySelector(".info-box-location-ja");
  const locationEn = infoBox.querySelector(".info-box-location-en");
  const intensityImg = infoBox.querySelector(".info-box-intensity-img");
  const magnitude = infoBox.querySelector(".info-magnitude");
  const depth = infoBox.querySelector(".info-depth");
  const coordinates = infoBox.querySelector(".info-coordinates");
  const timeEl = infoBox.querySelector(".info-time");

  if (locationJa)
    locationJa.innerHTML = createRubyHtml(report.hypocenterJa, report.hypocenterKana) || "不明";
  if (locationEn) locationEn.textContent = report.hypocenterEn || "Unknown";

  // Set intensity image
  if (intensityImg) {
    const intensityConfig = INTENSITY_CONFIG[report.maxIntensity] || INTENSITY_CONFIG["1"];
    intensityImg.src = `/img/shindo/${intensityConfig.img}`;
    intensityImg.alt = `Intensity ${report.maxIntensity}`;
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
    const { latitude, longitude } = report.coordinates;
    coordinates.textContent = `${latitude.toFixed(1)} ; ${longitude.toFixed(1)}`;
  } else if (coordinates) {
    coordinates.textContent = "--";
  }

  if (timeEl) {
    timeEl.textContent = report.originTime
      ? formatTimeJST(report.originTime * 1000) + " ごろ"
      : "--";
  }

  // Render observations list
  const observationsContainer = infoBox.querySelector("#observations-list-container");
  if (observationsContainer && report.observations) {
    renderObservationsList(
      observationsContainer,
      report.observations,
      globalThis.__areaCodes || new Map(),
      globalThis.__prefectureCodes || new Map(),
    );
  }

  // Setup observations list toggle
  const observationsWrapper = infoBox.querySelector(".observations-list-wrapper");
  if (observationsWrapper) {
    const header = observationsWrapper.querySelector(".observations-list-header");
    const toggle = observationsWrapper.querySelector(".observations-list-toggle");
    const container = observationsWrapper.querySelector(".observations-list-container");

    if (header && toggle && container) {
      // Set initial state: collapsed on mobile, expanded on desktop
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        container.classList.add("collapsed");
        toggle.classList.remove("rotated");
      } else {
        container.classList.remove("collapsed");
        toggle.classList.add("rotated");
      }

      // Remove any existing listeners by cloning and replacing
      const newHeader = header.cloneNode(true);
      header.parentNode.replaceChild(newHeader, header);

      // Toggle functionality
      newHeader.addEventListener("click", () => {
        container.classList.toggle("collapsed");
        toggle.classList.toggle("rotated");
      });
    }
  }

  // Show the info box
  infoBox.classList.remove("hidden");
}

boot().catch(console.error);
