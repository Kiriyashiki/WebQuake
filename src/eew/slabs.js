// Slab2-based earthquake type classifier for MF2013 (1 = crustal, 2 = interface, 3 = intraslab).

// Standard normal CDF (Abramowitz & Stegun 7.1.26 for erf)
function erf(x) {
  const s = Math.sign(x),
    a = Math.abs(x),
    t = 1 / (1 + 0.3275911 * a);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1 - poly * Math.exp(-a * a));
}
const Phi = (z) => 0.5 * (1 + erf(z * Math.SQRT1_2));

// meta = parsed slab2_japan.json, buffer = contents of slab2_japan.bin (ArrayBuffer or Node Buffer)
export function createSlabModel(meta, buffer) {
  if (ArrayBuffer.isView(buffer)) {
    buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  const all = new Float32Array(buffer);
  const slabs = {};
  for (const [name, g] of Object.entries(meta.slabs)) {
    const n = g.nx * g.ny;
    slabs[name] = {
      ...g,
      dep: all.subarray(g.depOffset, g.depOffset + n),
      unc: all.subarray(g.uncOffset, g.uncOffset + n),
    };
  }
  return { slabs };
}

// Bilinear interpolation; null outside the grid or if any corner is NaN (= outside the slab model)
function bilinear(g, arr, lat, lon) {
  const fx = (lon - g.lon0) / g.dlon,
    fy = (lat - g.lat0) / g.dlat;
  const i = Math.floor(fx),
    j = Math.floor(fy);
  if (!(i >= 0 && j >= 0 && i < g.nx - 1 && j < g.ny - 1)) return null;
  const tx = fx - i,
    ty = fy - j,
    k = j * g.nx + i;
  const v00 = arr[k],
    v10 = arr[k + 1],
    v01 = arr[k + g.nx],
    v11 = arr[k + g.nx + 1];
  if (Number.isNaN(v00 + v10 + v01 + v11)) return null;
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

// Slab surface depth (km, positive down) and uncertainty (km) for every slab covering the point
export function sampleSlabs(model, lat, lon) {
  const out = [];
  for (const [name, g] of Object.entries(model.slabs)) {
    const surfaceKm = bilinear(g, g.dep, lat, lon);
    if (surfaceKm === null) continue;
    const uncKm = bilinear(g, g.unc, lat, lon);
    out.push({ name, region: g.region, surfaceKm, uncKm: uncKm ?? 15 });
  }
  return out;
}

const DEFAULTS = {
  depthSigmaKm: 7, // hypocenter depth error (JMA)
  aboveKm: 5, // true depth more than this above the slab surface -> crustal
  belowKm: 12, // true depth more than this below the slab surface -> intraslab
  interfaceMaxDepthKm: 60, // no interface events deeper than this: that mass goes to intraslab
  noSlabCrustMaxDepthKm: 40, // outside every slab grid: shallower -> crustal, deeper -> intraslab
};

// ev = { lat, lon, depthKm }. Returns probabilities for types [1, 2, 3], the argmax type,
// and the region ("NE" Pacific / "SW" Philippine Sea) of the best-matching slab.
export function classifyEvent(model, ev, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cands = sampleSlabs(model, ev.lat, ev.lon).map((s) => ({
    ...s,
    delta: ev.depthKm - s.surfaceKm,
  }));

  if (!cands.length) {
    const crust = ev.depthKm <= o.noSlabCrustMaxDepthKm;
    return {
      type: crust ? 1 : 3,
      probs: crust ? [1, 0, 0] : [0, 0, 1],
      region: null,
      slab: null,
      deltaKm: null,
      sigmaKm: null,
      covered: false,
    };
  }
  // Best match = slab whose surface is closest in depth to the hypocenter (handles stacked slabs)
  const best = cands.reduce((a, b) => (Math.abs(b.delta) < Math.abs(a.delta) ? b : a));
  const sigma = Math.hypot(o.depthSigmaKm, best.uncKm);

  const pCrust = Phi((-o.aboveKm - best.delta) / sigma);
  let pSlab = 1 - Phi((o.belowKm - best.delta) / sigma);
  let pIface = Math.max(0, 1 - pCrust - pSlab);
  if (ev.depthKm > o.interfaceMaxDepthKm) {
    pSlab += pIface;
    pIface = 0;
  }

  const probs = [pCrust, pIface, pSlab];
  return {
    type: probs.indexOf(Math.max(...probs)) + 1,
    probs,
    region: best.region,
    slab: best.name,
    deltaKm: best.delta,
    sigmaKm: sigma,
    covered: true,
  };
}

// Probability-weighted mean of f(type) over the plausible types (e.g. shindo per type)
export function mixOverTypes(probs, f, minP = 0.02) {
  let s = 0,
    w = 0;
  probs.forEach((p, k) => {
    if (p >= minP) {
      s += p * f(k + 1);
      w += p;
    }
  });
  return s / w;
}
