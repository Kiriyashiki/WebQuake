import { haversineDistance } from "./constants.js";
import { pointInPolygon } from "./geoUtils.js";

export { pointInPolygon };

/**
 * Loads and caches data files used across modules.
 * All loaders use promise caching to avoid redundant network fetches —
 * calling the same loader multiple times returns the same promise.
 */

// ─── Promise caches ──────────────────────────────────────────────────────────
let _areaCodesPromise = null;
let _areaNameToCodePromise = null;
let _areaNameToCodeMap = new Map();
let _prefectureCodesPromise = null;
let _cityNamesPromise = null;
let _rawCsvPromise = null;
let _boundsPromise = null;
let _stationsCsvPromise = null;
let _cityForecastCsvPromise = null;
let _municipalitiesPromise = null;
let _cityPolygonsMap = null;

// ─── Area Codes ──────────────────────────────────────────────────────────────

/**
 * Returns the raw text of jma-area-codes.csv (cached).
 * Shared between loadAreaCodes() and historyMode's reverse lookup.
 * @returns {Promise<string>}
 */
export function loadAreaCodesRawCsv() {
  if (!_rawCsvPromise) {
    _rawCsvPromise = fetch('/jma-area-codes.csv').then(res => {
      if (!res.ok) throw new Error(`Failed to load area codes CSV: ${res.status}`);
      return res.text();
    });
  }
  return _rawCsvPromise;
}

/**
 * Loads and parses jma-area-codes.csv into a Map keyed by numeric code.
 *
 * CSV format (semicolon-delimited, no header):
 *   100;石狩地方北部;いしかりちほうきたぶ;Northern Part of Ishikari
 *
 * Returns: Map<number, { ja: string, kana: string, en: string }>
 */
export function loadAreaCodes() {
  if (!_areaCodesPromise) {
    _areaCodesPromise = loadAreaCodesRawCsv().then(text => {
      const map = new Map();
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(';');
        if (parts.length < 3) continue;

        const code = Number.parseInt(parts[0], 10);
        const ja   = parts[1]?.trim() ?? '';
        const kana = parts[2]?.trim() ?? '';
        const en   = parts[3]?.trim() ?? '';

        if (!Number.isNaN(code)) {
          map.set(code, { ja, kana, en });
          if (ja) {
            _areaNameToCodeMap.set(ja, code);
          }
        }
      }
      return map;
    });
  }
  return _areaCodesPromise;
}

/**
 * Loads a Map from Japanese area name to numeric area code.
 * @returns {Promise<Map<string, number>>}
 */
export function loadAreaNameToCodeMap() {
  if (!_areaNameToCodePromise) {
    _areaNameToCodePromise = loadAreaCodesRawCsv().then(text => {
      const map = new Map();
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(';');
        if (parts.length < 2) continue;

        const code = Number.parseInt(parts[0], 10);
        const ja   = parts[1]?.trim() ?? '';

        if (!Number.isNaN(code) && ja) {
          map.set(ja, code);
          _areaNameToCodeMap.set(ja, code);
        }
      }
      return map;
    });
  }
  return _areaNameToCodePromise;
}

/**
 * Synchronous lookup from cached name-to-code map, or null if not yet loaded/found.
 * @param {string} name
 * @returns {number|null}
 */
export function getAreaCodeByName(name) {
  if (!name) return null;
  return _areaNameToCodeMap.get(name) ?? null;
}

// ─── Prefecture Codes ────────────────────────────────────────────────────────

/**
 * Loads and parses prefecture-codes.csv into a Map keyed by numeric code.
 *
 * CSV format (semicolon-delimited, no header):
 *   1;北海道;ほっかいどう;Hokkaido
 *
 * Returns: Map<number, { name, kana, enName }>
 */
