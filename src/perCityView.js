import {
  EQDB_LOCAL_API_ENDPOINT,
  INTENSITY_CONFIG,
  eqdbIntensityToShindo,
  formatTimeJST,
} from "./constants.js";
import { getIntensityBadgeHtml } from "./intensityBadge.js";
import { fetchHistoryReport } from "./historyMode.js";
import { getHomeLocation } from "./sidebarUI.js";
import { displayHomeLocationDirectIntensity } from "./map/homeLocation.js";

/**
 * Fetches every municipality's maximum recorded intensity and event ID
 * from the local EQDB API server.
 *
 * @returns {Promise<Array<{city_code: string, max_intensity: number, event_id: number|null}>>}
 */
export async function fetchMunicipalitiesMaximum() {
  const url = `${EQDB_LOCAL_API_ENDPOINT}/api/municipalities/maximum`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch municipalities maximum (${response.status}: ${response.statusText})`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Invalid response format from municipalities maximum endpoint");
  }
  return data;
}

/**
 * Maps the value of #history-sort to the API sort parameter.
 * @returns {"newest" | "oldest" | "highest"}
 */
export function getHistorySortParam() {
  const sortEl = document.getElementById("history-sort");
  const val = sortEl?.value || "S2";
  if (val === "S0" || val === "newest") return "newest";
  if (val === "S1" || val === "oldest") return "oldest";
  return "highest";
}

/**
 * Fetches events recorded in a specific municipality from the local EQDB API server.
 *
 * @param {string|number} cityCode - 7-digit municipality code
 * @param {Object} [options]
 * @param {number} [options.page=1] - 1-based page index
 * @param {string} [options.sort="highest"] - Sort order ('highest', 'newest', 'oldest')
 * @returns {Promise<{city_code: string, page: number, limit: number, total: number, total_pages: number, sort: string, events: Array}>}
 */
export async function fetchPerCityEvents(cityCode, { page = 1, sort = "highest" } = {}) {
  const normalizedCode = String(cityCode).padStart(7, "0");
  const url = new URL(`${EQDB_LOCAL_API_ENDPOINT}/api/cities/${normalizedCode}/events`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", sort);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch city events (${response.status}: ${response.statusText})`);
  }
  return await response.json();
}


/**
 * Parses city_forecast_map.csv text into a Map<cityCode, areaCode>.
 *
 * @param {string} csvText
 * @returns {Map<string, number>}
 */
export function parseCityForecastMap(csvText) {
  const map = new Map();
  if (!csvText) return map;

  const lines = csvText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith("cityCode")) continue;

    const parts = line.split(",");
    if (parts.length >= 2) {
      const cityCode = parts[0].trim();
      const areaCode = Number.parseInt(parts[1].trim(), 10);
      if (cityCode && !Number.isNaN(areaCode)) {
        map.set(cityCode, areaCode);
      }
    }
  }
  return map;
}

/**
 * Groups municipality maximum records by intensity level, prefecture, and forecast area.
 *
 * @param {Object} options
 * @param {Array} options.municipalities - Array of {city_code, max_intensity, event_id}
 * @param {Map<string, number>} options.cityToAreaMap - Mapping from city code to forecast area code
 * @param {Map<number, {name: string, enName: string}>} options.prefectureCodes - Map of prefecture code to names
 * @param {Map<number, {ja: string, en: string}>} options.areaCodes - Map of area code to names
 * @param {Map<string, {ja: string, en: string}>} options.cityNames - Map of city code to names
 * @returns {Object} Grouped data keyed by intensity string (e.g. '7', '6+', ..., '0')
 */
