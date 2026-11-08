// Move sounds (lichess "sfx" set, AGPLv3+). Played through Web Audio — at once, however quickly they follow each other (a
// student holding ← or →) —; with an <audio> element until a sound is decoded, or where it can't be.
import { state } from './store.js';
import { holding } from './hold.js';

const VOLUME = 0.6;
const MOVES = ['Move', 'Capture', 'Check', 'Checkmate'];
// (in the lichess set these two are links to another sound: their files here only hold its name)
const SAME_AS = { Checkmate: 'Check', Confirmation: 'GenericNotify' };
const cache = {};
const decoded = {}; // name → its AudioBuffer (null: on its way, or it could not be decoded)
let context = null;
let last = null; // the move's sound playing now

function audio(name) {
  if (!cache[name]) {
    cache[name] = new Audio(`/assets/sound/${name}.mp3`);
    cache[name].volume = VOLUME;
  }
  return cache[name];
}

const audioContext = () => (context ||= new AudioContext());

function load(name) {
  if (name in decoded) return;
  decoded[name] = null;
  fetch(`/assets/sound/${name}.mp3`)
    .then(r => r.arrayBuffer())
    .then(data => audioContext().decodeAudioData(data))
    .then(buffer => (decoded[name] = buffer))
    .catch(() => {});
}

/**
 * A line learned: a little ping — two soft notes a fifth apart, made here (no sound file), each up at once and dying away
 * like a small bell.
 */
export function pingSound() {
  if (state.settings && state.settings.board?.sound === false) return;
  try {
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t = ctx.currentTime + 0.01;
    for (const [note, after, level] of [[1318.5, 0, 0.1], [1975.5, 0.085, 0.08]])
      for (const [overtone, share] of [[1, 1], [2, 0.16]]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = note * overtone;
        gain.gain.setValueAtTime(0.0001, t + after);
        gain.gain.exponentialRampToValueAtTime(level * share, t + after + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + after + 0.55 / overtone);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t + after);
        osc.stop(t + after + 0.58);
      }
  } catch {
    /* audio unavailable */
  }
}

export function sound(asked) {
  if (state.settings && state.settings.board?.sound === false) return;
  const name = SAME_AS[asked] || asked;
  try {
    for (const n of [...MOVES.map(m => SAME_AS[m] || m), name]) load(n);
    const buffer = decoded[name];
    if (!buffer) {
      const a = audio(name);
      a.currentTime = 0;
      a.play().catch(() => {});
      return;
    }
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = holding() ? VOLUME * 0.6 : VOLUME; // (dozens of them a second, going through a game)
    source.buffer = buffer;
    source.connect(gain).connect(ctx.destination);
    if (MOVES.includes(asked)) {
      // (each move's sound cuts the one before: they do not pile up)
      try {
        last?.stop();
      } catch {
        /* over already */
      }
      last = source;
    }
    source.start();
  } catch {
    /* audio unavailable */
  }
}

export function moveSound({ capture, check, mate } = {}) {
  sound(mate ? 'Checkmate' : check ? 'Check' : capture ? 'Capture' : 'Move');
}

/** The sound of a move taken back: its piece's, not the check or mate it gave. */
export const backSound = ({ capture } = {}) => sound(capture ? 'Capture' : 'Move');
