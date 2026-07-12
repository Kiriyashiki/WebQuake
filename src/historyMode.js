import { EQDB_API_URL } from './constants.js';
import { loadAreaCodesRawCsv, loadBoundsData } from './areaCodes.js';
import { parseReport, buildDisplayReport } from './reportUtils.js';

// ─── Utility functions (from generateEqdbReport.js) ─────────────────────────

function formatIntensity(rawInt) {
  if (!rawInt) return null;
  let val = rawInt.replace('震度', '');
  const map = {
    '５弱': '5-',
    '５強': '5+',
    '６弱': '6-',
    '６強': '6+',
    '１': '1',
    '２': '2',
    '３': '3',
    '４': '4',
    '７': '7'
  };
  return map[val] || val;
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
      const oneYearAgo = getDateOneYearAgo();
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
        dateFrom: '2004-01-01',
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
        dateFrom: '2004-01-01',
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
  const boundary = '----bound';

  const fields = [
    { name: 'mode', value: 'search' },
    { name: 'dateTimeF[]', value: params.dateFrom },
    { name: 'dateTimeF[]', value: '00:00' },
    { name: 'dateTimeT[]', value: params.dateTo },
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
async function fetchEqdbEvent(eventId, boundsData, forecastAreas, municipalities, areaCodesCsv) {
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

    function haversineDistance(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }

    function findForecastArea(point, cityBbox) {
      for (const feature of forecastAreas.features) {
        if (feature.geometry === null) { continue; }
        if (pointInPolygon(point, feature)) {
          return { code: feature.properties.code, name: feature.properties.name || null };
        }
      }
      if (cityBbox) {
        const [cMinLon, cMinLat, cMaxLon, cMaxLat] = cityBbox;
        const centroid = [(cMinLon + cMaxLon) / 2, (cMinLat + cMaxLat) / 2];
        for (const feature of forecastAreas.features) {
          if (feature.geometry === null) { continue; }
          if (pointInPolygon(centroid, feature)) {
            return { code: feature.properties.code, name: feature.properties.name || null };
          }
        }
      }
      let bestCode = null;
      let bestName = null;
      let minAreaDist = Infinity;
      for (const feature of forecastAreas.features) {
        if (feature.geometry === null) { continue; }
        const coords = feature.geometry.coordinates;
        const processAreaRing = (ring) => {
          for (const [lon, lat] of ring) {
            const dist = haversineDistance(point[1], point[0], lat, lon);
            if (dist < minAreaDist) {
              minAreaDist = dist;
              bestCode = feature.properties.code;
              bestName = feature.properties.name || null;
            }
          }
        };
        if (feature.geometry.type === 'Polygon') {
          for (const ring of coords) processAreaRing(ring);
        } else if (feature.geometry.type === 'MultiPolygon') {
          for (const poly of coords) {
            for (const ring of poly) processAreaRing(ring);
          }
        }
      }
      return { code: bestCode || 'UNKNOWN_AREA', name: bestName };
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
      const representativePoint = [validStations[0].lon, validStations[0].lat];
      const bestArea = findForecastArea(representativePoint, bbox);
      const areaCode = bestArea.code;
      const areaName = bestArea.name;

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
            const bestArea = findForecastArea([station.lon, station.lat], boundsData.cities[bestCityCode]);
            const areaCode = bestArea.code;
            const areaName = bestArea.name;

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

async function loadGeoData() {
  if (_geoDataCache) return _geoDataCache;

  const [bounds, forecastRes, muniRes, areaCodesCsv] = await Promise.all([
    loadBoundsData(),
    fetch('/forecast_areas.geojson'),
    fetch('/municipalities.geojson'),
    loadAreaCodesRawCsv(),
  ]);

  _geoDataCache = {
    bounds,
    forecastAreas: await forecastRes.json(),
    municipalities: await muniRes.json(),
    areaCodesCsv,
  };

  return _geoDataCache;
}

/**
 * Fetches history event list and builds full reports in batches.
 *
 * @param {Object} searchParams - Search parameters (dateFrom, dateTo, magMin, magMax, depMin, depMax, maxInt, sort)
 * @param {Map} areaCodes - Area code name mappings
 * @param {Object} options
 * @param {number} [options.limit=50] - Number of events to process
 * @param {number} [options.offset=0] - Offset into the event list
 * @param {Function} [options.onReportFetched] - Callback(report) called for each report
 * @param {Function} [options.onProgress] - Callback(processed, total) for progress
 * @returns {Promise<{reports: Array, totalEvents: number, eventList: Array}>}
 */
export async function fetchHistoryReports(searchParams, areaCodes = new Map(), options = {}) {
  const { limit = 50, offset = 0, onReportFetched = null, onProgress = null, cachedEventList = null } = options;
  const reports = [];

  try {
    // 1. Fetch the list of events (or use cached list)
    const eventList = cachedEventList || await fetchHistoryList(searchParams);

    if (eventList.length === 0) {
      return { reports, totalEvents: 0, eventList };
    }

    // Slice for pagination
    const eventsToProcess = eventList.slice(offset, offset + limit);
    const totalToProcess = eventsToProcess.length;
    let processedCount = 0;

    if (onProgress) onProgress(0, totalToProcess);

    // 2. Load geo data for report building
    const geoData = await loadGeoData();

    // 3. Process events in batches (max 2 concurrent to be polite to API)
    for (let i = 0; i < eventsToProcess.length; i += 2) {
      const batch = eventsToProcess.slice(i, i + 2);
      const batchPromises = batch.map(async (event) => {
        const reportJson = await fetchEqdbEvent(
          event.id,
          geoData.bounds,
          geoData.forecastAreas,
          geoData.municipalities,
          geoData.areaCodesCsv,
        );

        if (!reportJson) return null;

        const jmaReport = parseReport(reportJson);

        return buildDisplayReport(jmaReport, areaCodes, {
          fallbackName: event.name,
          isHistory: true,
        });
      });

      const batchResults = await Promise.all(batchPromises);

      for (const report of batchResults) {
        processedCount++;
        if (report) {
          reports.push(report);
          if (onReportFetched) onReportFetched(report);
        }
        if (onProgress) onProgress(processedCount, totalToProcess);
      }
    }
  } catch (err) {
    console.error('[history] Failed to fetch history reports:', err);
  }

  // The API already returns entries sorted by the specified sort mode,
  // so we preserve that order.
  return { reports, totalEvents: (options.cachedEventList || []).length, eventList: options.cachedEventList || [] };
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
