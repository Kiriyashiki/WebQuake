/**
 * Unified Desktop Bridge
 *
 * Provides a single abstraction layer for desktop-specific capabilities across
 * Tauri (Windows/macOS), Electron (Linux), and standard Web browsers.
 */

export function checkIsTauri() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function checkIsElectron() {
  return typeof window !== "undefined" && Boolean(window.__ELECTRON__);
}

export function checkIsDesktop() {
  return checkIsTauri() || checkIsElectron();
}

export const isTauri = checkIsTauri();
export const isElectron = checkIsElectron();
export const isDesktop = checkIsDesktop();

export function getDesktopType() {
  if (checkIsTauri()) return "tauri";
  if (checkIsElectron()) return "electron";
  return "web";
}

if (typeof window !== "undefined") {
  window.__DESKTOP__ = checkIsDesktop();
}

let _tauriFetch = null;
let _tauriLog = null;
let _tauriOpener = null;

/**
 * Universal desktop fetch that bypasses browser CORS restrictions and provides
 * access to raw response headers (like Cache-Control and Age) in desktop runtimes.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response|Object>}
 */
export async function desktopFetch(url, options = {}) {
  if (checkIsTauri()) {
    if (!_tauriFetch) {
      const mod = await import("@tauri-apps/plugin-http");
      _tauriFetch = mod.fetch;
    }
    return _tauriFetch(url, options);
  }

  if (checkIsElectron() && window.__ELECTRON_API__?.fetch) {
    const res = await window.__ELECTRON_API__.fetch(url, options);
    if (!res.ok && res.status === 0) {
      throw new Error(res.error || `Desktop network request failed for ${url}`);
    }

    const headersMap = new Map(Object.entries(res.headers || {}));
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: {
        get: (name) => headersMap.get(name.toLowerCase()) ?? null,
        has: (name) => headersMap.has(name.toLowerCase()),
        entries: () => headersMap.entries(),
        forEach: (cb) => headersMap.forEach(cb),
      },
      text: async () => res.body || "",
      json: async () => JSON.parse(res.body || "{}"),
    };
  }

  return fetch(url, options);
}

/**
 * Universal desktop file logging.
 *
 * @param {'info'|'warn'|'error'|'debug'|'trace'} level
 * @param {string} message
 */
export async function desktopLog(level, message) {
  if (checkIsTauri()) {
    if (!_tauriLog) {
      _tauriLog = await import("@tauri-apps/plugin-log");
    }
    const logFn = _tauriLog[level] || _tauriLog.info;
    return logFn(message);
  }

  if (checkIsElectron() && window.__ELECTRON_API__?.log) {
    return window.__ELECTRON_API__.log(level, message);
  }
}

/**
 * Universal external URL opener.
 * Opens the URL in the operating system's default web browser.
 *
 * @param {string} url
 */
export async function desktopOpenUrl(url) {
  if (checkIsTauri()) {
    if (!_tauriOpener) {
      _tauriOpener = await import("@tauri-apps/plugin-opener");
    }
    return _tauriOpener.openUrl(url);
  }

  if (checkIsElectron() && window.__ELECTRON_API__?.openUrl) {
    return window.__ELECTRON_API__.openUrl(url);
  }

  window.open(url, "_blank");
}
