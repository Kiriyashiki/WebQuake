import { eewState } from "./state.js";
import {
  formatTimeJSTWithSeconds,
  INTENSITY_CONFIG,
  LPGM_CONFIG,
} from "../constants.js";
import { createRubyHtml } from "../areaCodes.js";
import { getActiveProvider, isPlumEew } from "../eewProviders.js";
import { mergeForecasts, getIntVal, cityForecastMap } from "./physics.js";
import { updateMapForEew, clearEewMapDisplay } from "./eewMap.js";
import {
  updateCityAreasVisibility,
  highlightObservations,
  hideHomeLocationIntensity,
} from "../map.js";
import {
  getCityAreasState,
  getHomeIntensityState,
  getHomeLocation,
} from "../sidebarUI.js";
import { stopWaveAnimation, updateWaves } from "./waveAnimation.js";

/**
 * Updates the home location intensity display for all active EEWs.
 */
export function updateHomeIntensityForActiveEews() {
  if (!getHomeIntensityState()) {
    hideHomeLocationIntensity();
    return;
  }

  if (!eewState.isEewMapActive || eewState.activeEews.size === 0) {
    hideHomeLocationIntensity();
    return;
  }

  if (document.querySelector(".eq-item.active")) {
    return;
  }

  const activeEewList = Array.from(eewState.activeEews.values()).filter((e) => !e.isCancelled);
  const homeLocation = getHomeLocation();
  const homeCityCode =
    homeLocation?.cityCode ||
    (typeof localStorage !== "undefined" ? localStorage.getItem("home-city") : null);

  if (!homeCityCode) {
    hideHomeLocationIntensity();
    return;
  }

  const provider = getActiveProvider();
  const isHomeSyncOn = Boolean(provider?.supportsHomeSync && provider.getHomeSync());

  if (isHomeSyncOn) {
    let maxIntVal = -1;
    let maxIntStr = null;

    for (const eew of activeEewList) {
      const pointForecast = eew.msg?.pointForecast;
      const intStr = pointForecast?.intensity?.int;
      if (intStr != null) {
        const val = getIntVal(intStr);
        if (val > maxIntVal) {
          maxIntVal = val;
          maxIntStr = intStr;
        }
      }
    }

    updateEewHomeLocationDisplay(homeCityCode, maxIntStr);
  } else {
    const mergedForecast = mergeForecasts(activeEewList);
    const homeAreaCodeStr = cityForecastMap?.get(homeCityCode);
    if (homeAreaCodeStr) {
      const forecastArea = mergedForecast.find((f) => f.Code === Number.parseInt(homeAreaCodeStr));
      const forecastInt = forecastArea ? forecastArea.Intensity.To : null;
      updateEewHomeLocationDisplay(homeCityCode, forecastInt || null);
    } else {
      updateEewHomeLocationDisplay(homeCityCode, null);
    }
  }
}

// Hook into shared state for phase 3 map callbacks
eewState.updateHomeIntensity = updateHomeIntensityForActiveEews;

export function updateEewHomeLocationDisplay(cityCode, intensityStr) {
  const display = document.getElementById("home-intensity-display");
  if (!display) return;

  const cityInfo = eewState.cityNames?.get(cityCode) || { ja: "不明", en: "Unknown" };

  display.querySelector(".tooltip-ja").textContent = cityInfo.ja;
  display.querySelector(".tooltip-en").textContent = cityInfo.en;

  const intensityContainer = display.querySelector(".tooltip-intensity-container");

  if (intensityStr && intensityStr !== "0" && intensityStr !== "over" && intensityStr !== "不明") {
    const config = INTENSITY_CONFIG[intensityStr];
    if (config) {
      const img = intensityContainer.querySelector("img");
      if (img) {
        img.style.display = "";
        img.src = `/img/shindo/${config.img}`;
        img.alt = `Intensity ${intensityStr}`;
        img.title = `Forecasted Intensity: ${intensityStr}`;
      }

      const placeholder = intensityContainer.querySelector(".tooltip-intensity-placeholder");
      if (placeholder) placeholder.style.display = "none";

      intensityContainer.classList.remove("hidden");
      display.style.borderTopColor = config.color;
      display.querySelector(".tooltip-code").style.color = config.color;
    }
  } else {
    const img = intensityContainer.querySelector("img");
    if (img) img.style.display = "none";

    let placeholder = intensityContainer.querySelector(".tooltip-intensity-placeholder");
    if (placeholder) {
      placeholder.style.display = "";
    } else {
      placeholder = document.createElement("div");
      placeholder.className = "tooltip-intensity-placeholder";
      placeholder.textContent = "-";
      intensityContainer.appendChild(placeholder);
    }

    intensityContainer.classList.remove("hidden");
    const defaultColor = "#1e2e44";
    display.style.borderTopColor = defaultColor;
    display.querySelector(".tooltip-code").style.color = defaultColor;
  }

  display.classList.remove("hidden");
}

