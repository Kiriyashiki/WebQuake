const fs = require('fs');
const turf = require('@turf/turf');

// ---------- Load data ----------
const stations = JSON.parse(fs.readFileSync('extra/stations.json', 'utf-8'));
const prefectures = JSON.parse(fs.readFileSync('public/prefectures.geojson', 'utf-8'));

console.log(`Loaded ${stations.length} stations and ${prefectures.features.length} prefecture features`);

// ---------- Build station points ----------
const points = stations.map((s) => {
  const lat = Number(s.lat);
  const lon = Number(s.lon);
  return turf.point([lon, lat], {
    staLat: lat,
    staLon: lon,
    name: s.name,
    pref: s.pref,
    affi: s.affi,
  });
});

const pointCollection = turf.featureCollection(points);

// ---------- Compute bounding box from prefectures ----------
const bbox = turf.bbox(prefectures);
console.log(`Japan bounding box: [${bbox}]`);

// ---------- Compute Voronoi ----------
console.log('Computing Voronoi diagram...');
const voronoi = turf.voronoi(pointCollection, { bbox });

// Filter out any null cells (can happen with duplicate points)
const voronoiCells = voronoi.features.filter((f) => f !== null && f.geometry !== null);
console.log(`Generated ${voronoiCells.length} Voronoi cells`);

// ---------- Flatten all prefecture polygons with their bboxes ----------
console.log('Preparing land polygons...');
const landPolygons = [];
for (const feature of prefectures.features) {
  if (feature.geometry.type === 'Polygon') {
    const poly = turf.polygon(feature.geometry.coordinates);
    poly._bbox = turf.bbox(poly);
    landPolygons.push(poly);
  } else if (feature.geometry.type === 'MultiPolygon') {
    for (const coords of feature.geometry.coordinates) {
      const poly = turf.polygon(coords);
      poly._bbox = turf.bbox(poly);
      landPolygons.push(poly);
    }
  }
}
console.log(`Total land polygons: ${landPolygons.length}`);

// ---------- Helper: check bbox overlap ----------
function bboxOverlap(a, b) {
  // a and b are [minX, minY, maxX, maxY]
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

// ---------- Clip Voronoi cells to land using per-polygon intersection ----------
console.log('Clipping Voronoi cells to Japan coastline...');

const clippedFeatures = [];
let skipped = 0;
const startTime = Date.now();

for (let i = 0; i < voronoiCells.length; i++) {
  const cell = voronoiCells[i];
  const stationProps = points[i].properties;
  const cellBbox = turf.bbox(cell);

  // Collect fragments from intersecting with each overlapping land polygon
  const fragments = [];
  for (const land of landPolygons) {
    if (!bboxOverlap(cellBbox, land._bbox)) continue;
    try {
      const clipped = turf.intersect(turf.featureCollection([cell, land]));
      if (clipped) fragments.push(clipped);
    } catch (e) {
      // Skip failed intersections
    }
  }

  if (fragments.length === 0) {
    skipped++;
    continue;
  }

  // Merge fragments into a single feature
  let merged;
  if (fragments.length === 1) {
    merged = fragments[0];
  } else {
    try {
      merged = turf.union(turf.featureCollection(fragments));
    } catch (e) {
      // If union fails, take the largest fragment
      merged = fragments.reduce((best, f) => {
        try {
          return turf.area(f) > turf.area(best) ? f : best;
        } catch {
          return best;
        }
      }, fragments[0]);
    }
  }

  merged.properties = { ...stationProps };
  clippedFeatures.push(merged);

  // Progress logging
  if ((i + 1) % 500 === 0 || i === voronoiCells.length - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Processed ${i + 1}/${voronoiCells.length} cells (${elapsed}s)`);
  }
}

console.log(`Clipped ${clippedFeatures.length} cells (${skipped} skipped/empty)`);

// ---------- Write output ----------
const result = turf.featureCollection(clippedFeatures);
const outputPath = 'extra/shakemap.geojson';
fs.writeFileSync(outputPath, JSON.stringify(result));

const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
console.log(`Saved ${outputPath} (${sizeMB} MB)`);
