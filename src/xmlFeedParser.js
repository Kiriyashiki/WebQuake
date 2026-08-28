/**
 * XML Feed Parser for JMA Atom feed (eqvol.xml).
 *
 * Two-phase design matching the JSON feed's efficiency:
 *
 *   Phase 1 – fetchXmlFeedEntries():
 *     Fetches the lightweight Atom index (one HTTP request).
 *     For each relevant entry, checks a local cache keyed by dataUrl.
 *     Only fetches individual XML reports for entries whose <updated>
 *     timestamp has changed (or are unseen).  Cached entries are reused.
 *
 *   Phase 2 – Consumers use the returned normalized entries exactly
 *     as they would JSON feed entries.
 *
 * Entry title → report type mapping:
 *   震度速報            → VXSE51 (intensity flash)
 *   震源に関する情報    → VXSE52 (epicenter flash)
 *   震源・震度に関する情報 → VXSE53 (normal report)
 *   顕著な地震の震源要素更新のお知らせ → VXSE61 (special update)
 */

import { FLASH_INTENSITY_TITLE, FLASH_EPICENTER_TITLE, SPECIAL_TITLE, NORMAL_TITLE } from './reportUtils.js';
import { XML_FEED_URL } from './constants.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Atom feed entry titles we care about, mapped to the JSON `ttl` equivalents.
 * The Atom <title> uses slightly different wording for VXSE53.
 */
const ATOM_TITLE_TO_TTL = {
  '震度速報':            FLASH_INTENSITY_TITLE,    // VXSE51
  '震源に関する情報':    FLASH_EPICENTER_TITLE,    // VXSE52
  '震源・震度に関する情報': NORMAL_TITLE,       // VXSE53 → same ttl as JSON
  '顕著な地震の震源要素更新のお知らせ': SPECIAL_TITLE, // VXSE61
};

/** Set of Atom titles that we should process */
const RELEVANT_TITLES = new Set(Object.keys(ATOM_TITLE_TO_TTL));

// ─── Entry Cache ─────────────────────────────────────────────────────────────

/**
 * Cache of previously-fetched and normalized XML report entries.
 * Keyed by the Atom entry's data URL (unique per report).
 * Value: { updated: string, entry: normalizedEntry }
 *
 * This mirrors how the JSON path works: list.json is fetched every poll,
 * but individual report JSONs are only fetched when a new/updated entry
 * is detected.  Here, the Atom feed is the "index" and individual XML
 * reports are only fetched when their <updated> timestamp changes.
 */
const _entryCache = new Map();

// ─── Atom Feed Parsing ──────────────────────────────────────────────────────

let _lastModified = null;
let _eTag = null;

/**
 * Fetches the JMA Atom XML feed index and returns normalized entry objects
 * compatible with the JSON feed format.
 *
 * Only fetches individual XML reports for entries that are new or have a
 * changed <updated> timestamp since the last poll.  Cached entries are
 * reused directly.
 *
 * @param {Object} options Options containing tauriFetch if available
 * @returns {Promise<{ entries: Array, nextIntervalMs: number|null, notModified: boolean }>} 
 */
