// The coach's voice, read like a book: what the coach says with its speak tool — a whole reply, however long — is a
// text the student listens to as in the Book reader (components/CoachVoice.js shows it in the coach panel): the
// sentence being said is marked; the reading pauses and goes on, goes a sentence back or on, starts from any sentence
// clicked or from anywhere on its slider, at 1–2×; the coach's earlier texts stay, to be heard again from where they
// were left. A text the coach says while its text of the same turn is being read goes after it (a long reply said in
// parts); a new turn's is read at once. The voices are voice.js's: the natural one makes the parts ahead of the one
// being said, as for a book.
import { useEffect, useState } from '../vendor/preact.js';
import { state, setState, toast } from './store.js';
import { stored, store } from './util.js';
import { speechDoc } from './coachSpeech.js';
import { startReading, prepareReading, cancelReading, readAloud, stopSpeaking, pieces, langOf } from './voice.js';

export const SPEEDS = [1, 1.25, 1.5, 2];
const KEEP = 30; // texts kept to be heard again
const KEEP_CHARS = 400_000;
const AHEAD = 4; // parts the natural voice makes ahead of the one being said (and 600 characters at most)
const WORDS_A_MINUTE = 160; // (how long the rest takes, roughly: the voices at 1×)

let ids = 0;
let turn = 0; // the coach's turns: the student asked something, or the coach started working again

/** The coach began another turn: what it says next is read at once. */
export function coachTurn() {
  turn++;
}

const lang = () => langOf(state.settings?.language);
const speaking = on => state.coachSpeaking !== on && setState({ coachSpeaking: on });
const key = p => `${p.t.id}/${p.s}/${p.p}`;

/** In the Book reader the book's voice reads: the coach does not talk there (its texts wait in its panel elsewhere). */
const quietHere = () => /^#\/books(?:[/?]|$)/.test(globalThis.location?.hash || '');

/**
 * The coach's texts and their reading. A text: speechDoc's { blocks, sentences (each with its parts: what the voice
 * says, in pieces), chars } with { id, turn, heard (its reading began), at: { s, p } (where it is: sentence, part) }.
 */
export class CoachReading {
  constructor() {
    this.texts = [];
    this.cur = -1; // the text shown (and read)
    this.playing = false;
    this.held = false; // stopped in a text before its end (paused by the student, or by another voice)
    const speed = stored('coach.voice.speed', 1);
    this.speed = SPEEDS.includes(speed) ? speed : 1;
    this.run = 0;
    this.audio = new Map(); // key → { speed, text, prepared } (the natural voice's parts made in advance)
    this.listeners = new Set();
    this.failNoted = false;
  }

  emit() {
    for (const l of [...this.listeners]) l();
  }

  get text() {
    return this.texts[this.cur] || null;
  }

  /**
   * What the coach said: a text of its own, read now — or after the one being read when that one is the coach's last,
   * of the same turn (a long reply said in parts), or once the student goes on with it when they paused it. play
   * false: kept and shown, not read (the Book reader). Returns the text, or null when there is nothing to say in it.
   */
  add(raw, { play = true } = {}) {
    const doc = speechDoc(raw);
    // (a sentence is a part, a long one cut after a clause: no utterance of a system voice runs too long)
    for (const s of doc.sentences) s.parts = s.said ? pieces(s.said, 220) : [];
    if (!doc.sentences.some(s => s.parts.length)) return null;
    const t = { ...doc, id: ++ids, turn, heard: false, at: { s: 0, p: 0 } };
    const now = this.text;
    this.texts.push(t);
    this.trim();
    const queued = !!now && now.turn === t.turn && this.texts.indexOf(now) === this.texts.length - 2 && (this.playing || this.held);
    if (play && queued) this.emit();
    else if (play) this.seek(this.texts.length - 1, 0, true);
    else if (!this.playing) {
      this.cur = this.texts.length - 1;
      this.held = false;
      this.emit();
    } else this.emit();
    return t;
  }

  /** The oldest texts go (never the one shown) once there are too many. */
  trim() {
    let chars = this.texts.reduce((n, t) => n + t.chars, 0);
    while (this.texts.length > KEEP || (this.texts.length > 2 && chars > KEEP_CHARS)) {
      const i = this.cur === 0 ? 1 : 0;
      const [old] = this.texts.splice(i, 1);
      chars -= old.chars;
      if (this.cur > i) this.cur--;
      for (const [id, a] of this.audio)
        if (id.startsWith(`${old.id}/`)) {
          cancelReading(a.prepared);
          this.audio.delete(id);
        }
    }
  }

