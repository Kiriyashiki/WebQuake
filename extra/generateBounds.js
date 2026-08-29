const fs = require('node:fs');

const forecast = JSON.parse(fs.readFileSync('public/forecast_areas.geojson'));
const cities = JSON.parse(fs.readFileSync('public/municipalities.geojson'));

const bounds = {
  forecast: {},
  cities: {}
};

function getBounds(feature) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const updateBounds = (coord) => {
    if (typeof coord[0] === 'number') {
      if (coord[0] < minLng) minLng = coord[0];
      if (coord[1] < minLat) minLat = coord[1];
      if (coord[0] > maxLng) maxLng = coord[0];
      if (coord[1] > maxLat) maxLat = coord[1];
    } else {
      for (const c of coord) updateBounds(c);
    }
  };
  if (feature.geometry) {
    updateBounds(feature.geometry.coordinates);
  }
  return [
    Math.round(minLng * 1000) / 1000,
    Math.round(minLat * 1000) / 1000,
    Math.round(maxLng * 1000) / 1000,
    Math.round(maxLat * 1000) / 1000
  ];
}

for (const feature of forecast.features) {
  bounds.forecast[feature.properties.code] = getBounds(feature);
}

for (const feature of cities.features) {
  bounds.cities[feature.properties.regioncode] = getBounds(feature);
}

fs.writeFileSync('public/bounds.json', JSON.stringify(bounds));
console.log('Generated bounds.json, size:', fs.statSync('public/bounds.json').size);
