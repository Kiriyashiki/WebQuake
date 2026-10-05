import { EQDB_API_URL, haversineDistance } from './constants.js';
import {
  loadAreaCodesRawCsv,
  loadBoundsData,
  loadCityForecastMapCsv,
  loadMunicipalitiesGeojson,
} from './areaCodes.js';
import { parseReport, buildDisplayReport } from './reportUtils.js';
import { pointInPolygon } from './geoUtils.js';

// ─── Utility functions (from generateEqdbReport.js) ─────────────────────────

export const EQDB_MIN_DATE = '2000-01-01';

export function formatIntensity(rawInt) {
  if (!rawInt) return null;
  let val = String(rawInt).replace('震度', '').trim();
  const map = {
    '５弱': '5-',
    '５強': '5+',
    '６弱': '6-',
    '６強': '6+',
    '１': '1',
    '２': '2',
    '３': '3',
    '４': '4',
    '７': '7',
    '5弱': '5-',
    '5強': '5+',
    '6弱': '6-',
    '6強': '6+',
    '1': '1',
    '2': '2',
    '3': '3',
    '4': '4',
    '7': '7',
    '5-': '5-',
    '5+': '5+',
    '6-': '6-',
    '6+': '6+',
  };
  return map[val] || val;
}

/**
 * Normalizes a date string or Date object to YYYY-MM-DD format.
 * Supports YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, and Date instances.
 * @param {string|Date} date
 * @returns {string|null}
 */
export function normalizeDateString(date) {
  if (!date) return null;
  if (date instanceof Date) {
    return date.toISOString().slice(0, 10);
  }
  const str = String(date).trim();
  const dmyMatch = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(str);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
  }
  return str;
}

/**
 * Clamps a date string so it is never earlier than EQDB_MIN_DATE (2000-01-01).
 * @param {string|Date} date
 * @param {string} [fallback=EQDB_MIN_DATE]
 * @returns {string}
 */
export function clampMinDate(date, fallback = EQDB_MIN_DATE) {
  const normalized = normalizeDateString(date);
  if (!normalized || normalized < EQDB_MIN_DATE) {
    return fallback;
  }
  return normalized;
}

/** Converts JST time string to a strict GMT/UTC ISO string */
function formatOriginTime(jstTimeString) {
  if (!jstTimeString) return null;

  let isoFormatted = jstTimeString.replaceAll('/', '-').replace(' ', 'T');
  isoFormatted += '+09:00';

  const dateObj = new Date(isoFormatted);
  return dateObj.toISOString();
}

/** Determines the maximum intensity from an array of intensity strings */
function getMaxInt(intValues) {
  const intOrder = { '1': 1, '2': 2, '3': 3, '4': 4, '5-': 5, '5+': 6, '6-': 7, '6+': 8, '7': 9 };
  const validInts = intValues.filter(Boolean);
  if (validInts.length === 0) return null;

  return validInts.reduce((max, current) => {
    return intOrder[current] > intOrder[max] ? current : max;
  }, validInts[0]);
}