export function groupMunicipalitiesByIntensity({
  municipalities,
  cityToAreaMap,
  prefectureCodes,
  areaCodes,
  cityNames,
}) {
  const grouped = {};

  for (const item of municipalities) {
    const rawInt = item.max_intensity;
    const intensity = eqdbIntensityToShindo(rawInt) || (rawInt === 0 ? "0" : String(rawInt));

    if (!grouped[intensity]) {
      grouped[intensity] = new Map();
    }

    const cityCode = String(item.city_code).padStart(7, "0");
    const prefCode = Number.parseInt(cityCode.substring(0, 2), 10);
    const prefData = prefectureCodes?.get(prefCode) || {
      name: `県コード ${prefCode}`,
      enName: `Prefecture ${prefCode}`,
    };

    if (!grouped[intensity].has(prefCode)) {
      grouped[intensity].set(prefCode, {
        code: prefCode,
        name: prefData.name || `Prefecture ${prefCode}`,
        nameEn: prefData.enName || "",
        areas: new Map(),
      });
    }

    const prefEntry = grouped[intensity].get(prefCode);
    const areaCode = cityToAreaMap.get(cityCode) || 0;
    const areaData = areaCodes?.get(areaCode) || {
      ja: areaCode ? `区域 ${areaCode}` : "区域不明",
      en: areaCode ? `Area ${areaCode}` : "Unknown Area",
    };

    if (!prefEntry.areas.has(areaCode)) {
      prefEntry.areas.set(areaCode, {
        code: areaCode,
        name: areaData.ja || "",
        nameEn: areaData.en || "",
        cities: [],
      });
    }

    const areaEntry = prefEntry.areas.get(areaCode);
    const cityData = cityNames?.get(cityCode) || {};

    areaEntry.cities.push({
      code: cityCode,
      name: cityData.ja || cityCode,
      nameEn: cityData.en || "",
      maxIntensity: intensity,
      rawIntensity: rawInt,
      eventId: item.event_id,
    });
  }

  return grouped;
}

/**
 * Renders the observation-style list for per-city maximum intensity into the given container.
 *
 * @param {HTMLElement} container - Usually document.getElementById('history-list')
 * @param {Array} municipalities - Raw API data from fetchMunicipalitiesMaximum
 * @param {Object} context
 * @param {Map<string, number>} context.cityToAreaMap
 * @param {Map} context.prefectureCodes
 * @param {Map} context.areaCodes
 * @param {Map} context.cityNames
 * @param {maplibregl.Map} [context.map]
 * @param {Object} [context.featureBounds]
 */
