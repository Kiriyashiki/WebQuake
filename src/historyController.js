import {
  fetchHistoryReports,
  fetchHistoryEventList,
  fetchHistoryReport,
  getSearchPreset,
  fetchEqdbMaxDate,
  EQDB_MIN_DATE,
} from "./historyMode.js";
import { createReportItem } from "./sidebarUI.js";

/**
 * Initializes History Mode tab switching, preset buttons, search controls, and report loading.
 * @param {Object} options
 * @param {Map} options.areaCodes
 * @param {Function} options.onReportSelect
 */
export function initHistoryController({ areaCodes, onReportSelect }) {
  let historyReports = [];
  let _historyCachedEventList = null;
  let _historyLoadedCount = 0;
  let _currentHistoryPreset = "year";
  let _eqdbMaxDate = null;

  // ─── Sidebar Tab Switching ─────────────────────────────────────────────────
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
      dateFromEl.min = EQDB_MIN_DATE;
      dateFromEl.max = maxDate;
    }
    if (dateToEl) {
      dateToEl.min = EQDB_MIN_DATE;
      dateToEl.max = maxDate;
    }
  });

  /**
   * Reads search parameters from the form fields (or preset).
   */
  function _getSearchParams() {
    if (_currentHistoryPreset !== "custom") {
      const sortEl = document.getElementById("history-sort");
      const params = getSearchPreset(_currentHistoryPreset, _eqdbMaxDate);
      if (sortEl) params.sort = sortEl.value;
      return params;
    }

    const dateFromEl = document.getElementById("history-date-from");
    const dateToEl = document.getElementById("history-date-to");
    let dateFrom = dateFromEl?.value || EQDB_MIN_DATE;
    if (dateFrom < EQDB_MIN_DATE) {
      dateFrom = EQDB_MIN_DATE;
      if (dateFromEl) dateFromEl.value = EQDB_MIN_DATE;
    }
    let dateTo = dateToEl?.value || _eqdbMaxDate;
    if (dateTo && dateTo < EQDB_MIN_DATE) {
      dateTo = EQDB_MIN_DATE;
      if (dateToEl) dateToEl.value = EQDB_MIN_DATE;
    }
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
      _executeHistorySearch();
    });
  }

  // Load More button handler
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      if (loadMoreBtn.classList.contains("loading")) return;
      _loadMoreHistoryReports();
    });
  }

  /**
   * Executes a new history search: clears old results, fetches event list, loads first 50.
   */
  async function _executeHistorySearch() {
    const historyList = document.getElementById("history-list");
    const loadingContainer = document.getElementById("history-loading-container");
    const progressEl = document.getElementById("history-loading-progress");

    if (!historyList) return;

    searchBtn.classList.add("loading");
    searchBtn.textContent = "Searching... · 検索中...";

    historyList.innerHTML = "";
    historyReports = [];
    _historyLoadedCount = 0;
    _historyCachedEventList = null;
    if (loadMoreBtn) loadMoreBtn.style.display = "none";

    if (loadingContainer) loadingContainer.classList.remove("hidden");

    try {
      const params = _getSearchParams();

      _historyCachedEventList = await fetchHistoryEventList(params);

      if (_historyCachedEventList.length === 0) {
        historyList.innerHTML = `
          <li class="eq-item placeholder">
            <span class="mono muted">No results found · 結果なし</span>
          </li>
        `;
        return;
      }

      const existingSummary = historyList.parentNode.querySelector(".history-results-summary");
      if (existingSummary) existingSummary.remove();
      const summaryEl = document.createElement("div");
      summaryEl.className = "history-results-summary";
      summaryEl.textContent = `${_historyCachedEventList.length} events found (max 1000)`;
      historyList.before(summaryEl);

      const { reports } = await fetchHistoryReports(params, areaCodes, {
        limit: 50,
        offset: 0,
        cachedEventList: _historyCachedEventList,
        onReportFetched: (report) => {
          _addHistoryReportItem(historyList, report);
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
  async function _loadMoreHistoryReports() {
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
          _addHistoryReportItem(historyList, report);
        },
        onProgress: (processed, total) => {
          if (progressEl) progressEl.textContent = `${processed}/${total}`;
        },
      });

      historyReports.push(...reports);
      _historyLoadedCount = Math.min(_historyLoadedCount + 50, _historyCachedEventList.length);

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
  function _addHistoryReportItem(historyList, report) {
    let currentReport = report;
    let fetchPromise = null;

    const item = createReportItem(report, null, async (itemEl) => {
      const allItems = document.querySelectorAll(".eq-item");
      allItems.forEach((i) => i.classList.remove("active"));

      const targetEl = document.querySelector(`[data-event-id="${currentReport.eventId}"]`) || itemEl;
      targetEl.classList.add("active");

      const loadingContainer = document.getElementById("history-loading-container");
      const progressEl = document.getElementById("history-loading-progress");

      if (currentReport.observations && currentReport.observations.length > 0) {
        onReportSelect(currentReport);
        return;
      }

      if (loadingContainer) {
        loadingContainer.classList.remove("hidden");
        if (progressEl) progressEl.textContent = "Loading... · 読み込み中...";
      }
      targetEl.classList.add("loading");

      try {
        if (!fetchPromise) {
          fetchPromise = fetchHistoryReport(currentReport, areaCodes);
        }
        const fullReport = await fetchPromise;
        if (fullReport) {
          currentReport = fullReport;
          const idx = historyReports.findIndex((r) => r.eventId === fullReport.eventId);
          if (idx !== -1) {
            historyReports[idx] = fullReport;
          }
          if (targetEl.classList.contains("active")) {
            onReportSelect(fullReport);
          }
        }
      } catch (err) {
        console.error("[eq-viewer] Failed to load full history report:", err);
        fetchPromise = null;
      } finally {
        targetEl.classList.remove("loading");
        if (loadingContainer) {
          loadingContainer.classList.add("hidden");
        }
      }
    });

    historyList.appendChild(item);
  }
}