/** Formats lat, lon, dep into ±DD.D±DDD.D±DDDDD/ */
function formatCoordinates(lat, lon, depStr) {
  if (!lat || !lon) return null;

  const numLat = Number.parseFloat(lat);
  const numLon = Number.parseFloat(lon);

  const depthMatch = depStr ? depStr.match(/(\d+)/) : null;
  let depth = depthMatch ? Number.parseInt(depthMatch[1], 10) * 1000 : 0;

  const latStr = (numLat >= 0 ? '+' : '') + numLat.toString();
  const lonStr = (numLon >= 0 ? '+' : '') + numLon.toString();
  const depFormatted = `-${depth}`;

  return `${latStr}${lonStr}${depFormatted}/`;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

/**
 * Returns the date string for 1 year ago today in YYYY-MM-DD format (JST).
 */
function getDateOneYearAgo() {
  // Get current time in JST
  const now = new Date();
  const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));

  const year = jstNow.getUTCFullYear() - 1;
  const month = String(jstNow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jstNow.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

// ─── EQDB max date (fetched once) ────────────────────────────────────────────

let _eqdbMaxDate = null;

/**
 * Fetches the latest available date from the EQDB API.
 * The result is cached after the first successful fetch.
 * @returns {Promise<string>} Date string in YYYY-MM-DD format
 */
export async function fetchEqdbMaxDate() {
  if (_eqdbMaxDate) return _eqdbMaxDate;

  try {
    const res = await fetch('https://www.data.jma.go.jp/eqdb/data/shindo/js/date.json');
    const data = await res.json();
    if (data.en) {
      _eqdbMaxDate = data.en; // e.g. "2026-07-08"
      return _eqdbMaxDate;
    }
  } catch (err) {
    console.warn('[history] Failed to fetch EQDB max date:', err);
  }

  // Fallback: 8 days ago in JST (conservative)
  const now = new Date();
  const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  jstNow.setUTCDate(jstNow.getUTCDate() - 8);
  const year = jstNow.getUTCFullYear();
  const month = String(jstNow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jstNow.getUTCDate()).padStart(2, '0');
  _eqdbMaxDate = `${year}-${month}-${day}`;
  return _eqdbMaxDate;
}

// ─── Search Presets ──────────────────────────────────────────────────────────

/**
 * Returns preset search parameters.
 * @param {string} preset - Preset name ('year', 'large', 'deep')
 * @param {string} maxDate - The latest available EQDB date (YYYY-MM-DD)
 * @returns {Object} Search parameters
 */
export function getSearchPreset(preset, maxDate) {
  switch (preset) {
    case 'large':
      return {
        dateFrom: EQDB_MIN_DATE,
        dateTo: maxDate,
        magMin: '0.0',
        magMax: '9.9',
        depMin: '000',
        depMax: '999',
        maxInt: 'A', // 5-
        sort: 'S0',
      };
    case 'deep':
      return {
        dateFrom: EQDB_MIN_DATE,
        dateTo: maxDate,
        magMin: '0.0',
        magMax: '9.9',
        depMin: '200',
        depMax: '999',
        maxInt: '1',
        sort: 'S0',
      };
    case 'year':
    default: {
      const oneYearAgo = clampMinDate(getDateOneYearAgo());
      return {
        dateFrom: oneYearAgo,
        dateTo: oneYearAgo,
        magMin: '0.0',
        magMax: '9.9',
        depMin: '000',
        depMax: '999',
        maxInt: '1',
        sort: 'S0',
      };
    }
  }
}

// ─── EQDB API functions ──────────────────────────────────────────────────────

/**
 * Fetches the list of earthquake events from the EQDB API with search parameters.
 * @param {Object} params - Search parameters
 * @param {string} params.dateFrom - Start date (YYYY-MM-DD)
 * @param {string} params.dateTo - End date (YYYY-MM-DD)
 * @param {string} params.magMin - Minimum magnitude (e.g. '0.0')
 * @param {string} params.magMax - Maximum magnitude (e.g. '9.9')
 * @param {string} params.depMin - Minimum depth (e.g. '000')
 * @param {string} params.depMax - Maximum depth (e.g. '999')
 * @param {string} params.maxInt - Minimum intensity filter ('1'-'7', 'A'=5-, 'B'=5+, 'C'=6-, 'D'=6+)
 * @param {string} params.sort - Sort mode ('S0'=newest, 'S1'=oldest, 'S2'=highest intensity)
 * @returns {Promise<Array>} Array of event objects with { id, ot, name, ... }
 */
async function fetchHistoryList(params) {
  const dateFrom = clampMinDate(params.dateFrom, EQDB_MIN_DATE);
  let dateTo = normalizeDateString(params.dateTo) || dateFrom;
  if (dateTo < EQDB_MIN_DATE) {
    dateTo = EQDB_MIN_DATE;
  }

  const boundary = '----bound';

  const fields = [
    { name: 'mode', value: 'search' },
    { name: 'dateTimeF[]', value: dateFrom },
    { name: 'dateTimeF[]', value: '00:00' },
    { name: 'dateTimeT[]', value: dateTo },
    { name: 'dateTimeT[]', value: '23:59' },
    { name: 'mag[]', value: params.magMin },
    { name: 'mag[]', value: params.magMax },
    { name: 'dep[]', value: params.depMin },
    { name: 'dep[]', value: params.depMax },
    { name: 'epi[]', value: '99' },
    { name: 'pref[]', value: '99' },
    { name: 'city[]', value: '99' },
    { name: 'station[]', value: '99' },
    { name: 'obsInt', value: '1' },
    { name: 'maxInt', value: params.maxInt },
    { name: 'additionalC', value: 'true' },
    { name: 'Sort', value: params.sort },
    { name: 'Comp', value: 'C0' },
    { name: 'seisCount', value: 'false' },
    { name: 'observed', value: 'false' },
  ];

  let body = '';
  for (const field of fields) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`;
  }
  body += `--${boundary}--\r\n`;

  const response = await fetch(EQDB_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: body
  });

  const data = await response.json();

  if (!data.res || !Array.isArray(data.res)) {
    console.warn('[history] No results from EQDB search');
    return [];
  }

  return data.res;
}

/**
 * Fetches a single EQDB event and builds a report JSON compatible with
 * JMAEarthquakeReport.fromJSON().
 * @param {string} eventId - The EQDB event ID
 * @param {Object} boundsData - Pre-loaded bounds.json
 * @param {Object} geoData - Pre-computed geoData maps
 * @returns {Promise<Object|null>} Report JSON or null on failure
 */
/**
 * Fetches raw earthquake event data from the EQDB API.
 * @param {string} eventId
 * @returns {Promise<{ hyp: Object, observations: Array }|null>}
 */
async function _fetchRawEqdbEvent(eventId) {
  const boundary = '----bound';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nevent\r\n--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${eventId}\r\n--${boundary}--\r\n`;

  const response = await fetch(EQDB_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const eqdbData = await response.json();

  if (!eqdbData.res?.hyp?.[0]) {
    console.warn(`[history] No hyp data for event ${eventId}`);
    return null;
  }

  return {
    hyp: eqdbData.res.hyp[0],
    observations: eqdbData.res.int || [],
  };
}

/**
 * Computes bounding envelope [minLon, minLat, maxLon, maxLat] covering all stations in an event.
 */
function _getStationEnvelope(stationPoints) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const s of stationPoints) {
    if (s.lon < minLon) minLon = s.lon;
    if (s.lat < minLat) minLat = s.lat;
    if (s.lon > maxLon) maxLon = s.lon;
    if (s.lat > maxLat) maxLat = s.lat;
  }

  return { minLon, minLat, maxLon, maxLat };
}

