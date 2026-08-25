const fs = require('fs');
const turf = require('@turf/turf');

// ---------- Load data ----------
console.log('Loading datasets...');
const stations = JSON.parse(fs.readFileSync('extra/stations.json', 'utf-8'));
const prefectures = JSON.parse(fs.readFileSync('public/prefectures.geojson', 'utf-8'));

let exclusions = { features: [] };
try {
  exclusions = JSON.parse(fs.readFileSync('extra/exclusions.geojson', 'utf-8'));
  console.log(`Loaded ${exclusions.features.length} exclusion features`);
} catch (e) {
  console.log('No exclusions.geojson found or error reading it. Proceeding without exclusions.');
}

console.log(`Loaded ${stations.length} stations and ${prefectures.features.length} prefecture features`);

// ---------- Helper: check bbox overlap ----------
function bboxOverlap(a, b) {
  // a and b are [minX, minY, maxX, maxY]
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

// ---------- Flatten all prefecture polygons ----------
console.log('Preparing land polygons...');
let landPolygons = [];
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

// ---------- Flatten exclusions ----------
const exclusionPolygons = [];
for (const feature of exclusions.features) {
  if (!feature.geometry) continue;
  if (feature.geometry.type === 'Polygon') {
    const poly = turf.polygon(feature.geometry.coordinates);
    poly._bbox = turf.bbox(poly);
    exclusionPolygons.push(poly);
  } else if (feature.geometry.type === 'MultiPolygon') {
    for (const coords of feature.geometry.coordinates) {
      const poly = turf.polygon(coords);
      poly._bbox = turf.bbox(poly);
      exclusionPolygons.push(poly);
    }
  }
}

// ---------- Apply exclusions to land polygons ----------
if (exclusionPolygons.length > 0) {
  console.log(`Subtracting ${exclusionPolygons.length} exclusion polygons from land...`);
  const finalLandPolygons = [];
  
  for (const land of landPolygons) {
    let currentParts = [land];
    
    for (const excl of exclusionPolygons) {
      if (!bboxOverlap(land._bbox, excl._bbox)) continue;
      
      const nextParts = [];
      for (const part of currentParts) {
        try {
          const diff = turf.difference(turf.featureCollection([part, excl]));
          if (diff) {
            if (diff.geometry.type === 'Polygon') {
              nextParts.push(diff);
            } else if (diff.geometry.type === 'MultiPolygon') {
              for (const coords of diff.geometry.coordinates) {
                nextParts.push(turf.polygon(coords));
              }
            }
          }
          // If diff is null, part is completely covered by exclusion, so it is removed.
        } catch (e) {
          // If difference fails (e.g., self-intersection issues), fallback to keeping the part
          nextParts.push(part);
        }
      }
      currentParts = nextParts;
      if (currentParts.length === 0) break;
    }
    
    for (const part of currentParts) {
      part._bbox = turf.bbox(part);
      finalLandPolygons.push(part);
    }
  }
  landPolygons = finalLandPolygons;
}
console.log(`Total land polygons after exclusions: ${landPolygons.length}`);

// ---------- Compute bounding box from updated land polygons ----------
const landFeatureCollection = turf.featureCollection(landPolygons);
const bbox = turf.bbox(landFeatureCollection);
console.log(`Japan bounding box (after exclusions): [${bbox}]`);

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

// ---------- Compute Voronoi ----------
console.log('Computing Voronoi diagram...');
const voronoi = turf.voronoi(pointCollection, { bbox });

// Filter out any null cells (can happen with duplicate points)
const voronoiCells = voronoi.features.filter((f) => f !== null && f.geometry !== null);
console.log(`Generated ${voronoiCells.length} Voronoi cells`);

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
      if (clipped) {
        if (clipped.geometry.type === 'Polygon') {
          fragments.push(clipped);
        } else if (clipped.geometry.type === 'MultiPolygon') {
          for (const coords of clipped.geometry.coordinates) {
            fragments.push(turf.polygon(coords));
          }
        }
      }
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
let result = turf.featureCollection(clippedFeatures);

// Truncate coordinates to 6 decimal places to reduce file size
console.log('Truncating coordinates to 6 decimal places...');
result = turf.truncate(result, { precision: 6, coordinates: 2, mutate: true });

const outputPath = 'extra/shakemap.geojson';
fs.writeFileSync(outputPath, JSON.stringify(result));

const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
console.log(`Saved ${outputPath} (${sizeMB} MB)`);
