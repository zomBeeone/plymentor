// Move sounds (lichess "sfx" set, AGPLv3+).
import { state } from './store.js';

const cache = {};
function audio(name) {
  if (!cache[name]) {
    cache[name] = new Audio(`/assets/sound/${name}.mp3`);
    cache[name].volume = 0.6;
  }
  return cache[name];
}

export function sound(name) {
  if (state.settings && state.settings.board?.sound === false) return;
  try {
    const a = audio(name);
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch {
    /* audio unavailable */
  }
}

export function moveSound({ capture, check, mate } = {}) {
  sound(mate ? 'Checkmate' : check ? 'Check' : capture ? 'Capture' : 'Move');
}
