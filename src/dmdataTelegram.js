/**
 * DM-D.S.S. telegram helpers used by the KyoQuake Service provider.
 *
 * The proxy forwards DM-D.S.S. `data` frames unmodified. XML telegrams carry a
 * base64-encoded, gzip-compressed JMA XML document in `body`; the same
 * document is then fed through the existing XML report pipeline.
 */

import {
  FLASH_INTENSITY_TITLE,
  FLASH_EPICENTER_TITLE,
  NORMAL_TITLE,
  DISTANT_EARTHQUAKE_TITLE,
  SPECIAL_TITLE,
  LPGM_TITLE,
} from "./reportUtils.js";

const TELEGRAM_TYPE_TO_TTL = {
  VXSE51: FLASH_INTENSITY_TITLE,
  VXSE52: FLASH_EPICENTER_TITLE,
  VXSE53: NORMAL_TITLE,
  VXSE61: SPECIAL_TITLE,
  VXSE62: LPGM_TITLE,
};

const KNOWN_TITLES = new Set([
  FLASH_INTENSITY_TITLE,
  FLASH_EPICENTER_TITLE,
  NORMAL_TITLE,
  DISTANT_EARTHQUAKE_TITLE,
  SPECIAL_TITLE,
  LPGM_TITLE,
]);

/** Telegram types delivered on the proxy's /eq channel. */
export const EQ_TELEGRAM_TYPES = new Set([
  ...Object.keys(TELEGRAM_TYPE_TO_TTL),
  "IXAC41",
]);

export function isEqTelegram(message) {
  return message?.type === "data" && EQ_TELEGRAM_TYPES.has(message.head?.type);
}

function _xmlHeadTitle(doc) {
  const head = doc?.getElementsByTagName?.("Head")?.[0];
  const title = head?.getElementsByTagName?.("Title")?.[0];
  return title?.textContent?.trim() || null;
}

/**
 * Maps a telegram to the internal report title (`ttl`). The XML head title is
 * preferred because a VXSE53 can be either a normal or a distant-earthquake
 * report.
 *
 * @param {Object} message DM-D.S.S. data frame.
 * @param {Document|null} [doc] Decoded XML document, used as a fallback.
 */
export function getTelegramTtl(message, doc = null) {
  const headTitle = message?.xmlReport?.head?.title || _xmlHeadTitle(doc);
  if (headTitle && KNOWN_TITLES.has(headTitle)) return headTitle;
  return TELEGRAM_TYPE_TO_TTL[message?.head?.type] || null;
}

function _base64ToBytes(base64) {
  const binary = atob(String(base64).replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function _gunzipBytes(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream is not supported");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Decodes the XML text carried by a DM-D.S.S. XML telegram.
 * @returns {Promise<string|null>}
 */
export async function decodeTelegramXmlText(message) {
  if (message?.format !== "xml" || !message.body) return null;
  if (message.compression && message.compression !== "gzip") return null;

  let bytes;
  try {
    bytes =
      message.encoding === "base64"
        ? _base64ToBytes(message.body)
        : new TextEncoder().encode(String(message.body));
    if (message.compression === "gzip") {
      bytes = await _gunzipBytes(bytes);
    }
    return new TextDecoder("utf-8").decode(bytes);
  } catch (err) {
    console.warn("[dmdata] Failed to decode XML telegram:", err.message);
    return null;
  }
}

/**
 * Decodes an XML telegram into a DOM document.
 * @returns {Promise<Document|null>}
 */
export async function decodeTelegramXml(message) {
  const text = await decodeTelegramXmlText(message);
  if (!text || typeof DOMParser === "undefined") return null;

  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    console.warn("[dmdata] Invalid XML in telegram", message?.head?.type);
    return null;
  }
  return doc;
}
