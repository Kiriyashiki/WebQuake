import { EQDB_API_URL, haversineDistance } from './constants.js';
import { loadAreaCodesRawCsv, loadBoundsData, loadCityForecastMapCsv } from './areaCodes.js';
import { parseReport, buildDisplayReport } from './reportUtils.js';

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
 * @param {Object} forecastAreas - Pre-loaded forecast_areas.geojson
 * @param {Object} municipalities - Pre-loaded municipalities.geojson
 * @param {string} areaCodesCsv - Pre-loaded jma-area-codes.csv content
 * @returns {Promise<Object|null>} Report JSON or null on failure
 */
async function fetchEqdbEvent(eventId, boundsData, forecastAreas, municipalities, areaCodesCsv, cityForecastCsv) {
  try {
    const boundary = '----bound';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nevent\r\n--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${eventId}\r\n--${boundary}--\r\n`;

    const response = await fetch(EQDB_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: body
    });

    const eqdbData = await response.json();

    if (!eqdbData.res?.hyp?.[0]) {
      console.warn(`[history] No hyp data for event ${eventId}`);
      return null;
    }

    const hyp = eqdbData.res.hyp[0];
    const observations = eqdbData.res.int || [];

    // Parse the hypocenter CSV into a Map
    const hypocenterCodeMap = new Map();
    areaCodesCsv.split('\n').forEach(line => {
      const parts = line.split(';');
      if (parts.length >= 2) {
        hypocenterCodeMap.set(parts[1].trim(), parts[0].trim());
      }
    });
    const resolvedHypocenterCode = hypocenterCodeMap.get(hyp.name) || null;

    // Parse the city to forecast area mapping
    const cityToAreaMap = new Map();
    if (cityForecastCsv) {
      cityForecastCsv.split('\n').forEach(line => {
        const parts = line.split(',');
        if (parts.length >= 2) {
          cityToAreaMap.set(parts[0].trim(), parts[1].trim());
        }
      });
    }

    // Map forecast area names for quick lookup
    const forecastAreaNames = new Map();
    for (const feature of forecastAreas.features) {
      if (feature.properties?.code) {
        forecastAreaNames.set(feature.properties.code, feature.properties.name);
      }
    }

    // Map municipalities for quick O(1) lookup by regioncode
    const cityPolygons = new Map();
    for (const feature of municipalities.features) {
      if (feature.properties?.regioncode) {
        cityPolygons.set(feature.properties.regioncode.toString(), feature);
      }
    }

    // Simple point-in-polygon using ray casting 
    function pointInPolygon(point, polygon) {
      const [px, py] = point;

      function checkRing(ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const xi = ring[i][0], yi = ring[i][1];
          const xj = ring[j][0], yj = ring[j][1];
          const intersect = ((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
          if (intersect) inside = !inside;
        }
        return inside;
      }

      const coords = polygon.geometry.coordinates;
      if (polygon.geometry.type === 'Polygon') {
        // First ring is outer, rest are holes
        let inside = checkRing(coords[0]);
        for (let i = 1; i < coords.length; i++) {
          if (checkRing(coords[i])) inside = !inside;
        }
        return inside;
      } else if (polygon.geometry.type === 'MultiPolygon') {
        for (const poly of coords) {
          let inside = checkRing(poly[0]);
          for (let i = 1; i < poly.length; i++) {
            if (checkRing(poly[i])) inside = !inside;
          }
          if (inside) return true;
        }
        return false;
      }
      return false;
    }

    // Create observation point features
    const stationPoints = observations.map(obs => ({
      lon: Number.parseFloat(obs.lon),
      lat: Number.parseFloat(obs.lat),
      int: formatIntensity(obs.int),
      matched: false
    }));

    // Process Cities, Areas, and Prefectures
    const prefMap = new Map();

    for (const [cityCode, bbox] of Object.entries(boundsData.cities)) {
      const [minLon, minLat, maxLon, maxLat] = bbox;

      // STEP A: Fast Bounding Box Filter
      const candidatesInBounds = stationPoints.filter(s =>
        s.lon >= minLon && s.lon <= maxLon && s.lat >= minLat && s.lat <= maxLat
      );

      // STEP B: Precise Point-in-Polygon Filter
      let cityInt = null;
      let validStations = null;
      const cityFeature = cityPolygons.get(cityCode);

      if (cityFeature && candidatesInBounds.length > 0) {
        validStations = candidatesInBounds.filter(station => {
          if (station.matched) return false;
          if (pointInPolygon([station.lon, station.lat], cityFeature)) {
            station.matched = true;
            return true;
          }
          return false;
        });

        const ints = validStations.map(s => s.int);
        cityInt = getMaxInt(ints);
      }

      if (!cityInt) continue;

      // STEP C: Assign to Forecast Area
      const areaCode = cityToAreaMap.get(cityCode) || 'UNKNOWN_AREA';
      const areaName = forecastAreaNames.get(areaCode) || null;

      // Pref code is first 2 digits of city code
      const prefCode = cityCode.substring(0, 2);

      if (!prefMap.has(prefCode)) {
        prefMap.set(prefCode, { code: prefCode, name: null, areas: new Map() });
      }
      const prefData = prefMap.get(prefCode);

      if (!prefData.areas.has(areaCode)) {
        prefData.areas.set(areaCode, { code: areaCode, name: areaName, cities: [] });
      }
      const areaData = prefData.areas.get(areaCode);

      areaData.cities.push({
        Code: cityCode,
        Name: null,
        MaxInt: cityInt
      });
    }

    // STEP D: Fallback for unmatched stations (e.g. just off the coast)
    const unmatchedStations = stationPoints.filter(s => !s.matched);
    if (unmatchedStations.length > 0) {
      for (const station of unmatchedStations) {
        if (!station.int) continue;
        
        let bestCityCode = null;
        let minDistance = 10; // Max 10km search radius

        const searchRadiusDeg = 0.1; // ~11km roughly
        for (const [cityCode, bbox] of Object.entries(boundsData.cities)) {
          const [minLon, minLat, maxLon, maxLat] = bbox;
          if (station.lon >= minLon - searchRadiusDeg && station.lon <= maxLon + searchRadiusDeg &&
              station.lat >= minLat - searchRadiusDeg && station.lat <= maxLat + searchRadiusDeg) {
            
            const cityFeature = cityPolygons.get(cityCode);
            if (!cityFeature) continue;

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

            if (cityMinDist < minDistance) {
              minDistance = cityMinDist;
              bestCityCode = cityCode;
            }
          }
        }

        if (bestCityCode) {
          station.matched = true;
          const prefCode = bestCityCode.substring(0, 2);
          
          let existingCityEntry = null;
          let existingPrefData = prefMap.get(prefCode);
          if (existingPrefData) {
            for (const aData of existingPrefData.areas.values()) {
              const cEntry = aData.cities.find(c => c.Code === bestCityCode);
              if (cEntry) {
                existingCityEntry = cEntry;
                break;
              }
            }
          }

          if (existingCityEntry) {
            existingCityEntry.MaxInt = getMaxInt([existingCityEntry.MaxInt, station.int]);
          } else {
            const areaCode = cityToAreaMap.get(bestCityCode) || 'UNKNOWN_AREA';
            const areaName = forecastAreaNames.get(areaCode) || null;

            if (!prefMap.has(prefCode)) {
              prefMap.set(prefCode, { code: prefCode, name: null, areas: new Map() });
            }
            const prefData = prefMap.get(prefCode);

            if (!prefData.areas.has(areaCode)) {
              prefData.areas.set(areaCode, { code: areaCode, name: areaName, cities: [] });
            }
            const areaData = prefData.areas.get(areaCode);

            areaData.cities.push({
              Code: bestCityCode,
              Name: null,
              MaxInt: station.int
            });
          }
        }
      }
    }

    // Structure the Nested Observation Array and calculate MaxInts
    const prefArray = Array.from(prefMap.values()).map(prefData => {
      const formattedAreas = Array.from(prefData.areas.values()).map(area => {
        const areaMaxInt = getMaxInt(area.cities.map(c => c.MaxInt));
        return {
          Code: area.code,
          Name: area.name,
          MaxInt: areaMaxInt,
          City: area.cities
        };
      });

      const prefMaxInt = getMaxInt(formattedAreas.map(a => a.MaxInt));
      return {
        Code: prefData.code,
        Name: prefData.name,
        MaxInt: prefMaxInt,
        Area: formattedAreas
      };
    });

    // Assemble Final JSON (same format as generateEqdbReport.js)
    const finalReport = {
      Head: {
        EventID: hyp.id
      },
      Body: {
        Earthquake: {
          OriginTime: formatOriginTime(hyp.ot),
          Magnitude: hyp.mag,
          Hypocenter: {
            Area: {
              Code: resolvedHypocenterCode,
              Coordinate: formatCoordinates(hyp.lat, hyp.lon, hyp.dep)
            }
          }
        },
        Intensity: {
          Observation: {
            MaxInt: formatIntensity(hyp.maxI),
            Pref: prefArray
          }
        }
      }
    };

    return finalReport;

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

  const [bounds, forecastRes, muniRes, areaCodesCsv, cityForecastCsv] = await Promise.all([
    loadBoundsData(),
    fetch('/forecast_areas.geojson'),
    fetch('/municipalities.geojson'),
    loadAreaCodesRawCsv(),
    loadCityForecastMapCsv()
  ]);

  _geoDataCache = {
    bounds,
    forecastAreas: await forecastRes.json(),
    municipalities: await muniRes.json(),
    areaCodesCsv,
    cityForecastCsv,
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

  const lat = event?.lat != null && event?.lat !== '' ? Number.parseFloat(event.lat) : null;
  const lon = event?.lon != null && event?.lon !== '' ? Number.parseFloat(event.lon) : null;
  const coordinates = (lat !== null && lon !== null && !Number.isNaN(lat) && !Number.isNaN(lon))
    ? { latitude: lat, longitude: lon }
    : null;

  const depthMatch = event?.dep ? String(event.dep).match(/(\d+)/) : null;
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

// ─── Cache of full reports ───────────────────────────────────────────────────

const _fullReportCache = new Map();
const _inFlightPromises = new Map();

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
    return _fullReportCache.get(eventId);
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
        geoData.forecastAreas,
        geoData.municipalities,
        geoData.areaCodesCsv,
        geoData.cityForecastCsv
      );

      if (!reportJson) return null;

      const jmaReport = parseReport(reportJson);
      const fullReport = buildDisplayReport(jmaReport, areaCodes, {
        fallbackName,
        isHistory: true,
      });

      fullReport.isFullReport = true;
      fullReport.isBaseReport = false;
      _fullReportCache.set(eventId, fullReport);
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