  /**
   * The first part to say at sentence `s`, part `p` of text `t`, or after it there — onward: in the texts after it not
   * heard yet, too (the coach's next parts) —, or null.
   */
  find(t, s, p, onward = true) {
    for (;;) {
      for (; s < t.sentences.length; s++, p = 0) if (p < t.sentences[s].parts.length) return { t, s, p };
      const next = onward && this.texts[this.texts.indexOf(t) + 1];
      if (!next || next.heard) return null;
      t = next;
      s = 0;
      p = 0;
    }
  }

  after(pos) {
    return this.find(pos.t, pos.s, pos.p + 1);
  }

  play() {
    const t = this.text;
    if (this.playing || !t) return;
    if (!this.find(t, t.at.s, t.at.p, false)) t.at = { s: 0, p: 0 }; // (heard to its end: from its start again)
    this.playing = true;
    this.held = false;
    t.heard = true;
    this.loop(++this.run);
    this.emit();
  }

  /** Stops the reading (no "paused" of its own: a seek, or the student's pause). */
  halt() {
    this.playing = false;
    this.run++;
    stopSpeaking();
    this.release();
  }

  pause() {
    if (!this.playing) return;
    this.halt();
    this.held = true;
    this.emit();
    this.warm();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Goes to sentence `s` of text `i` — and reads from there if it was reading, or `play`. */
  seek(i, s = 0, play = this.playing) {
    const t = this.texts[i];
    if (!t) return;
    if (this.playing) this.halt();
    this.cur = i;
    t.at = { s: Math.max(0, Math.min(s, t.sentences.length - 1)), p: 0 };
    if (play) return this.play();
    this.held = true;
    this.emit();
    this.warm();
  }

  /** The next or the previous sentence (dir 1 or -1) with something to say — into the next or the previous text at its end. */
  step(dir) {
    if (!this.text) return;
    let i = this.cur;
    let s = this.text.at.s + dir;
    while (this.texts[i]) {
      const t = this.texts[i];
      for (; s >= 0 && s < t.sentences.length; s += dir) if (t.sentences[s].parts.length) return this.seek(i, s);
      i += dir;
      s = dir > 0 ? 0 : (this.texts[i]?.sentences.length ?? 0) - 1;
    }
  }

  /** Text `i`, where it was left (or from its start, heard to its end) — read if it was reading, or `play`. */
  show(i, play = this.playing) {
    const t = this.texts[i];
    if (!t) return;
    this.seek(i, this.find(t, t.at.s, t.at.p, false) ? t.at.s : 0, play);
  }

  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return;
    this.speed = speed;
    store('coach.voice.speed', speed);
    this.emit();
    this.warm();
  }

  /** Roughly how many minutes the rest of the text takes to say. */
  minutesLeft() {
    const t = this.text;
    if (!t) return 0;
    let words = 0;
    for (let s = t.at.s; s < t.sentences.length; s++) words += t.sentences[s].said.split(/\s+/).filter(Boolean).length;
    return words / (WORDS_A_MINUTE * (state.settings?.voice?.rate || 1) * this.speed);
  }

  /**
   * Has the natural voice make the parts from `from` on in advance (AHEAD of them, `n`), in the reading's order: a part
   * missing before others makes them again after it; the parts made for other places, or at another speed, go.
   */
  prefetch(from, n = AHEAD) {
    const want = new Set();
    let chars = 0;
    let missing = false;
    for (let p = from, k = 0; p && k < n; p = this.after(p), k++) {
      const id = key(p);
      const text = p.t.sentences[p.s].parts[p.p];
      const have = this.audio.get(id);
      if (have && (have.speed !== this.speed || have.text !== text || (missing && !have.prepared.done))) {
        cancelReading(have.prepared);
        this.audio.delete(id);
      }
      if (!this.audio.has(id)) {
        const prepared = prepareReading(text, { speed: this.speed, lang: lang() });
        if (!prepared) return; // (the system voice: nothing is made in advance)
        this.audio.set(id, { speed: this.speed, text, prepared });
        missing = true;
      }
      want.add(id);
      if ((chars += text.length) > 600) break;
    }
    for (const [id, a] of this.audio)
      if (!want.has(id)) {
        cancelReading(a.prepared);
        this.audio.delete(id);
      }
  }

