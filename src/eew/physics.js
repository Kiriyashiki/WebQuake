import {
  loadCityForecastMapCsv,
  loadStationsCsvText,
  loadAreaNameToCodeMap,
} from "../areaCodes.js";
import { ENABLE_SM1999_GMPE } from "../constants.js";
import { createSlabModel } from "./slabs.js";
import { prepareEvent, shindoAtSite } from "./mf2013.js";

export const travelTimeData = {};
export const cityForecastMap = new Map();
export const stationsData = [];
let _eewDependenciesPromise = null;

// ─── Ground Motion Prediction Equation (GMPE) selection ──────────────────────
export const EEW_GMPE_SM1999 = "sm1999";
export const EEW_GMPE_MF2013 = "mf2013";
const EEW_GMPE_STORAGE_KEY = "eew-gmpe";

let _slabModel = null;

/**
 * Returns the GMPE selected for EEW intensity estimates.
 * MF 2013 is the default; SM 1999 is only selectable when enabled.
 * @returns {string} One of EEW_GMPE_SM1999 / EEW_GMPE_MF2013
 */
export function getEewGmpe() {
  if (!ENABLE_SM1999_GMPE) return EEW_GMPE_MF2013;
  const saved =
    typeof localStorage !== "undefined" ? localStorage.getItem(EEW_GMPE_STORAGE_KEY) : null;
  return saved === EEW_GMPE_SM1999 ? EEW_GMPE_SM1999 : EEW_GMPE_MF2013;
}

/**
 * Persists the GMPE selection. Invalid ids (or SM 1999 when disabled) become MF 2013.
 * @param {string} id
 * @returns {string} The normalized selection
 */
export function setEewGmpe(id) {
  const value = ENABLE_SM1999_GMPE && id === EEW_GMPE_SM1999 ? EEW_GMPE_SM1999 : EEW_GMPE_MF2013;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(EEW_GMPE_STORAGE_KEY, value);
  }
  return value;
}

/**
 * Returns the loaded slab model used by the MF 2013 GMPE, or null if unavailable.
 */
export function getSlabModel() {
  return _slabModel;
}

/**
 * Loads (once) the slab2 model consumed by the MF 2013 GMPE.
 * @returns {Promise<object|null>}
 */
async function loadSlabModel() {
  if (_slabModel) return _slabModel;

  const [metaRes, binRes] = await Promise.all([
    fetch("/slab2_japan.json"),
    fetch("/slab2_japan.bin"),
  ]);
  if (!metaRes.ok || !binRes.ok) {
    throw new Error(`slab2_japan fetch failed (${metaRes.status}/${binRes.status})`);
  }
  const [meta, buffer] = await Promise.all([metaRes.json(), binRes.arrayBuffer()]);
  _slabModel = createSlabModel(meta, buffer);
  console.info("[EEW] Loaded MF 2013 slab model.");
  return _slabModel;
}

/**
 * Prepares an event for the MF 2013 GMPE (classify once, reuse for every station).
 * Returns null when the slab model is unavailable.
 * @returns {object|null}
 */
export function prepareMf2013Event(magnitude, depthKm, lat, lon) {
  if (!_slabModel) return null;
  return prepareEvent({ magnitude, depthKm, lat, lon }, _slabModel);
}

/**
 * JMA shindo estimate for one station via the MF 2013 GMPE.
 * Returns null when the event/model is unavailable or the station lacks avs30.
 * @param {object} ev - Event prepared by prepareMf2013Event
 * @param {object} station - Row from stationsData ({ lat, lon, avs30, d1400 })
 * @param {number} [epicentralDistanceKm]
 * @returns {number|null}
 */
export function calculateMf2013Shindo(ev, station, epicentralDistanceKm) {
  if (!ev) return null;
  return shindoAtSite(ev, {
    lat: station.lat,
    lon: station.lon,
    avs30: station.avs30,
    d1400: station.d1400 ?? null,
    epicentralDistanceKm,
  });
}

/**
 * Loads EEW travel time tables, city forecast mappings, and seismic stations data.
 */
