/**
 * Audio playback utilities using the Web Audio API.
 */

/** @type {AudioContext|null} */
let _ctx = null;

/** @type {Map<string, AudioBuffer>} */
const _bufferCache = new Map();

/**
 * Returns the shared AudioContext, creating it on first use.
 */
function _getContext() {
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  return _ctx;
}

/**
 * Preloads an audio file into the buffer cache.
 * Call this at startup to prevent IPC fetch hangs when the OS sleeps.
 * @param {string} path - Path to the audio file (e.g. '/sfx/ping.wav')
 */
export async function preloadAudio(path) {
  try {
    if (_bufferCache.has(path)) return;
    
    const ctx = _getContext();
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
 * @param {string} path - Path to the audio file
 */
export async function playAudio(path) {
  try {
    const ctx = _getContext();

    // Resume context if it was suspended (e.g. by autoplay policy or OS sleep)
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    let buffer = _bufferCache.get(path);

    if (!buffer) {
      // Fallback if not preloaded
      await preloadAudio(path);
      buffer = _bufferCache.get(path);
      if (!buffer) return;
    }

    console.debug(`[audio] Playing audio ${path}`);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      source.disconnect();
    };
    source.start();
  } catch (err) {
    console.warn(`[audio] Failed to play ${path}:`, err);
  }
}