export function renderPerCityObservationList(container, municipalities, {
  cityToAreaMap,
  prefectureCodes,
  areaCodes,
  cityNames,
  map,
  featureBounds,
  onCitySelect,
}) {
  if (!container) return;
  container.innerHTML = "";

  if (!municipalities || municipalities.length === 0) {
    container.innerHTML = `
      <li class="eq-item placeholder">
        <span class="mono muted">No municipality data available · 市区町村データがありません</span>
      </li>
    `;
    return;
  }

  const grouped = groupMunicipalitiesByIntensity({
    municipalities,
    cityToAreaMap,
    prefectureCodes,
    areaCodes,
    cityNames,
  });

  // Standard descending order: highest intensity first down to 0
  const intensityOrder = ["7", "6+", "6-", "5+", "5-", "4", "3", "2", "1", "0"];
  const activeIntensities = intensityOrder.filter((int) => grouped[int] && grouped[int].size > 0);

  for (const intensity of activeIntensities) {
    const section = document.createElement("li");
    section.className = "observations-intensity-section";

    const config = INTENSITY_CONFIG[intensity] || { color: "#4a4a4a", fontColor: "#FFFFFF" };

    // Shindo 5- and above (major shaking) are opened by default
    const shouldOpen = ["7", "6+", "6-", "5+", "5-"].includes(intensity);

    // Section header
    const header = document.createElement("div");
    header.className = "observations-intensity-header";
    header.style.backgroundColor = config.color;

    const toggle = document.createElement("span");
    toggle.className = "observations-toggle";
    toggle.style.color = config.fontColor;
    toggle.textContent = shouldOpen ? "▼" : "▶";

    const label = document.createElement("span");
    label.className = "observations-intensity-label";
    label.style.color = config.fontColor;
    const labelText = intensity === "0" ? "震度 0" : `震度 ${intensity.replace("-", "弱").replace("+", "強")}`;
    label.textContent = labelText;

    header.appendChild(toggle);
    header.appendChild(label);

    // Section content (collapsible)
    const content = document.createElement("div");
    content.className = "observations-intensity-content";
    content.style.borderLeft = `2px solid ${config.color}`;
    if (!shouldOpen) {
      content.classList.add("collapsed");
    }

    // Prefectures sorted numerically 1 to 47
    const prefMap = grouped[intensity];
    const sortedPrefs = Array.from(prefMap.values()).sort((a, b) => a.code - b.code);

    for (const pref of sortedPrefs) {
      const prefDiv = document.createElement("div");
      prefDiv.className = "observation-pref";

      const prefRow = document.createElement("div");
      prefRow.className = "observation-row pref-row";
      prefRow.innerHTML = `<span class="observation-ja">${pref.name}</span><span class="observation-dot">·</span><span class="observation-en">${pref.nameEn || pref.code}</span>`;
      prefDiv.appendChild(prefRow);

      // Forecast areas sorted numerically
      const sortedAreas = Array.from(pref.areas.values()).sort((a, b) => a.code - b.code);

      for (const area of sortedAreas) {
        const areaDiv = document.createElement("div");
        areaDiv.className = "observation-area";

        const areaRow = document.createElement("div");
        areaRow.className = "observation-row area-row";
        areaRow.innerHTML = `<span class="observation-ja">${area.name}</span><span class="observation-dot">·</span><span class="observation-en">${area.nameEn || area.code}</span>`;
        areaDiv.appendChild(areaRow);

        // Cities sorted numerically by city code
        const sortedCities = area.cities.sort((a, b) => a.code.localeCompare(b.code));

        for (const city of sortedCities) {
          const cityDiv = document.createElement("div");
          cityDiv.className = "observation-city";

          const cityRow = document.createElement("div");
          cityRow.className = "observation-row city-row";
          cityRow.innerHTML = `<span class="observation-ja">${city.name}</span><span class="observation-dot">·</span><span class="observation-en">${city.nameEn || city.code}</span>`;

          // Clicking a city triggers per-city events view and zooms to city
          cityRow.style.cursor = "pointer";
          cityRow.title = `${city.name} · ${city.nameEn || city.code}`;
          cityRow.addEventListener("click", (e) => {
            e.stopPropagation();
            if (map && featureBounds?.cities?.[city.code]) {
              const bbox = featureBounds.cities[city.code];
              if (bbox) {
                map.fitBounds(
                  [
                    [bbox[0], bbox[1]],
                    [bbox[2], bbox[3]],
                  ],
                  {
                    padding: { top: 60, bottom: 60, left: 70, right: 60 },
                    maxZoom: 6,
                    essential: true,
                  }
                );
              }
            }
            if (typeof onCitySelect === "function") {
              onCitySelect(city.code, { zoom: true });
            }
          });

          cityDiv.appendChild(cityRow);
          areaDiv.appendChild(cityDiv);
        }

        prefDiv.appendChild(areaDiv);
      }

      content.appendChild(prefDiv);
    }

    // Toggle click handler
    header.addEventListener("click", () => {
      content.classList.toggle("collapsed");
      toggle.textContent = content.classList.contains("collapsed") ? "▶" : "▼";
    });

    section.appendChild(header);
    section.appendChild(content);
    container.appendChild(section);
  }

  console.info(`[perCityView] Rendered per-city observations list (${municipalities.length} cities)`);
}

/**
 * Updates the home location intensity display for the per-city maximum mode.
 *
 * @param {Array<{city_code: string, max_intensity: number}>} municipalities
 * @param {Map} cityNames
 */
export function updatePerCityHomeLocationDisplay(municipalities, cityNames) {
  if (!municipalities || !cityNames) return;

  const homeLocation = getHomeLocation();
  if (!homeLocation?.cityCode) return;

  const homeCodeStr = String(homeLocation.cityCode).padStart(7, "0");
  const homeRecord = municipalities.find(
    (c) => String(c.city_code).padStart(7, "0") === homeCodeStr
  );

  const homeMaxInt = homeRecord
    ? eqdbIntensityToShindo(homeRecord.max_intensity) || "0"
    : "0";

  displayHomeLocationDirectIntensity(homeLocation.cityCode, homeMaxInt, cityNames);
}