/**
 * Adds or updates a city intensity entry in the prefMap hierarchy.
 */
function _addOrUpdateCityInPrefMap(
  prefMap,
  cityCode,
  intensity,
  cityToAreaMap,
  forecastAreaNames,
) {
  const prefCode = cityCode.substring(0, 2);
  if (!prefMap.has(prefCode)) {
    prefMap.set(prefCode, { code: prefCode, name: null, areas: new Map() });
  }
  const prefData = prefMap.get(prefCode);

  const areaCode = cityToAreaMap.get(cityCode) || 'UNKNOWN_AREA';
  const areaName = forecastAreaNames.get(areaCode) || null;

  if (!prefData.areas.has(areaCode)) {
    prefData.areas.set(areaCode, { code: areaCode, name: areaName, cities: [] });
  }
  const areaData = prefData.areas.get(areaCode);

  const existingCity = areaData.cities.find((c) => c.Code === cityCode);
  if (existingCity) {
    existingCity.MaxInt = getMaxInt([existingCity.MaxInt, intensity]);
  } else {
    areaData.cities.push({
      Code: cityCode,
      Name: null,
      MaxInt: intensity,
    });
  }
}

/**
 * Performs point-in-polygon matching on station candidates for a given city feature.
 */
function _matchCityPolygon(candidatesInBounds, cityFeature) {
  if (!cityFeature) return null;

  const validStations = candidatesInBounds.filter((station) => {
    if (station.matched) return false;
    if (pointInPolygon([station.lon, station.lat], cityFeature)) {
      station.matched = true;
      return true;
    }
    return false;
  });

  return validStations.length > 0 ? getMaxInt(validStations.map((s) => s.int)) : null;
}

/**
 * Matches observation stations to municipality polygons using bounding boxes and point-in-polygon.
 */
