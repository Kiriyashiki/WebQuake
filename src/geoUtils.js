/**
 * Shared Geographic & Coordinate Utilities
 *
 * Provides coordinate decoding, depth parsing, and geometry calculations
 * shared across feed parsers, report builders, and map operations.
 */

/**
 * Parses depth (in km) from a coordinate string like "+4012.6+14218.2-44000/".
 * The third component encodes depth in metres with inverted sign (negative = underground).
 * Returns positive depth in km, or null if unparseable.
 *
 * @param {string} cod - Coordinate string from JMA report
 * @returns {number|null} Depth in km, or null
 */
export function parseDepth(cod) {
  if (!cod) return null;
  const match = /^[+-][\d.]+[+-][\d.]+([+-]\d+\.?\d*)\/$/u.exec(cod);
  if (!match) return null;
  const depthMetres = Number.parseFloat(match[1]);
  if (Number.isNaN(depthMetres)) return null;
  return Math.abs(depthMetres) / 1000;
}

/**
 * Parses latitude and longitude from a coordinate string.
 * Supports:
 * - Degree-minute format (±DDMM.M±DDDMM.M...)
 * - Degree-minute-second format (±DDMMSS.S±DDDMMSS.S...)
 * - Decimal degrees (±DD.D±DDD.D...)
 *
 * @param {string} cod - Coordinate string like "+3559.9+14005.7-68000/" or "+36.0+140.1/"
 * @returns {{ latitude: number, longitude: number }|null}
 */
export function parseCoordinates(cod) {
  if (!cod) return null;
  const match = /^([+-])(\d+)(\.\d+)?([+-])(\d+)(\.\d+)?(?:[+-]\d+\.?\d*)?\/$/u.exec(cod);
  if (!match) return null;

  const [, s1, int1, frac1 = "", s2, int2, frac2 = ""] = match;

  let latitude;
  if (int1.length === 4) {
    const deg = Number.parseInt(int1.slice(0, 2), 10);
    const min = Number.parseFloat(int1.slice(2) + frac1);
    latitude = (s1 === "-" ? -1 : 1) * (deg + min / 60);
  } else if (int1.length === 6) {
    const deg = Number.parseInt(int1.slice(0, 2), 10);
    const min = Number.parseInt(int1.slice(2, 4), 10);
    const sec = Number.parseFloat(int1.slice(4) + frac1);
    latitude = (s1 === "-" ? -1 : 1) * (deg + min / 60 + sec / 3600);
  } else {
    latitude = Number.parseFloat(s1 + int1 + frac1);
  }

  let longitude;
  if (int2.length === 5) {
    const deg = Number.parseInt(int2.slice(0, 3), 10);
    const min = Number.parseFloat(int2.slice(3) + frac2);
    longitude = (s2 === "-" ? -1 : 1) * (deg + min / 60);
  } else if (int2.length === 7) {
    const deg = Number.parseInt(int2.slice(0, 3), 10);
    const min = Number.parseInt(int2.slice(3, 5), 10);
    const sec = Number.parseFloat(int2.slice(5) + frac2);
    longitude = (s2 === "-" ? -1 : 1) * (deg + min / 60 + sec / 3600);
  } else {
    longitude = Number.parseFloat(s2 + int2 + frac2);
  }

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;

  return { latitude, longitude };
}

// Aliases for backward compatibility
export const parseDepthFromCod = parseDepth;
export const parseCoordinatesFromCod = parseCoordinates;

/**
 * Determines whether a given [longitude, latitude] point lies inside a GeoJSON Polygon or MultiPolygon
 * using ray casting.
 *
 * @param {[number, number]} point - [longitude, latitude]
 * @param {Object} polygon - GeoJSON Polygon or MultiPolygon feature
 * @returns {boolean}
 */
export function pointInPolygon(point, polygon) {
  const [px, py] = point;

  function checkRing(ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect =
        yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  const coords = polygon?.geometry?.coordinates;
  if (!coords) return false;

  if (polygon.geometry.type === "Polygon") {
    let inside = checkRing(coords[0]);
    for (let i = 1; i < coords.length; i++) {
      if (checkRing(coords[i])) inside = !inside;
    }
    return inside;
  } else if (polygon.geometry.type === "MultiPolygon") {
    for (const poly of coords) {
      let inside = checkRing(poly[0]);
      for (let i = 1; i < poly.length; i++) {
        if (checkRing(poly[i])) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }
  return false;
}