/**
 * Creates a DOM element for a single city earthquake event, matching the EQDB search results
 * appearance while adding a line for the recorded intensity in the chosen city.
 *
 * @param {Object} options
 * @param {Object} options.event - Event object from API
 * @param {Map} [options.areaCodes] - Map of area codes for hypocenter name lookup
 * @param {Function} [options.onSelect] - Callback when event item is clicked
 * @returns {HTMLLIElement}
 */
export function createCityEventItem({ event, areaCodes, onSelect }) {
  const item = document.createElement("li");
  item.className = "eq-item";
  item.dataset.eventId = event.event_id;

  const rawMaxInt = event.max_intensity;
  const maxShindo = eqdbIntensityToShindo(rawMaxInt) || (rawMaxInt === 0 ? "0" : String(rawMaxInt));
  const hasIntensity = !!(maxShindo && INTENSITY_CONFIG[maxShindo] && maxShindo !== "0");
  const intensityConfig = hasIntensity ? INTENSITY_CONFIG[maxShindo] : INTENSITY_CONFIG[0];
  const borderColor = intensityConfig.color;

  const rawCityInt = event.city_intensity ?? event.intensity;
  const cityShindo = eqdbIntensityToShindo(rawCityInt) || (rawCityInt === 0 ? "0" : String(rawCityInt));
  const cityShindoText = cityShindo === "0" ? "震度 0" : `震度 ${cityShindo.replace("-", "弱").replace("+", "強")}`;
  const cityIntConfig = INTENSITY_CONFIG[cityShindo] || INTENSITY_CONFIG[0];

  const hypoCode = Number.parseInt(event.hypo_code, 10);
  const hypoEntry = areaCodes?.get(hypoCode) || {};
  const hypocenterJa = hypoEntry.ja || (hypoCode ? `震源コード ${hypoCode}` : "震源不明");
  const hypocenterEn = hypoEntry.en || (hypoCode ? `Hypocenter ${hypoCode}` : "Unknown");

  const originMs = event.time ? Date.parse(event.time) : null;
  const timeStr = originMs && !Number.isNaN(originMs) ? formatTimeJST(originMs) : "----/--/-- --:--";
  const magStr = typeof event.magnitude === "number" ? event.magnitude.toFixed(1) : "--";

  const intensityHtml = getIntensityBadgeHtml(hasIntensity ? maxShindo : "0", {
    title: hasIntensity ? `Intensity: ${maxShindo}` : undefined,
  });

  item.innerHTML = `
    <div class="eq-content">
      <div class="eq-left">
        <div class="eq-location-ja">${hypocenterJa}</div>
        <div class="eq-location-en" title="${hypocenterEn}">${hypocenterEn}</div>
        <div class="city-event-intensity-row">
          <span class="city-event-intensity-badge" style="background-color: ${cityIntConfig.color}; color: ${cityIntConfig.fontColor};">
            ${cityShindoText}
          </span>
        </div>
        <div class="eq-footer">
          <div class="eq-mag">
            <span class="eq-mag-label">M</span>
            ${magStr}
          </div>
          <div class="eq-time">${timeStr}</div>
        </div>
      </div>
      <div class="eq-intensity-container">
        ${intensityHtml}
      </div>
    </div>
  `;

  item.style.borderColor = borderColor;
  item.style.borderWidth = "2px";

  if (onSelect) {
    item.addEventListener("click", () => onSelect(item, event));
  }

  return item;
}

/**
 * Creates and manages the city events view in the sidebar.
 *
 * @param {Object} options
 * @param {HTMLElement} options.historyList - The #history-list element
 * @param {Map} options.areaCodes
 * @param {Map} options.cityNames
 * @param {Function} options.onReportSelect - Callback(fullReport) when an event is opened
 * @param {Function} options.onBack - Callback when the "Back to list" button is clicked
 * @returns {Object} Manager with showCityEvents(cityCode), hide(), getActiveCityCode()
 */