export async function fetchXmlFeedEntries(options = {}) {
  const headers = {};
  if (_lastModified) headers['If-Modified-Since'] = _lastModified;
  if (_eTag) headers['If-None-Match'] = _eTag;

  const fetchFn = options.tauriFetch || fetch;

  // 1. Fetch the Atom feed index (lightweight — just the feed XML)
  const feedRes = await fetchFn(XML_FEED_URL, {
    method: 'GET',
    mode: 'cors',
    cache: 'no-cache',
    headers,
  });

  let nextIntervalMs = null;
  let notModified = false;

  if (options.tauriFetch) {
    const cacheControl = feedRes.headers.get('cache-control') || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    const maxAge = maxAgeMatch ? Number.parseInt(maxAgeMatch[1], 10) : 60;
    const age = Number.parseInt(feedRes.headers.get('age') || '0', 10);
    
    // Schedule next poll when age reaches maxAge + 1s to be safe
    nextIntervalMs = Math.max((maxAge - age + 1), 1) * 1000;
    
    // Update cache headers if not 304
    if (feedRes.status !== 304) {
      if (feedRes.headers.get('last-modified')) _lastModified = feedRes.headers.get('last-modified');
      if (feedRes.headers.get('etag')) _eTag = feedRes.headers.get('etag');
    }
  }

  if (feedRes.status === 304) {
    return { entries: [], nextIntervalMs, notModified: true };
  }

  if (!feedRes.ok) {
    throw new Error(`XML feed fetch failed: ${XML_FEED_URL} (${feedRes.status})`);
  }

  const feedText = await feedRes.text();
  const parser = new DOMParser();
  const feedDoc = parser.parseFromString(feedText, 'application/xml');

  const parseError = feedDoc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`XML feed parse error: ${parseError.textContent}`);
  }

  // 2. Extract relevant <entry> elements from the Atom index
  const atomEntries = feedDoc.getElementsByTagName('entry');
  const toFetch = [];    // Entries that need individual XML report fetching
  const fromCache = [];  // Entries served from cache

  for (const atomEntry of atomEntries) {
    const title = _atomText(atomEntry, 'title');
    if (!title || !RELEVANT_TITLES.has(title)) continue;

    const dataUrl = _atomLinkHref(atomEntry);
    if (!dataUrl) continue;

    const updated = _atomText(atomEntry, 'updated');

    // Check cache: skip fetch if we already have this entry with same timestamp
    const cached = _entryCache.get(dataUrl);
    if (cached && cached.updated === updated) {
      fromCache.push(cached.entry);
    } else {
      toFetch.push({ title, dataUrl, updated });
    }
  }

  // 3. Fetch only new/changed individual XML reports (in batches of 4)
  const newlyFetched = [];

  if (toFetch.length > 0) {
    console.debug(`[xml-feed] Fetching ${toFetch.length} new/updated report(s), ${fromCache.length} cached`);

    for (let i = 0; i < toFetch.length; i += 4) {
      const batch = toFetch.slice(i, i + 4);
      const batchResults = await Promise.all(
        batch.map(atomEntry => _fetchAndNormalizeXmlEntry(atomEntry, options))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result) {
          // Store in cache keyed by data URL
          _entryCache.set(batch[j].dataUrl, {
            updated: batch[j].updated,
            entry: result,
          });
          newlyFetched.push(result);
        }
      }
    }
  }

  return { entries: [...fromCache, ...newlyFetched], nextIntervalMs, notModified };
}

/**
 * Clears the entry cache.  Called when live mode is stopped to free memory.
 */
export function clearXmlFeedCache() {
  _entryCache.clear();
}

/**
 * Removes cached entries for the given event IDs.
 * Called when the sidebar prunes old reports to free stale XML documents.
 * @param {Set<string>} eventIdsToRemove
 */
export function pruneXmlFeedCache(eventIdsToRemove) {
  for (const [url, cached] of _entryCache) {
    if (cached.entry?.eid && eventIdsToRemove.has(cached.entry.eid)) {
      _entryCache.delete(url);
    }
  }
}

document.addEventListener('reports-pruned', (e) => {
  if (e.detail?.removedIds) {
    pruneXmlFeedCache(e.detail.removedIds);
  }
});

// ─── Individual XML Report Fetching & Normalization ─────────────────────────

/**
 * Fetches an individual XML report and normalizes it to the JSON entry format.
 *
 * @param {{ title: string, dataUrl: string, updated: string }} atomEntry
 * @param {Object} options Options containing tauriFetch if available
 * @returns {Promise<Object|null>} Normalized entry or null on failure
 */
