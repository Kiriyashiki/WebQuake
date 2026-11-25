/**
 * IXAC41 (推計震度分布図作図用データ / 250 m estimated intensity mesh) parser.
 *
 * The telegram body is a base64-encoded BUFR edition 3 message. Large messages
 * are split into parts sharing the same (type, author, time) key. This module
 * reassembles split messages and parses the IXAC41-specific descriptors without
 * requiring external WMO/JMA BUFR tables; widths and scales follow the JMA
 * specification No.40102.
 */

import { floatToShindo } from "../eew/physics.js";

const BUFR_SIGNATURE = "BUFR";
const TERMINATOR = "7777";
const ASSEMBLY_TIMEOUT_MS = 10 * 60 * 1000;

const CELL_LAT_SIZE = 1 / 480;
const CELL_LON_SIZE = 1 / 320;

const DESCRIPTOR_WIDTHS = {
  "0-08-193": 7,
  "0-08-198": 2,
  "0-60-003": 4,
  "0-60-002": 7,
  "0-01-242": 7,
  "0-01-240": 10,
  "0-08-194": 7,
  "0-01-241": 10,
  "0-05-021": 16,
  "0-06-021": 13,
  "0-05-002": 15,
  "0-06-002": 16,
  "0-07-061": 14,
  "0-60-001": 7,
  "0-05-240": 7,
  "0-06-240": 7,
  "0-05-241": 4,
  "0-06-241": 4,
  "0-05-242": 4,
  "0-06-242": 4,
  "0-05-243": 3,
  "0-06-243": 3,
};

const REPLICATION_WIDTHS = {
  "0-31-001": 8,
  "0-31-002": 16,
  "0-31-003": 8,
};

// ─── Split-message assembly ──────────────────────────────────────────────────

/** @type {Map<string, {parts: Map<string, Uint8Array>, declared: number|null, timer: any}>} */
const assemblies = new Map();