function _matchStationsToCities(stationPoints, boundsData, geoData, prefMap) {
  const envelope = _getStationEnvelope(stationPoints);
  const { cityPolygons, cityToAreaMap, forecastAreaNames } = geoData;

  for (const [cityCode, bbox] of Object.entries(boundsData.cities)) {
    const [minLon, minLat, maxLon, maxLat] = bbox;

    // Broad-phase reject: skip cities completely outside the event's station envelope
    if (
      maxLon < envelope.minLon ||
      minLon > envelope.maxLon ||
      maxLat < envelope.minLat ||
      minLat > envelope.maxLat
    ) {
      continue;
    }

    const candidatesInBounds = stationPoints.filter(
      (s) => s.lon >= minLon && s.lon <= maxLon && s.lat >= minLat && s.lat <= maxLat,
    );
    if (candidatesInBounds.length === 0) continue;

    const cityInt = _matchCityPolygon(candidatesInBounds, cityPolygons.get(cityCode));
    if (cityInt) {
      _addOrUpdateCityInPrefMap(prefMap, cityCode, cityInt, cityToAreaMap, forecastAreaNames);
    }
  }
}

/**
 * Calculates minimum distance from a station to any coordinate vertex of a city polygon feature.
 */
function _minDistanceToCityFeature(station, cityFeature) {
  let cityMinDist = Infinity;
  const coords = cityFeature.geometry.coordinates;

  const processRing = (ring) => {
    for (const [lon, lat] of ring) {
      const dist = haversineDistance(station.lat, station.lon, lat, lon);
      if (dist < cityMinDist) cityMinDist = dist;
    }
  };

  if (cityFeature.geometry.type === 'Polygon') {
    for (const ring of coords) processRing(ring);
  } else if (cityFeature.geometry.type === 'MultiPolygon') {
    for (const poly of coords) {
      for (const ring of poly) processRing(ring);
    }
  }

  return cityMinDist;
}

/**
 * Searches nearby cities within search radius for an unmatched coastal station.
 */
function _findNearestCityForStation(station, boundsData, cityPolygons, maxRadiusKm = 10) {
  let bestCityCode = null;
  let minDistance = maxRadiusKm;
  const searchRadiusDeg = 0.1; // ~11km roughly

  for (const [cityCode, bbox] of Object.entries(boundsData.cities)) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    if (
      station.lon >= minLon - searchRadiusDeg &&
      station.lon <= maxLon + searchRadiusDeg &&
      station.lat >= minLat - searchRadiusDeg &&
      station.lat <= maxLat + searchRadiusDeg
    ) {
      const cityFeature = cityPolygons.get(cityCode);
      if (!cityFeature) continue;

      const dist = _minDistanceToCityFeature(station, cityFeature);
      if (dist < minDistance) {
        minDistance = dist;
        bestCityCode = cityCode;
      }
    }
  }

  return bestCityCode;
}

/**
 * Fallback pass for stations that did not fall inside any polygon (e.g. coastal/offshore).
 */
function _matchUnmatchedStationsFallback(stationPoints, boundsData, geoData, prefMap) {
  const unmatchedStations = stationPoints.filter((s) => !s.matched);
  if (unmatchedStations.length === 0) return;

  const { cityPolygons, cityToAreaMap, forecastAreaNames } = geoData;

  for (const station of unmatchedStations) {
    if (!station.int) continue;

    const bestCityCode = _findNearestCityForStation(station, boundsData, cityPolygons);
    if (bestCityCode) {
      station.matched = true;
      _addOrUpdateCityInPrefMap(
        prefMap,
        bestCityCode,
        station.int,
        cityToAreaMap,
        forecastAreaNames,
      );
    }
  }
}

/**
 * Structures the nested Observation array with rolled-up MaxInt for areas and prefectures.
 */
function _buildPrefObservationArray(prefMap) {
  return Array.from(prefMap.values()).map((prefData) => {
    const formattedAreas = Array.from(prefData.areas.values()).map((area) => {
      const areaMaxInt = getMaxInt(area.cities.map((c) => c.MaxInt));
      return {
        Code: area.code,
        Name: area.name,
        MaxInt: areaMaxInt,
        City: area.cities,
      };
    });

    const prefMaxInt = getMaxInt(formattedAreas.map((a) => a.MaxInt));
    return {
      Code: prefData.code,
      Name: prefData.name,
      MaxInt: prefMaxInt,
      Area: formattedAreas,
    };
  });
}

/**
 * Assembles the final report object compatible with JMAEarthquakeReport.
 */
