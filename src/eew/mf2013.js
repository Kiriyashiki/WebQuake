// Morikawa & Fujiwara (2013)

import { classifyEvent, mixOverTypes } from "./slabs.js";

const VEL = {
  a: -0.0325,
  b: [-0.002654, -0.002408, -0.003451],
  c: [5.6952, 5.6026, 6.003],
  d: 0.002266,
  pd: 0.12914,
  dlmin: 105.0,
  ps: -0.6934,
  vsmax: 850.0,
  gNE: 0.0000469,
  gSW: 0.0000372,
  ph: -0.2643,
};

// Volcanic front traces provided by NIED (listed so that the fore-arc is on the right-hand side)
const FRONTS = {
  NE: {
    lat: [24.0, 31.0, 34.1, 36.1, 37.2, 39.3, 42.6, 43.6, 44.3, 45.9],
    lon: [141.6, 140.2, 139.7, 138.7, 140.1, 141.0, 141.2, 145.0, 146.9, 150.0],
  },
  SW: {
    lat: [24.5, 24.5, 27.9, 29.5, 31.5, 33.4, 34.9, 35.3, 35.3, 36.2, 36.2],
    lon: [122.0, 124.0, 128.3, 129.7, 130.8, 131.6, 132.0, 133.7, 134.9, 136.9, 138.7],
  },
};

// Philippine Sea plate zones 4 (Kyushu) and 5 (Ryukyu).
const PHP = [
  {
    lon: [
      132.133, 131.917, 131.7, 131.517, 131.483, 131.083, 130.9, 130.3, 130.0, 130.4, 130.6, 131.0,
      131.283,
    ],
    lat: [
      33.217, 32.933, 32.533, 32.017, 31.783, 31.067, 30.817, 31.05, 31.267, 32.0, 32.367, 32.65,
      33.267,
    ],
  },
  {
    lon: [
      130.3, 130.9, 130.467, 130.067, 129.6, 129.2, 128.8, 127.767, 126.817, 126.267, 125.3, 125.0,
      124.5, 123.7, 123.0, 122.5, 122.233, 121.5, 122.233, 123.0, 124.0, 125.0, 126.0, 127.0, 128.0,
      129.0, 130.0,
    ],
    lat: [
      31.05, 30.817, 30.25, 29.8, 29.233, 28.6, 28.1, 27.1, 26.1, 25.6, 24.967, 24.85, 24.717,
      24.633, 24.533, 24.55, 24.55, 24.55, 25.333, 25.5, 25.767, 26.5, 27.267, 28.0, 28.817, 30.0,
      31.267,
    ],
  },
];

function inPolygon(lon, lat, p) {
  let inside = false;
  for (let i = 0, j = p.lon.length - 1; i < p.lon.length; j = i++) {
    if (
      p.lat[i] > lat !== p.lat[j] > lat &&
      lon < ((p.lon[j] - p.lon[i]) * (lat - p.lat[i])) / (p.lat[j] - p.lat[i]) + p.lon[i]
    )
      inside = !inside;
  }
  return inside;
}

// Signed distance (km) to a front trace: positive on the fore-arc, negative on the back-arc
export function signedDistanceToFront(lat, lon, tr) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180),
    ky = 110.574;
  let best = Infinity,
    sign = 1;
  for (let i = 0; i < tr.lat.length - 1; i++) {
    const ax = (tr.lon[i] - lon) * kx,
      ay = (tr.lat[i] - lat) * ky;
    const bx = (tr.lon[i + 1] - lon) * kx,
      by = (tr.lat[i + 1] - lat) * ky;
    const sx = bx - ax,
      sy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * sx + ay * sy) / (sx * sx + sy * sy)));
    const d = Math.hypot(ax + t * sx, ay + t * sy);
    if (d < best) {
      best = d;
      sign = sx * -ay - sy * -ax <= 0 ? 1 : -1;
    }
  }
  return sign * best;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180,
    dLat = (lat2 - lat1) * r,
    dLon = (lon2 - lon1) * r;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// PGV (cm/s, surface) for one earthquake type; mw = moment magnitude, X = fault distance (km)
