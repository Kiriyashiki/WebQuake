/**
 * Loads city.json and prefecture-codes.csv data, builds a hierarchical list 
 * of observations grouped by intensity level.
 */

import { loadPrefectureCodes, loadCityNames, loadRegions } from "./areaCodes.js";
import {
  CONDITION_GROUP_KEY,
  CONDITION_INTENSITY,
  INTENSITY_CONFIG,
  LPGM_CONFIG,
} from "./constants.js";

/**
 * Render generation per container. Rendering is asynchronous (it awaits the
 * city/prefecture data), so a newer render must be able to cancel an older one
 * that is still in flight. Without this, two overlapping calls both clear the
 * container and then both append, duplicating the list.
 */
let renderGeneration = 0;
const renderTokens = new WeakMap();

/**
 * Invalidates any in-flight observations render for `container`.
 * Call this before clearing the container from outside this module.
 * @param {HTMLElement} container
 */
export function invalidateObservationsList(container) {
  if (!container) return;
  renderTokens.set(container, ++renderGeneration);
}

/**
 * Build hierarchical observations list grouped by intensity
 * Each city/area is grouped by its own intensity (maxInt).
 * If a prefecture has areas/cities with different intensities,
 * it will appear in multiple intensity sections.
 * @param {Array} observations - From JMAEarthquakeReport.observations
 * @param {Map} areaCodes - Area code mappings (area names)
 * @param {Map} prefectureCodes - Prefecture code mappings (pref names and kana)
 * @param {Map} cityNames - City name mappings
 * @returns {Object} Grouped observations by intensity
 */
// Shared helpers for grouping observations
function ensureIntensityGroup(grouped, intensity) {
  if (!grouped[intensity]) {
    grouped[intensity] = [];
  }
}

function findOrCreatePref(grouped, prefectureCodes, intensity, prefCode, prefName) {
  let pref = grouped[intensity].find(p => p.code === prefCode);
  if (!pref) {
    const prefData = prefectureCodes?.get(prefCode) || {};
    pref = {
      code: prefCode,
      name: prefData.name || prefName,
      nameEn: prefData.enName || '',
      kana: prefData.kana || '',
      areas: [],
    };
    grouped[intensity].push(pref);
  }
  return pref;
}

function findOrCreateArea(pref, areaCode, areaName, areaNameEn) {
  let area = pref.areas.find(a => a.code === areaCode);
  if (!area) {
    area = {
      code: areaCode,
      name: areaName,
      nameEn: areaNameEn,
      cities: [],
    };
    pref.areas.push(area);
  }
  return area;
}

export function groupObservationsByIntensity(observations, areaCodes = new Map(), prefectureCodes = new Map(), cityNames = new Map()) {
  const grouped = {};

  // Iterate through all prefs, areas, and cities
  for (const pref of observations) {
    const prefCode = pref.code;
    const prefName = pref.name;

    for (const area of pref.areas) {
      const areaCode = area.code;
      const areaName = areaCodes.get(areaCode)?.ja || area.name;
      const areaNameEn = areaCodes.get(areaCode)?.en || '';

      for (const city of area.cities) {
        // Group each city by its own intensity.
        // Cities with a condition (e.g. "震度５弱以上未入電") but no maxInt
        // are grouped under the special '未入電' key.
        const cityIntensity = city.maxInt || (city.condition ? CONDITION_GROUP_KEY : null);
        if (!cityIntensity) continue; // skip cities with no intensity info at all
        ensureIntensityGroup(grouped, cityIntensity);

        const prefEntry = findOrCreatePref(grouped, prefectureCodes, cityIntensity, prefCode, prefName);
        const areaEntry = findOrCreateArea(prefEntry, areaCode, areaName, areaNameEn);

        const cityCode = city.code;
        // Pad cityCode to 7 digits for matching with cityNames Map keys if necessary,
        // though observations code format might vary. Usually they are 7 digit strings.
        const codeKey = String(cityCode).padStart(7, '0');
        const cityData = cityNames.get(codeKey);

        // Check if this city already exists in the area
        const hasCity = areaEntry.cities.some(c => c.code === cityCode);
        if (!hasCity) {
          areaEntry.cities.push({
            code: cityCode,
            name: cityData?.ja || city.name,
            nameEn: cityData?.en || '',
            kana: cityData?.kana || null,
            maxInt: city.maxInt,
            condition: city.condition || null,
          });
        }
      }
    }
  }

  return grouped;
}

function getIntensityRank(val, isLpgm) {
  if (isLpgm) {
    return Number.parseInt(val, 10) || 0;
  }
  // The condition group ("震度５弱以上未入電") represents 5- or greater.
  if (val === CONDITION_GROUP_KEY) return 5;
  if (['7', '6+', '6-', '5+', '5-'].includes(val)) {
    return 5;
  }
  if (val === '4') {
    return 4;
  }
  return Number.parseInt(val, 10) || 0;
}