  /** The parts being made but not made yet are not made (the reading stopped: the voice is free for others). */
  release() {
    for (const [id, a] of this.audio)
      if (!a.prepared.done) {
        cancelReading(a.prepared);
        this.audio.delete(id);
      }
  }

  /** Waiting at a place: the natural voice makes the part there, so that ▶ speaks at once. */
  warm() {
    const t = this.text;
    if (this.playing || !t || quietHere() || !state.settings?.voice?.enabled) return;
    const here = this.find(t, t.at.s, t.at.p, false);
    if (here) this.prefetch(here, 1);
  }

  /** All texts gone, nothing being said (tests). */
  clear() {
    if (this.playing) this.halt();
    for (const a of this.audio.values()) cancelReading(a.prepared);
    this.audio.clear();
    this.texts = [];
    this.cur = -1;
    this.held = false;
    this.emit();
  }

  async loop(run) {
    const reading = startReading();
    speaking(true);
    let first = true; // (the first part said starts at once; then a pause before each part — longer for a sentence)
    while (this.playing && run === this.run) {
      const t = this.text;
      const here = t && this.find(t, t.at.s, t.at.p);
      if (!here) {
        // the end (▶ reads it again from its start)
        if (t) t.at = { s: t.sentences.length, p: 0 };
        this.playing = false;
        this.emit();
        break;
      }
      if (here.t !== t) {
        // on to what the coach said after it
        t.at = { s: t.sentences.length, p: 0 };
        this.cur = this.texts.indexOf(here.t);
        here.t.heard = true;
      }
      here.t.at = { s: here.s, p: here.p };
      this.emit();
      // the part's audio (taken: it is said now), the ones after it being made meanwhile
      this.prefetch(here);
      const made = this.audio.get(key(here));
      this.audio.delete(key(here));
      const next = this.after(here);
      if (next) this.prefetch(next);
      const text = here.t.sentences[here.s].parts[here.p];
      try {
        await readAloud(text, { reading, speed: this.speed, lang: lang(), prepared: made?.text === text ? made.prepared : null, pause: first ? 0 : here.p === 0 ? 0.35 : 0.15 });
        first = false;
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.warn('reading the coach’s text aloud failed:', e);
          if (!this.failNoted) {
            this.failNoted = true;
            toast(`Your coach's text could not be read aloud: ${e.message}`, 'error', 7000);
          }
        }
        if (run === this.run && this.playing) {
          // stopped from outside (another reading, the voice switched off, the coach interrupted), or no voice: paused
          this.playing = false;
          this.held = true;
          this.release();
          this.emit();
        }
        break;
      }
      if (run !== this.run || !this.playing) break;
      here.t.at = { s: here.s, p: here.p + 1 };
    }
    if (run === this.run && !this.playing) speaking(false);
  }
}

export const coachReading = new CoachReading();

/** Re-renders the calling component whenever the coach's reading changes. */
export function useCoachReading() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force(x => x + 1);
    coachReading.listeners.add(l);
    return () => coachReading.listeners.delete(l);
  }, []);
  return coachReading;
}

// ---------------------------------------------------------------------------------------------
// The coach's speak tool

/** The desktop window may play sound before the first click (its autoplay policy, see desktop/main.js). */
const mayPlay = () => !!globalThis.window?.plymentor || !globalThis.navigator?.userActivation || navigator.userActivation.hasBeenActive;

let blocked = null; // the text said before the page could play sound: read after the first click
let blockedNoted = false;

function unlock() {
  window.removeEventListener('pointerdown', unlock, true);
  window.removeEventListener('keydown', unlock, true);
  const b = blocked;
  blocked = null;
  const i = b ? coachReading.texts.indexOf(b.t) : -1;
  if (i >= 0 && Date.now() - b.at < 90_000 && state.settings?.voice?.enabled && !quietHere() && !coachReading.playing) setTimeout(() => coachReading.show(i, true), 0);
}

/** The coach's speak tool: what it says is read (kept, not read, in the Book reader — or until the first click). */
export function coachSays(ev) {
  if (!state.settings?.voice?.enabled || !ev.text) return;
  const quiet = quietHere();
  const wait = !quiet && !mayPlay();
  const t = coachReading.add(ev.text, { play: !quiet && !wait });
  if (!wait || !t) return;
  if (!blocked) {
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }
  blocked = { t, at: Date.now() };
  if (!blockedNoted) {
    blockedNoted = true;
    toast('Your coach is talking — click anywhere on the page to hear it.', 'info', 8000);
  }
}
