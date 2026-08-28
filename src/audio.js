/**
 * Audio playback utilities.
 * Uses HTMLAudioElement with Blob URLs to prevent Tauri IPC hangs during OS sleep
 * and bypass WebKitGTK Web Audio API playback bugs.
 */

/** @type {Map<string, HTMLAudioElement>} */
const _audioCache = new Map();

/**
 * Preloads an audio file into the buffer cache.
 * Call this at startup to prevent IPC fetch hangs when the OS sleeps.
 * @param {string} path - Path to the audio file (e.g. '/sfx/ping.wav')
 */
export async function preloadAudio(path) {
  try {
    if (_audioCache.has(path)) return;
    
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Fetch failed: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    
    const audio = new Audio(url);
    _audioCache.set(path, audio);
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
    let audio = _audioCache.get(path);

    if (!audio) {
      // Fallback if not preloaded
      await preloadAudio(path);
      audio = _audioCache.get(path);
      if (!audio) return;
    }

    console.debug(`[audio] Playing audio ${path}`);

    // Clone the node to allow overlapping playback of the same sound
    const clone = audio.cloneNode();
    clone.play().catch(e => console.warn(`[audio] Playback prevented:`, e));
  } catch (err) {
    console.warn(`[audio] Failed to play ${path}:`, err);
  }
}
