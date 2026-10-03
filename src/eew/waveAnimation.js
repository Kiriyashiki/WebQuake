import { eewState } from "./state.js";
import { getCircleCoords, getTravelDistance } from "./physics.js";
import { isPlumEew } from "../eewProviders.js";

let waveInterval = null;

/**
 * Starts 250ms animation loop updating P and S wave propagation circles.
 */
export function startWaveAnimation() {
  console.debug("[eq-viewer-eew] startWaveAnimation: START");
  if (waveInterval) return;

  console.debug("[eq-viewer-eew] startWaveAnimation: setting interval");
  waveInterval = setInterval(updateWaves, 250);

  // Defer the initial wave update to avoid interacting with MapLibre sources
  // synchronously in the same tick as layout property changes, which can
  // crash WebKit2GTK's WebGL context.
  setTimeout(() => {
    console.debug("[eq-viewer-eew] startWaveAnimation: initial updateWaves");
    updateWaves();
  }, 50);
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

    if (pRad >= 2000) {
      continue;
    }
    allFinished = false;

    let opacity = 1.0;
    if (pRad > 1750) {
      opacity = 1.0 - (pRad - 1750) / 250;
      if (opacity < 0) opacity = 0;
    }

    const coords = msg.Hypocenter.Coordinate;
    if (coords && coords.length >= 2) {
      const lng = Number.parseFloat(coords[0]);
      const lat = Number.parseFloat(coords[1]);

      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        if (pRad > 0) {
          pFeatures.push({
            type: "Feature",
            properties: { opacity },
            geometry: {
              type: "Polygon",
              coordinates: [getCircleCoords(lat, lng, pRad, 96)],
            },
          });
        }
        if (sRad > 0) {
          sFeatures.push({
            type: "Feature",
            properties: { opacity },
            geometry: {
              type: "Polygon",
              coordinates: [getCircleCoords(lat, lng, sRad, 64)],
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
