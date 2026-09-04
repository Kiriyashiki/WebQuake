const IS_TAURI = Boolean(window.__TAURI_INTERNALS__);

/** @type {AudioContext|null} */
let _ctx = null;

/** @type {Map<string, AudioBuffer>} */
const _bufferCache = new Map();

function _getContext() {
  if (!_ctx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      _ctx = new AudioContextClass();
    }
  }
  return _ctx;
}

// Automatically unlock Web Audio API on first user interaction in browser
if (typeof window !== "undefined") {
  const unlock = () => {
    if (_ctx && _ctx.state === "suspended") {
      _ctx.resume().catch(() => {});
    }
  };
  window.addEventListener("click", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

/**
 * Preloads an audio file into memory.
 * In Tauri, sounds are embedded into the native binary for zero-latency playback.
 * In browser, decodes into AudioBuffer.
 * @param {string} path - Path to the audio file (e.g. '/sfx/ping.wav')
 */
export async function preloadAudio(path) {
  if (IS_TAURI) return;

  try {
    if (_bufferCache.has(path)) return;
    const ctx = _getContext();
    if (!ctx) return;

    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Fetch failed: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    _bufferCache.set(path, buffer);
  } catch (err) {
    console.warn(`[audio] Failed to preload ${path}:`, err);
  }
}

/**
 * Plays an audio file by path.
 * In Tauri, uses native Rust playback via pw-play/paplay/aplay to bypass WebKitGTK GStreamer deadlocks.
 * In browser, uses Web Audio API with pre-decoded AudioBuffers.
 * @param {string} path - Path to the audio file
 */
export async function playAudio(path) {
  console.debug(`[audio] Playing audio ${path}`);

  // 1. Native Tauri playback: completely bypasses WebKitGTK and GStreamer deadlocks
  if (IS_TAURI && window.__TAURI_INTERNALS__?.invoke) {
    try {
      await window.__TAURI_INTERNALS__.invoke("play_sound", { name: path });
      return;
    } catch (err) {
      console.warn(`[audio] Native play_sound failed, falling back to Web Audio:`, err);
    }
  }

  // 2. Web Audio API fallback (for browser or if native command failed)
  try {
    const ctx = _getContext();
    if (!ctx) return;

    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    let buffer = _bufferCache.get(path);
    if (!buffer) {
      await preloadAudio(path);
      buffer = _bufferCache.get(path);
      if (!buffer) return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (err) {
    console.warn(`[audio] Failed to play ${path}:`, err);
  }
}