export function mf2013Pgv(mw, type, X, avs30, d1400, ai = 0, ph = 0) {
  const p = VEL,
    mwc = Math.min(mw, 8.2);
  const gd = d1400 == null ? 0 : p.pd * Math.log10(Math.max(p.dlmin, d1400) / 300);
  const gs = p.ps * Math.log10(Math.min(p.vsmax, avs30) / 350);
  const log10pgv =
    p.a * (mwc - 16) ** 2 +
    p.b[type - 1] * X +
    p.c[type - 1] -
    Math.log10(X + p.d * 10 ** (0.5 * mwc)) +
    gd +
    gs +
    ai +
    ph;
  return 10 ** log10pgv;
}

const DEFAULTS = {
  phMaxDepthKm: 60, // J-SHIS page: "shallower than about 60 km"
  nied: true, // NIED variant: NE taper, zone 4/5 rules for SW AI and PH
  classifier: {}, // options forwarded to classifyEvent
};

// Classify the event once; reuse for many sites. ev = { magnitude (Mjma), depthKm, lat, lon,
// optional: mw (overrides Mjma-0.171), type (1|2|3 forces the type), region ("NE"|"SW") }
export function prepareEvent(ev, slabModel, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let cls;
  if (ev.type) {
    cls = { probs: [0, 0, 0], region: ev.region ?? null };
    cls.probs[ev.type - 1] = 1;
  } else {
    cls = classifyEvent(slabModel, ev, o.classifier);
  }
  return {
    ...ev,
    o,
    probs: cls.probs,
    region: ev.region ?? cls.region,
    cls,
    mw: ev.mw ?? ev.magnitude - 0.171,
    inZone45: PHP.some((z) => inPolygon(ev.lon, ev.lat, z)),
  };
}

// AI and PH terms (log10 units) for one type at one site
function extraTerms(p, type, site) {
  if (type < 2 || !p.region) return { ai: 0, ph: 0 }; // crustal: neither term applies
  const h = Math.max(p.depthKm - 30, 0);
  const xvf = signedDistanceToFront(site.lat, site.lon, FRONTS[p.region]);
  let ai = 0,
    ph = 0;
  if (p.region === "NE") {
    const taper = p.o.nied ? Math.min(Math.max((site.lat - 35.5) / 1.0, 0), 1) : 1;
    ai = VEL.gNE * xvf * h * taper;
  } else {
    const skip =
      p.depthKm < 60 || (p.o.nied && site.lon >= 136.9) || (p.o.nied && type === 3 && !p.inZone45);
    if (!skip) ai = VEL.gSW * Math.min(xvf, 75) * h;
    if (type === 3 && p.depthKm < p.o.phMaxDepthKm && !(p.o.nied && p.inZone45)) ph = VEL.ph;
  }
  return { ai, ph };
}

// site = { lat, lon, avs30, d1400 (null if unknown), epicentralDistanceKm (optional) }
export function shindoAtSiteDetail(p, site) {
  if (!(site.avs30 > 0)) return null;
  const epi = site.epicentralDistanceKm ?? haversineKm(p.lat, p.lon, site.lat, site.lon);
  const hypo = Math.hypot(epi, p.depthKm);
  const X = Math.max(hypo - 10 ** (0.5 * p.mw - 1.85) / 2, 3.0); // pseudo fault distance (approximation)
  const perType = [1, 2, 3].map((t) => {
    const { ai, ph } = extraTerms(p, t, site);
    const pgv = mf2013Pgv(p.mw, t, X, site.avs30, site.d1400, ai, ph);
    return { type: t, pgv, ai, ph, shindo: 2.68 + 1.72 * Math.log10(pgv) };
  });
  return {
    shindo: mixOverTypes(p.probs, (t) => perType[t - 1].shindo),
    probs: p.probs,
    X,
    perType,
  };
}

export const shindoAtSite = (p, site) => shindoAtSiteDetail(p, site)?.shindo ?? null;

// Convenience one-shot wrapper
export function calculateMf2013Shindo(ev, site, slabModel, opts) {
  return shindoAtSite(prepareEvent(ev, slabModel, opts), site);
}
