import { eewState } from "./state.js";
import { getCircleCoords, getTravelDistance } from "./physics.js";
import { isPlumEew } from "../externalProviders.js";

let waveInterval = null;

// Waves are drawn up to this radius and fade out between the two values
const WAVE_MAX_RADIUS = 2000;
const WAVE_FADE_START = 1750;

/**
 * Returns the opacity of a wave circle based on its own propagation radius.
 */
function getWaveOpacity(radius) {
  if (radius <= WAVE_FADE_START) return 1.0;
  const opacity = 1.0 - (radius - WAVE_FADE_START) / (WAVE_MAX_RADIUS - WAVE_FADE_START);
  return Math.max(0, opacity);
}

/**
 * Starts 250ms animation loop updating P and S wave propagation circles.
 */
export function startWaveAnimation() {
  if (waveInterval) return;

  waveInterval = setInterval(updateWaves, 250);

  updateWaves();
}

/**
 * Stops wave animation interval and resets map wave GeoJSON sources.
 */
export function stopWaveAnimation() {
  if (waveInterval) {
    clearInterval(waveInterval);
    waveInterval = null;
  }
  if (eewState.mapInstance?.getSource("eew-p-wave")) {
    eewState.mapInstance.getSource("eew-p-wave").setData({ type: "FeatureCollection", features: [] });
  }
  if (eewState.mapInstance?.getSource("eew-s-wave")) {
    eewState.mapInstance.getSource("eew-s-wave").setData({ type: "FeatureCollection", features: [] });
  }
}

/**
 * Recalculates P and S wave propagation distances and updates map layers.
 */
export function updateWaves() {
  if (!eewState.mapInstance) return;
  if (document.hidden) return;

  const pSrc = eewState.mapInstance.getSource("eew-p-wave");
  const sSrc = eewState.mapInstance.getSource("eew-s-wave");

  // If EEW is not active on the map or user is viewing a normal report, do not draw wave animations
  if (!eewState.isEewMapActive || eewState.activeEews.size === 0 || document.querySelector(".eq-item.active")) {
    if (pSrc) pSrc.setData({ type: "FeatureCollection", features: [] });
    if (sSrc) sSrc.setData({ type: "FeatureCollection", features: [] });
    if (eewState.activeEews.size === 0) {
      stopWaveAnimation();
    }
    return;
  }

  const pFeatures = [];
  const sFeatures = [];
  const now = Date.now();
  let allFinished = true;

  for (const eew of eewState.activeEews.values()) {
    const msg = eew.msg;
    if (!msg?.Hypocenter || eew.isCancelled) continue;

    const isPlum = isPlumEew(msg);
    if (isPlum) continue;

    const originTime = new Date(msg.OriginDateTime).getTime();
    const t = Math.max(0, (now - originTime) / 1000);

    let depth = Number.parseInt(msg.Hypocenter.Depth, 10);
    if (Number.isNaN(depth)) depth = 10;

    // Convert to multiple of 10 for table lookup, cap at 700km
    depth = Math.round(depth / 10) * 10;
    if (depth > 700) depth = 700;

    const pRad = getTravelDistance(depth, t, "P");
    const sRad = getTravelDistance(depth, t, "S");

    // Each wave fades out on its own radius, so the slower S wave keeps
    // animating after the P wave has already disappeared
    const pVisible = pRad > 0 && pRad < WAVE_MAX_RADIUS;
    const sVisible = sRad > 0 && sRad < WAVE_MAX_RADIUS;

    if (!pVisible && !sVisible) {
      continue;
    }
    allFinished = false;

    const pOpacity = getWaveOpacity(pRad);
    const sOpacity = getWaveOpacity(sRad);

    const coords = msg.Hypocenter.Coordinate;
    if (coords && coords.length >= 2) {
      const lng = Number.parseFloat(coords[0]);
      const lat = Number.parseFloat(coords[1]);

      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        if (pVisible) {
          pFeatures.push({
            type: "Feature",
            properties: { opacity: pOpacity },
            geometry: {
              type: "Polygon",
              coordinates: [getCircleCoords(lat, lng, pRad, 128)],
            },
          });
        }
        if (sVisible) {
          sFeatures.push({
            type: "Feature",
            properties: { opacity: sOpacity },
            geometry: {
              type: "Polygon",
              coordinates: [getCircleCoords(lat, lng, sRad, 96)],
            },
          });
        }
      }
    }
  }

  if (pSrc) pSrc.setData({ type: "FeatureCollection", features: pFeatures });
  if (sSrc) sSrc.setData({ type: "FeatureCollection", features: sFeatures });

  if (allFinished) {
    stopWaveAnimation();
  }
}