/**
 * Build and render observations list in the given container
 * @param {HTMLElement} container - Container element for the list
 * @param {Array} observations - From JMAEarthquakeReport.observations
 * @param {Map} areaCodes - Area code mappings
 * @param {Map} prefCodes - Prefecture code mappings (optional, will be loaded if not provided)
 * @param {Object} [options] - Optional rendering options
 * @param {boolean} [options.isFlashReport=false] - If true, render in flash mode (no cities, show notice)
 */
export async function renderObservationsList(container, observations, areaCodes = new Map(), prefCodes = null, options = {}) {
  if (!container) return;

  // Claim this container for the latest render, then clear the previous list.
  const renderToken = ++renderGeneration;
  renderTokens.set(container, renderToken);
  container.innerHTML = '';

  if (!observations || observations.length === 0) return;

  const { isFlashReport = false, isLpgm = false } = options;

  try {
    // Load data (cached in areaCodes.js — no redundant fetches).
    // City names are only needed for full reports.  Flash and LPGM reports
    // only contain forecast areas and are grouped by region.
    const needsCityNames = !isFlashReport && !isLpgm;
    const [cityNames, resolvedPrefCodes, regions] = await Promise.all([
      needsCityNames ? loadCityNames() : Promise.resolve(new Map()),
      prefCodes ? Promise.resolve(prefCodes) : loadPrefectureCodes(),
      isFlashReport || isLpgm
        ? loadRegions().catch((err) => {
            console.warn("[observationsList] Failed to load regions, grouping as Other:", err);
            return new Map();
          })
        : Promise.resolve(null),
    ]);

    // A newer render (or an explicit invalidation) has superseded this one.
    if (renderTokens.get(container) !== renderToken) return;

    // Flash and LPGM reports have forecast-area observations only.  Their area
    // codes map to the larger JMA regions; normal reports keep
    // pref > forecast > city.
    const grouped = isFlashReport || isLpgm
      ? groupObservationsByIntensityRegion(observations, areaCodes, regions, isLpgm)
      : groupObservationsByIntensity(observations, areaCodes, resolvedPrefCodes, cityNames);

    // Get intensity order (descending: highest first).
    // The condition group ('未入電') represents "5- or greater, no data
    // received", so it sits between 5- and 4.
    const intensities = Object.keys(grouped).sort((a, b) => {
      const order = isLpgm ? ['4', '3', '2', '1'] : ['7', '6+', '6-', '5+', '5-', CONDITION_GROUP_KEY, '4', '3', '2', '1'];
      const idxA = order.includes(a) ? order.indexOf(a) : order.length;
      const idxB = order.includes(b) ? order.indexOf(b) : order.length;
      return idxA - idxB;
    });

    // Show flash report notice at the top
    if (isFlashReport) {
      const notice = document.createElement('div');
      notice.className = 'observations-flash-notice';
      notice.innerHTML = `
        <span class="flash-notice-text">市区町村ごとの情報はまだ配信されていません</span>
        <span class="flash-notice-text-en">Per-city intensity data not yet available</span>
      `;
      container.appendChild(notice);
    }

    // Check if max intensity is 5- or higher
    const maxIntensity = intensities[0];
    const maxIntensityRank = getIntensityRank(maxIntensity, isLpgm);

    // Create sections for each intensity
    for (const intensity of intensities) {
      const section = document.createElement('div');
      section.className = 'observations-intensity-section';

      // Resolve style config; the condition group uses the 5- colour.
      const config = (
        isLpgm
          ? LPGM_CONFIG[intensity]
          : INTENSITY_CONFIG[intensity === CONDITION_GROUP_KEY ? CONDITION_INTENSITY : intensity]
      ) || { color: '#4a4a4a', fontColor: '#FFFFFF' };

      // Header (collapsible)
      const header = document.createElement('div');
      header.className = 'observations-intensity-header';
      header.style.backgroundColor = config.color;

      // Determine if section should be open by default
      const intensityRank = getIntensityRank(intensity, isLpgm);
      const shouldOpen = isLpgm || maxIntensityRank < 5 || intensityRank >= 4;

      const toggle = document.createElement('span');
      toggle.className = 'observations-toggle';
      toggle.style.color = config.fontColor;
      toggle.textContent = shouldOpen ? '▼' : '▶';

      const label = document.createElement('span');
      label.className = 'observations-intensity-label';
      label.style.color = config.fontColor;
      // Special label for non-standard intensity keys
      let labelText = `震度 ${intensity.replace('-', '弱').replace('+', '強')}`;
      if (isLpgm) {
        labelText = `長周期地震動階級 ${intensity}`;
      } else if (intensity === CONDITION_GROUP_KEY) {
        labelText = '震度５弱以上未入電';
      }
      label.textContent = labelText;

      header.appendChild(toggle);
      header.appendChild(label);

      // Content (collapsible)
      const content = document.createElement('div');
      content.className = 'observations-intensity-content';
      content.style.borderLeft = '2px solid ' + config.color;
      if (!shouldOpen) content.classList.add('collapsed');

      // Add top-level groups (prefecture or region), forecast areas and cities
      const groups = grouped[intensity];
      for (const group of groups) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'observation-pref';

        const groupRow = document.createElement('div');
        groupRow.className = 'observation-row pref-row';
        const groupJa = group.name;
        const groupEn = group.nameEn || group.code;
        groupRow.innerHTML = `<span class="observation-ja">${groupJa}</span><span class="observation-dot">·</span><span class="observation-en">${groupEn}</span>`;
        groupDiv.appendChild(groupRow);

        // Areas under the group
        for (const area of group.areas) {
          const areaDiv = document.createElement('div');
          areaDiv.className = 'observation-area';

          const areaRow = document.createElement('div');
          areaRow.className = 'observation-row area-row';
          const areaJa = area.name;
          const areaEn = area.nameEn || area.code;
          areaRow.innerHTML = `<span class="observation-ja">${areaJa}</span><span class="observation-dot">·</span><span class="observation-en">${areaEn}</span>`;
          areaDiv.appendChild(areaRow);

          // Cities under area (only for full reports)
          if (!isFlashReport && !isLpgm) {
            for (const city of area.cities) {
              const cityDiv = document.createElement('div');
              cityDiv.className = 'observation-city';

              const cityRow = document.createElement('div');
              cityRow.className = 'observation-row city-row';
              const cityJa = city.name;
              const cityEn = city.nameEn || city.code;
              cityRow.innerHTML = `<span class="observation-ja">${cityJa}</span><span class="observation-dot">·</span><span class="observation-en">${cityEn}</span>`;
              cityDiv.appendChild(cityRow);

              areaDiv.appendChild(cityDiv);
            }
          }

          groupDiv.appendChild(areaDiv);
        }

        content.appendChild(groupDiv);
      }

      // Toggle functionality
      header.addEventListener('click', () => {
        content.classList.toggle('collapsed');
        toggle.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
      });

      section.appendChild(header);
      section.appendChild(content);
      container.appendChild(section);
    }

    console.info('[observationsList] Rendered observations list');
  } catch (err) {
    console.error('[observationsList] Error rendering observations list:', err);
  }
}

