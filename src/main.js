import "../styles/index.css";
import { formatTimeJST, INTENSITY_CONFIG } from "./constants.js";
import { createRubyHtml, loadAreaCodes, loadPrefectureCodes, loadCityNames } from "./areaCodes.js";
import {
  initMap,
  highlightObservations,
  displayEpicenter,
  clearEpicenter,
  clearAllEpicenters,
  updateCityAreasVisibility,
  fitBoundsToObservations,
  displayHomeMarker,
  clearHomeMarker,
  displayHomeLocationIntensity,
  hideHomeLocationIntensity,
} from "./map.js";
import { fetchEarthquakeReports } from "./parseReports.js";
import {
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
} from "./sidebarUI.js";
import { renderObservationsList } from "./observationsList.js";
import { startLivePolling, stopLivePolling } from "./liveMode.js";
import {
  fetchHistoryReports,
  fetchHistoryEventList,
  getSearchPreset,
  fetchEqdbMaxDate,
} from "./historyMode.js";
import { initEewSettings, handlePossibleEewReport } from "./eew.js";
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

  // ─── Sidebar Tab Switching ─────────────────────────────────────────────────
  let historyReports = [];
  let _historyCachedEventList = null;
  let _historyLoadedCount = 0;
  let _currentHistoryPreset = "year";
  let _eqdbMaxDate = null;

  const tabButtons = document.querySelectorAll(".sidebar-tab");
  const liveTabContent = document.getElementById("live-tab-content");
  const historyTabContent = document.getElementById("history-tab-content");

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.dataset.tab;

      // Update active tab button
      tabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      // Show/hide content (no clearing — preserves DOM)
      if (tabName === "live") {
        liveTabContent.classList.add("active");
        historyTabContent.classList.remove("active");
      } else {
        liveTabContent.classList.remove("active");
        historyTabContent.classList.add("active");
      }
    });
  });

  // ─── History Search Controls ────────────────────────────────────────────────

  const presetButtons = document.querySelectorAll(".search-preset-btn");
  const customFields = document.getElementById("history-custom-fields");
  const searchBtn = document.getElementById("history-search-btn");
  const loadMoreBtn = document.getElementById("history-load-more-btn");

  // Preset button handling
  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.preset;

      // Update active state
      presetButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      _currentHistoryPreset = preset;

      // Show/hide custom fields
      if (preset === "custom") {
        customFields.classList.remove("hidden");
      } else {
        customFields.classList.add("hidden");
        // Populate fields from preset so they're visible if user switches to custom later
        _applyPresetToFields(preset);
      }
    });
  });

  /**
   * Applies a preset's values to the custom search fields.
   */
  function _applyPresetToFields(preset) {
    const params = getSearchPreset(preset, _eqdbMaxDate);
    const dateFromEl = document.getElementById("history-date-from");
    const dateToEl = document.getElementById("history-date-to");
    const minIntEl = document.getElementById("history-min-intensity");
    const magMinEl = document.getElementById("history-mag-min");
    const magMaxEl = document.getElementById("history-mag-max");
    const depMinEl = document.getElementById("history-depth-min");
    const depMaxEl = document.getElementById("history-depth-max");
    const sortEl = document.getElementById("history-sort");

    if (dateFromEl) dateFromEl.value = params.dateFrom;
    if (dateToEl) dateToEl.value = params.dateTo;
    if (minIntEl) minIntEl.value = params.maxInt;
    if (magMinEl) magMinEl.value = params.magMin;
    if (magMaxEl) magMaxEl.value = params.magMax;
    if (depMinEl) depMinEl.value = params.depMin;
    if (depMaxEl) depMaxEl.value = params.depMax;
    if (sortEl) sortEl.value = params.sort;
  }

  // Fetch EQDB max date, then initialize fields with default preset
  fetchEqdbMaxDate().then((maxDate) => {
    _eqdbMaxDate = maxDate;
    _applyPresetToFields("year");

    // Set date input constraints
    const dateFromEl = document.getElementById("history-date-from");
    const dateToEl = document.getElementById("history-date-to");
    if (dateFromEl) {
      dateFromEl.min = "2004-01-01";
      dateFromEl.max = maxDate;
    }
    if (dateToEl) {
      dateToEl.min = "2004-01-01";
      dateToEl.max = maxDate;
    }
  });

  /**
   * Reads search parameters from the form fields (or preset).
   */
  function _getSearchParams() {
    if (_currentHistoryPreset !== "custom") {
      // Use sort from UI even for presets
      const sortEl = document.getElementById("history-sort");
      const params = getSearchPreset(_currentHistoryPreset, _eqdbMaxDate);
      if (sortEl) params.sort = sortEl.value;
      return params;
    }

    const dateFrom = document.getElementById("history-date-from")?.value || "2004-01-01";
    const dateTo = document.getElementById("history-date-to")?.value || _eqdbMaxDate;
    const minInt = document.getElementById("history-min-intensity")?.value || "1";
    const magMin = document.getElementById("history-mag-min")?.value || "0.0";
    const magMax = document.getElementById("history-mag-max")?.value || "9.9";
    const depMin = document.getElementById("history-depth-min")?.value || "0";
    const depMax = document.getElementById("history-depth-max")?.value || "999";
    const sort = document.getElementById("history-sort")?.value || "S0";

    return {
      dateFrom,
      dateTo,
      magMin: Number.parseFloat(magMin).toFixed(1),
      magMax: Number.parseFloat(magMax).toFixed(1),
      depMin: String(Number.parseInt(depMin, 10)).padStart(3, "0"),
      depMax: String(Number.parseInt(depMax, 10)).padStart(3, "0"),
      maxInt: minInt,
      sort,
    };
  }

  // Search button handler
  if (searchBtn) {
    searchBtn.addEventListener("click", () => {
      if (searchBtn.classList.contains("loading")) return;
      _executeHistorySearch(areaCodes, onReportSelect);
    });
  }

  // Load More button handler
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      if (loadMoreBtn.classList.contains("loading")) return;
      _loadMoreHistoryReports(areaCodes, onReportSelect);
    });
  }

  /**
   * Executes a new history search: clears old results, fetches event list, loads first 50.
   */
  async function _executeHistorySearch(areaCodes, onReportSelect) {
    const historyList = document.getElementById("history-list");
    const loadingContainer = document.getElementById("history-loading-container");
    const progressEl = document.getElementById("history-loading-progress");

    if (!historyList) return;

    // Disable search button
    searchBtn.classList.add("loading");
    searchBtn.textContent = "Searching... · 検索中...";

    // Clear previous results
    historyList.innerHTML = "";
    historyReports = [];
    _historyLoadedCount = 0;
    _historyCachedEventList = null;
    if (loadMoreBtn) loadMoreBtn.style.display = "none";

    if (loadingContainer) loadingContainer.classList.remove("hidden");

    try {
      const params = _getSearchParams();

      // 1. Fetch event list
      _historyCachedEventList = await fetchHistoryEventList(params);

      if (_historyCachedEventList.length === 0) {
        historyList.innerHTML = `
          <li class="eq-item placeholder">
            <span class="mono muted">No results found · 結果なし</span>
          </li>
        `;
        return;
      }

      // Show result count — remove old summary first
      const existingSummary = historyList.parentNode.querySelector(".history-results-summary");
      if (existingSummary) existingSummary.remove();
      const summaryEl = document.createElement("div");
      summaryEl.className = "history-results-summary";
      summaryEl.textContent = `${_historyCachedEventList.length} events found (max 1000)`;
      historyList.before(summaryEl);

      // 2. Fetch first batch of reports
      const { reports } = await fetchHistoryReports(params, areaCodes, {
        limit: 50,
        offset: 0,
        cachedEventList: _historyCachedEventList,
        onReportFetched: (report) => {
          _addHistoryReportItem(historyList, report, onReportSelect);
        },
        onProgress: (processed, total) => {
          if (progressEl) progressEl.textContent = `${processed}/${total}`;
        },
      });

      historyReports = reports;
      _historyLoadedCount = Math.min(50, _historyCachedEventList.length);

      if (reports.length === 0) {
        historyList.innerHTML = `
          <li class="eq-item placeholder">
            <span class="mono muted">No reports could be loaded · レポートを読み込めませんでした</span>
          </li>
        `;
      }

      // Show Load More if there are more events
      if (_historyLoadedCount < _historyCachedEventList.length && loadMoreBtn) {
        loadMoreBtn.style.display = "block";
        loadMoreBtn.textContent = `Load More (${_historyCachedEventList.length - _historyLoadedCount} remaining) · もっと読み込む`;
        loadMoreBtn.classList.remove("loading");
      }
    } catch (err) {
      console.error("[eq-viewer] Failed to search history:", err);
      historyList.innerHTML = `
        <li class="eq-item placeholder">
          <span class="mono muted">Error searching · 検索エラー</span>
        </li>
      `;
    } finally {
      if (loadingContainer) loadingContainer.classList.add("hidden");
      searchBtn.classList.remove("loading");
      searchBtn.textContent = "Search · 検索";
    }
  }

  /**
   * Loads the next batch of 50 history reports.
   */
  async function _loadMoreHistoryReports(areaCodes, onReportSelect) {
    if (!_historyCachedEventList || _historyLoadedCount >= _historyCachedEventList.length) return;

    const historyList = document.getElementById("history-list");
    const loadingContainer = document.getElementById("history-loading-container");
    const progressEl = document.getElementById("history-loading-progress");

    loadMoreBtn.classList.add("loading");
    loadMoreBtn.textContent = "Loading... · 読み込み中...";
    if (loadingContainer) loadingContainer.classList.remove("hidden");

    try {
      const params = _getSearchParams();

      const { reports } = await fetchHistoryReports(params, areaCodes, {
        limit: 50,
        offset: _historyLoadedCount,
        cachedEventList: _historyCachedEventList,
        onReportFetched: (report) => {
          _addHistoryReportItem(historyList, report, onReportSelect);
        },
        onProgress: (processed, total) => {
          if (progressEl) progressEl.textContent = `${processed}/${total}`;
        },
      });

      historyReports.push(...reports);
      _historyLoadedCount = Math.min(_historyLoadedCount + 50, _historyCachedEventList.length);

      // Update or hide Load More
      const remaining = _historyCachedEventList.length - _historyLoadedCount;
      if (remaining > 0) {
        loadMoreBtn.textContent = `Load More (${remaining} remaining) · もっと読み込む`;
        loadMoreBtn.classList.remove("loading");
      } else {
        loadMoreBtn.style.display = "none";
      }
    } catch (err) {
      console.error("[eq-viewer] Failed to load more history:", err);
      loadMoreBtn.textContent = "Error · エラー";
    } finally {
      loadMoreBtn.classList.remove("loading");
      if (loadingContainer) loadingContainer.classList.add("hidden");
    }
  }

  /**
   * Adds a report item to the history list.
   */
  function _addHistoryReportItem(historyList, report, onReportSelect) {
    const item = document.createElement("li");
    item.className = "eq-item";
    item.dataset.eventId = report.eventId;

    const intensityConfig = INTENSITY_CONFIG[report.maxIntensity] || INTENSITY_CONFIG["1"];
    const borderColor = intensityConfig.color;
    const intensityImg = intensityConfig.img;

    const timeStr = report.originTime
      ? formatTimeJST(report.originTime * 1000)
      : "----/--/-- --:--";

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

    item.style.borderColor = borderColor;
    item.style.borderWidth = "2px";

    item.addEventListener("click", () => {
      // Clear active from both live and history lists
      document.querySelectorAll(".eq-item").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");

      if (onReportSelect) onReportSelect(report);
    });

    // Append in API-returned order (already sorted by selected sort mode)
    historyList.appendChild(item);
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
    console.log("[eq-viewer] Map style loaded:", map.isStyleLoaded());

    // Store current report in global for settings changes
    globalThis.__currentReport = report;

    // Clear all initial epicenters when a report is opened
    clearAllEpicenters(map);

    // Handle city areas visibility for flash reports
    // Flash reports don't have per-city data, so temporarily switch city mode off
    if (report.isFlashReport) {
      updateCityAreasVisibility(map, false);
    } else {
      // Restore city areas to user's preferred setting
      updateCityAreasVisibility(map, getCityAreasState());
    }

    // Show info box on map
    _displayMapInfoBox(report);

    // Give MapLibre a moment to apply layout property changes before setting feature states.
    // If setFeatureState is called on a source whose layers were just made visible in the same tick,
    // MapLibre often drops the feature states.
    setTimeout(() => {
      // Highlight areas on map based on observation intensity
      highlightObservations(map, report.observations);
      const boundsFitted = fitBoundsToObservations(
        map,
        report.observations,
        featureBounds,
        report.isFlashReport ? false : getCityAreasState(),
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
    }, 50);
  };

  // Initialize auto-open toggle
  initAutoOpenToggle((isEnabled) => {
    console.log("[eq-viewer] Auto-open:", isEnabled ? "enabled" : "disabled");
  });

  // Initialize city areas toggle
  initCityAreasToggle((isEnabled) => {
    console.log("[eq-viewer] City areas:", isEnabled ? "enabled" : "disabled");

    // Skip if we're currently viewing a flash report (which forces city areas off anyway)
    if (globalThis.__currentReport?.isFlashReport) return;

    updateCityAreasVisibility(map, isEnabled);

    // Re-apply highlights after a delay to ensure MapLibre retains them on the newly visible layer
    if (globalThis.__currentReport) {
      setTimeout(() => {
        if (!map.isStyleLoaded()) return;
        highlightObservations(map, globalThis.__currentReport.observations);
      }, 50);
    }
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

  // Initialize EEW
  initEewSettings(map, featureBounds, cityNames, areaCodes);

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
      },
    );

    hideSidebarLoadingPopup();

    // Display all epicenters on the map only if no report is currently open
    const activeItem = document.querySelector(".eq-item.active");
    if (!activeItem) {
      // displayAllEpicenters(map, reports);
    }

    _updateStatus("live");

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
              if (added) {
                if (report.coordinates) {
                  // Add new epicenter to map
                  displayEpicenter(map, report.coordinates);
                }

                // Track most recent new report for auto-open using the publish time (feedRdt)
                // This correctly handles flash reports which might have null originTime.
                if (!mostRecentNewReport || report.feedRdt >= mostRecentNewReport.feedRdt) {
                  mostRecentNewReport = report;
                }

                // Auto-open the most recent new report if enabled
                const eewCheck = handlePossibleEewReport(report);
                let shouldAutoOpen = false;

                if (getAutoOpenState()) {
                  if (eewCheck === false) {
                    // Suppressed because it's a lower intensity EEW
                    shouldAutoOpen = false;
                  } else if (mostRecentNewReport) {
                    shouldAutoOpen = true;
                  }
                }

                if (shouldAutoOpen) {
                  const targetReport = mostRecentNewReport || report;
                  console.log("[eq-viewer] Auto-opening report:", targetReport.eventId);
                  const item = document.querySelector(`[data-event-id="${targetReport.eventId}"]`);
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
 * Handles flash reports with appropriate badges and restricted data display.
 */
function _displayMapInfoBox(report) {
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

  // Clean up EEW specific DOM alterations
  const eewSerialRow = infoBox.querySelector(".eew-serial-row");
  if (eewSerialRow) eewSerialRow.remove();

  const eewIntensityPlaceholder = infoBox.querySelector(".eew-intensity-placeholder");
  if (eewIntensityPlaceholder) eewIntensityPlaceholder.remove();

  if (intensityImg) intensityImg.style.display = "block";

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
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "Coordinates";
    const { latitude, longitude } = report.coordinates;
    coordinates.textContent = `${latitude.toFixed(1)} ; ${longitude.toFixed(1)}`;
  } else if (coordinates) {
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "Coordinates";
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
      { isFlashReport: !!report.isFlashReport },
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
