import {
  loadCityForecastMapCsv,
  loadStationsCsvText,
  loadAreaNameToCodeMap,
} from "../areaCodes.js";

export const travelTimeData = {};
export const cityForecastMap = new Map();
export const stationsData = [];
let _eewDependenciesPromise = null;

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
