import fs from 'node:fs/promises';
import * as turf from '@turf/turf';

// ─── UTILITY FUNCTIONS ────────────────────────────────────────────────────────

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

// ─── MAIN GENERATOR ──────────────────────────────────────────────────────────

async function generateReport(eventId) {
  try {
    // 1. Fetch EQDB Data
    const boundary = '----bound';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nevent\r\n--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${eventId}\r\n--${boundary}--\r\n`;

    const response = await fetch('https://www.data.jma.go.jp/eqdb/data/shindo/api/', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: body
    });

    const eqdbData = await response.json();
    const hyp = eqdbData.res.hyp[0];
    const observations = eqdbData.res.int;

    // 2. Load Local Geographical Data
    const boundsData = JSON.parse(await fs.readFile('../public/bounds.json', 'utf-8'));
    const forecastAreas = JSON.parse(await fs.readFile('../public/forecast_areas.geojson', 'utf-8'));
    const municipalities = JSON.parse(await fs.readFile('../public/municipalities.geojson', 'utf-8'));
    const areaCodesCsv = await fs.readFile('../public/jma-area-codes.csv', 'utf-8');

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

    // 3. Create Turf Feature Collection for EQDB observation points
    const stationFeatures = observations.map(obs => {
      return turf.point([Number.parseFloat(obs.lon), Number.parseFloat(obs.lat)], {
        int: formatIntensity(obs.int)
      });
    });

    // 4. Process Cities, Areas, and Prefectures
    const prefMap = new Map(); 

    for (const [cityCode, bbox] of Object.entries(boundsData.cities)) {
      const minLon = bbox[0], minLat = bbox[1], maxLon = bbox[2], maxLat = bbox[3];
      
      // -- STEP A: Fast Bounding Box Filter --
      const candidatesInBounds = stationFeatures.filter(f => {
        const [lon, lat] = f.geometry.coordinates;
        return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
      });

      // -- STEP B: Precise Point-in-Polygon Filter --
      let cityInt = null;
      let validStations = null;
      const cityFeature = cityPolygons.get(cityCode);
      
      if (cityFeature && candidatesInBounds.length > 0) {
          validStations = candidatesInBounds.filter(station => 
          turf.booleanPointInPolygon(station, cityFeature)
        );
        
        // Extract intensities from stations inside the precise boundary
        const ints = validStations.map(s => s.properties.int);
        cityInt = getMaxInt(ints);
      }

      // If no stations recorded an intensity in this city polygon, skip adding it to the report
      if (!cityInt) continue;

      // -- STEP C: Assign to Forecast Area --
      // We use the exact location of the first valid station we found inside this city.
      const representativePoint = validStations[0]; 

      let areaCode = null;
      let areaName = null;
      for (const feature of forecastAreas.features) {
        // Check if our station point falls inside the forecast area
        if (turf.booleanPointInPolygon(representativePoint, feature)) {
          areaCode = feature.properties.code;
          areaName = feature.properties.name || null;
          break;
        }
      }

      // Fallback just in case a station point sits slightly outside a generalized polygon border
      if (!areaCode) {
        const guaranteedLandPoint = turf.pointOnFeature(cityFeature);
        for (const feature of forecastAreas.features) {
          if (turf.booleanPointInPolygon(guaranteedLandPoint, feature)) {
            areaCode = feature.properties.code;
            areaName = feature.properties.name || null;
            break;
          }
        }
      }

      if (!areaCode) areaCode = 'UNKNOWN_AREA';

      // Pref code is first 2 digits of city code
      const prefCode = cityCode.substring(0, 2);

      // Build nested hierarchy maps
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

    // 5. Structure the Nested Observation Array and calculate MaxInts
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

    // 6. Assemble Final JSON
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

    // 7. Output result
    await fs.writeFile(`${eventId}_report.json`, JSON.stringify(finalReport, null, 2));
    console.log(`✅ Successfully generated report for ${eventId}`);

  } catch (error) {
    console.error('Failed to generate report:', error);
  }
}

// Execute
const targetEventIds = ['20240808164255', '20240417231448', '20180618075834', '20161021140722'];
for (let i of targetEventIds){
  generateReport(i);
}
