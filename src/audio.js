/**
 * Audio playback utilities using the Web Audio API.
 */

/** @type {AudioContext|null} */
let _ctx = null;

/** @type {Map<string, AudioBuffer>} */
const _bufferCache = new Map();

/**
 * Returns the shared AudioContext, creating it on first use.
 * WebKit requires an AudioContext to be created (or resumed) from a user
 * gesture, but in practice Tauri desktop apps are not subject to autoplay
 * restrictions.
 */
function _getContext() {
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  return _ctx;
}

/**
 * Plays an audio file by path. Fetches and decodes on first call,
 * then replays from cache.
 * @param {string} path - Path to the audio file (e.g. '/sfx/ping.wav')
 */
export async function playAudio(path) {
  try {
    const ctx = _getContext();

    // Resume context if it was suspended (e.g. by autoplay policy)
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    let buffer = _bufferCache.get(path);

    if (!buffer) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Fetch failed: HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = await ctx.decodeAudioData(arrayBuffer);
      _bufferCache.set(path, buffer);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (err) {
    console.warn(`[audio] Failed to play ${path}:`, err);
  }
}
