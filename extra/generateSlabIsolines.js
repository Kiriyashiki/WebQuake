// Generates slab-depth isolines (contours) as a 2D GeoJSON from the Slab2 grids
// stored in public/slab2_japan.json + public/slab2_japan.bin.
//
// Usage: node extra/generateSlabIsolines.js
// Output: extra/slab-isolines.geojson
//
// Each grid cell is 0.1 degrees; depths are km (positive down) and NaN outside
// the slab. Contours are extracted with marching squares and stitched into
// LineStrings. Every feature carries { name, depth }.

import fs from 'node:fs';

const META_PATH = 'public/slab2_japan.json';
const BIN_PATH = 'public/slab2_japan.bin';
const OUTPUT_PATH = 'extra/slab-isolines.geojson';

const NAMES = {
  kur: 'Kuril',
  izu: 'Izu-Bonin',
  ryu: 'Ryukyu',
};

// 10 km steps up to 80 km, then 20 km steps.
function depthBreaks(maxDepth) {
  const breaks = [];
  for (let d = 10; d <= 80; d += 10) if (d < maxDepth) breaks.push(d);
  for (let d = 100; d < maxDepth; d += 20) breaks.push(d);
  return breaks;
}

// Marching-squares edge table. Corner bits: c0 = bottom-left (1), c1 =
// bottom-right (2), c2 = top-right (4), c3 = top-left (8).
// Edges: e0 = bottom (c0-c1), e1 = right (c1-c2), e2 = top (c2-c3), e3 = left (c3-c0).
const CASES = {
  0: [],
  1: [[3, 0]],
  2: [[0, 1]],
  3: [[3, 1]],
  4: [[1, 2]],
  5: null, // ambiguous
  6: [[0, 2]],
  7: [[2, 3]],
  8: [[2, 3]],
  9: [[0, 2]],
  10: null, // ambiguous
  11: [[1, 2]],
  12: [[1, 3]],
  13: [[0, 1]],
  14: [[0, 3]],
  15: [],
};

function buildSlab(meta, all, code) {
  const g = meta.slabs[code];
  const n = g.nx * g.ny;
  return {
    ...g,
    code,
    name: NAMES[code] ?? code,
    dep: all.subarray(g.depOffset, g.depOffset + n),
  };
}

// Interpolate the crossing on an edge. Endpoints are normalized by grid index
// so adjacent cells compute bit-identical coordinates for their shared edge.
function edgePoint(slab, i1, j1, v1, i2, j2, v2, level) {
  const k1 = j1 * slab.nx + i1;
  const k2 = j2 * slab.nx + i2;
  if (k1 > k2) {
    [i1, j1, v1, i2, j2, v2] = [i2, j2, v2, i1, j1, v1];
  }
  const t = (level - v1) / (v2 - v1);
  return [
    slab.lon0 + (i1 + t * (i2 - i1)) * slab.dlon,
    slab.lat0 + (j1 + t * (j2 - j1)) * slab.dlat,
  ];
}

function contourSegments(slab, level) {
  const { nx, ny, dep } = slab;
  const segments = [];

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      const v0 = dep[k];
      const v1 = dep[k + 1];
      const v2 = dep[k + nx + 1];
      const v3 = dep[k + nx];
      if (Number.isNaN(v0 + v1 + v2 + v3)) continue;

      const c0 = v0 > level ? 1 : 0;
      const c1 = v1 > level ? 2 : 0;
      const c2 = v2 > level ? 4 : 0;
      const c3 = v3 > level ? 8 : 0;
      const code = c0 | c1 | c2 | c3;
      if (code === 0 || code === 15) continue;

      const point = (edge) => {
        switch (edge) {
          case 0:
            return edgePoint(slab, i, j, v0, i + 1, j, v1, level);
          case 1:
            return edgePoint(slab, i + 1, j, v1, i + 1, j + 1, v2, level);
          case 2:
            return edgePoint(slab, i, j + 1, v3, i + 1, j + 1, v2, level);
          default:
            return edgePoint(slab, i, j, v0, i, j + 1, v3, level);
        }
      };

      let pairs = CASES[code];
      if (pairs === null) {
        const centerAbove = (v0 + v1 + v2 + v3) / 4 > level;
        if (code === 5) {
          pairs = centerAbove
            ? [
                [0, 1],
                [2, 3],
              ]
            : [
                [3, 0],
                [1, 2],
              ];
        } else {
          pairs = centerAbove
            ? [
                [3, 0],
                [1, 2],
              ]
            : [
                [0, 1],
                [2, 3],
              ];
        }
      }

      for (const [ea, eb] of pairs) segments.push([point(ea), point(eb)]);
    }
  }

  return segments;
}

const KEY_PRECISION = 7;
function key(p) {
  return p[0].toFixed(KEY_PRECISION) + ',' + p[1].toFixed(KEY_PRECISION);
}

// Join segments that share endpoints into polylines.
function stitch(segments) {
  const adjacency = new Map();
  const add = (p, index) => {
    const k = key(p);
    let list = adjacency.get(k);
    if (!list) adjacency.set(k, (list = []));
    list.push(index);
  };

  segments.forEach(([a, b], index) => {
    add(a, index);
    add(b, index);
  });

  const used = new Uint8Array(segments.length);
  const findUnused = (k) => {
    const list = adjacency.get(k);
    if (!list) return -1;
    for (const index of list) if (!used[index]) return index;
    return -1;
  };

  const lines = [];
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = 1;

    const [a, b] = segments[s];
    if (key(a) === key(b)) continue;

    const right = [b];
    let tailKey = key(b);
    for (;;) {
      const next = findUnused(tailKey);
      if (next === -1) break;
      used[next] = 1;
      const [p, q] = segments[next];
      const other = key(p) === tailKey ? q : p;
      right.push(other);
      tailKey = key(other);
    }

    const left = [a];
    let headKey = key(a);
    for (;;) {
      const prev = findUnused(headKey);
      if (prev === -1) break;
      used[prev] = 1;
      const [p, q] = segments[prev];
      const other = key(p) === headKey ? q : p;
      left.push(other);
      headKey = key(other);
    }

    left.reverse();
    lines.push(left.concat(right));
  }

  return lines;
}

function round(p) {
  return [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))];
}

const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
const buffer = fs.readFileSync(BIN_PATH);
const all = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

const features = [];
for (const code of Object.keys(meta.slabs)) {
  const slab = buildSlab(meta, all, code);

  let maxDepth = -Infinity;
  for (const v of slab.dep) {
    if (!Number.isNaN(v) && v > maxDepth) maxDepth = v;
  }

  const breaks = depthBreaks(maxDepth);
  console.log(`${slab.name}: depth up to ${maxDepth.toFixed(1)} km, ${breaks.length} levels`);

  for (const level of breaks) {
    const lines = stitch(contourSegments(slab, level));
    for (const coords of lines) {
      if (coords.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { name: slab.name, depth: level },
        geometry: { type: 'LineString', coordinates: coords.map(round) },
      });
    }
    console.log(`  ${level} km: ${lines.length} isolines`);
  }
}

const geojson = { type: 'FeatureCollection', features };
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(geojson));

const sizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(2);
console.log(`\nSaved ${features.length} features to ${OUTPUT_PATH} (${sizeMB} MB)`);