export function updateEewUI(isNewEew = false) {
  console.debug(`[eq-viewer-eew] updateEewUI: START (isNewEew=${isNewEew})`);
  if (eewState.activeEews.size === 0) {
    console.debug("[eq-viewer-eew] updateEewUI: no active EEWs, cleaning up");
    clearEewMapDisplay();
    stopWaveAnimation();

    // Restore city/area layer visibility to user's preference
    // (updateMapForEew forced it off while EEWs were active)
    if (eewState.mapInstance) {
      updateCityAreasVisibility(eewState.mapInstance, getCityAreasState());
    }

    // Remove UI
    const container = document.getElementById("eew-list-container");
    if (container) {
      container.innerHTML = "";
      container.classList.add("hidden");
    }

    if (eewState.carouselTimer) {
      clearInterval(eewState.carouselTimer);
      eewState.carouselTimer = null;
    }

    // Resume normal report
    const activeItem = document.querySelector(".eq-item.active");
    if (activeItem) {
      activeItem.click();
    } else if (eewState.previousReport) {
      const el = document.querySelector(`[data-event-id="${eewState.previousReport.eventId}"]`);
      if (el) el.click();
      else {
        const firstEl = document.querySelector(".eq-item");
        if (firstEl) firstEl.click();
      }
    } else {
      const firstEl = document.querySelector(".eq-item");
      if (firstEl) firstEl.click();
    }

    // Force cleanup if nothing was clicked
    setTimeout(() => {
      const stillActive = document.querySelector(".eq-item.active");
      const infoBox = document.getElementById("map-info-box");
      if (infoBox && !stillActive) infoBox.classList.add("hidden");

      if (!stillActive && eewState.mapInstance) {
        highlightObservations(eewState.mapInstance, []);
      }
    }, 50);

    return;
  }

  // Filter active and sort by order received
  const eews = Array.from(eewState.activeEews.values()).sort((a, b) => a.receivedAt - b.receivedAt);

  // Store previous report and switch map to EEW if a brand new EEW arrived
  if (isNewEew) {
    console.debug("[eq-viewer-eew] updateEewUI: handling brand new EEW");
    eewState.isEewMapActive = true;
    const currentActive = document.querySelector(".eq-item.active");
    if (currentActive?.closest("#eq-list") || currentActive?.closest("#history-list")) {
      eewState.previousReport = globalThis.__currentReport;
      currentActive.classList.remove("active"); // Deactivate normal report in list
    }
  }

  // Render list entry container
  const container = document.getElementById("eew-list-container");
  container.classList.remove("hidden");

  if (!eewState.carouselTimer && eews.length > 1) {
    eewState.carouselTimer = setInterval(() => {
      eewState.carouselIndex = (eewState.carouselIndex + 1) % eewState.activeEews.size;
      renderCurrentEew();
    }, 4000);
  } else if (eews.length <= 1) {
    if (eewState.carouselTimer) {
      clearInterval(eewState.carouselTimer);
      eewState.carouselTimer = null;
    }
    eewState.carouselIndex = 0;
  }

  if (eewState.carouselIndex >= eews.length) eewState.carouselIndex = 0;

  console.debug("[eq-viewer-eew] updateEewUI: rendering current EEW");
  renderCurrentEew();
}