async function _fetchAndNormalizeXmlEntry(atomEntry, options = {}) {
  try {
    const fetchFn = options.tauriFetch || fetch;
    const res = await fetchFn(atomEntry.dataUrl, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
    });

    if (!res.ok) {
      console.warn(`[xml-feed] Failed to fetch report: ${atomEntry.dataUrl} (${res.status})`);
      return null;
    }

    const xmlText = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      console.warn(`[xml-feed] Parse error for: ${atomEntry.dataUrl}`);
      return null;
    }

    // Extract common fields from the XML report
    const eventId = _xmlText(doc, 'EventID');
    if (!eventId) {
      console.warn(`[xml-feed] No EventID in: ${atomEntry.dataUrl}`);
      return null;
    }

    // Map the Atom title to the JSON `ttl` equivalent
    const ttl = ATOM_TITLE_TO_TTL[atomEntry.title] || atomEntry.title;

    // Build the normalized entry based on report type
    const baseEntry = {
      eid: eventId,
      ttl,
      rdt: atomEntry.updated || null,
      _xmlDoc: doc,          // Carry the parsed XML doc for later use
      _xmlUrl: atomEntry.dataUrl,
    };

    if (atomEntry.title === '震源・震度に関する情報') {
      return _normalizeVXSE53Entry(baseEntry, doc);
    }

    if (atomEntry.title === '震度速報') {
      return _normalizeVXSE51Entry(baseEntry, doc);
    }

    if (atomEntry.title === '震源に関する情報') {
      return _normalizeVXSE52Entry(baseEntry, doc);
    }

    if (atomEntry.title === '顕著な地震の震源要素更新のお知らせ') {
      return _normalizeVXSE61Entry(baseEntry, doc);
    }

    return baseEntry;
  } catch (err) {
    console.warn(`[xml-feed] Error fetching ${atomEntry.dataUrl}:`, err.message);
    return null;
  }
}

/**
 * Normalizes a VXSE53 (震源・震度に関する情報) XML report.
 * This is the main full report – we store the XML doc reference for
 * later parsing by JMAEarthquakeReport.fromXmlDoc().
 */
function _normalizeVXSE53Entry(baseEntry, doc) {
  return {
    ...baseEntry,
    json: null,  // No JSON file – data comes from _xmlDoc
  };
}

/**
 * Normalizes a VXSE51 (震度速報) XML report.
 * Extracts area-level intensity observations from the XML Body.
 */
function _normalizeVXSE51Entry(baseEntry, doc) {
  const at = _xmlText(doc, 'TargetDateTime');
  const maxi = _xmlText(doc, 'MaxInt');

  return {
    ...baseEntry,
    json: null,
    at,
    maxi,
  };
}

/**
 * Normalizes a VXSE52 (震源に関する情報) XML report.
 * Extracts epicenter details directly from the XML.
 */
function _normalizeVXSE52Entry(baseEntry, doc) {
  const at = _xmlText(doc, 'OriginTime') || _xmlText(doc, 'TargetDateTime');

  const magElements = [
    ...doc.getElementsByTagName('Magnitude'),
    ...doc.getElementsByTagName('jmx_eb:Magnitude'),
  ];
  const mag = magElements.length > 0 ? magElements[0].textContent.trim() : null;

  const cod = _xmlCoordinate(doc);

  const hypocenter = doc.getElementsByTagName('Hypocenter')[0];
  let acd = null;
  let anm = null;
  if (hypocenter) {
    const area = hypocenter.getElementsByTagName('Area')[0];
    if (area) {
      const codes = area.getElementsByTagName('Code');
      for (const code of codes) {
        if (code.getAttribute('type') === '震央地名') {
          acd = code.textContent.trim();
          break;
        }
      }
      const nameEl = area.getElementsByTagName('Name')[0];
      if (nameEl) anm = nameEl.textContent.trim();
    }
  }

  const maxi = _xmlText(doc, 'MaxInt');

  return {
    ...baseEntry,
    json: null,
    at,
    mag,
    cod,
    acd,
    anm,
    maxi,
  };
}

/**
 * Normalizes a VXSE61 (顕著な地震の震源要素更新のお知らせ) XML report.
 * Extracts updated magnitude and coordinates from the XML.
 */
