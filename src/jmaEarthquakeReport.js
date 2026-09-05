/**
 * JMAEarthquakeReport
 * Parses a JMA "震源・震度に関する情報" XML report string into structured data.
 * Also supports JSON format "震源・震度情報" via the fromJSON static factory method.
 */
class JMAEarthquakeReport {
  /**
   * @param {string} xmlString - Raw XML report as a string.
   */
  constructor(xmlString) {
    const parser = new DOMParser();
    this._doc = parser.parseFromString(xmlString, "application/xml");

    const parseError = this._doc.querySelector("parsererror");
    if (parseError) {
      throw new Error(`XML parse error: ${parseError.textContent}`);
    }

    this.eventId = this._parseEventId();
    this.originTime = this._parseOriginTime();
    this.hypocenterCode = this._parseHypocenterCode();
    this.hypocenterName = this._parseHypocenterName();
    this.hypocenterEnName = this._parseHypocenterEnName();
    this.magnitude = this._parseMagnitude();
    this.maxIntensity = this._parseMaxIntensity();
    this.coordinates = this._parseCoordinates();
    this.depth = this._parseDepth();
    this.observations = this._parseObservations();
    this.headTitle = this._parseHeadTitle();
    this.freeFormComment = this._parseFreeFormComment();
    this.isDistantEarthquake = this._parseIsDistantEarthquake();
    this.isVolcano = this._parseIsVolcano();
  }

  /**
   * Factory method to create a JMAEarthquakeReport from JSON data.
   * @param {Object} jsonData - Parsed JSON object from JMA API
   * @returns {JMAEarthquakeReport}
   */
  static fromJSON(jsonData) {
    const report = Object.create(JMAEarthquakeReport.prototype);

    report.eventId = report._parseEventIdFromJson(jsonData);
    report.originTime = report._parseOriginTimeFromJson(jsonData);
    report.hypocenterCode = report._parseHypocenterCodeFromJson(jsonData);
    report.hypocenterName = report._parseHypocenterNameFromJson(jsonData);
    report.hypocenterEnName = report._parseHypocenterEnNameFromJson(jsonData);
    report.magnitude = report._parseMagnitudeFromJson(jsonData);
    report.maxIntensity = report._parseMaxIntensityFromJson(jsonData);
    report.coordinates = report._parseCoordinatesFromJson(jsonData);
    report.depth = report._parseDepthFromJson(jsonData);
    report.observations = report._parseObservationsFromJson(jsonData);
    report.headTitle = report._parseHeadTitleFromJson(jsonData);
    report.freeFormComment = report._parseFreeFormCommentFromJson(jsonData);
    report.isDistantEarthquake = !!(
      report.headTitle?.includes("遠地地震に関する情報") ||
      jsonData?.Head?.InfoKind?.includes("遠地地震") ||
      jsonData?.Head?.Headline?.Text?.includes("海外で規模の大きな地震")
    );
    report.isVolcano = !!report.freeFormComment?.includes(
      "実際には、規模の大きな地震は発生していない点に留意してください",
    );

    return report;
  }