export function loadPrefectureCodes() {
  if (!_prefectureCodesPromise) {
    _prefectureCodesPromise = (async () => {
      const res = await fetch('/prefecture-codes.csv');
      if (!res.ok) throw new Error(`Failed to load prefecture codes CSV: ${res.status}`);

      const text = await res.text();
      const map = new Map();

      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(';');
        if (parts.length < 2) continue;

        const code   = Number.parseInt(parts[0], 10);
        const name   = parts[1]?.trim() ?? '';
        const kana   = parts[2]?.trim() ?? '';
        const enName = parts[3]?.trim() ?? '';

        if (!Number.isNaN(code)) {
          map.set(code, { name, kana, enName });
        }
      }

      return map;
    })();
  }
  return _prefectureCodesPromise;
}

// ─── City Names ──────────────────────────────────────────────────────────────

/**
 * Loads city.json data into a Map keyed by city code string.
 *
 * JSON format:
 *   {
 *     "0123500": { "japanese": "石狩市", "english": "Ishikari City", ... }
 *   }
 *
 * Returns: Map<string, { ja: string, en: string }>
 */
export function loadCityNames() {
  if (!_cityNamesPromise) {
    _cityNamesPromise = (async () => {
      const res = await fetch('/city.json');
      if (!res.ok) throw new Error(`Failed to load city names JSON: ${res.status}`);

      const data = await res.json();
      const map = new Map();

      for (const [code, info] of Object.entries(data)) {
        map.set(code, {
          ja: info.japanese || '',
          en: info.english || ''
        });
      }

      return map;
    })();
  }
  return _cityNamesPromise;
}

// ─── Station Names ─────────────────────────────────────────────────────────────

let _stationNamesPromise = null;

/**
 * Returns the raw text of stations.csv (cached).
 * Shared between loadStationNames() and EEW.
 * @returns {Promise<string>}
 */
export function loadStationsCsvText() {
  if (!_stationsCsvPromise) {
    _stationsCsvPromise = fetch('/stations.csv').then(res => {
      if (!res.ok) throw new Error(`Failed to load stations CSV: ${res.status}`);
      return res.text();
    });
  }
  return _stationsCsvPromise;
}

/**
 * Loads stations.csv data into Maps keyed by code and nameja.
 *
 * CSV format (semicolon-delimited, with header):
 *   code;nameja;kana;nameen
 *
 * Returns: { byCode: Map<string, {ja, kana, en}>, byName: Map<string, {ja, kana, en}> }
 */
export function loadStationNames() {
  if (!_stationNamesPromise) {
    _stationNamesPromise = (async () => {
      const text = await loadStationsCsvText();
      const byCode = new Map();
      const byName = new Map();

      const lines = text.split('\n');
      let startIndex = 0;
      if (lines.length > 0 && lines[0].startsWith('code')) {
        startIndex = 1;
      }

      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(';');
        if (parts.length < 4) continue;

        const code = parts[0].trim();
        const ja   = parts[1].replace(/[＊*]/g, "").trim();
        const kana = parts[2].trim();
        const en   = parts[3].replace(/[＊*]/g, "").trim();

        const info = { ja, kana, en };
        if (code) byCode.set(code, info);
        if (ja) byName.set(ja, info);
      }

      return { byCode, byName };
    })();
  }
  return _stationNamesPromise;
}

// ─── Bounds Data ─────────────────────────────────────────────────────────────

/**
 * Loads bounds.json data (cached).
 * Shared between main.js and historyMode.js.
 * @returns {Promise<Object>}
 */
export function loadBoundsData() {
  if (!_boundsPromise) {
    _boundsPromise = (async () => {
      const res = await fetch('/bounds.json');
      if (!res.ok) throw new Error(`Failed to load bounds.json: ${res.status}`);
      return res.json();
    })();
  }
  return _boundsPromise;
}

// ─── City Forecast Map ─────────────────────────────────────────────────────────

/**
 * Returns the raw text of city_forecast_map.csv (cached).
 * Shared between EEW and historyMode.
 * @returns {Promise<string>}
 */
