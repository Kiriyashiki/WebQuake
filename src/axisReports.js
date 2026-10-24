/**
 * AXIS WebSocket report adapter.
 *
 * AXIS sends JMA reports on the `jmx-seismology` channel using the XML data
 * model transposed to JSON: repeated XML elements become arrays and element
 * values become objects such as `{ valueOf_: "..." }`.
 *
 * The rest of the app works with either the flattened JMA JSON feed format or
 * the XML DOM.  This module converts AXIS payloads into both:
 *   - a normalized live-feed entry (for liveMode.js)
 *   - JMA-JSON-shaped data (for the existing report parsers)
 */

import {
  FLASH_INTENSITY_TITLE,
  FLASH_EPICENTER_TITLE,
  NORMAL_TITLE,
  DISTANT_EARTHQUAKE_TITLE,
  SPECIAL_TITLE,
  LPGM_TITLE,
  parseFlashIntensityJson,
} from "./reportUtils.js";
import { parseLpgmJson } from "./lpgmUtils.js";
import { AXIS_REPORT_CHANNEL } from "./constants.js";

export { AXIS_REPORT_CHANNEL };

const AXIS_TITLE_TO_TTL = {
  "震度速報": FLASH_INTENSITY_TITLE,
  "震源に関する情報": FLASH_EPICENTER_TITLE,
  "震源・震度情報": NORMAL_TITLE,
  "震源・震度に関する情報": NORMAL_TITLE,
  "遠地地震に関する情報": DISTANT_EARTHQUAKE_TITLE,
  "顕著な地震の震源要素更新のお知らせ": SPECIAL_TITLE,
  "長周期地震動に関する観測情報": LPGM_TITLE,
};

/** Returns the first element when an XML-transposed value is an array. */
function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Accepts either the WebSocket envelope ({ channel, message }) or the inner
 * `message` payload.
 */
function unwrapAxisMessage(message) {
  if (
    message &&
    typeof message === "object" &&
    message.channel &&
    message.message &&
    typeof message.message === "object"
  ) {
    return message.message;
  }
  return message;
}

/** Returns a list for fields that may be a single element or an array. */
function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Converts a transposed XML value to its scalar text representation.
 * Handles `{ valueOf_: ... }`, `{ Text: ... }`, arrays and plain values.
 */
function scalar(value) {
  let current = first(value);
  if (current && typeof current === "object" && !Array.isArray(current)) {
    if ("valueOf_" in current) {
      current = current.valueOf_;
    } else if ("Text" in current) {
      current = current.Text;
    } else {
      return null;
    }
  }
  if (current == null) return null;
  return String(current);
}

function axisTitle(message) {
  return (
    scalar(message?.Head?.Title) ||
    scalar(message?.Control?.Title) ||
    scalar(message?.Head?.InfoKind) ||
    null
  );
}

function axisTtl(message) {
  const title = axisTitle(message);
  if (!title) return null;
  return AXIS_TITLE_TO_TTL[title] || null;
}

function normalizeArea(area) {
  if (!area || typeof area !== "object") return null;
  return {
    ...area,
    Name: scalar(area.Name),
    Code: scalar(area.Code),
    Coordinate: scalar(area.Coordinate),
    enName: scalar(area.enName),
  };
}

function normalizeEarthquake(message) {
  const earthquake = first(message?.Body?.Earthquake);
  if (!earthquake || typeof earthquake !== "object") return null;

  return {
    ...earthquake,
    OriginTime: scalar(earthquake.OriginTime),
    ArrivalTime: scalar(earthquake.ArrivalTime),
    Magnitude: scalar(earthquake.Magnitude),
    Hypocenter: earthquake.Hypocenter
      ? {
          ...earthquake.Hypocenter,
          Area: normalizeArea(earthquake.Hypocenter.Area),
        }
      : undefined,
  };
}

function normalizeCity(city) {
  const entry = {
    ...city,
    Code: scalar(city.Code),
    Name: scalar(city.Name),
    MaxInt: scalar(city.MaxInt),
    MaxLgInt: scalar(city.MaxLgInt),
    Condition: scalar(city.Condition),
    IntensityStation: asArray(city.IntensityStation).map((station) => ({
      ...station,
      Code: scalar(station.Code),
      Name: scalar(station.Name),
      Int: scalar(station.Int),
      MaxLgInt: scalar(station.MaxLgInt),
      enName: scalar(station.enName),
    })),
  };
  return entry;
}

