/**
 * Loads city.json and prefecture-codes.csv data, builds a hierarchical list 
 * of observations grouped by intensity level.
 */

import { loadPrefectureCodes, loadCityNames } from "./areaCodes.js";
import { INTENSITY_CONFIG } from "./constants";



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
        // Group each city by its own intensity
        const cityIntensity = city.maxInt;
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
 */
export async function renderObservationsList(container, observations, areaCodes = new Map(), prefCodes = null) {
  if (!container || !observations || observations.length === 0) return;

  try {
    // Load data (cached in areaCodes.js — no redundant fetches)
    const cityNames = await loadCityNames();
    const resolvedPrefCodes = prefCodes || await loadPrefectureCodes();

    // Group observations by intensity
    const grouped = groupObservationsByIntensity(observations, areaCodes, resolvedPrefCodes, cityNames);

    // Get intensity order (descending: highest first)
    const intensities = Object.keys(grouped).sort((a, b) => {
      const order = ['7', '6+', '6-', '5+', '5-', '4', '3', '2', '1'];
      return order.indexOf(a) - order.indexOf(b);
    });

    // Clear container
    container.innerHTML = '';

    // Check if max intensity is 5- or higher
    const maxIntensity = intensities[0];
    const maxIntensityRank = ['7', '6+', '6-', '5+', '5-'].includes(maxIntensity) ? 5 : 
                             maxIntensity === '4' ? 4 : 
                             Number.parseInt(maxIntensity, 10);

    // Create sections for each intensity
    for (const intensity of intensities) {
      const section = document.createElement('div');
      section.className = 'observations-intensity-section';

      // Header (collapsible)
      const header = document.createElement('div');
      header.className = 'observations-intensity-header';
      header.style.backgroundColor = INTENSITY_CONFIG[intensity].color;

      // Determine if section should be open by default
      const intensityRank = ['7', '6+', '6-', '5+', '5-'].includes(intensity) ? 5 :
                           intensity === '4' ? 4 :
                           Number.parseInt(intensity, 10);
      const shouldOpen = maxIntensityRank >= 5 ? intensityRank >= 4 : true;

      const toggle = document.createElement('span');
      toggle.className = 'observations-toggle';
      toggle.style.color = INTENSITY_CONFIG[intensity].fontColor;
      toggle.textContent = shouldOpen ? '▼' : '▶';

      const label = document.createElement('span');
      label.className = 'observations-intensity-label';
      label.style.color = INTENSITY_CONFIG[intensity].fontColor;
      label.textContent = `震度 ${intensity.replace('-', '弱').replace('+', '強')}`;

      header.appendChild(toggle);
      header.appendChild(label);

      // Content (collapsible)
      const content = document.createElement('div');
      content.className = 'observations-intensity-content';
      content.style.borderLeft = '2px solid ' + INTENSITY_CONFIG[intensity].color;
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

          // Cities under area
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
