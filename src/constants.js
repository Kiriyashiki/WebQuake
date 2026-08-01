// ─── API Feed URLs ──────────────────────────────────────────────────────────
export const FEED_URL_LATEST = 'https://www.jma.go.jp/bosai/quake/data/list.json';
export const FEED_DATA_BASE_URL = 'https://www.jma.go.jp/bosai/quake/data/';
export const EQDB_API_URL = 'https://www.data.jma.go.jp/eqdb/data/shindo/api/';
export const XML_FEED_URL = 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml';

// ─── Debug ──────────────────────────────────────────────────────────────────
export const USE_TEST_SERVER = false;

// ─── Intensity Configuration (JMA Shindo Scale) ──────────────────────────────
export const INTENSITY_CONFIG = {
  "1":  { color: "#6B7878", fontColor: "#FFFFFF", img: "1.png" },
  "2":  { color: "#1E6EE6", fontColor: "#FFFFFF", img: "2.png" },
  "3":  { color: "#32B464", fontColor: "#FFFFFF", img: "3.png" },
  "4":  { color: "#FFE05D", fontColor: "#000000", img: "4.png" },
  "5-": { color: "#FFAA13", fontColor: "#000000", img: "5minus.png" },
  "5+": { color: "#EF6F12", fontColor: "#000000", img: "5plus.png" },
  "6-": { color: "#E40000", fontColor: "#FFFFFF", img: "6minus.png" },
  "6+": { color: "#A00000", fontColor: "#FFFFFF", img: "6plus.png" },
  "7":  { color: "#5D0092", fontColor: "#FFFFFF", img: "7.png" }
};

// ─── Map Colour Palette ──────────────────────────────────────────────────────
export const MAP_COLORS = {
  ocean: "#060a0e",
  lake: "#080c11",
  land: "#0d1520",
  japan: "#111d2c",
  japanLine: "#1e2e44",
  prefectureLine: "#333e4e",
  forecastLine: "#24334a",
  cityLine: "#192434",
  worldLine: "#141e2c",
  accent2: "#f0a500",
  hoverFill: "rgba(240, 165, 0, 0.18)",
};

// Live Mode interval
export const POLL_INTERVAL = 15000;

/**
 * Helper to convert a hex color to rgba with specified opacity.
 * @param {string} hex - Hex color (e.g., "#FF0000")
 * @param {number} opacity - Opacity 0-1 (e.g., 0.4)
 * @returns {string} rgba color string
 */
function hexToRgba(hex, opacity) {
  // Remove # and parse hex
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Builds intensity color expressions for MapLibre style.
 * Returns a case expression that maps intensity levels to full-opacity or reduced-opacity colors.
 * @param {boolean} isDimmed - If true, returns 40% opacity colors; else full opacity
 * @param {string} fallback - Default color when no intensity is set (default: "transparent")
 * @returns {Array} MapLibre case expression
 */
export function buildIntensityColorExpression(isDimmed = false, fallback = "transparent") {
  const opacity = isDimmed ? 0.4 : 1;
  const colors = [];

  Object.entries(INTENSITY_CONFIG).forEach(([intensity, config]) => {
    const color = isDimmed ? hexToRgba(config.color, opacity) : config.color;
    colors.push(["==", ["feature-state", "intensity"], intensity], color);
  });

  // Default to fallback
  colors.push(fallback);

  return ["case", ...colors];
}

/**
 * Formats Unix timestamp (milliseconds) to YYYY/MM/DD HH:MM format in JST (UTC+9).
 */
export function formatTimeJST(ms) {
  const date = new Date(ms);
  
  // Convert to JST (UTC+9) by adding 9 hours to the UTC timestamp
  const jstDate = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  
  const year = jstDate.getUTCFullYear();
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstDate.getUTCDate()).padStart(2, "0");
  const hours = String(jstDate.getUTCHours()).padStart(2, "0");
  const minutes = String(jstDate.getUTCMinutes()).padStart(2, "0");
  
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

/**
 * Formats Unix timestamp (milliseconds) to YYYY/MM/DD HH:MM:SS format in JST (UTC+9).
 */
export function formatTimeJSTWithSeconds(ms) {
  const date = new Date(ms);
  
  // Convert to JST (UTC+9) by adding 9 hours to the UTC timestamp
  const jstDate = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  
  const year = jstDate.getUTCFullYear();
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstDate.getUTCDate()).padStart(2, "0");
  const hours = String(jstDate.getUTCHours()).padStart(2, "0");
  const minutes = String(jstDate.getUTCMinutes()).padStart(2, "0");
  const seconds = String(jstDate.getUTCSeconds()).padStart(2, "0");
  
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