function _synthesizeEqdbReport(hyp, prefArray, resolvedHypocenterCode) {
  return {
    Head: {
      EventID: hyp.id,
    },
    Body: {
      Earthquake: {
        OriginTime: formatOriginTime(hyp.ot),
        Magnitude: hyp.mag,
        Hypocenter: {
          Area: {
            Code: resolvedHypocenterCode,
            Coordinate: formatCoordinates(hyp.lat, hyp.lon, hyp.dep),
          },
        },
      },
      Intensity: {
        Observation: {
          MaxInt: formatIntensity(hyp.maxI),
          Pref: prefArray,
        },
      },
    },
  };
}

/**
 * Fetches a single EQDB event and builds a report JSON compatible with
 * JMAEarthquakeReport.fromJSON().
 * @param {string} eventId - The EQDB event ID
 * @param {Object} boundsData - Pre-loaded bounds.json
 * @param {Object} geoData - Pre-computed geoData maps
 * @returns {Promise<Object|null>} Report JSON or null on failure
 */
async function fetchEqdbEvent(eventId, boundsData, geoData) {
  try {
    const rawData = await _fetchRawEqdbEvent(eventId);
    if (!rawData) return null;

    const { hyp, observations } = rawData;
    const resolvedHypocenterCode = geoData.hypocenterCodeMap.get(hyp.name) || null;

    // Create observation point features
    const stationPoints = observations.map((obs) => ({
      lon: Number.parseFloat(obs.lon),
      lat: Number.parseFloat(obs.lat),
      int: formatIntensity(obs.int),
      matched: false,
    }));

    const prefMap = new Map();
    if (stationPoints.length > 0) {
      _matchStationsToCities(stationPoints, boundsData, geoData, prefMap);
      _matchUnmatchedStationsFallback(stationPoints, boundsData, geoData, prefMap);
    }

    const prefArray = _buildPrefObservationArray(prefMap);
    return _synthesizeEqdbReport(hyp, prefArray, resolvedHypocenterCode);
  } catch (error) {
    console.error(`[history] Failed to generate report for ${eventId}:`, error);
    return null;
  }
}

// ─── Cached geo data (loaded once) ──────────────────────────────────────────

let _geoDataCache = null;
let _geoDataClearTimeout = null;

function resetGeoDataTimeout() {
  if (_geoDataClearTimeout) {
    clearTimeout(_geoDataClearTimeout);
  }
  _geoDataClearTimeout = setTimeout(() => {
    _geoDataCache = null;
    console.info("[history] Released geo data cache due to inactivity.");
  }, 5 * 60 * 1000);
}

async function loadGeoData() {
  resetGeoDataTimeout();
  
  if (_geoDataCache) return _geoDataCache;

  const [bounds, forecastRes, municipalities, areaCodesCsv, cityForecastCsv] = await Promise.all([
    loadBoundsData(),
    fetch('/forecast_areas.geojson').then((res) => {
      if (!res.ok) throw new Error(`Failed to load forecast_areas.geojson: ${res.status}`);
      return res.json();
    }),
    loadMunicipalitiesGeojson(),
    loadAreaCodesRawCsv(),
    loadCityForecastMapCsv(),
  ]);

  // Pre-parse hypocenter CSV into Map
  const hypocenterCodeMap = new Map();
  if (areaCodesCsv) {
    areaCodesCsv.split('\n').forEach(line => {
      const parts = line.split(';');
      if (parts.length >= 2) {
        hypocenterCodeMap.set(parts[1].trim(), parts[0].trim());
      }
    });
  }

  // Pre-parse city to forecast area mapping
  const cityToAreaMap = new Map();
  if (cityForecastCsv) {
    cityForecastCsv.split('\n').forEach(line => {
      const parts = line.split(',');
      if (parts.length >= 2) {
        cityToAreaMap.set(parts[0].trim(), parts[1].trim());
      }
    });
  }

  // Pre-map forecast area names for quick lookup
  const forecastAreaNames = new Map();
  if (forecastRes?.features) {
    for (const feature of forecastRes.features) {
      if (feature.properties?.code) {
        forecastAreaNames.set(feature.properties.code, feature.properties.name);
      }
    }
  }

  // Pre-map municipalities for quick O(1) lookup by regioncode
  const cityPolygons = new Map();
  if (municipalities?.features) {
    for (const feature of municipalities.features) {
      if (feature.properties?.regioncode) {
        cityPolygons.set(feature.properties.regioncode.toString(), feature);
      }
    }
  }

  _geoDataCache = {
    bounds,
    hypocenterCodeMap,
    cityToAreaMap,
    forecastAreaNames,
    cityPolygons,
  };

  return _geoDataCache;
}