  /**
   * Factory method to create a JMAEarthquakeReport from a pre-parsed XML Document.
   * Avoids re-serializing and re-parsing when the Document is already available
   * (e.g. from the XML feed live mode path).
   * @param {Document} xmlDoc - Already-parsed XML Document
   * @returns {JMAEarthquakeReport}
   */
  static fromXmlDoc(xmlDoc) {
    const report = Object.create(JMAEarthquakeReport.prototype);
    report._doc = xmlDoc;

    report.eventId = report._parseEventId();
    report.originTime = report._parseOriginTime();
    report.hypocenterCode = report._parseHypocenterCode();
    report.hypocenterName = report._parseHypocenterName();
    report.hypocenterEnName = report._parseHypocenterEnName();
    report.magnitude = report._parseMagnitude();
    report.maxIntensity = report._parseMaxIntensity();
    report.coordinates = report._parseCoordinates();
    report.depth = report._parseDepth();
    report.observations = report._parseObservations();
    report.headTitle = report._parseHeadTitle();
    report.freeFormComment = report._parseFreeFormComment();
    report.isDistantEarthquake = report._parseIsDistantEarthquake();
    report.isVolcano = report._parseIsVolcano();

    return report;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Return text content of the first element matching a tag name, or null. */
  _text(tagName, context = this._doc) {
    const el = context.getElementsByTagName(tagName)[0];
    return el ? el.textContent.trim() : null;
  }

  // ─── Field parsers ────────────────────────────────────────────────────────

  /** EventID string, e.g. "20260524041507" */
  _parseEventId() {
    return this._text("EventID");
  }

  /**
   * Origin time as a Unix timestamp (seconds).
   * Reads <OriginTime> from the Earthquake element.
   */
  _parseOriginTime() {
    const raw = this._text("OriginTime");
    if (!raw) return null;
    const ms = Date.parse(raw); // handles ISO 8601 with timezone offsets
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  /**
   * Numeric hypocenter area code.
   * Reads the <Code type="震央地名"> inside <Hypocenter>.
   */
  _parseHypocenterCode() {
    const hypocenter = this._doc.getElementsByTagName("Hypocenter")[0];
    if (!hypocenter) return null;
    const codes = hypocenter.getElementsByTagName("Code");
    for (const code of codes) {
      if (code.getAttribute("type") === "震央地名") {
        return Number.parseInt(code.textContent.trim(), 10);
      }
    }
    return null;
  }

  /**
   * Hypocenter name text from <Hypocenter><Area><Name>.
   */
  _parseHypocenterName() {
    const hypocenter = this._doc.getElementsByTagName("Hypocenter")[0];
    if (!hypocenter) return null;
    const area = hypocenter.getElementsByTagName("Area")[0];
    if (!area) return null;
    const nameEl = area.getElementsByTagName("Name")[0];
    return nameEl ? nameEl.textContent.trim() : null;
  }

  /**
   * Hypocenter English name from <Hypocenter><Area><enName> (if present in XML).
   */
  _parseHypocenterEnName() {
    const hypocenter = this._doc.getElementsByTagName("Hypocenter")[0];
    if (!hypocenter) return null;
    const area = hypocenter.getElementsByTagName("Area")[0];
    if (!area) return null;
    const enEl =
      area.getElementsByTagName("enName")[0] || area.getElementsByTagName("jmx_eb:enName")[0];
    if (enEl) return enEl.textContent.trim();
    const names = area.getElementsByTagName("Name");
    for (const n of names) {
      if (n.getAttribute("type")?.includes("英")) {
        return n.textContent.trim();
      }
    }
    return null;
  }

  /**
   * Report title from Head or Control.
   */
  _parseHeadTitle() {
    const head = this._doc.getElementsByTagName("Head")[0];
    if (head) {
      const titleEl = head.getElementsByTagName("Title")[0];
      if (titleEl) return titleEl.textContent.trim();
    }
    const control = this._doc.getElementsByTagName("Control")[0];
    if (control) {
      const titleEl = control.getElementsByTagName("Title")[0];
      if (titleEl) return titleEl.textContent.trim();
    }
    const titleEls = this._doc.getElementsByTagName("Title");
    return titleEls[0] ? titleEls[0].textContent.trim() : null;
  }

  /**
   * FreeFormComment text from <Comments><FreeFormComment>.
   */
  _parseFreeFormComment() {
    const comments = this._doc.getElementsByTagName("Comments")[0];
    if (comments) {
      const freeEl = comments.getElementsByTagName("FreeFormComment")[0];
      if (freeEl) return freeEl.textContent.trim();
    }
    const freeEls = this._doc.getElementsByTagName("FreeFormComment");
    return freeEls[0] ? freeEls[0].textContent.trim() : null;
  }

  /**
   * Identifies distant earthquake reports ('遠地地震に関する情報' in title or headline).
   */
  _parseIsDistantEarthquake() {
    const headTitle = this.headTitle ?? this._parseHeadTitle();
    if (headTitle && headTitle.includes("遠地地震に関する情報")) {
      return true;
    }
    const titles = this._doc.getElementsByTagName("Title");
    for (const el of titles) {
      if (el.textContent.includes("遠地地震に関する情報")) {
        return true;
      }
    }
    const headlines = this._doc.getElementsByTagName("Headline");
    for (const el of headlines) {
      if (el.textContent.includes("海外で規模の大きな地震")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Identifies overseas volcanic eruption reports by checking for the specific notice
   * in FreeFormComment: '実際には、規模の大きな地震は発生していない点に留意してください'.
   */
  _parseIsVolcano() {
    const comment = this.freeFormComment ?? this._parseFreeFormComment();
    return !!(
      comment && comment.includes("実際には、規模の大きな地震は発生していない点に留意してください")
    );
  }

  /** Magnitude as a float, e.g. 3.5 */
  _parseMagnitude() {
    // The element may be namespace-prefixed as jmx_eb:Magnitude
    const candidates = [
      ...this._doc.getElementsByTagName("Magnitude"),
      ...this._doc.getElementsByTagName("jmx_eb:Magnitude"),
    ];
    for (const el of candidates) {
      const text = el.textContent.trim().replace(/^[MＭ]\s*/u, "");
      const v = Number.parseFloat(text);
      if (!Number.isNaN(v)) return v;
    }
    return null;
  }

  /**
   * Maximum observed intensity as a string.
   */
  _parseMaxIntensity() {
    return this._text("MaxInt");
  }

  /**
   * Coordinates parsed from the jmx_eb:Coordinate element.
   * Format may be decimal degrees (±DD.D±DDD.D[±DDDDD]/) or degree-minutes (±DDMM.M±DDDMM.M[±DDDDD]/).
   * Supports coordinates with or without a depth component (e.g. overseas/volcano reports "-06.1+105.4/").
   * Returns { latitude: number, longitude: number } (depth handled separately).
   */
  _parseCoordinates() {
    const raw = this._getCoordinateRaw();
    if (!raw) return null;
    const match = /^([+-])(\d+)(\.\d+)?([+-])(\d+)(\.\d+)?(?:[+-]\d+\.?\d*)?\/$/u.exec(raw);
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

  /**
   * Depth in kilometres (positive value = below surface).
   * The coordinate string encodes depth in metres with the sign inverted
   * (negative = underground), e.g. -10000 → 10 km.
   * Returns null if depth is omitted or unknown.
   */
  _parseDepth() {
    const raw = this._getCoordinateRaw();
    if (!raw) return null;
    const match = /^([+-][\d.]+)([+-][\d.]+)([+-]\d+\.?\d*)\/$/u.exec(raw);
    if (!match) return null;
    const depthMetres = Number.parseFloat(match[3]);
    if (Number.isNaN(depthMetres)) return null;
    // Negative metres = underground; return positive km value.
    return Math.abs(depthMetres) / 1000;
  }

  /** Raw coordinate string shared by coordinates + depth parsers. */
  _getCoordinateRaw() {
    const candidates = [
      ...this._doc.getElementsByTagName("Coordinate"),
      ...this._doc.getElementsByTagName("jmx_eb:Coordinate"),
    ];
    for (const el of candidates) {
      const text = el.textContent.trim();
      if (text) return text;
    }
    return null;
  }

  /**
   * Builds the observations array
   */
  _parseObservations() {
    const observation = this._doc.getElementsByTagName("Observation")[0];
    if (!observation) return [];

    const prefs = observation.getElementsByTagName("Pref");
    const result = [];

    for (const pref of prefs) {
      const prefEntry = {
        code: Number.parseInt(this._directChildText(pref, "Code"), 10),
        name: this._directChildText(pref, "Name"),
        maxInt: this._directChildText(pref, "MaxInt"),
        areas: [],
      };

      for (const area of pref.getElementsByTagName("Area")) {
        // Only direct Area children of this Pref (not nested inside City)
        if (area.parentNode !== pref) continue;

        const areaEntry = {
          code: Number.parseInt(this._directChildText(area, "Code"), 10),
          name: this._directChildText(area, "Name"),
          maxInt: this._directChildText(area, "MaxInt"),
          cities: [],
        };

        for (const city of area.getElementsByTagName("City")) {
          if (city.parentNode !== area) continue;

          const cityEntry = {
            code: Number.parseInt(this._directChildText(city, "Code"), 10),
            name: this._directChildText(city, "Name"),
            maxInt: this._directChildText(city, "MaxInt"),
          };
          // Parse IntensityStation elements within this City
          const stationEls = city.getElementsByTagName("IntensityStation");
          if (stationEls.length > 0) {
            cityEntry.stations = [];
            for (const station of stationEls) {
              if (station.parentNode !== city) continue;
              cityEntry.stations.push({
                name: this._directChildText(station, "Name"),
                code: this._directChildText(station, "Code"),
                int: this._directChildText(station, "Int"),
              });
            }
          }
          areaEntry.cities.push(cityEntry);
        }

        prefEntry.areas.push(areaEntry);
      }

      result.push(prefEntry);
    }

    return result;
  }

  /**
   * Returns the text content of the *direct* child element with the given
   * tag name, ignoring deeper descendants with the same tag.
   */
  _directChildText(parent, tagName) {
    for (const child of parent.children) {
      if (child.localName === tagName) return child.textContent.trim();
    }
    return null;
  }

  /** Returns all parsed fields as a plain object. */
  toJSON() {
    return {
      eventId: this.eventId,
      originTime: this.originTime,
      hypocenterCode: this.hypocenterCode,
      hypocenterName: this.hypocenterName,
      hypocenterEnName: this.hypocenterEnName,
      magnitude: this.magnitude,
      maxIntensity: this.maxIntensity,
      coordinates: this.coordinates,
      depth: this.depth,
      observations: this.observations,
      headTitle: this.headTitle,
      freeFormComment: this.freeFormComment,
      isDistantEarthquake: this.isDistantEarthquake,
      isVolcano: this.isVolcano,
    };
  }

  // ─── JSON Parsing Methods ─────────────────────────────────────────────────

  /** Parse EventID from JSON Head.EventID */
  _parseEventIdFromJson(jsonData) {
    return jsonData?.Head?.EventID || null;
  }

  /** Parse origin time from JSON Body.Earthquake.OriginTime */
  _parseOriginTimeFromJson(jsonData) {
    const raw = jsonData?.Body?.Earthquake?.OriginTime;
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  /** Parse hypocenter code from JSON Body.Earthquake.Hypocenter.Area.Code */
  _parseHypocenterCodeFromJson(jsonData) {
    const code = jsonData?.Body?.Earthquake?.Hypocenter?.Area?.Code;
    if (!code) return null;
    return Number.parseInt(code, 10);
  }

  /** Parse hypocenter name from JSON Body.Earthquake.Hypocenter.Area.Name */
  _parseHypocenterNameFromJson(jsonData) {
    return jsonData?.Body?.Earthquake?.Hypocenter?.Area?.Name || null;
  }

  /** Parse hypocenter English name from JSON Body.Earthquake.Hypocenter.Area.enName */
  _parseHypocenterEnNameFromJson(jsonData) {
    return jsonData?.Body?.Earthquake?.Hypocenter?.Area?.enName || null;
  }

  /** Parse head title from JSON Head.Title or Control.Title */
  _parseHeadTitleFromJson(jsonData) {
    return jsonData?.Head?.Title || jsonData?.Control?.Title || null;
  }

  /** Parse free form comment from JSON Body.Comments.FreeFormComment */
  _parseFreeFormCommentFromJson(jsonData) {
    return jsonData?.Body?.Comments?.FreeFormComment || jsonData?.Comments?.FreeFormComment || null;
  }

  /** Parse magnitude from JSON Body.Earthquake.Magnitude */
  _parseMagnitudeFromJson(jsonData) {
    const mag = jsonData?.Body?.Earthquake?.Magnitude;
    if (!mag) return null;
    const cleaned = String(mag)
      .trim()
      .replace(/^[MＭ]\s*/u, "");
    const v = Number.parseFloat(cleaned);
    return Number.isNaN(v) ? null : v;
  }

  /** Parse max intensity from JSON Body.Intensity.Observation.MaxInt */
  _parseMaxIntensityFromJson(jsonData) {
    return jsonData?.Body?.Intensity?.Observation?.MaxInt || null;
  }

  /** Parse coordinates from JSON Body.Earthquake.Hypocenter.Area.Coordinate */
  _parseCoordinatesFromJson(jsonData) {
    const raw = jsonData?.Body?.Earthquake?.Hypocenter?.Area?.Coordinate;
    if (!raw) return null;
    const match = /^([+-])(\d+)(\.\d+)?([+-])(\d+)(\.\d+)?(?:[+-]\d+\.?\d*)?\/$/u.exec(raw);
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

  /** Parse depth from JSON Body.Earthquake.Hypocenter.Area.Coordinate */
  _parseDepthFromJson(jsonData) {
    const raw = jsonData?.Body?.Earthquake?.Hypocenter?.Area?.Coordinate;
    if (!raw) return null;
    const match = /^([+-][\d.]+)([+-][\d.]+)([+-]\d+\.?\d*)\/$/u.exec(raw);
    if (!match) return null;
    const depthMetres = Number.parseFloat(match[3]);
    if (Number.isNaN(depthMetres)) return null;
    return Math.abs(depthMetres) / 1000;
  }

  /** Parse observations from JSON Body.Intensity.Observation.Pref */
  _parseObservationsFromJson(jsonData) {
    const prefArray = jsonData?.Body?.Intensity?.Observation?.Pref;
    if (!prefArray || !Array.isArray(prefArray)) return [];

    const result = [];
    for (const pref of prefArray) {
      const prefEntry = {
        code: Number.parseInt(pref.Code, 10),
        name: pref.Name || null,
        maxInt: pref.MaxInt || null,
        areas: [],
      };

      const areaArray = pref.Area || [];
      for (const area of areaArray) {
        const areaEntry = {
          code: Number.parseInt(area.Code, 10),
          name: area.Name || null,
          maxInt: area.MaxInt || null,
          cities: [],
        };

        const cityArray = area.City || [];
        for (const city of cityArray) {
          const cityEntry = {
            code: Number.parseInt(city.Code, 10),
            name: city.Name || null,
            maxInt: city.MaxInt || null,
          };
          // Some cities report a Condition (e.g. "震度５弱以上未入電") instead of MaxInt
          if (city.Condition) {
            cityEntry.condition = city.Condition;
          }
          // Parse IntensityStation data (per-station observations within this city)
          const stationArray = city.IntensityStation || [];
          if (stationArray.length > 0) {
            cityEntry.stations = [];
            for (const station of stationArray) {
              const stationEntry = {
                name: station.Name || null,
                code: station.Code || null,
                int: station.Int || null,
              };
              if (station.enName) {
                stationEntry.enName = station.enName;
              }
              cityEntry.stations.push(stationEntry);
            }
          }
          areaEntry.cities.push(cityEntry);
        }

        prefEntry.areas.push(areaEntry);
      }

      result.push(prefEntry);
    }

    return result;
  }
}

export default JMAEarthquakeReport;