/**
 * Group flash/LPGM observations by intensity and JMA region.
 * These reports only contain forecast areas, so the prefecture level is
 * replaced by the larger region (Kanto, Tohoku, ...) from regions.csv.
 * Areas without a region (sea/outside Japan/unmapped) are grouped as Other.
 *
 * @param {Array} observations - Observations array (areas have empty cities arrays)
 * @param {Map} areaCodes - Area code mappings, including regionCode
 * @param {Map|null} regions - Region code -> { name, kana, en }
 * @param {boolean} isLpgm - If true, groups by maxLgInt instead of maxInt
 * @returns {Object} Grouped observations by intensity
 */
function groupObservationsByIntensityRegion(
  observations,
  areaCodes = new Map(),
  regions = new Map(),
  isLpgm = false,
) {
  const grouped = {};

  for (const pref of observations) {
    for (const area of pref.areas) {
      const intensity = isLpgm ? area.maxLgInt : area.maxInt;
      if (!intensity) continue;
      ensureIntensityGroup(grouped, intensity);

      const areaCode = area.code;
      const areaData = areaCodes.get(areaCode);
      const areaName = areaData?.ja || area.name;
      const areaNameEn = areaData?.en || '';
      const regionCode = areaData?.regionCode ?? null;
      const regionData = regionCode != null ? regions?.get(regionCode) : null;
      const groupKey = regionData ? regionCode : "unknown";

      let regionEntry = grouped[intensity].find((entry) => entry.code === groupKey);
      if (!regionEntry) {
        regionEntry = {
          code: groupKey,
          name: regionData?.name || "その他",
          nameEn: regionData?.en || "Other",
          kana: regionData?.kana || "",
          order: regionData ? regionCode : Number.MAX_SAFE_INTEGER,
          areas: [],
        };
        grouped[intensity].push(regionEntry);
      }

      findOrCreateArea(regionEntry, areaCode, areaName, areaNameEn);
    }
  }

  // Regions have a natural order (Hokkaido -> Okinawa); keep it stable inside
  // each intensity section. Unmapped areas go last.
  for (const entries of Object.values(grouped)) {
    entries.sort((a, b) => a.order - b.order);
  }

  return grouped;
}