export async function loadEewDependencies() {
  if (_eewDependenciesPromise) return _eewDependenciesPromise;

  _eewDependenciesPromise = (async () => {
    try {
      const [tjmaRes, cityRes, stationsRes] = await Promise.all([
        fetch("/tjma2001.csv").then((res) => res.text()),
        loadCityForecastMapCsv(),
        loadStationsCsvText(),
        loadAreaNameToCodeMap().catch(() => {}),
        loadSlabModel().catch((err) => {
          console.error("[EEW] MF 2013 slab model unavailable:", err);
        }),
      ]);

      for (const key of Object.keys(travelTimeData)) {
        delete travelTimeData[key];
      }
      const tjmaLines = tjmaRes.trim().split("\n");
      for (let i = 1; i < tjmaLines.length; i++) {
        if (!tjmaLines[i]) continue;
        const [depth, distance, p_time, s_time] = tjmaLines[i].split(",").map(Number);
        if (!travelTimeData[depth]) {
          travelTimeData[depth] = [];
        }
        travelTimeData[depth].push({ distance, p_time, s_time });
      }

      cityRes.split("\n").forEach((line) => {
        const parts = line.split(",");
        if (parts.length >= 2) {
          cityForecastMap.set(parts[0].trim(), parts[1].trim());
        }
      });

      const stationsLines = stationsRes.trim().split("\n");
      for (let i = 1; i < stationsLines.length; i++) {
        if (!stationsLines[i]) continue;
        const parts = stationsLines[i].split(";");
        if (parts.length >= 8) {
          stationsData.push({
            lat: Number.parseFloat(parts[4]),
            lon: Number.parseFloat(parts[5]),
            cityCode: parts[6],
            arv: Number.parseFloat(parts[7]),
            avs30: parts.length > 8 ? Number.parseFloat(parts[8]) : Number.NaN,
            d1400: parts.length > 9 && parts[9].trim() !== "" ? Number.parseFloat(parts[9]) : null,
          });
        }
      }
      console.info("[EEW] Loaded dependencies.");
    } catch (err) {
      console.error("[EEW] Could not load dependencies:", err);
    }
  })();

  return _eewDependenciesPromise;
}

/**
 * Calculates peak ground acceleration / JMA seismic intensity estimate via GMPE.
 * Si & Midorikawa (1999)
 */
export function calculateGmpe(magnitude, depthKm, epicentralDistance, arv) {
  const mw = magnitude - 0.171;
  const hypocentralDistance = Math.hypot(epicentralDistance, depthKm);
  const faultShift = 10.0 ** (0.5 * mw - 1.85) / 2.0;
  const d2 = Math.max(hypocentralDistance - faultShift, 3.0);
  const saturationTerm = 0.0028 * 10.0 ** (0.5 * mw);
  const sourceEnergy = 0.58 * mw + 0.0038 * depthKm - 1.29;
  const geometricDecay = Math.log10(d2 + saturationTerm);
  const anelasticDecay = 0.002 * d2;
  const siteAmplification = Math.log10(arv * 1.31);
  const log10a = sourceEnergy - geometricDecay - anelasticDecay + siteAmplification;
  const shindo = 2.68 + 1.72 * log10a;
  return shindo;
}

/**
 * Converts float intensity to standard JMA intensity string representation.
 */
export function floatToShindo(val) {
  if (val < 0.5) return "0";
  if (val < 1.5) return "1";
  if (val < 2.5) return "2";
  if (val < 3.5) return "3";
  if (val < 4.5) return "4";
  if (val < 5.0) return "5-";
  if (val < 5.5) return "5+";
  if (val < 6.0) return "6-";
  if (val < 6.5) return "6+";
  return "7";
}

/**
 * Calculates circular coordinate vertices on Earth surface.
 */
export function getCircleCoords(centerLat, centerLng, radiusKm, points = 64) {
  const coords = [];
  const R = 6371; // Earth radius in km
  const lat1 = (centerLat * Math.PI) / 180;
  const lon1 = (centerLng * Math.PI) / 180;
  const d = radiusKm / R;

  for (let i = 0; i <= points; i++) {
    const brng = (i / points) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
    );
    let lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return coords;
}

/**
 * Computes P/S wave travel distance for a given depth and elapsed time.
 */
export function getTravelDistance(depth, time, phase) {
  if (!travelTimeData?.[depth]) return 0;

  const data = travelTimeData[depth];

  let prev = data[0];
  for (let i = 1; i < data.length; i++) {
    const curr = data[i];
    const prevTime = phase === "P" ? prev.p_time : prev.s_time;
    const currTime = phase === "P" ? curr.p_time : curr.s_time;

    if (time >= prevTime && time <= currTime) {
      if (currTime === prevTime) return prev.distance;
      const ratio = (time - prevTime) / (currTime - prevTime);
      return prev.distance + ratio * (curr.distance - prev.distance);
    }
    prev = curr;
  }

  const lastTime = phase === "P" ? prev.p_time : prev.s_time;
  if (time > lastTime) {
    return prev.distance;
  }

  return 0;
}

/**
 * Converts JMA intensity scale string to comparable numeric rank.
 */
export function getIntVal(v) {
  if (v === "7") return 70;
  if (v === "6+") return 65;
  if (v === "6-") return 60;
  if (v === "5+") return 55;
  if (v === "5-") return 50;
  const parsed = Number.parseInt(v);
  return Number.isNaN(parsed) ? 0 : parsed * 10;
}

/**
 * Merges multiple active EEW forecast arrays, keeping the highest predicted intensity per area code.
 */
export function mergeForecasts(eewList) {
  const map = new Map();
  for (const eew of eewList) {
    if (eew.isCancelled || !eew.msg.Forecast) continue;
    for (const f of eew.msg.Forecast) {
      const existing = map.get(f.Code);
      if (!existing) {
        map.set(f.Code, f);
      } else {
        const existingInt = getIntVal(existing.Intensity.To);
        const newInt = getIntVal(f.Intensity.To);
        if (newInt > existingInt) {
          map.set(f.Code, f);
        }
      }
    }
  }
  return Array.from(map.values());
}
