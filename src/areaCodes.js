/**
 * Loads and caches data files used across modules.
 * All loaders use promise caching to avoid redundant network fetches —
 * calling the same loader multiple times returns the same promise.
 */

// ─── Promise caches ──────────────────────────────────────────────────────────
let _areaCodesPromise = null;
let _prefectureCodesPromise = null;
let _cityNamesPromise = null;
let _rawCsvPromise = null;
let _boundsPromise = null;

// ─── Area Codes ──────────────────────────────────────────────────────────────

/**
 * Returns the raw text of jma-area-codes.csv (cached).
 * Shared between loadAreaCodes() and historyMode's reverse lookup.
 * @returns {Promise<string>}
 */
export function loadAreaCodesRawCsv() {
  if (!_rawCsvPromise) {
    _rawCsvPromise = fetch('/jma-area-codes.csv').then(res => {
      if (!res.ok) throw new Error(`Failed to load area codes CSV: ${res.status}`);
      return res.text();
    });
  }
  return _rawCsvPromise;
}

/**
 * Loads and parses jma-area-codes.csv into a Map keyed by numeric code.
 *
 * CSV format (semicolon-delimited, no header):
 *   100;石狩地方北部;いしかりちほうきたぶ;Northern Part of Ishikari
 *
 * Returns: Map<number, { ja: string, kana: string, en: string }>
 */
export function loadAreaCodes() {
  if (!_areaCodesPromise) {
    _areaCodesPromise = loadAreaCodesRawCsv().then(text => {
      const map = new Map();
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(';');
        if (parts.length < 3) continue;

        const code = Number.parseInt(parts[0], 10);
        const ja   = parts[1]?.trim() ?? '';
        const kana = parts[2]?.trim() ?? '';
        const en   = parts[3]?.trim() ?? '';

        if (!Number.isNaN(code)) {
          map.set(code, { ja, kana, en });
        }
      }
      return map;
    });
  }
  return _areaCodesPromise;
}

// ─── Prefecture Codes ────────────────────────────────────────────────────────

/**
 * Loads and parses prefecture-codes.csv into a Map keyed by numeric code.
 *
 * CSV format (semicolon-delimited, no header):
 *   1;北海道;ほっかいどう;Hokkaido
 *
 * Returns: Map<number, { name, kana, enName }>
 */
export function loadPrefectureCodes() {
  if (!_prefectureCodesPromise) {
    _prefectureCodesPromise = (async () => {
      const res = await fetch('/prefecture-codes.csv');
      if (!res.ok) throw new Error(`Failed to load prefecture codes CSV: ${res.status}`);

      const text = await res.text();
      const map = new Map();

      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(';');
        if (parts.length < 2) continue;

        const code   = Number.parseInt(parts[0], 10);
        const name   = parts[1]?.trim() ?? '';
        const kana   = parts[2]?.trim() ?? '';
        const enName = parts[3]?.trim() ?? '';

        if (!Number.isNaN(code)) {
          map.set(code, { name, kana, enName });
        }
      }

      return map;
    })();
  }
  return _prefectureCodesPromise;
}

// ─── City Names ──────────────────────────────────────────────────────────────

/**
 * Loads city.json data into a Map keyed by city code string.
 *
 * JSON format:
 *   {
 *     "0123500": { "japanese": "石狩市", "english": "Ishikari City", ... }
 *   }
 *
 * Returns: Map<string, { ja: string, en: string }>
 */
export function loadCityNames() {
  if (!_cityNamesPromise) {
    _cityNamesPromise = (async () => {
      const res = await fetch('/city.json');
      if (!res.ok) throw new Error(`Failed to load city names JSON: ${res.status}`);

      const data = await res.json();
      const map = new Map();

      for (const [code, info] of Object.entries(data)) {
        map.set(code, {
          ja: info.japanese || '',
          en: info.english || ''
        });
      }

      return map;
    })();
  }
  return _cityNamesPromise;
}

// ─── Bounds Data ─────────────────────────────────────────────────────────────

/**
 * Loads bounds.json data (cached).
 * Shared between main.js and historyMode.js.
 * @returns {Promise<Object>}
 */
export function loadBoundsData() {
  if (!_boundsPromise) {
    _boundsPromise = (async () => {
      const res = await fetch('/bounds.json');
      if (!res.ok) throw new Error(`Failed to load bounds.json: ${res.status}`);
      return res.json();
    })();
  }
  return _boundsPromise;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Create HTML for a ruby text (for displaying kana above kanji)
 * @param {string} text - Japanese text
 * @param {string} kana - Kana reading
 * @returns {string} HTML string with ruby element
 */
export function createRubyHtml(text, kana) {
  if (!kana) return text;
  return `<ruby>${text}<rt>${kana}</rt></ruby>`;
}