export function renderCurrentEew() {
  console.debug("[eq-viewer-eew] renderCurrentEew: START");
  const eews = Array.from(eewState.activeEews.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  if (eews.length === 0) return;

  const currentEew = eews[eewState.carouselIndex];
  const msg = currentEew.msg;
  const isCancelled = currentEew.isCancelled;
  const isWarning = msg.Title.includes("警報");
  const isPlum = isPlumEew(msg);
  const isLowAccuracy = Boolean(msg.isLowAccuracy);
  const isTest = Boolean(currentEew.isTest || msg.isTest || msg.Flag?.is_training);
  const providerName = currentEew.providerName || getActiveProvider()?.name;

  let hypoCodeNum = Number.parseInt(msg.Hypocenter?.Code);
  if ((!hypoCodeNum || Number.isNaN(hypoCodeNum)) && msg.Hypocenter?.Name && eewState.areaCodes) {
    for (const [code, info] of eewState.areaCodes.entries()) {
      if (info.ja === msg.Hypocenter.Name) {
        hypoCodeNum = code;
        if (msg.Hypocenter) msg.Hypocenter.Code = code;
        break;
      }
    }
  }
  const hypoInfo = eewState.areaCodes
    ? eewState.areaCodes.get(hypoCodeNum) || { ja: msg.Hypocenter.Name, en: "Unknown", kana: "" }
    : { ja: msg.Hypocenter.Name, en: "Unknown", kana: "" };

  let labelColor = isCancelled
    ? "#7f8c8d"
    : isWarning
      ? "#e84c3d"
      : isLowAccuracy
        ? "#1e6ee6"
        : "#f39c12";
  let labelText = isCancelled
    ? "Cancelled • キャンセル"
    : isWarning
      ? "EEW (Warning) • 緊急地震速報（警報）"
      : "EEW (Forecast) • 緊急地震速報（予報）";

  // Render the list entry
  const container = document.getElementById("eew-list-container");
  let listHtml = `
    <div class="eew-list-item" style="border-top: 4px solid ${labelColor};">
      <div class="eew-list-header" style="color: ${labelColor}; font-weight: bold; font-size: 12px; margin-bottom: 4px;">
         ${eews.length > 1 ? `[${eewState.carouselIndex + 1}/${eews.length}] ` : ""}${labelText}
      </div>
      <div class="eq-content">
        <div class="eq-left">
          <div class="eq-location-ja">${hypoInfo.ja}</div>
          <div class="eq-location-en">${hypoInfo.en}</div>
          <div class="eq-footer">
            <div class="eq-mag">
              <span class="eq-mag-label">M</span>
              ${isPlum ? "--" : msg.Magnitude || "--"}
            </div>
            <div class="eq-time">${formatTimeJSTWithSeconds(new Date(msg.OriginDateTime).getTime())}</div>
          </div>
        </div>
        <div class="eq-intensity-container">
  `;

  if (msg.Intensity && msg.Intensity !== "不明") {
    const intensityConfig = INTENSITY_CONFIG[msg.Intensity] || INTENSITY_CONFIG["1"];
    listHtml += `<img src="/img/shindo/${intensityConfig.img}" class="eq-intensity-img" />`;
  } else {
    listHtml += `<div class="eew-intensity-placeholder" style="width:60px; height:60px; border-radius:3px; background:#1e2e44; display:flex; align-items:center; justify-content:center; color:#fff; font-size:24px; font-weight:bold;">-</div>`;
  }

  listHtml += `</div></div></div>`;
  container.innerHTML = listHtml;

  const listItem = container.querySelector(".eew-list-item");
  if (listItem) {
    listItem.addEventListener("click", () => {
      console.debug("[eq-viewer-eew] EEW list item clicked");
      // If a normal report was clicked, it becomes active. Deactivate it.
      const currentActive = document.querySelector(".eq-item.active");
      if (currentActive) {
        currentActive.classList.remove("active");
      }
      globalThis.__currentReport = null;
      eewState.isEewMapActive = true;
      renderEewInfoBox(
        msg,
        isCancelled,
        isWarning,
        isPlum,
        eews.length,
        eewState.carouselIndex + 1,
        providerName,
      );
      updateMapForEew();

      const testBanner = document.getElementById("eew-test-banner");
      if (testBanner) {
        if (isTest) {
          testBanner.classList.remove("hidden");
        } else {
          testBanner.classList.add("hidden");
        }
      }

      // Defer wave updates to avoid synchronous source operations right after layout changes
      setTimeout(updateWaves, 50);
    });
  }

  // Render info box and map only if EEW is active and no normal report is currently active
  const currentActive = document.querySelector(".eq-item.active");
  const testBanner = document.getElementById("eew-test-banner");
  if (testBanner) {
    if (isTest && eewState.isEewMapActive && !currentActive) {
      testBanner.classList.remove("hidden");
    } else {
      testBanner.classList.add("hidden");
    }
  }

  if (eewState.isEewMapActive && !currentActive) {
    console.debug("[eq-viewer-eew] renderCurrentEew: rendering info box");
    renderEewInfoBox(
      msg,
      isCancelled,
      isWarning,
      isPlum,
      eews.length,
      eewState.carouselIndex + 1,
      providerName,
    );
    console.debug("[eq-viewer-eew] renderCurrentEew: updating map for EEW");
    updateMapForEew();
    console.debug("[eq-viewer-eew] renderCurrentEew: COMPLETE");
  }
}

export function renderEewInfoBox(
  msg,
  isCancelled,
  isWarning,
  isPlum,
  totalCount,
  currentIndex,
  providerName,
) {
  const infoBox = document.getElementById("map-info-box");
  if (!infoBox) return;
  infoBox.classList.remove("hidden");

  const mapTogglesWrapper = infoBox.querySelector(".map-toggles-wrapper");
  if (mapTogglesWrapper) mapTogglesWrapper.classList.add("hidden");

  const lpgmRow = infoBox.querySelector(".info-box-lpgm-row");
  const locationJa = infoBox.querySelector(".info-box-location-ja");
  const locationEn = infoBox.querySelector(".info-box-location-en");
  const flashBadge = infoBox.querySelector(".info-box-flash-badge");
  const intensityImg = infoBox.querySelector(".info-box-intensity-img");
  const intensityContainer = infoBox.querySelector(".info-box-intensity-container");
  const magnitude = infoBox.querySelector(".info-magnitude");
  const depth = infoBox.querySelector(".info-depth");
  const coordinates = infoBox.querySelector(".info-coordinates");
  const timeEl = infoBox.querySelector(".info-time");

  const volcanoRow = infoBox.querySelector(".info-box-volcano-row");
  if (volcanoRow) volcanoRow.classList.add("hidden");
  const magRow =
    infoBox.querySelector(".info-box-magnitude-row") || magnitude?.closest(".info-box-row");
  if (magRow) magRow.classList.remove("hidden");
  const depthRow = infoBox.querySelector(".info-box-depth-row") || depth?.closest(".info-box-row");
  if (depthRow) depthRow.classList.remove("hidden");

  const isLowAccuracy = Boolean(msg.isLowAccuracy);
  let labelColor = isCancelled
    ? "#7f8c8d"
    : isWarning
      ? "#e84c3d"
      : isLowAccuracy
        ? "#1e6ee6"
        : "#f39c12";
  let labelText = isCancelled ? "Cancelled" : isWarning ? "EEW (Warning)" : "EEW (Forecast)";
  if (totalCount > 1) labelText = `[${currentIndex}/${totalCount}] ` + labelText;

  let hypoCodeNum = Number.parseInt(msg.Hypocenter?.Code);
  if ((!hypoCodeNum || Number.isNaN(hypoCodeNum)) && msg.Hypocenter?.Name && eewState.areaCodes) {
    for (const [code, info] of eewState.areaCodes.entries()) {
      if (info.ja === msg.Hypocenter.Name) {
        hypoCodeNum = code;
        if (msg.Hypocenter) msg.Hypocenter.Code = code;
        break;
      }
    }
  }
  const hypoInfo = eewState.areaCodes
    ? eewState.areaCodes.get(hypoCodeNum) || { ja: msg.Hypocenter.Name, en: "Unknown", kana: "" }
    : { ja: msg.Hypocenter.Name, en: "Unknown", kana: "" };

  locationJa.innerHTML = createRubyHtml(hypoInfo.ja, hypoInfo.kana) || msg.Hypocenter.Name;
  locationEn.textContent = hypoInfo.en;

  if (flashBadge) {
    flashBadge.classList.remove("hidden");
    flashBadge.style.backgroundColor = labelColor + "33";
    flashBadge.style.borderColor = labelColor;
    flashBadge.querySelector(".flash-badge-text").textContent = labelText;
    flashBadge.querySelector(".flash-badge-text").style.color = labelColor;
  }

  if (msg.Intensity && msg.Intensity !== "不明") {
    const intensityConfig = INTENSITY_CONFIG[msg.Intensity] || INTENSITY_CONFIG["1"];
    intensityImg.src = `/img/shindo/${intensityConfig.img}`;
    intensityImg.title = `Intensity: ${msg.Intensity}`;
    intensityImg.style.display = "block";
    const existingPlaceholder = intensityContainer.querySelector(".eew-intensity-placeholder");
    if (existingPlaceholder) existingPlaceholder.remove();
    const infoPlaceholder = intensityContainer.querySelector(".info-box-intensity-placeholder");
    if (infoPlaceholder) infoPlaceholder.remove();
  } else {
    intensityImg.style.display = "none";
    const infoPlaceholder = intensityContainer.querySelector(".info-box-intensity-placeholder");
    if (infoPlaceholder) infoPlaceholder.remove();
    let placeholder = intensityContainer.querySelector(".eew-intensity-placeholder");
    if (!placeholder) {
      placeholder = document.createElement("div");
      placeholder.className = "eew-intensity-placeholder";
      placeholder.style.cssText =
        "width:54px; height:54px; border-radius:3px; background:#1e2e44; display:flex; align-items:center; justify-content:center; color:#fff; font-size:24px; font-weight:bold;";
      placeholder.textContent = "-";
      intensityContainer.appendChild(placeholder);
    }
  }

  const isPlumMethod = isPlum !== undefined ? Boolean(isPlum) : isPlumEew(msg);
  magnitude.textContent = isPlumMethod ? "--" : `M ${msg.Magnitude}`;
  depth.textContent = isPlumMethod ? "--" : (msg.Hypocenter?.Depth ?? "--");

  if (isPlumMethod) {
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "PLUM method • PLUM法による仮定震源要素";
    coordinates.textContent = "";
  } else if (msg.Hypocenter?.Coordinate) {
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "Coordinates • 北緯東経";
    const [lon, lat] = msg.Hypocenter.Coordinate;
    coordinates.textContent = `${lat.toFixed(1)} ; ${lon.toFixed(1)}`;
  } else {
    const coordsLabel = coordinates.previousElementSibling;
    if (coordsLabel) coordsLabel.textContent = "Coordinates • 北緯東経";
    coordinates.textContent = "--";
  }

  if (timeEl) {
    timeEl.textContent = formatTimeJSTWithSeconds(new Date(msg.OriginDateTime).getTime());
  }

  const lpgmValue = infoBox.querySelector(".info-lpgm");
  if (lpgmRow && lpgmValue) {
    if (msg.maxLgInt) {
      let maxLg = msg.maxLgInt;
      lpgmValue.textContent = `CLASS ${maxLg}`;
      if (typeof maxLg === "string") {
        maxLg = Number.parseInt(maxLg);
      }
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

  // Set Serial and Final under intensity image
  const serialEl = infoBox.querySelector(".info-box-eew-serial");
  if (serialEl) {
    const isFinal = Boolean(msg.Flag?.is_final);
    const serialNum = msg.Serial ?? "";
    serialEl.textContent = serialNum ? `#${serialNum}${isFinal ? " Final" : ""}` : (isFinal ? "Final" : "");
    serialEl.classList.remove("hidden");
  }

  const detailsContainer = infoBox.querySelector(".info-box-details");
  const oldSerialRow = detailsContainer?.querySelector(".eew-serial-row");
  if (oldSerialRow) oldSerialRow.remove();

  // Add Extra row for Source
  let sourceRow = detailsContainer.querySelector(".eew-source-row");
  if (!sourceRow) {
    sourceRow = document.createElement("div");
    sourceRow.className = "info-box-row eew-source-row";
    detailsContainer.appendChild(sourceRow);
  }
  sourceRow.innerHTML = `
    <span class="info-label">Source • 受信元</span>
    <span class="info-value mono">${providerName}</span>
  `;

  // Forecast Observations
  const obsHeaderLabel = infoBox.querySelector(".observations-list-label");
  if (obsHeaderLabel) obsHeaderLabel.textContent = "Forecast • 予想";

  const observationsContainer = infoBox.querySelector("#observations-list-container");
  if (observationsContainer) {
    observationsContainer.innerHTML = "";

    let disclaimer = observationsContainer.querySelector(".eew-forecast-disclaimer");
    if (!disclaimer) {
      disclaimer = document.createElement("div");
      disclaimer.className = "eew-forecast-disclaimer";
      disclaimer.style.cssText =
        "font-size: 11px; color: var(--text-dim); text-align: center; padding: 2px; background: rgba(0,0,0,0.2); border-radius: 4px;";
      disclaimer.textContent = "Estimated intensities • 予想震度";
      observationsContainer.appendChild(disclaimer);
    }

    // Group and sort Forecast
    if (msg.Forecast && msg.Forecast.length > 0) {
      const mergedForecast = mergeForecasts(Array.from(eewState.activeEews.values()));

      const forecastByInt = {};
      for (const f of mergedForecast) {
        if (f.Intensity.To === "0" || f.Intensity.To === "over" || f.Intensity.To === "不明")
          continue;
        const intStr = f.Intensity.To;
        if (!forecastByInt[intStr]) forecastByInt[intStr] = [];
        forecastByInt[intStr].push(f);
      }

      const sortedInts = Object.keys(forecastByInt).sort((a, b) => {
        const getVal = (v) => {
          if (v === "7") return 70;
          if (v === "6+") return 65;
          if (v === "6-") return 60;
          if (v === "5+") return 55;
          if (v === "5-") return 50;
          return Number.parseInt(v) * 10;
        };
        return getVal(b) - getVal(a);
      });

      for (const intStr of sortedInts) {
        const config = INTENSITY_CONFIG[intStr] || INTENSITY_CONFIG["1"];

        const section = document.createElement("div");
        section.className = "observations-intensity-section";

        const header = document.createElement("div");
        header.className = "observations-intensity-header";
        header.style.backgroundColor = config.color;
        header.style.cursor = "default";

        const labelText = `震度 ${intStr.replace("-", "弱").replace("+", "強")}`;
        header.innerHTML = `<span class="observations-intensity-label" style="color: ${config.fontColor}; padding-left: 8px;">${labelText}</span>`;

        const content = document.createElement("div");
        content.className = "observations-intensity-content";
        content.style.borderLeft = "2px solid " + config.color;

        forecastByInt[intStr].forEach((f) => {
          const codeNum = Number.parseInt(f.Code);
          const areaInfo = eewState.areaCodes
            ? eewState.areaCodes.get(codeNum) || { ja: f.Name, en: f.Code }
            : { ja: f.Name, en: f.Code };

          const prefDiv = document.createElement("div");
          prefDiv.className = "observation-area";

          const prefRow = document.createElement("div");
          prefRow.className = "observation-row area-row";
          prefRow.innerHTML = `<span class="observation-ja">${areaInfo.ja}</span><span class="observation-dot">·</span><span class="observation-en">${areaInfo.en}</span>`;

          prefDiv.appendChild(prefRow);
          content.appendChild(prefDiv);
        });

        section.appendChild(header);
        section.appendChild(content);
        observationsContainer.appendChild(section);
      }
    }

    // Force open observations and lock it
    const obsWrapper = infoBox.querySelector(".observations-list-wrapper");
    if (obsWrapper) {
      obsWrapper.classList.add("expanded");
      const toggleBtn = obsWrapper.querySelector(".observations-list-toggle");
      if (toggleBtn) toggleBtn.style.display = "none"; // Lock toggle
    }
  }
}