function base64ToBytes(value) {
  const clean = String(value || "").replace(/\s+/g, "");
  if (!clean) return new Uint8Array(0);
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readUInt24(bytes, offset) {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function ascii(bytes, offset, length) {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[offset + i]);
  return text;
}

function assemblyKey(head) {
  return [head?.type || "", head?.author || "", head?.time || ""].join("|");
}

function partKey(message) {
  return typeof message?.head?.designation === "string"
    ? message.head.designation
    : "";
}

function sortPartKeys(keys) {
  return [...keys].sort((a, b) => {
    if (a === b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    return a < b ? -1 : 1;
  });
}

function clearAssembly(key) {
  const group = assemblies.get(key);
  if (!group) return;
  if (group.timer) clearTimeout(group.timer);
  assemblies.delete(key);
}

/**
 * Drops all in-progress split assemblies. Intended for tests.
 */
export function resetIxac41Assembler() {
  for (const key of assemblies.keys()) clearAssembly(key);
}

/**
 * Ingests one IXAC41 websocket message. Split parts are buffered until the
 * message is complete.
 *
 * @param {Object} message DM-D.S.S. data frame.
 * @returns {{status: "ignored"|"incomplete"|"parsed"|"error", mesh?: Object,
 *   joinedBytes?: number, declaredBytes?: number|null}}
 */
export function ingestIxac41Message(message) {
  if (message?.head?.type !== "IXAC41") return { status: "ignored" };

  let bytes;
  try {
    bytes = base64ToBytes(message.body);
  } catch (err) {
    console.warn("[ixac41] Invalid base64 body:", err.message);
    return { status: "error" };
  }
  if (bytes.length === 0) return { status: "ignored" };

  const key = assemblyKey(message.head);
  let group = assemblies.get(key);
  if (!group) {
    group = { parts: new Map(), declared: null, hasFirstPart: false, timer: null };
    assemblies.set(key, group);
    group.timer = setTimeout(() => {
      console.warn("[ixac41] Dropping incomplete message:", key);
      assemblies.delete(key);
    }, ASSEMBLY_TIMEOUT_MS);
    if (typeof group.timer?.unref === "function") group.timer.unref();
  }

  if (bytes.length >= 7 && ascii(bytes, 0, 4) === BUFR_SIGNATURE) {
    group.declared = readUInt24(bytes, 4);
    group.hasFirstPart = true;
  }
  group.parts.set(partKey(message), bytes);

  const ordered = sortPartKeys(group.parts.keys()).map((part) => group.parts.get(part));
  const joined = concatBytes(ordered);
  const endsWithTerminator =
    joined.length >= 4 && ascii(joined, joined.length - 4, 4) === TERMINATOR;
  const complete =
    group.hasFirstPart &&
    (endsWithTerminator ||
      (group.declared !== null && joined.length === group.declared));

  if (!complete) {
    return {
      status: "incomplete",
      joinedBytes: joined.length,
      declaredBytes: group.declared,
    };
  }

  clearAssembly(key);

  try {
    const mesh = parseIxac41Bufr(joined, message.head);
    if (!mesh) return { status: "error" };
    return { status: "parsed", mesh };
  } catch (err) {
    console.warn("[ixac41] Failed to parse BUFR message:", err.message);
    return { status: "error" };
  }
}

// ─── BUFR bit reader ─────────────────────────────────────────────────────────

class BitReader {
  constructor(bytes, byteOffset = 0, byteLength = bytes.length - byteOffset) {
    this.bytes = bytes;
    this.pos = byteOffset;
    this.bit = 0;
    this.end = byteOffset + byteLength;
  }

  read(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      if (this.pos >= this.end) throw new Error("Unexpected end of BUFR data");
      value = (value << 1) | ((this.bytes[this.pos] >> (7 - this.bit)) & 1);
      this.bit += 1;
      if (this.bit === 8) {
        this.bit = 0;
        this.pos += 1;
      }
    }
    return value;
  }
}

// ─── Descriptor helpers ──────────────────────────────────────────────────────

function descriptorString(value) {
  const f = value >> 14;
  const x = (value >> 8) & 0x3f;
  const y = value & 0xff;
  return `${f}-${String(x).padStart(2, "0")}-${String(y).padStart(3, "0")}`;
}

function descriptorClass(value) {
  return value >> 14;
}

function descriptorX(value) {
  return (value >> 8) & 0x3f;
}

function shindoFromClass(classInt, modifier) {
  if (!Number.isFinite(classInt)) return null;
  if (modifier === 1) return `${classInt}-`;
  if (modifier === 2) return `${classInt}+`;
  return String(classInt);
}

/**
 * Maps a measured intensity value (0.1 units, 0..127) to the shindo label from
 * the message's class table, falling back to the standard JMA mapping.
 */
export function shindoFromIntensity(intensity, classes = []) {
  for (const entry of classes) {
    if (intensity >= entry.lower && intensity <= entry.upper) return entry.shindo;
  }
  return floatToShindo(intensity / 10);
}

function formatJstPrefix(originTimeMs) {
  const jst = new Date(originTimeMs + 9 * 60 * 60 * 1000);
  return (
    String(jst.getUTCFullYear()).padStart(4, "0") +
    String(jst.getUTCMonth() + 1).padStart(2, "0") +
    String(jst.getUTCDate()).padStart(2, "0") +
    String(jst.getUTCHours()).padStart(2, "0") +
    String(jst.getUTCMinutes()).padStart(2, "0")
  );
}

// ─── IXAC41 BUFR parser ──────────────────────────────────────────────────────

/**
 * Parses one complete IXAC41 BUFR message.
 *
 * @param {Uint8Array} bytes Complete base64-decoded BUFR message.
 * @param {Object} [head] Original telegram head, for metadata/key.
 * @returns {Object|null} Mesh object or null when the message is not IXAC41.
 */
export function parseIxac41Bufr(bytes, head = null) {
  if (!bytes || bytes.length < 8) return null;
  if (ascii(bytes, 0, 4) !== BUFR_SIGNATURE) return null;

  const declared = readUInt24(bytes, 4);
  if (declared > 0 && declared <= bytes.length) {
    bytes = bytes.subarray(0, declared);
  }

  const section1Offset = 8;
  if (bytes.length < section1Offset + 3) return null;
  const section1Length = readUInt24(bytes, section1Offset);
  const section3Offset = section1Offset + section1Length;
  if (section3Offset + 3 > bytes.length) return null;

  const section3Length = readUInt24(bytes, section3Offset);
  if (section3Length < 7 || section3Offset + section3Length > bytes.length) return null;

  const descriptorCount = Math.floor((section3Length - 7) / 2);
  const descriptors = new Array(descriptorCount);
  for (let i = 0; i < descriptorCount; i += 1) {
    const offset = section3Offset + 7 + i * 2;
    descriptors[i] = (bytes[offset] << 8) | bytes[offset + 1];
  }

  const section4Offset = section3Offset + section3Length;
  if (section4Offset + 4 > bytes.length) return null;
  const section4Length = readUInt24(bytes, section4Offset);
  if (section4Length < 4 || section4Offset + section4Length > bytes.length) return null;

  const reader = new BitReader(bytes, section4Offset + 4, section4Length - 4);

  const classes = [];
  const meshState = {
    lat1: 0,
    lon1: 0,
    lat2: 0,
    lon2: 0,
    lat3: 0,
    lon3: 0,
    halfLat: 0,
    halfLon: 0,
  };
  let currentClass = {};
  const lats = [];
  const lons = [];
  const intensities = [];
  let maxIntensity = -1;

  const meta = {
    year: null,
    month: null,
    day: null,
    hour: null,
    minute: null,
    reportType: null,
    epicenterCode: null,
    epicenterLat: null,
    epicenterLon: null,
    depth: null,
    magnitude: null,
  };
  let depthScaled = false;

  const readElement = (fxy, kind) => {
    if (fxy.startsWith("2-02-")) {
      if (fxy === "2-02-123") depthScaled = true;
      if (fxy === "2-02-000") depthScaled = false;
      return;
    }

    if (fxy === "3-01-011") {
      const year = reader.read(12);
      meta.year = year < 100 ? 2000 + year : year;
      meta.month = reader.read(4);
      meta.day = reader.read(6);
      return;
    }

    if (fxy === "3-01-012") {
      meta.hour = reader.read(5);
      meta.minute = reader.read(6);
      return;
    }

    const width = DESCRIPTOR_WIDTHS[fxy];
    if (width == null) {
      throw new Error(`Unsupported IXAC41 descriptor ${fxy}`);
    }
    const raw = reader.read(width);

    if (kind === "class") {
      if (fxy === "0-08-198") currentClass.modifier = raw;
      else if (fxy === "0-60-003") currentClass.classInt = raw;
      else if (fxy === "0-60-002") {
        if (currentClass.lower == null) {
          currentClass.lower = raw;
        } else if (currentClass.upper == null) {
          currentClass.upper = raw;
          const shindo = shindoFromClass(currentClass.classInt, currentClass.modifier);
          if (shindo && Number.isFinite(currentClass.classInt)) {
            classes.push({ shindo, lower: currentClass.lower, upper: currentClass.upper });
          }
          currentClass = {};
        }
      }
      return;
    }

    if (kind === "mesh") {
      switch (fxy) {
        case "0-05-240":
          meshState.lat1 = raw;
          break;
        case "0-06-240":
          meshState.lon1 = raw;
          break;
        case "0-05-241":
          meshState.lat2 = raw;
          break;
        case "0-06-241":
          meshState.lon2 = raw;
          break;
        case "0-05-242":
          meshState.lat3 = raw;
          break;
        case "0-06-242":
          meshState.lon3 = raw;
          break;
        case "0-05-243":
          meshState.halfLat = raw;
          break;
        case "0-06-243":
          meshState.halfLon = raw;
          break;
        case "0-60-002": {
          const halfLatIndex = (meshState.halfLat - 1) >> 1;
          const halfLonIndex = (meshState.halfLat - 1) & 1;
          const quarterLatIndex = (meshState.halfLon - 1) >> 1;
          const quarterLonIndex = (meshState.halfLon - 1) & 1;

          const lat =
            meshState.lat1 * (2 / 3) +
            meshState.lat2 / 12 +
            meshState.lat3 / 120 +
            halfLatIndex / 240 +
            quarterLatIndex / 480;
          const lon =
            100 +
            meshState.lon1 +
            meshState.lon2 / 8 +
            meshState.lon3 / 80 +
            halfLonIndex / 160 +
            quarterLonIndex / 320;

          lats.push(lat);
          lons.push(lon);
          intensities.push(raw);
          if (raw > maxIntensity) maxIntensity = raw;
          break;
        }
        default:
          break;
      }
      return;
    }

    switch (fxy) {
      case "0-01-242":
        meta.reportType = raw;
        break;
      case "0-01-240":
        meta.epicenterCode = raw;
        break;
      case "0-05-002":
        meta.epicenterLat = (raw - 9000) / 100;
        break;
      case "0-06-002":
        meta.epicenterLon = (raw - 18000) / 100;
        break;
      case "0-07-061":
        meta.depth = depthScaled ? raw : raw * 0.01;
        break;
      case "0-60-001":
        meta.magnitude = raw === 0 ? null : raw === 127 ? ">8" : raw / 10;
        break;
      default:
        break;
    }
  };

  const processRange = (start, end, repeat, kind) => {
    for (let r = 0; r < repeat; r += 1) {
      let i = start;
      while (i < end) {
        const value = descriptors[i];
        if (value == null) break;
        const f = descriptorClass(value);
        const x = descriptorX(value);

        if (f === 1 && (value & 0xff) === 0) {
          const countDescriptor = descriptors[i + 1];
          if (countDescriptor == null) break;
          const countFxy = descriptorString(countDescriptor);
          const countWidth = REPLICATION_WIDTHS[countFxy];
          if (countWidth == null) {
            throw new Error(`Unsupported IXAC41 replication count ${countFxy}`);
          }
          const count = reader.read(countWidth);
          const groupStart = i + 2;
          const groupEnd = groupStart + x;

          let groupKind = kind;
          const replicationFxy = descriptorString(value);
          if (replicationFxy === "1-05-000") groupKind = "class";
          else if (
            replicationFxy === "1-13-000" ||
            replicationFxy === "1-07-000" ||
            replicationFxy === "1-03-000"
          ) {
            groupKind = "mesh";
          }

          if (count > 0) processRange(groupStart, groupEnd, count, groupKind);
          i = groupEnd;
          continue;
        }

        readElement(descriptorString(value), kind);
        i += 1;
      }
    }
  };

  processRange(0, descriptors.length, 1, "meta");

  if (lats.length === 0) return null;

  const originTimeMs =
    meta.year != null && meta.month != null && meta.day != null &&
    meta.hour != null && meta.minute != null
      ? Date.UTC(meta.year, meta.month - 1, meta.day, meta.hour, meta.minute, 0)
      : null;

  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < lats.length; i += 1) {
    if (lats[i] < minLat) minLat = lats[i];
    if (lats[i] > maxLat) maxLat = lats[i];
    if (lons[i] < minLon) minLon = lons[i];
    if (lons[i] > maxLon) maxLon = lons[i];
  }

  const latArray = Float32Array.from(lats);
  const lonArray = Float32Array.from(lons);
  const intensityArray = Uint8Array.from(intensities);

  return {
    key: assemblyKey(head),
    head,
    announcedTime: head?.time || null,
    announcedTimeMs: head?.time ? Date.parse(head.time) : null,
    originTimeMs,
    originTimeJstPrefix: originTimeMs != null ? formatJstPrefix(originTimeMs) : null,
    epicenterCode: meta.epicenterCode,
    epicenterLat: meta.epicenterLat,
    epicenterLon: meta.epicenterLon,
    depth: meta.depth,
    magnitude: meta.magnitude,
    classes,
    lat: latArray,
    lon: lonArray,
    intensity: intensityArray,
    cellCount: latArray.length,
    bounds: {
      minLat,
      maxLat: maxLat + CELL_LAT_SIZE,
      minLon,
      maxLon: maxLon + CELL_LON_SIZE,
    },
    cellSize: { lat: CELL_LAT_SIZE, lon: CELL_LON_SIZE },
    maxIntensity,
    maxShindo: maxIntensity >= 0 ? shindoFromIntensity(maxIntensity, classes) : null,
    receivedAt: Date.now(),
  };
}
