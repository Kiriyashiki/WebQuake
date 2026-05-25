/**
 * JMAEarthquakeReport
 * Parses a JMA "震源・震度に関する情報" XML report string into structured data.
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
    const match = raw.match(/^([+-]\d+\.?\d*)([+-]\d+\.?\d*)([+-]\d+\.?\d*)\/$/);
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
    const match = raw.match(/^([+-]\d+\.?\d*)([+-]\d+\.?\d*)([+-]\d+\.?\d*)\/$/);
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

          areaEntry.cities.push({
            code:   Number.parseInt(this._directChildText(city, "Code"), 10),
            name:   this._directChildText(city, "Name"),
            maxInt: this._directChildText(city, "MaxInt"),
          });
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
}

export default JMAEarthquakeReport;