export function createCityEventsManager({
  historyList,
  areaCodes,
  cityNames,
  onReportSelect,
  onBack,
}) {
  let container = document.getElementById("history-city-events-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "history-city-events-container";
    container.className = "city-events-container hidden";
    historyList.after(container);
  }

  container.innerHTML = `
    <div class="city-events-header">
      <div class="city-events-title-row">
        <span class="city-events-ja"></span>
        <span class="city-events-dot">·</span>
        <span class="city-events-en"></span>
      </div>
      <div class="city-events-sub-row"></div>
    </div>
    <ul class="city-events-list"></ul>
    <button class="city-events-load-more-btn load-older-btn" style="display: none;">
      Load More · もっと読み込む
    </button>
    <div class="city-events-back-bar">
      <button class="city-events-back-btn" type="button">
        <span class="city-events-back-arrow">◀</span>
        <span>Back to list · 市区町村一覧に戻る</span>
      </button>
    </div>
  `;

  const headerTitleJa = container.querySelector(".city-events-ja");
  const headerDot = container.querySelector(".city-events-dot");
  const headerTitleEn = container.querySelector(".city-events-en");
  const headerSubRow = container.querySelector(".city-events-sub-row");
  const listEl = container.querySelector(".city-events-list");
  const loadMoreBtn = container.querySelector(".city-events-load-more-btn");
  const backBtn = container.querySelector(".city-events-back-btn");

  let activeCityCode = null;
  let currentPage = 1;
  let totalPages = 1;
  let totalEvents = 0;
  let loadedCount = 0;

  async function handleEventClick(itemEl, event) {
    document.querySelectorAll(".eq-item").forEach((el) => el.classList.remove("active"));
    itemEl.classList.add("active");
    itemEl.classList.add("loading");

    const loadingContainer = document.getElementById("history-loading-container");
    const progressEl = document.getElementById("history-loading-progress");
    if (loadingContainer) loadingContainer.classList.remove("hidden");
    if (progressEl) progressEl.textContent = "Loading... · 読み込み中...";

    try {
      const rawMaxInt = event.max_intensity;
      const maxShindo = eqdbIntensityToShindo(rawMaxInt) || (rawMaxInt === 0 ? "0" : String(rawMaxInt));
      const hypoCode = Number.parseInt(event.hypo_code, 10);
      const hypoEntry = areaCodes?.get(hypoCode) || {};
      const hypocenterJa = hypoEntry.ja || (hypoCode ? `震源コード ${hypoCode}` : "震源不明");
      const hypocenterEn = hypoEntry.en || (hypoCode ? `Hypocenter ${hypoCode}` : "Unknown");
      const originMs = event.time ? Date.parse(event.time) : null;
      const originTimeSec = originMs && !Number.isNaN(originMs) ? Math.floor(originMs / 1000) : null;

      const baseReport = {
        eventId: event.event_id,
        originTime: originTimeSec,
        magnitude: event.magnitude,
        maxIntensity: maxShindo,
        hypocenterCode: hypoCode,
        hypocenterJa,
        hypocenterKana: hypoEntry.kana || "",
        hypocenterEn,
        name: hypocenterJa,
        isHistory: true,
        isBaseReport: true,
        isFullReport: false,
      };

      const fullReport = await fetchHistoryReport(baseReport, areaCodes);
      if (fullReport && itemEl.classList.contains("active")) {
        globalThis.__isPerCityModeActive = false;
        onReportSelect(fullReport);
      }
    } catch (err) {
      console.error("[perCityView] Failed to open event report:", err);
    } finally {
      itemEl.classList.remove("loading");
      if (loadingContainer) loadingContainer.classList.add("hidden");
    }
  }

  async function loadCityPage(cityCode, page = 1) {
    const sort = getHistorySortParam();
    const data = await fetchPerCityEvents(cityCode, { page, sort });

    if (page === 1) {
      listEl.innerHTML = "";
      totalEvents = data.total;
      totalPages = data.total_pages;
      currentPage = 1;
      loadedCount = data.events.length;

      headerSubRow.textContent = `${totalEvents} events recorded · 観測地震一覧`;

      if (data.events.length === 0) {
        listEl.innerHTML = `
          <li class="eq-item placeholder">
            <span class="mono muted">No earthquake events recorded · 観測地震データがありません</span>
          </li>
        `;
      } else {
        for (const ev of data.events) {
          const item = createCityEventItem({
            event: ev,
            areaCodes,
            onSelect: handleEventClick,
          });
          listEl.appendChild(item);
        }
      }
    } else {
      for (const ev of data.events) {
        const item = createCityEventItem({
          event: ev,
          areaCodes,
          onSelect: handleEventClick,
        });
        listEl.appendChild(item);
      }
      currentPage = page;
      loadedCount += data.events.length;
    }

    if (currentPage < totalPages) {
      const remaining = totalEvents - loadedCount;
      loadMoreBtn.style.display = "block";
      loadMoreBtn.classList.remove("loading");
      loadMoreBtn.textContent = `Load More (${remaining} remaining) · もっと読み込む`;
    } else {
      loadMoreBtn.style.display = "none";
    }
  }

  loadMoreBtn.addEventListener("click", async () => {
    if (!activeCityCode || currentPage >= totalPages || loadMoreBtn.classList.contains("loading")) {
      return;
    }
    loadMoreBtn.classList.add("loading");
    loadMoreBtn.textContent = "Loading... · 読み込み中...";

    try {
      await loadCityPage(activeCityCode, currentPage + 1);
    } catch (err) {
      console.error("[perCityView] Failed to load more city events:", err);
      loadMoreBtn.textContent = "Error loading · 読み込みエラー";
    } finally {
      loadMoreBtn.classList.remove("loading");
    }
  });

  backBtn.addEventListener("click", () => {
    hide();
    if (onBack) onBack();
  });

  function showCityEvents(cityCode) {
    activeCityCode = String(cityCode).padStart(7, "0");

    // Hide observation list & summary
    historyList.style.display = "none";
    const summaryEl = historyList.parentNode.querySelector(".history-results-summary");
    if (summaryEl) summaryEl.style.display = "none";

    // Show city events container
    container.classList.remove("hidden");

    // Populate header
    const cityInfo = cityNames?.get(activeCityCode) || {};
    const nameJa = cityInfo.ja || activeCityCode;
    const nameEn = cityInfo.en || "";

    headerTitleJa.textContent = nameJa;
    headerTitleEn.textContent = nameEn;
    headerDot.style.display = (nameJa && nameEn) ? "" : "none";
    headerSubRow.textContent = "Loading events... · 読み込み中...";

    listEl.innerHTML = `
      <li class="eq-item placeholder">
        <span class="loading-spinner"></span>
        <span class="mono muted">Loading events... · 読み込み中...</span>
      </li>
    `;
    loadMoreBtn.style.display = "none";

    loadCityPage(activeCityCode, 1).catch((err) => {
      console.error("[perCityView] Failed to load city events:", err);
      listEl.innerHTML = `
        <li class="eq-item placeholder">
          <span class="mono muted">Failed to load city events · データの読み込みに失敗しました</span>
        </li>
      `;
      headerSubRow.textContent = "Error · エラー";
    });
  }

  function hide() {
    activeCityCode = null;
    container.classList.add("hidden");
    historyList.style.display = "";
    const summaryEl = historyList.parentNode.querySelector(".history-results-summary");
    if (summaryEl) summaryEl.style.display = "";
  }

  return {
    showCityEvents,
    hide,
    getActiveCityCode: () => activeCityCode,
    isShowing: () => !container.classList.contains("hidden"),
    reloadCurrentCity: () => {
      if (activeCityCode && !container.classList.contains("hidden")) {
        showCityEvents(activeCityCode);
      }
    },
  };
}

