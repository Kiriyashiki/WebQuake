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

    this.eventId       = this._parseEventId();
    this.originTime    = this._parseOriginTime();
    this.hypocenterCode = this._parseHypocenterCode();
    this.magnitude     = this._parseMagnitude();
    this.maxIntensity  = this._parseMaxIntensity();
    this.coordinates   = this._parseCoordinates();
    this.depth         = this._parseDepth();
    this.observations  = this._parseObservations();
  }

  /**
   * Factory method to create a JMAEarthquakeReport from JSON data.
   * @param {Object} jsonData - Parsed JSON object from JMA API
   * @returns {JMAEarthquakeReport}
   */
  static fromJSON(jsonData) {
    const report = Object.create(JMAEarthquakeReport.prototype);
    
    report.eventId       = report._parseEventIdFromJson(jsonData);
    report.originTime    = report._parseOriginTimeFromJson(jsonData);
    report.hypocenterCode = report._parseHypocenterCodeFromJson(jsonData);
    report.magnitude     = report._parseMagnitudeFromJson(jsonData);
    report.maxIntensity  = report._parseMaxIntensityFromJson(jsonData);
    report.coordinates   = report._parseCoordinatesFromJson(jsonData);
    report.depth         = report._parseDepthFromJson(jsonData);
    report.observations  = report._parseObservationsFromJson(jsonData);
    
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

    report.eventId       = report._parseEventId();
    report.originTime    = report._parseOriginTime();
    report.hypocenterCode = report._parseHypocenterCode();
    report.magnitude     = report._parseMagnitude();
    report.maxIntensity  = report._parseMaxIntensity();
    report.coordinates   = report._parseCoordinates();
    report.depth         = report._parseDepth();
    report.observations  = report._parseObservations();

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

  /** Magnitude as a float, e.g. 3.5 */
  _parseMagnitude() {
    // The element may be namespace-prefixed as jmx_eb:Magnitude
    const candidates = [
      ...this._doc.getElementsByTagName("Magnitude"),
      ...this._doc.getElementsByTagName("jmx_eb:Magnitude"),
    ];
    for (const el of candidates) {
      const v = Number.parseFloat(el.textContent.trim());
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
   * The value looks like: +35.9+137.3-10000/
   * Returns { latitude: number, longitude: number } (depth handled separately).
   */
  _parseCoordinates() {
    const raw = this._getCoordinateRaw();
    if (!raw) return null;
    // Pattern: ±DD.D±DDD.D±DDDDD/
    // We capture lat and lon here; depth sign is handled in _parseDepth.
    const match = /^([+-]\d+\.?\d*)([+-]\d+\.?\d*)([+-]\d+\.?\d*)\/$/u.exec(raw);
    if (!match) return null;
    return {
      latitude:  Number.parseFloat(match[1]),
      longitude: Number.parseFloat(match[2]),
    };
  }

  /**
   * Depth in kilometres (positive value = below surface).
   * The coordinate string encodes depth in metres with the sign inverted
   * (negative = underground), e.g. -10000 → 10 km.
   */
  _parseDepth() {
    const raw = this._getCoordinateRaw();
    if (!raw) return null;
    const match = /^([+-]\d+\.?\d*)([+-]\d+\.?\d*)([+-]\d+\.?\d*)\/$/u.exec(raw);
    if (!match) return null;
    const depthMetres = Number.parseFloat(match[3]);
    // Negative metres = underground; return positive km value.
    return Math.abs(depthMetres) / 1000;
  }

  /** Raw coordinate string shared by coordinates + depth parsers. */
  _getCoordinateRaw() {
    const candidates = [
      ...this._doc.getElementsByTagName("Coordinate"),
      ...this._doc.getElementsByTagName("jmx_eb:Coordinate"),
    ];
    return candidates[0] ? candidates[0].textContent.trim() : null;
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
        code:   Number.parseInt(this._directChildText(pref, "Code"), 10),
        name:   this._directChildText(pref, "Name"),
        maxInt: this._directChildText(pref, "MaxInt"),
        areas:  [],
      };

      for (const area of pref.getElementsByTagName("Area")) {
        // Only direct Area children of this Pref (not nested inside City)
        if (area.parentNode !== pref) continue;

        const areaEntry = {
          code:   Number.parseInt(this._directChildText(area, "Code"), 10),
          name:   this._directChildText(area, "Name"),
          maxInt: this._directChildText(area, "MaxInt"),
          cities: [],
        };

        for (const city of area.getElementsByTagName("City")) {
          if (city.parentNode !== area) continue;

          const cityEntry = {
            code:   Number.parseInt(this._directChildText(city, "Code"), 10),
            name:   this._directChildText(city, "Name"),
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
                int:  this._directChildText(station, "Int"),
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
      eventId:        this.eventId,
      originTime:     this.originTime,
      hypocenterCode: this.hypocenterCode,
      magnitude:      this.magnitude,
      maxIntensity:   this.maxIntensity,
      coordinates:    this.coordinates,
      depth:          this.depth,
      observations:   this.observations,
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

  /** Parse magnitude from JSON Body.Earthquake.Magnitude */
  _parseMagnitudeFromJson(jsonData) {
    const mag = jsonData?.Body?.Earthquake?.Magnitude;
    if (!mag) return null;
    const v = Number.parseFloat(mag);
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
    // Pattern: ±DD.D±DDD.D±DDDDD/
    const match = /^([+-]\d+\.?\d*)([+-]\d+\.?\d*)([+-]\d+\.?\d*)\/$/u.exec(raw);
    if (!match) return null;
    return {
      latitude:  Number.parseFloat(match[1]),
      longitude: Number.parseFloat(match[2]),
    };
  }

  /** Parse depth from JSON Body.Earthquake.Hypocenter.Area.Coordinate */
  _parseDepthFromJson(jsonData) {
    const raw = jsonData?.Body?.Earthquake?.Hypocenter?.Area?.Coordinate;
    if (!raw) return null;
    const match = /^([+-]\d+\.?\d*)([+-]\d+\.?\d*)([+-]\d+\.?\d*)\/$/u.exec(raw);
    if (!match) return null;
    const depthMetres = Number.parseFloat(match[3]);
    return Math.abs(depthMetres) / 1000;
  }

  /** Parse observations from JSON Body.Intensity.Observation.Pref */
  _parseObservationsFromJson(jsonData) {
    const prefArray = jsonData?.Body?.Intensity?.Observation?.Pref;
    if (!prefArray || !Array.isArray(prefArray)) return [];

    const result = [];
    for (const pref of prefArray) {
      const prefEntry = {
        code:   Number.parseInt(pref.Code, 10),
        name:   pref.Name || null,
        maxInt: pref.MaxInt || null,
        areas:  [],
      };

      const areaArray = pref.Area || [];
      for (const area of areaArray) {
        const areaEntry = {
          code:   Number.parseInt(area.Code, 10),
          name:   area.Name || null,
          maxInt: area.MaxInt || null,
          cities: [],
        };

        const cityArray = area.City || [];
        for (const city of cityArray) {
          const cityEntry = {
            code:   Number.parseInt(city.Code, 10),
            name:   city.Name || null,
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
                int:  station.Int || null,
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