function _normalizeVXSE61Entry(baseEntry, doc) {
  const magElements = [
    ...doc.getElementsByTagName('Magnitude'),
    ...doc.getElementsByTagName('jmx_eb:Magnitude'),
  ];
  const mag = magElements.length > 0 ? magElements[0].textContent.trim() : null;

  const cod = _xmlCoordinate(doc);

  return {
    ...baseEntry,
    json: null,
    mag,
    cod,
  };
}

// ─── XML Parsing for Intensity Observations ─────────────────────────────────

/**
 * Parses intensity observations from an already-fetched VXSE51 XML document.
 * Returns the same format as parseFlashIntensityJson from reportUtils.js:
 * { maxIntensity: string|null, observations: Array }
 *
 * @param {Document} xmlDoc - Parsed XML document of a VXSE51 report
 * @returns {{ maxIntensity: string|null, observations: Array }}
 */
export function parseFlashIntensityXml(xmlDoc) {
  const maxInt = _xmlText(xmlDoc, 'MaxInt');
  const observation = xmlDoc.getElementsByTagName('Observation')[0];
  if (!observation) return { maxIntensity: maxInt, observations: [] };

  const prefs = observation.getElementsByTagName('Pref');
  const observations = [];

  for (const pref of prefs) {
    // Only direct Pref children of Observation
    if (pref.parentNode !== observation) continue;

    const prefEntry = {
      code: Number.parseInt(_directChildText(pref, 'Code'), 10),
      name: _directChildText(pref, 'Name') || null,
      maxInt: _directChildText(pref, 'MaxInt') || null,
      areas: [],
    };

    for (const area of pref.getElementsByTagName('Area')) {
      if (area.parentNode !== pref) continue;
      prefEntry.areas.push({
        code: Number.parseInt(_directChildText(area, 'Code'), 10),
        name: _directChildText(area, 'Name') || null,
        maxInt: _directChildText(area, 'MaxInt') || null,
        cities: [], // No cities in 震度速報
      });
    }

    observations.push(prefEntry);
  }

  return { maxIntensity: maxInt, observations };
}

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns text content of the first element with the given tag name in the doc.
 * Handles Atom namespace elements by using getElementsByTagName which works
 * in both namespaced and non-namespaced contexts.
 */
function _atomText(parent, tagName) {
  const el = parent.getElementsByTagName(tagName)[0];
  return el ? el.textContent.trim() : null;
}

/**
 * Returns the href attribute of the first <link type="application/xml"> in an entry.
 */
function _atomLinkHref(atomEntry) {
  const links = atomEntry.getElementsByTagName('link');
  for (const link of links) {
    if (link.getAttribute('type') === 'application/xml') {
      return link.getAttribute('href');
    }
  }
  return null;
}

/**
 * Returns text content of the first element matching tagName in a parsed XML doc.
 */
function _xmlText(doc, tagName) {
  const el = doc.getElementsByTagName(tagName)[0];
  return el ? el.textContent.trim() : null;
}

/**
 * Returns text content of the first direct child element with the given local name.
 */
function _directChildText(parent, tagName) {
  for (const child of parent.children) {
    if (child.localName === tagName) return child.textContent.trim();
  }
  return null;
}

/**
 * Extracts coordinate string from an XML document.
 * Prefers the detailed degree-minute coordinate (type="震源位置（度分）") if present,
 * falling back to the first available Coordinate element.
 *
 * @param {Document} doc
 * @returns {string|null} Coordinate string or null
 */
function _xmlCoordinate(doc) {
  const coordElements = [
    ...doc.getElementsByTagName('Coordinate'),
    ...doc.getElementsByTagName('jmx_eb:Coordinate'),
  ];
  if (coordElements.length === 0) return null;

  const degMinEl = coordElements.find(
    (el) => el.getAttribute('type') === '震源位置（度分）' || el.getAttribute('type')?.includes('度分')
  );
  if (degMinEl) {
    const text = degMinEl.textContent.trim();
    if (text) return text;
  }

  return coordElements[0].textContent.trim() || null;
}