/**
 * Resolves Japanese and English hypocenter names from area codes mapping.
 * @param {string} name - Hypocenter name in Japanese
 * @param {Map} [areaCodes] - Area codes Map (code -> { ja, kana, en })
 * @returns {{ ja: string, kana: string, en: string, code: number|null }}
 */
function resolveHypocenterNames(name, areaCodes) {
  if (!name) {
    return { ja: '不明', kana: 'ふめい', en: 'Unknown', code: null };
  }

  if (areaCodes && areaCodes.size > 0) {
    for (const [code, entry] of areaCodes.entries()) {
      if (entry.ja === name) {
        return {
          ja: entry.ja,
          kana: entry.kana || 'ふめい',
          en: entry.en || name || 'Unknown',
          code: code,
        };
      }
    }
  }

  return {
    ja: name,
    kana: 'ふめい',
    en: name || 'Unknown',
    code: null,
  };
}

/**
 * Builds a base report object from an EQDB search result event.
 * Contains lightweight fields needed for the sidebar entry display without
 * fetching and parsing full observation/geometry data.
 *
 * @param {Object} event - Search result item from EQDB API
 * @param {Map} [areaCodes] - Area code mappings
 * @returns {Object} Base report object
 */
export function buildHistoryBaseReport(event, areaCodes = new Map()) {
  const names = resolveHypocenterNames(event?.name, areaCodes);

  let originTime = null;
  if (event?.ot) {
    const isoFormatted = event.ot.replaceAll('/', '-').replace(' ', 'T') + '+09:00';
    const ms = Date.parse(isoFormatted);
    if (!Number.isNaN(ms)) {
      originTime = Math.floor(ms / 1000);
    }
  }

  const magNum = event?.mag != null && event?.mag !== '' ? Number.parseFloat(event.mag) : null;
  const magnitude = (magNum !== null && !Number.isNaN(magNum)) ? magNum : null;

  const latStr = event?.lat != null && event?.lat !== '' ? String(event.lat) : null;
  const lonStr = event?.lon != null && event?.lon !== '' ? String(event.lon) : null;
  const lat = latStr !== null ? Number.parseFloat(latStr) : null;
  const lon = lonStr !== null ? Number.parseFloat(lonStr) : null;
  const latDec = latStr && latStr.includes('.') ? latStr.split('.')[1].length : 0;
  const lonDec = lonStr && lonStr.includes('.') ? lonStr.split('.')[1].length : 0;
  const accuracy = (latDec || lonDec) ? Math.max(latDec, lonDec) : 3;
  const coordinates = (lat !== null && lon !== null && !Number.isNaN(lat) && !Number.isNaN(lon))
    ? { latitude: lat, longitude: lon, accuracy }
    : null;

  const depthMatch = event?.dep ? /(\d+)/.exec(String(event.dep)) : null;
  const depth = depthMatch ? Number.parseInt(depthMatch[1], 10) : null;

  return {
    eventId: event?.id,
    originTime,
    magnitude,
    maxIntensity: formatIntensity(event?.maxI),
    hypocenterCode: names.code,
    hypocenterJa: names.ja,
    hypocenterKana: names.kana,
    hypocenterEn: names.en,
    coordinates,
    depth,
    observations: null,
    isHistory: true,
    isBaseReport: true,
    isFullReport: false,
    rawEvent: event,
  };
}

// ─── Cache of full reports (LRU) ─────────────────────────────────────────────

const MAX_HISTORY_REPORT_CACHE = 50;
const _fullReportCache = new Map();
const _inFlightPromises = new Map();

function _cacheFullReport(eventId, fullReport) {
  if (_fullReportCache.has(eventId)) {
    _fullReportCache.delete(eventId);
  } else if (_fullReportCache.size >= MAX_HISTORY_REPORT_CACHE) {
    const oldestKey = _fullReportCache.keys().next().value;
    _fullReportCache.delete(oldestKey);
  }
  _fullReportCache.set(eventId, fullReport);
}

/**
 * Clears the in-memory cache of full history reports.
 */
export function clearHistoryReportCache() {
  _fullReportCache.clear();
  _inFlightPromises.clear();
}

