const fs = require('node:fs');
const turf = require('@turf/turf');

const forecast = JSON.parse(fs.readFileSync('../public/forecast_areas.geojson'));
const cities = JSON.parse(fs.readFileSync('../public/municipalities.geojson'));

let csvContent = 'cityCode,areaCode\n';

for (const feature of cities.features) {
  const cityCode = feature.properties.regioncode;
  if (!feature.geometry?.coordinates || feature.geometry.coordinates.length === 0 || !cityCode) continue;
  
  // turf.pointOnFeature returns a point inside the polygon
  const pt = turf.pointOnFeature(feature);

  let bestAreaCode = null;
  
  // Use turf.booleanPointInPolygon to find the forecast area
  for (const area of forecast.features) {
    if (!area.geometry) continue;
    if (turf.booleanPointInPolygon(pt, area)) {
      bestAreaCode = area.properties.code;
      break;
    }
  }

  // Fallback if not strictly inside due to boundary precision
  if (!bestAreaCode) {
    // We will use a distance fallback
    let minAreaDist = Infinity;
    
    // Custom distance logic similar to historyMode.js for distance
    const pointCoords = pt.geometry.coordinates;
    const px = pointCoords[0];
    const py = pointCoords[1];
    
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

    for (const area of forecast.features) {
      if (!area.geometry) continue;
      const coords = area.geometry.coordinates;
      
      const processAreaRing = (ring) => {
        for (const [lon, lat] of ring) {
          const dist = haversineDistance(py, px, lat, lon);
          if (dist < minAreaDist) {
            minAreaDist = dist;
            bestAreaCode = area.properties.code;
          }
        }
      };
      
      if (area.geometry.type === 'Polygon') {
        for (const ring of coords) processAreaRing(ring);
      } else if (area.geometry.type === 'MultiPolygon') {
        for (const poly of coords) {
          for (const ring of poly) processAreaRing(ring);
        }
      }
    }
  }

  if (bestAreaCode) {
    csvContent += `${cityCode},${bestAreaCode}\n`;
  }
}

fs.writeFileSync('../public/city_forecast_map.csv', csvContent);
console.log('Successfully generated city_forecast_map.csv in public/ directory.');
