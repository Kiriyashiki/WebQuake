import { INTENSITY_CONFIG, LPGM_CONFIG } from "./constants.js";

/**
 * Escapes characters for safe inclusion in HTML attribute values.
 * @param {string} str
 * @returns {string}
 */
function escapeHtmlAttr(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Resolves the configuration, display text, and composition state for an intensity value.
 * @param {string|number|null|undefined} intensity - Intensity value (e.g. 1, 4, "5-", "5+", 7, 0, null)
 * @param {boolean} [isLpgm=false] - Whether to use the LPGM scale
 * @returns {{
 *   config: { color: string, fontColor: string },
 *   displayText: string,
 *   isComposite: boolean,
 *   num: string,
 *   sign: string,
 *   intensityStr: string
 * }}
 */
export function getIntensityBadgeInfo(intensity, isLpgm = false) {
  const configMap = isLpgm ? LPGM_CONFIG : INTENSITY_CONFIG;
  const isUnknown =
    intensity === null ||
    intensity === undefined ||
    intensity === "" ||
    intensity === "不明" ||
    intensity === 0 ||
    intensity === "0" ||
    intensity === "over";

  if (isUnknown || !configMap[intensity]) {
    const zeroConfig = configMap[0] || INTENSITY_CONFIG[0] || { color: "#1e2e44", fontColor: "#FFFFFF" };
    return {
      config: zeroConfig,
      displayText: "-",
      isComposite: false,
      num: "-",
      sign: "",
      intensityStr: isUnknown ? "0" : String(intensity),
    };
  }

  const config = configMap[intensity];
  const str = String(intensity);
  const match = /^(\d+)([+-])$/.exec(str);
  if (match) {
    return {
      config,
      displayText: str,
      isComposite: true,
      num: match[1],
      sign: match[2],
      intensityStr: str,
    };
  }

  return {
    config,
    displayText: str,
    isComposite: false,
    num: str,
    sign: "",
    intensityStr: str,
  };
}

/**
 * Generates the HTML string for an intensity badge.
 * Replicates the format of the original 256x256 images:
 * - Font: 'M PLUS 1p' bold (font-weight: 700)
 * - Single value centered at 50% / 50% with font-size 146 (57.03cqw)
 * - Composite values (5-, 5+, 6-, 6+):
 *   - Number centered horizontally at 40.625% (104/256), vertically at 50%
 *   - Sign centered horizontally at 71.875% (184/256), vertically at 39.84375% (102/256) with font-size 112 (43.75cqw)
 *
 * @param {string|number|null|undefined} intensity
 * @param {Object} [options={}]
 * @param {boolean} [options.isLpgm=false]
 * @param {string} [options.title]
 * @param {string} [options.customClass=""]
 * @param {string} [options.style=""]
 * @returns {string}
 */
export function getIntensityBadgeHtml(intensity, options = {}) {
  const { isLpgm = false, title, customClass = "", style = "" } = options;
  const info = getIntensityBadgeInfo(intensity, isLpgm);

  const classes = ["intensity-badge"];
  if (info.isComposite) {
    classes.push("intensity-badge-composite");
  }
  if (customClass) {
    classes.push(customClass);
  }

  let badgeTitle = title;
  if (badgeTitle === undefined && info.displayText !== "-") {
    badgeTitle = isLpgm ? `LPGM: ${info.displayText}` : `Intensity: ${info.displayText}`;
  }

  const titleAttr = badgeTitle ? ` title="${escapeHtmlAttr(badgeTitle)}"` : "";
  const extraStyle = style ? ` ${style}` : "";
  const styleAttr = `style="background-color: ${info.config.color}; color: ${info.config.fontColor};${extraStyle}"`;

  if (info.isComposite) {
    return `<div class="${classes.join(" ")}" ${styleAttr}${titleAttr}><span class="intensity-num">${info.num}</span><span class="intensity-sign">${info.sign}</span></div>`;
  }

  return `<div class="${classes.join(" ")}" ${styleAttr}${titleAttr}><span class="intensity-value">${info.num}</span></div>`;
}

/**
 * Renders an intensity badge inside a DOM container element.
 * @param {HTMLElement} container
 * @param {string|number|null|undefined} intensity
 * @param {Object} [options={}]
 */
export function renderIntensityBadge(container, intensity, options = {}) {
  if (!container) return;
  container.innerHTML = getIntensityBadgeHtml(intensity, options);
}