/**
 * Fetches and builds the full report for a single event ID or base report.
 * Results are cached in memory to avoid redundant network and geo calculations.
 *
 * @param {string|Object} eventOrId - Event ID string or base report object
 * @param {Map} [areaCodes] - Area code name mappings
 * @returns {Promise<Object|null>} Display-ready full report object or null
 */
export async function fetchHistoryReport(eventOrId, areaCodes = new Map()) {
  const eventId = typeof eventOrId === 'string'
    ? eventOrId
    : (eventOrId?.eventId || eventOrId?.id);

  if (!eventId) return null;

  if (typeof eventOrId === 'object' && eventOrId?.observations && !eventOrId?.isBaseReport) {
    return eventOrId;
  }

  if (_fullReportCache.has(eventId)) {
    const cached = _fullReportCache.get(eventId);
    _fullReportCache.delete(eventId);
    _fullReportCache.set(eventId, cached);
    return cached;
  }

  if (_inFlightPromises.has(eventId)) {
    return _inFlightPromises.get(eventId);
  }

  const promise = (async () => {
    try {
      const fallbackName = typeof eventOrId === 'object'
        ? (eventOrId.hypocenterJa || eventOrId.name || null)
        : null;

      const geoData = await loadGeoData();
      const reportJson = await fetchEqdbEvent(
        eventId,
        geoData.bounds,
        geoData,
      );

      if (!reportJson) return null;

      const jmaReport = parseReport(reportJson);
      const fullReport = buildDisplayReport(jmaReport, areaCodes, {
        fallbackName,
        isHistory: true,
      });

      fullReport.isFullReport = true;
      fullReport.isBaseReport = false;
      _cacheFullReport(eventId, fullReport);
      return fullReport;
    } catch (err) {
      console.error(`[history] Failed to fetch and build report for ${eventId}:`, err);
      return null;
    } finally {
      _inFlightPromises.delete(eventId);
    }
  })();

  _inFlightPromises.set(eventId, promise);
  return promise;
}

/**
 * Loads base information needed for sidebar display for each search result item.
 * Slices the event list and builds lightweight base reports without fetching
 * or building the whole report for each event.
 *
 * @param {Object} searchParams - Search parameters (dateFrom, dateTo, magMin, magMax, depMin, depMax, maxInt, sort)
 * @param {Map} areaCodes - Area code name mappings
 * @param {Object} options
 * @param {number} [options.limit=50] - Number of events to process
 * @param {number} [options.offset=0] - Offset into the event list
 * @param {Function} [options.onReportFetched] - Callback(report) called for each report
 * @param {Function} [options.onProgress] - Callback(processed, total) for progress
 * @param {Array} [options.cachedEventList] - Pre-fetched event list
 * @returns {Promise<{reports: Array, totalEvents: number, eventList: Array}>}
 */
export async function fetchHistoryReports(searchParams, areaCodes = new Map(), options = {}) {
  const { limit = 50, offset = 0, onReportFetched = null, onProgress = null, cachedEventList = null } = options;
  const reports = [];

  try {
    const eventList = cachedEventList || await fetchHistoryList(searchParams);

    if (!eventList || eventList.length === 0) {
      return { reports, totalEvents: 0, eventList: [] };
    }

    const eventsToProcess = eventList.slice(offset, offset + limit);
    const totalToProcess = eventsToProcess.length;

    if (onProgress) onProgress(0, totalToProcess);

    for (let i = 0; i < eventsToProcess.length; i++) {
      const event = eventsToProcess[i];
      const baseReport = buildHistoryBaseReport(event, areaCodes);
      reports.push(baseReport);
      if (onReportFetched) onReportFetched(baseReport);
      if (onProgress) onProgress(i + 1, totalToProcess);
    }

    return { reports, totalEvents: eventList.length, eventList };
  } catch (err) {
    console.error('[history] Failed to fetch history reports:', err);
    return { reports, totalEvents: 0, eventList: [] };
  }
}

/**
 * Fetches only the event list from the EQDB API (for pagination).
 * @param {Object} searchParams - Search parameters
 * @returns {Promise<Array>} Array of event objects
 */
export async function fetchHistoryEventList(searchParams) {
  return fetchHistoryList(searchParams);
}

/**
 * Returns the formatted date string for display in the history tab header.
 * @returns {string} Date 1 year ago in YYYY/MM/DD format
 */
export function getHistoryDateDisplay() {
  const dateStr = getDateOneYearAgo();
  return dateStr.replaceAll('-', '/');
}
