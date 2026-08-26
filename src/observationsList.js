/**
 * Loads city.json and prefecture-codes.csv data, builds a hierarchical list 
 * of observations grouped by intensity level.
 */

import { loadPrefectureCodes, loadCityNames } from "./areaCodes.js";
import { INTENSITY_CONFIG, LPGM_CONFIG } from "./constants";



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
export function groupObservationsByIntensity(observations, areaCodes = new Map(), prefectureCodes = new Map(), cityNames = new Map()) {
  const grouped = {};

  // Helper to ensure intensity group exists
  const ensureIntensity = (intensity) => {
    if (!grouped[intensity]) {
      grouped[intensity] = [];
    }
  };

  // Helper to find or create pref in intensity group
  const findOrCreatePref = (intensity, prefCode, prefName) => {
    let pref = grouped[intensity].find(p => p.code === prefCode);
    if (!pref) {
      const prefData = prefectureCodes.get(prefCode) || {};
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
  };

  // Helper to find or create area in pref
  const findOrCreateArea = (pref, areaCode, areaName, areaNameEn) => {
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
  };

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
        const cityIntensity = city.maxInt || (city.condition ? '未入電' : null);
        if (!cityIntensity) continue; // skip cities with no intensity info at all
        ensureIntensity(cityIntensity);

        const prefEntry = findOrCreatePref(cityIntensity, prefCode, prefName);
        const areaEntry = findOrCreateArea(prefEntry, areaCode, areaName, areaNameEn);

        const cityCode = city.code;
        // Pad cityCode to 7 digits for matching with cityNames Map keys if necessary,
        // though observations code format might vary. Usually they are 7 digit strings.
        const codeKey = String(cityCode).padStart(7, '0');
        const cityData = cityNames.get(codeKey);

        // Check if this city already exists in the area
        const existingCity = areaEntry.cities.find(c => c.code === cityCode);
        if (!existingCity) {
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

  // Clear container
  container.innerHTML = '';

  if (!observations || observations.length === 0) return;

  const { isFlashReport = false, isLpgm = false } = options;

  try {
    // Load data (cached in areaCodes.js — no redundant fetches)
    const cityNames = await loadCityNames();
    const resolvedPrefCodes = prefCodes || await loadPrefectureCodes();

    // Group observations by intensity
    const grouped = (isFlashReport || isLpgm)
      ? groupObservationsByIntensityAreaOnly(observations, areaCodes, resolvedPrefCodes, isLpgm)
      : groupObservationsByIntensity(observations, areaCodes, resolvedPrefCodes, cityNames);

    // Get intensity order (descending: highest first)
    // '未入電' (no data received) is placed after all standard intensities
    const intensities = Object.keys(grouped).sort((a, b) => {
      const order = isLpgm ? ['4', '3', '2', '1'] : ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1', '未入電'];
      const idxA = order.indexOf(a) === -1 ? order.length : order.indexOf(a);
      const idxB = order.indexOf(b) === -1 ? order.length : order.indexOf(b);
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
    const maxIntensityRank = isLpgm ? Number.parseInt(maxIntensity, 10) :
                             (['7', '6+', '6-', '5+', '5-'].includes(maxIntensity) ? 5 : 
                             maxIntensity === '4' ? 4 : 
                             Number.parseInt(maxIntensity, 10));

    // Create sections for each intensity
    for (const intensity of intensities) {
      const section = document.createElement('div');
      section.className = 'observations-intensity-section';

      // Resolve style config; fall back for non-standard keys like '未入電'
      const config = (isLpgm ? LPGM_CONFIG[intensity] : INTENSITY_CONFIG[intensity]) || { color: '#4a4a4a', fontColor: '#FFFFFF' };

      // Header (collapsible)
      const header = document.createElement('div');
      header.className = 'observations-intensity-header';
      header.style.backgroundColor = config.color;

      // Determine if section should be open by default
      const intensityRank = isLpgm ? Number.parseInt(intensity, 10) || 0 :
                           (['7', '6+', '6-', '5+', '5-'].includes(intensity) ? 5 :
                           intensity === '4' ? 4 :
                           Number.parseInt(intensity, 10) || 0);
      
      const shouldOpen = isLpgm ? true : (maxIntensityRank >= 5 ? intensityRank >= 4 : true);

      const toggle = document.createElement('span');
      toggle.className = 'observations-toggle';
      toggle.style.color = config.fontColor;
      toggle.textContent = shouldOpen ? '▼' : '▶';

      const label = document.createElement('span');
      label.className = 'observations-intensity-label';
      label.style.color = config.fontColor;
      // Special label for non-standard intensity keys
      const labelText = isLpgm
        ? `長周期地震動階級 ${intensity}`
        : (intensity === '未入電'
            ? '震度５弱以上未入電'
            : `震度 ${intensity.replace('-', '弱').replace('+', '強')}`);
      label.textContent = labelText;

      header.appendChild(toggle);
      header.appendChild(label);

      // Content (collapsible)
      const content = document.createElement('div');
      content.className = 'observations-intensity-content';
      content.style.borderLeft = '2px solid ' + config.color;
      if (!shouldOpen) content.classList.add('collapsed');

      // Add prefectures, areas, cities to content
      const prefs = grouped[intensity];
      for (const pref of prefs) {
        const prefDiv = document.createElement('div');
        prefDiv.className = 'observation-pref';

        const prefRow = document.createElement('div');
        prefRow.className = 'observation-row pref-row';
        const prefJa = pref.name;
        const prefEn = pref.nameEn || pref.code;
        prefRow.innerHTML = `<span class="observation-ja">${prefJa}</span><span class="observation-dot">·</span><span class="observation-en">${prefEn}</span>`;
        prefDiv.appendChild(prefRow);

        // Areas under pref
        for (const area of pref.areas) {
          const areaDiv = document.createElement('div');
          areaDiv.className = 'observation-area';

          const areaRow = document.createElement('div');
          areaRow.className = 'observation-row area-row';
          const areaJa = area.name;
          const areaEn = area.nameEn || area.code;
          areaRow.innerHTML = `<span class="observation-ja">${areaJa}</span><span class="observation-dot">·</span><span class="observation-en">${areaEn}</span>`;
          areaDiv.appendChild(areaRow);

          // Cities under area (only for non-flash reports)
          if (!isFlashReport) {
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

          prefDiv.appendChild(areaDiv);
        }

        content.appendChild(prefDiv);
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
 * Group observations by intensity at the area level (no cities).
 * Used for flash reports (震度速報) which don't have per-city data, and for LPGM which only has area-level intensities.
 * @param {Array} observations - Observations array (areas have empty cities arrays)
 * @param {Map} areaCodes - Area code mappings
 * @param {Map} prefectureCodes - Prefecture code mappings
 * @param {boolean} isLpgm - If true, groups by maxLgInt instead of maxInt
 * @returns {Object} Grouped observations by intensity
 */
function groupObservationsByIntensityAreaOnly(observations, areaCodes = new Map(), prefectureCodes = new Map(), isLpgm = false) {
  const grouped = {};

  const ensureIntensity = (intensity) => {
    if (!grouped[intensity]) {
      grouped[intensity] = [];
    }
  };

  const findOrCreatePref = (intensity, prefCode, prefName) => {
    let pref = grouped[intensity].find(p => p.code === prefCode);
    if (!pref) {
      const prefData = prefectureCodes.get(prefCode) || {};
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
  };

  for (const pref of observations) {
    const prefCode = pref.code;
    const prefName = pref.name;

    for (const area of pref.areas) {
      const intensity = isLpgm ? area.maxLgInt : area.maxInt;
      if (!intensity) continue;
      ensureIntensity(intensity);

      const areaCode = area.code;
      const areaName = areaCodes.get(areaCode)?.ja || area.name;
      const areaNameEn = areaCodes.get(areaCode)?.en || '';

      const prefEntry = findOrCreatePref(intensity, prefCode, prefName);

      const existingArea = prefEntry.areas.find(a => a.code === areaCode);
      if (!existingArea) {
        prefEntry.areas.push({
          code: areaCode,
          name: areaName,
          nameEn: areaNameEn,
          cities: [], // empty for area-only view
        });
      }
    }
  }

  return grouped;
}
