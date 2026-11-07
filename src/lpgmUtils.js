import { getDirectChildText as _directChildText } from './xmlUtils.js';
import { normalizeIntensityString } from './constants.js';

function _asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Reads a scalar out of a flattened or XML-transposed JSON value. */
function _jsonScalar(value) {
  const current = Array.isArray(value) ? value[0] : value;
  if (current && typeof current === "object") {
    if ("valueOf_" in current) return current.valueOf_ == null ? null : String(current.valueOf_);
    if ("Text" in current) return current.Text == null ? null : String(current.Text);
    return null;
  }
  return current == null ? null : String(current);
}

/**
 * AXIS VXSE62 payloads omit the body-level MaxLgInt fields and only expose the
 * seismic intensity (MaxInt). The LPGM classes are still present in the report
 * headline, e.g. "長周期地震動階級１", together with their forecast areas.
 * Fill the missing MaxLgInt fields from that headline before parsing.
 */
function _fillLpgmFromHeadline(jsonData) {
  const observation = jsonData?.Body?.Intensity?.Observation;
  if (!observation) return;

  const areaClasses = new Map();
  for (const information of _asArray(jsonData?.Head?.Headline?.Information)) {
    for (const item of _asArray(information?.Item)) {
      let classValue = null;
      for (const kind of _asArray(item?.Kind)) {
        const name = _jsonScalar(kind?.Name) || "";
        const match = /階級\s*([1-4１-４])/.exec(name);
        if (match) {
          classValue = normalizeIntensityString(match[1]);
          break;
        }
      }
      if (!classValue) continue;
      for (const area of _asArray(item?.Areas?.Area)) {
        const code = _jsonScalar(area?.Code);
        if (code) areaClasses.set(String(code), classValue);
      }
    }
  }

  if (areaClasses.size === 0) return;

  let maxClass = null;
  for (const pref of _asArray(observation.Pref)) {
    for (const area of _asArray(pref.Area)) {
      if (!area.MaxLgInt) {
        const fallback = areaClasses.get(String(area.Code));
        if (fallback) area.MaxLgInt = fallback;
      }
      const classValue = area.MaxLgInt;
      if (!classValue) continue;

      const numeric = Number.parseInt(classValue, 10);
      if (Number.isFinite(numeric)) {
        maxClass = maxClass == null ? numeric : Math.max(maxClass, numeric);
        const prefNumeric = Number.parseInt(pref.MaxLgInt, 10);
        if (!Number.isFinite(prefNumeric) || numeric > prefNumeric) {
          pref.MaxLgInt = classValue;
        }
      }
    }
  }

  if (!observation.MaxLgInt && maxClass != null) {
    observation.MaxLgInt = String(maxClass);
  }
}

export function parseLpgmJson(jsonData) {
  _fillLpgmFromHeadline(jsonData);
  const maxLgInt = jsonData?.Body?.Intensity?.Observation?.MaxLgInt || null;
  const prefArray = jsonData?.Body?.Intensity?.Observation?.Pref || [];

  const observations = [];

  for (const pref of prefArray) {
    const prefEntry = {
      code: Number.parseInt(pref.Code, 10),
      name: pref.Name || null,
      maxLgInt: pref.MaxLgInt || null,
      areas: [],
    };

    const areaArray = pref.Area || [];
    for (const area of areaArray) {
      const areaEntry = {
        code: Number.parseInt(area.Code, 10),
        name: area.Name || null,
        maxLgInt: area.MaxLgInt || null,
        stations: [], // for possible future use, though the UI only paints areas
      };

      const stationArray = area.IntensityStation || [];
      for (const station of stationArray) {
        areaEntry.stations.push({
          name: station.Name || null,
          code: station.Code || null,
          int: station.MaxLgInt || station.Int || null, // depending on field name
        });
      }

      prefEntry.areas.push(areaEntry);
    }

    observations.push(prefEntry);
  }

  return {
    maxLgInt,
    observations,
  };
}



export function parseLpgmXml(xmlDoc) {
  const observation = xmlDoc.querySelector("Body > Intensity > Observation");
  if (!observation) return null;

  const maxLgInt = _directChildText(observation, "MaxLgInt") || null;
  const observations = [];

  for (const pref of observation.childNodes) {
    if (pref.nodeType !== 1 || pref.tagName !== "Pref") continue;

    const prefEntry = {
      code: Number.parseInt(_directChildText(pref, "Code"), 10),
      name: _directChildText(pref, "Name") || null,
      maxLgInt: _directChildText(pref, "MaxLgInt") || null,
      areas: [],
    };

    for (const area of pref.childNodes) {
      if (area.nodeType !== 1 || area.tagName !== "Area") continue;

      const areaEntry = {
        code: Number.parseInt(_directChildText(area, "Code"), 10),
        name: _directChildText(area, "Name") || null,
        maxLgInt: _directChildText(area, "MaxLgInt") || null,
        stations: [],
      };

      for (const station of area.childNodes) {
        if (station.nodeType !== 1 || station.tagName !== "IntensityStation") continue;
        areaEntry.stations.push({
          name: _directChildText(station, "Name") || null,
          code: _directChildText(station, "Code") || null,
          int: _directChildText(station, "MaxLgInt") || _directChildText(station, "Int") || null,
        });
      }

      prefEntry.areas.push(areaEntry);
    }

    observations.push(prefEntry);
  }

  return {
    maxLgInt,
    observations,
  };
}