function normalizeAreaObservation(area) {
  return {
    ...area,
    Code: scalar(area.Code),
    Name: scalar(area.Name),
    MaxInt: scalar(area.MaxInt),
    MaxLgInt: scalar(area.MaxLgInt),
    City: asArray(area.City).map(normalizeCity),
  };
}

function normalizePref(pref) {
  return {
    ...pref,
    Code: scalar(pref.Code),
    Name: scalar(pref.Name),
    MaxInt: scalar(pref.MaxInt),
    MaxLgInt: scalar(pref.MaxLgInt),
    Area: asArray(pref.Area).map(normalizeAreaObservation),
  };
}

function normalizeObservation(observation) {
  if (!observation || typeof observation !== "object") return null;
  return {
    ...observation,
    MaxInt: scalar(observation.MaxInt),
    MaxLgInt: scalar(observation.MaxLgInt),
    Pref: asArray(observation.Pref).map(normalizePref),
  };
}

function normalizeComments(comments) {
  if (!comments || typeof comments !== "object") return comments;
  const result = { ...comments };
  for (const key of Object.keys(result)) {
    const value = first(result[key]);
    if (value && typeof value === "object") {
      result[key] = scalar(value.Text ?? value.valueOf_);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Converts an AXIS message into the flattened JSON shape used by the JMA
 * report parsers (the `json` files referenced by JMA's list.json).
 *
 * @param {Object} message - AXIS `message` payload
 * @returns {Object|null}
 */
export function axisMessageToJmaJson(message) {
  message = unwrapAxisMessage(message);
  if (!message || typeof message !== "object") return null;

  const body = message.Body || {};
  const earthquake = normalizeEarthquake(message);
  const observation = first(body.Intensity?.Observation);
  const comments = first(body.Comments);

  return {
    Control: message.Control ? { ...message.Control } : undefined,
    Head: message.Head ? { ...message.Head } : undefined,
    Body: {
      ...body,
      Earthquake: earthquake || undefined,
      Intensity: body.Intensity
        ? {
            ...body.Intensity,
            Observation: normalizeObservation(observation),
          }
        : undefined,
      Comments: comments ? normalizeComments(comments) : undefined,
    },
  };
}

/**
 * Builds a normalized live-feed entry from an AXIS message, compatible with
 * the entries produced by xmlFeedParser.js.
 *
 * @param {Object} message - AXIS `message` payload
 * @returns {Object|null}
 */
export function normalizeAxisMessage(message) {
  message = unwrapAxisMessage(message);
  if (!message || typeof message !== "object") return null;

  const ttl = axisTtl(message);
  if (!ttl) return null;

  const json = axisMessageToJmaJson(message);
  const head = json?.Head || {};
  const control = json?.Control || {};
  const earthquake = json?.Body?.Earthquake || null;
  const area = earthquake?.Hypocenter?.Area || null;
  const observation = json?.Body?.Intensity?.Observation || null;

  const eid = scalar(head.EventID);
  if (!eid) return null;

  const reportDateTime = scalar(head.ReportDateTime) || scalar(control.DateTime) || null;
  const rdt = scalar(control.DateTime) || reportDateTime;
  const maxi = observation?.MaxInt ?? observation?.MaxLgInt ?? null;

  return {
    eid,
    ttl,
    rdt,
    reportDateTime,
    serial: scalar(head.Serial) || null,
    at: scalar(earthquake?.OriginTime) || scalar(head.TargetDateTime) || null,
    mag: earthquake?.Magnitude ?? null,
    cod: area?.Coordinate ?? null,
    acd: area?.Code ?? null,
    anm: area?.Name ?? null,
    maxi,
    json: null,
    source: "axis",
    _axisMessage: message,
  };
}

/**
 * Parses a VXSE51 AXIS message into area-level flash observations.
 * @param {Object} message
 * @returns {{ maxIntensity: string|null, observations: Array }}
 */
export function parseAxisIntensity(message) {
  return parseFlashIntensityJson(axisMessageToJmaJson(message));
}

/**
 * Parses a VXSE62 AXIS message into LPGM observations.
 * @param {Object} message
 * @returns {{ maxLgInt: string|null, observations: Array }}
 */
export function parseAxisLpgm(message) {
  return parseLpgmJson(axisMessageToJmaJson(message));
}