export function loadCityForecastMapCsv() {
  if (!_cityForecastCsvPromise) {
    _cityForecastCsvPromise = fetch('/city_forecast_map.csv').then(res => {
      if (!res.ok) throw new Error(`Failed to load city_forecast_map.csv: ${res.status}`);
      return res.text();
    });
  }
  return _cityForecastCsvPromise;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Create HTML for a ruby text (for displaying kana above kanji)
 * @param {string} text - Japanese text
 * @param {string} kana - Kana reading
 * @returns {string} HTML string with ruby element
 */
export function createRubyHtml(text, kana) {
  if (!kana) return text;
  return `<ruby>${text}<rt>${kana}</rt></ruby>`;
}

// ─── Municipalities GeoJSON & Coordinate Lookup ──────────────────────────────

/**
 * Loads municipalities.geojson data (cached).
 * @returns {Promise<Object>}
 */
export function loadMunicipalitiesGeojson() {
  if (!_municipalitiesPromise) {
    _municipalitiesPromise = fetch('/municipalities.geojson').then(res => {
      if (!res.ok) throw new Error(`Failed to load municipalities.geojson: ${res.status}`);
      return res.json();
    });
  }
  return _municipalitiesPromise;
}


/**
 * Finds the matching city code and prefecture code for given [lon, lat] coordinates.
 * Uses bounding box filtering and point-in-polygon matching with a distance-based fallback.
 * @param {number} lon
 * @param {number} lat
 * @returns {Promise<{ cityCode: string, prefCode: string, name: string } | null>}
 */
export async function findCityForCoordinates(lon, lat) {
  if (typeof lon !== "number" || typeof lat !== "number" || Number.isNaN(lon) || Number.isNaN(lat)) {
    return null;
  }

  const [boundsData, municipalities] = await Promise.all([
    loadBoundsData(),
    loadMunicipalitiesGeojson(),
  ]);

  if (!boundsData?.cities || !municipalities?.features) {
    return null;
  }

  if (!_cityPolygonsMap) {
    _cityPolygonsMap = new Map();
    for (const feature of municipalities.features) {
      if (feature.properties?.regioncode) {
        _cityPolygonsMap.set(feature.properties.regioncode.toString(), feature);
      }
    }
  }

  // STEP A: Fast Bounding Box Filter
  const candidates = [];
  for (const [cityCode, bbox] of Object.entries(boundsData.cities)) {
    if (lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]) {
      candidates.push(cityCode);
    }
  }

  // STEP B: Precise Point-in-Polygon Filter
  for (const cityCode of candidates) {
    const feat = _cityPolygonsMap.get(cityCode);
    if (feat && pointInPolygon([lon, lat], feat)) {
      return {
        cityCode,
        prefCode: cityCode.substring(0, 2),
        name: feat.properties?.name || "",
      };
    }
  }

  // STEP C: Fallback for points slightly off the coast or on boundaries
  let bestCityCode = null;
  let minDistance = 25; // km
  const searchRadiusDeg = 0.25;

  for (const [cityCode, bbox] of Object.entries(boundsData.cities)) {
    if (lon >= bbox[0] - searchRadiusDeg && lon <= bbox[2] + searchRadiusDeg &&
        lat >= bbox[1] - searchRadiusDeg && lat <= bbox[3] + searchRadiusDeg) {
      const feat = _cityPolygonsMap.get(cityCode);
      if (!feat) continue;

      const processRing = (ring) => {
        for (const [rLon, rLat] of ring) {
          const dist = haversineDistance(lat, lon, rLat, rLon);
          if (dist < minDistance) {
            minDistance = dist;
            bestCityCode = cityCode;
          }
        }
      };

      if (feat.geometry.type === 'Polygon') {
        processRing(feat.geometry.coordinates[0]);
      } else if (feat.geometry.type === 'MultiPolygon') {
        for (const poly of feat.geometry.coordinates) {
          processRing(poly[0]);
        }
      }
    }
  }

  if (bestCityCode) {
    const feat = _cityPolygonsMap.get(bestCityCode);
    return {
      cityCode: bestCityCode,
      prefCode: bestCityCode.substring(0, 2),
      name: feat?.properties?.name || "",
    };
  }

  return null;
}
