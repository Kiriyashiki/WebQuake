import { EQDB_API_URL } from './constants.js';
import JMAEarthquakeReport from './jmaEarthquakeReport.js';

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

// ─── EQDB API functions ──────────────────────────────────────────────────────

/**
 * Fetches the list of earthquake events from 1 year ago today via the EQDB API.
 * @returns {Promise<Array>} Array of event objects with { id, ot, name, ... }
 */
async function fetchHistoryList() {
  const dateStr = getDateOneYearAgo();
  const boundary = '----bound';

  const fields = [
    { name: 'mode', value: 'search' },
    { name: 'dateTimeF[]', value: dateStr },
    { name: 'dateTimeF[]', value: '00:00' },
    { name: 'dateTimeT[]', value: dateStr },
    { name: 'dateTimeT[]', value: '23:59' },
    { name: 'mag[]', value: '0.0' },
    { name: 'mag[]', value: '9.9' },
    { name: 'dep[]', value: '000' },
    { name: 'dep[]', value: '999' },
    { name: 'epi[]', value: '99' },
    { name: 'pref[]', value: '99' },
    { name: 'city[]', value: '99' },
    { name: 'station[]', value: '99' },
    { name: 'obsInt', value: '1' },
    { name: 'maxInt', value: '1' },
    { name: 'additionalC', value: 'false' },
    { name: 'Sort', value: 'S0' },
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

    // Create observation point features
    const stationPoints = observations.map(obs => ({
      lon: Number.parseFloat(obs.lon),
      lat: Number.parseFloat(obs.lat),
      int: formatIntensity(obs.int)
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
        validStations = candidatesInBounds.filter(station =>
          pointInPolygon([station.lon, station.lat], cityFeature)
        );

        const ints = validStations.map(s => s.int);
        cityInt = getMaxInt(ints);
      }

      if (!cityInt) continue;

      // STEP C: Assign to Forecast Area
      const representativePoint = [validStations[0].lon, validStations[0].lat];

      let areaCode = null;
      let areaName = null;
      for (const feature of forecastAreas.features) {
        if (pointInPolygon(representativePoint, feature)) {
          areaCode = feature.properties.code;
          areaName = feature.properties.name || null;
          break;
        }
      }

      // Fallback: use centroid of city polygon bounding box
      if (!areaCode && cityFeature) {
        const [cMinLon, cMinLat, cMaxLon, cMaxLat] = bbox;
        const centroid = [(cMinLon + cMaxLon) / 2, (cMinLat + cMaxLat) / 2];
        for (const feature of forecastAreas.features) {
          if (pointInPolygon(centroid, feature)) {
            areaCode = feature.properties.code;
            areaName = feature.properties.name || null;
            break;
          }
        }
      }

      if (!areaCode) areaCode = 'UNKNOWN_AREA';

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

  const [boundsRes, forecastRes, muniRes, csvRes] = await Promise.all([
    fetch('/bounds.json'),
    fetch('/forecast_areas.geojson'),
    fetch('/municipalities.geojson'),
    fetch('/jma-area-codes.csv'),
  ]);

  _geoDataCache = {
    bounds: await boundsRes.json(),
    forecastAreas: await forecastRes.json(),
    municipalities: await muniRes.json(),
    areaCodesCsv: await csvRes.text(),
  };

  return _geoDataCache;
}

/**
 * Fetches history entries for 1 year ago today and builds full reports.
 * Each report is converted to the same display-ready format used by live mode.
 *
 * @param {Map} areaCodes - Area code name mappings
 * @param {Function} onReportFetched - Callback(report) called for each report
 * @param {Function} onProgress - Callback(processed, total) for progress
 * @returns {Promise<Array>} Array of display-ready report objects
 */
export async function fetchHistoryReports(areaCodes = new Map(), onReportFetched = null, onProgress = null) {
  const reports = [];

  try {
    // 1. Fetch the list of events
    const eventList = await fetchHistoryList();

    if (eventList.length === 0) {
      return reports;
    }

    const totalCount = eventList.length;
    let processedCount = 0;

    if (onProgress) onProgress(0, totalCount);

    // 2. Load geo data for report building
    const geoData = await loadGeoData();

    // 3. Process events in batches (max 2 concurrent to be polite to API)
    for (let i = 0; i < eventList.length; i += 2) {
      const batch = eventList.slice(i, i + 2);
      const batchPromises = batch.map(async (event) => {
        const reportJson = await fetchEqdbEvent(
          event.id,
          geoData.bounds,
          geoData.forecastAreas,
          geoData.municipalities,
          geoData.areaCodesCsv,
        );

        if (!reportJson) return null;

        // Parse through JMAEarthquakeReport.fromJSON to get canonical format
        const jmaReport = JMAEarthquakeReport.fromJSON(reportJson);

        // Build display-ready report object (same format as parseReports.js)
        const hypocenterCodeEntry = areaCodes.get(jmaReport.hypocenterCode) || {};
        const hypocenterJa = hypocenterCodeEntry.ja || event.name || '不明';
        const hypocenterKana = hypocenterCodeEntry.kana || 'ふめい';
        const hypocenterEn = hypocenterCodeEntry.en || 'Unknown';

        return {
          eventId: jmaReport.eventId,
          originTime: jmaReport.originTime,
          magnitude: jmaReport.magnitude,
          maxIntensity: jmaReport.maxIntensity,
          hypocenterCode: jmaReport.hypocenterCode,
          hypocenterJa,
          hypocenterKana,
          hypocenterEn,
          coordinates: jmaReport.coordinates,
          depth: jmaReport.depth,
          observations: jmaReport.observations,
          jmaReport,
          isHistory: true,
        };
      });

      const batchResults = await Promise.all(batchPromises);

      for (const report of batchResults) {
        processedCount++;
        if (report) {
          reports.push(report);
          if (onReportFetched) onReportFetched(report);
        }
        if (onProgress) onProgress(processedCount, totalCount);
      }
    }
  } catch (err) {
    console.error('[history] Failed to fetch history reports:', err);
  }

  // Sort by origin time, newest first
  reports.sort((a, b) => (b.originTime || 0) - (a.originTime || 0));
  return reports;
}

/**
 * Returns the formatted date string for display in the history tab header.
 * @returns {string} Date 1 year ago in YYYY/MM/DD format
 */
export function getHistoryDateDisplay() {
  const dateStr = getDateOneYearAgo();
  return dateStr.replaceAll('-', '/');
}
