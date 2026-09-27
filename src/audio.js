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
 * Preloads an audio file into memory and decodes into AudioBuffer.
 * @param {string} path - Path to the audio file (e.g. '/sfx/ping.wav')
 */
export async function preloadAudio(path) {
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
 * Plays an audio file by path using Web Audio API with pre-decoded AudioBuffers.
 * @param {string} path - Path to the audio file
 */
export async function playAudio(path) {
  console.debug(`[audio] Playing audio ${path}`);

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
