export function parseLpgmJson(jsonData) {
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

function _directChildText(parent, tagName) {
  if (!parent) return null;
  for (const child of parent.childNodes) {
    if (child.nodeType === 1 && child.tagName === tagName) {
      return child.textContent.trim();
    }
  }
  return null;
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
