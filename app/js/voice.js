// The coach's voice: plays what the coach says with its speak tool. Two engines, both on the student's computer:
// - natural: Kokoro, a neural voice (js/voice/worker.js) — sounds human; English only; a one-time download (~330 MB;
//   it runs on the graphics card when there is one);
// - browser: the system's voices (Web Speech API; on Windows the voices installed in Windows) — every language.
import { post } from './api.js';
import { state, setState, toast } from './store.js';
import { coachVoiceChanged } from './coachTerm.js';

let ctx = null; // AudioContext for the natural voice
let source = null; // the sound playing now
let gen = 0; // every new utterance (or stop) ends the older playback loops
let pending = null; // what the coach said before the page was allowed to play sound
let blockedNoted = false;
let fallbackNoted = false;

// ---------------------------------------------------------------------------------------------
// The natural voice's worker

let worker = null;
let seq = 0;
const waiting = new Map(); // id -> { resolve, reject, keep (a book's part made in advance: kept when the voice stops) }
let loadWaiters = [];

function voiceWorker() {
  if (worker) return worker;
  worker = new Worker('/js/voice.js', { type: 'module', name: 'plymentor-voice' });
  worker.onmessage = e => {
    const m = e.data || {};
    if (m.type === 'audio' || (m.type === 'error' && m.id)) {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.type === 'audio') w.resolve(m);
      else w.reject(new Error(m.message));
    } else if (m.type === 'progress') for (const l of loadWaiters) l.onProgress?.(m.percent);
    else if (m.type === 'upgrading') toast('Getting the natural voice’s faster model (about 330 MB, once). It speaks as before meanwhile.', 'info', 8000);
    else if (m.type === 'upgraded') toast(m.device === 'webgpu' ? 'The natural voice now runs on your graphics card: no more waiting.' : 'The natural voice now uses its faster model.', 'success', 6000);
    else if (m.type === 'loaded' || m.type === 'error') {
      const list = loadWaiters;
      loadWaiters = [];
      for (const l of list) m.type === 'loaded' ? l.resolve() : l.reject(new Error(m.message));
    }
  };
  worker.onerror = e => {
    const err = new Error(e.message || 'The natural voice stopped working.');
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
    for (const l of loadWaiters) l.reject(err);
    loadWaiters = [];
    worker = null;
  };
  return worker;
}

/**
 * Generates speech for one piece of text: { samples, rate } (the promise has the request's id). speed: the voice's own
 * by default; keep: not dropped when the voice stops (a book's part made in advance); trim: without most of the
 * silence around it.
 */
function speech(text, speed, { keep = false, trim = false } = {}) {
  const id = ++seq;
  const p = new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, keep });
    const v = state.settings?.voice || {};
    voiceWorker().postMessage({ type: 'speak', id, text, voice: v.naturalVoice, speed: speed ?? v.rate, trim });
  });
  p.id = id;
  return p;
}

// Settings → Coach language → BCP 47 language
const LANGS = {
  en: ['english', 'ingilizce', 'englisch'],
  tr: ['türkçe', 'turkce', 'turkish'],
  de: ['deutsch', 'german', 'almanca'],
  es: ['español', 'espanol', 'spanish'],
  fr: ['français', 'francais', 'french'],
  it: ['italiano', 'italian'],
  pt: ['português', 'portugues', 'portuguese'],
  nl: ['nederlands', 'dutch'],
  pl: ['polski', 'polish'],
  ru: ['русский', 'russian'],
  uk: ['українська', 'ukrainian'],
  sv: ['svenska', 'swedish'],
  nb: ['norsk', 'norwegian'],
  da: ['dansk', 'danish'],
  fi: ['suomi', 'finnish'],
  cs: ['čeština', 'cestina', 'czech'],
  el: ['ελληνικά', 'greek'],
  hu: ['magyar', 'hungarian'],
  ro: ['română', 'romana', 'romanian'],
  ar: ['العربية', 'arabic'],
  he: ['עברית', 'hebrew'],
  fa: ['فارسی', 'persian', 'farsi'],
  hi: ['हिन्दी', 'hindi'],
  ja: ['日本語', 'japanese'],
  zh: ['中文', 'chinese', 'mandarin'],
  ko: ['한국어', 'korean'],
  id: ['bahasa', 'indonesian'],
  vi: ['tiếng việt', 'vietnamese'],
};

export function langOf(language) {
  const l = String(language || 'English').trim().toLowerCase();
  for (const [code, names] of Object.entries(LANGS)) if (names.some(n => l.startsWith(n))) return code;
  return /^[a-z]{2}(-|_|$)/.test(l) ? l.slice(0, 2) : 'en';
}

/** Which engine speaks now: the natural voice needs to be downloaded and the coach to speak English. */
export function voiceEngine() {
  const s = state.settings;
  return s?.voice?.engine === 'natural' && s?.voice?.naturalDownloaded && langOf(s?.language) === 'en' ? 'natural' : 'browser';
}

// ---------------------------------------------------------------------------------------------
// Text → speech-friendly text (the coach writes for the ear already; this catches what slips through)

const PIECES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
const SAN =
  /(?<![\w-])(?:(O-O-O|O-O|0-0-0|0-0)|([KQRBN])([a-h])?([1-8])?(x)?([a-h][1-8])|([a-h])(?:(x)([a-h][1-8])|([1-8]))(?:=?([QRBN]))?)([+#])?(?:[!?]{1,2})?(?![\w-])/g;

function sanWords(_m, castle, piece, file, rank, cap, to, pFile, pCap, pTo, pRank, promo, check) {
  let w;
  if (castle) w = castle.replace(/0/g, 'O') === 'O-O-O' ? 'castles queenside' : 'castles kingside';
  else if (piece) w = `${PIECES[piece]}${file || rank ? ` from ${file || ''}${rank || ''}` : ''} ${cap ? 'takes' : 'to'} ${to}`;
  else if (pCap) w = `${pFile} takes ${pTo}`;
  else w = `${pFile}${pRank}`;
  if (promo) w += `, promoting to a ${PIECES[promo]}`;
  if (check) w += check === '#' ? ', checkmate' : ', check';
  return w;
}

export function speechText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ') // code blocks, board diagrams
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links: their text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_)(?=\S)([^*_\n]*?\S)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/(?<![\w.])\d{1,3}\s*\.{1,3}\s*(?=[KQRBNa-hO])/g, '') // move numbers
    .replace(SAN, sanWords)
    .replace(/(^|\s)#(\d+)\b/g, '$1mate in $2')
    .replace(/(^|[\s(])([+-])(\d+(?:\.\d+)?)\b/g, (_m, a, sign, n) => `${a}${sign === '+' ? 'plus' : 'minus'} ${n}`)
    .replace(/\s*(→|->)\s*/g, ' to ')
    .replace(/[ \t]*\n+[ \t]*/g, '. ')
    .replace(/([.!?])(\s*\.)+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Speakable pieces: the first sentence alone (so the voice starts quickly), then up to ~220 characters each. */
function chunks(text, max = 220) {
  const out = [];
  let cur = '';
  const kept = text.replace(/(\d)\.(\d)/g, '$1․$2'); // "1.5" does not end a sentence
  const sentences = kept.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [kept];
  for (const raw of sentences) {
    const s = raw.trim().replace(/․/g, '.');
    if (!s) continue;
    const limit = out.length ? max : 120;
    if (!cur || cur.length + 1 + s.length <= limit) cur = cur ? `${cur} ${s}` : s;
    else {
      out.push(cur);
      cur = s;
    }
    if (!out.length && cur.length >= 40) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out.flatMap(c => (c.length <= 400 ? [c] : c.split(/(?<=[,;:])\s+/)));
}

// ---------------------------------------------------------------------------------------------
// Engines

function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Plays the pieces with the natural voice; the next piece is generated while the current one plays. */
async function playNatural(parts, my) {
  const ac = audio();
  let next = speech(parts[0]);
  for (let i = 0; i < parts.length; i++) {
    let buf;
    try {
      const data = await next;
      if (my !== gen) return;
      if (i + 1 < parts.length) {
        next = speech(parts[i + 1]);
        next.catch(() => {}); // handled when awaited; ignored when the playback stops first
      }
      buf = ac.createBuffer(1, data.samples.length, data.rate);
      buf.copyToChannel(data.samples, 0);
    } catch (e) {
      if (my !== gen) return;
      e.at = i;
      throw e;
    }
    if (my !== gen) return;
    await new Promise(resolve => {
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      src.onended = resolve;
      source = src;
      src.start();
    });
    if (my !== gen) return;
  }
}

export function browserVoices(lang, all = window.speechSynthesis?.getVoices() || []) {
  const score = v => (/natural|neural/i.test(v.name) ? 8 : 0) + (/premium|enhanced/i.test(v.name) ? 6 : 0) + (/google/i.test(v.name) ? 4 : 0) + (/online/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1);
  return all
    .filter(v => (v.lang || '').toLowerCase().replace('_', '-').startsWith(lang))
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

function browserVoice() {
  const all = window.speechSynthesis?.getVoices() || [];
  const want = state.settings?.voice?.browserVoice;
  return (want && all.find(v => v.name === want)) || browserVoices(langOf(state.settings?.language), all)[0] || null;
}

function playBrowser(parts, my) {
  const synth = window.speechSynthesis;
  if (!synth || !parts.length) return Promise.resolve();
  synth.cancel();
  const voice = browserVoice();
  return new Promise(resolve => {
    parts.forEach((text, i) => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || langOf(state.settings?.language);
      u.rate = state.settings?.voice?.rate || 1;
      if (i === parts.length - 1) u.onend = u.onerror = () => resolve();
      if (my === gen) synth.speak(u);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Speaking

const setSpeaking = on => state.coachSpeaking !== on && setState({ coachSpeaking: on });

export function stopSpeaking() {
  gen++;
  for (const [id, w] of waiting)
    if (!w.keep) {
      w.reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
      waiting.delete(id);
    }
  try {
    source?.stop();
  } catch {
    /* already ended */
  }
  source = null;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* no speech synthesis */
  }
  pending = null;
  setSpeaking(false);
}

/** Says `text` now (replacing anything still being said). */
export async function say(text) {
  stopSpeaking();
  const my = gen;
  const parts = chunks(speechText(text));
  if (!parts.length) return;
  setSpeaking(true);
  try {
    if (voiceEngine() === 'natural') {
      try {
        await playNatural(parts, my);
      } catch (e) {
        if (my !== gen) return;
        if (!fallbackNoted) {
          fallbackNoted = true;
          toast(`The natural voice is not available (${e.message}); using the system voice.`, 'error', 7000);
        }
        await playBrowser(parts.slice(e.at || 0), my);
      }
    } else await playBrowser(parts, my);
  } finally {
    if (my === gen) setSpeaking(false);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a book aloud (the Book reader): short parts one after the other — each ends with a move the board plays.
// The natural voice makes the parts ahead of the one being read (the reader asks: prepareReading), in pieces of a
// sentence or a clause, without the silence it puts around them: the reader's own pauses go between them. Reading stops
// when stopSpeaking() is called (pausing, or the coach starting to talk); the parts made in advance are kept for it.

const aborted = () => Object.assign(new Error('stopped'), { name: 'AbortError' });
let utterance = null; // (kept: Chrome may forget an utterance it still speaks, and its end event with it)

/** The voice a book is read with: the natural one (English books) when the student chose and downloaded it. */
export function readingEngine(lang = 'en') {
  const v = state.settings?.voice || {};
  return v.engine === 'natural' && v.naturalDownloaded && lang === 'en' ? 'natural' : 'browser';
}

/** A book is open: the natural voice loads (and warms up) now, so that the reading starts at once. */
export function warmReading(lang = 'en') {
  if (readingEngine(lang) === 'natural') voiceWorker().postMessage({ type: 'load' });
}

/** Starts a reading: the coach's voice stops; returns the reading, for readAloud. */
export function startReading() {
  stopSpeaking();
  return gen;
}

const readingSpeed = speed => (state.settings?.voice?.rate || 1) * speed;

/**
 * A part of a book in pieces for the natural voice, made one after the other: cut after a sentence or a clause, 220
 * characters at most — the first shorter, so that it comes soon (and the model reads 500 characters at most).
 */
export function pieces(text) {
  const out = [];
  let rest = text.trim();
  while (rest) {
    const max = out.length ? 220 : 140;
    if (rest.length <= max) {
      out.push(rest);
      break;
    }
    const head = rest.slice(0, max + 1);
    let cut = -1;
    // (the last sentence's end in it — not a move number's dots: "12... h6" —, else a clause's, a dash or a comma, else
    // a space, not too near its start)
    for (const [re, from] of [[/(?<!\b\d{1,3}\.{0,2})[.!?…]["'”’)\]]*\s/g, 0.2], [/[;:]\s/g, 0.2], [/[,—–]\s/g, 0.2], [/\s/g, 0.35]]) {
      for (const m of head.matchAll(re)) if (m.index >= max * from) cut = m.index + m[0].length;
      if (cut > 0) break;
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return out;
}

/**
 * Starts making the natural voice's audio for a part of a book (null with the system voice): { texts, pieces (promises
 * of their audio), done (once all are made) }. Hand it to readAloud — or to cancelReading when it will not be said.
 */
export function prepareReading(text, { speed = 1, lang = 'en' } = {}) {
  if (readingEngine(lang) !== 'natural') return null;
  const texts = pieces(text);
  const p = { texts, pieces: texts.map(t => speech(t, readingSpeed(speed), { keep: true, trim: true })), done: false };
  for (const piece of p.pieces) piece.catch(() => {});
  Promise.all(p.pieces).then(() => (p.done = true), () => {});
  return p;
}

/** A part made in advance that will not be said: the voice does not make what it has not made yet. */
export function cancelReading(prepared) {
  if (!prepared) return;
  const ids = prepared.pieces.map(p => p.id).filter(id => waiting.has(id));
  for (const id of ids) {
    waiting.get(id).reject(aborted());
    waiting.delete(id);
  }
  if (ids.length) voiceWorker().postMessage({ type: 'cancel', ids });
}

/** Plays a piece of the natural voice after `pause` seconds; resolves when it has been played (or stopped). */
function playPiece(data, pause) {
  const ac = audio();
  const buf = ac.createBuffer(1, data.samples.length, data.rate);
  buf.copyToChannel(data.samples, 0);
  return new Promise(resolve => {
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.onended = resolve;
    source = src;
    src.start(ac.currentTime + Math.max(0, pause));
  });
}

/**
 * Says one part of a book; resolves once it has been said, rejects with an AbortError when the reading has stopped.
 * pause: the silence before it, in seconds at 1× (the natural voice's; the system voice keeps its own).
 */
export async function readAloud(text, { reading, speed = 1, lang = 'en', prepared = null, pause = 0 }) {
  if (reading !== gen) throw aborted();
  if (readingEngine(lang) === 'natural') {
    const p = prepared || prepareReading(text, { speed, lang });
    try {
      const rate = readingSpeed(speed);
      for (const [i, piece] of p.pieces.entries()) {
        const data = await piece;
        if (reading !== gen) throw aborted();
        // (between the pieces of a part: a sentence's pause, or a clause's)
        const before = i === 0 ? pause : /[.!?…]["'”’)\]]*$/.test(p.texts[i - 1]) ? 0.3 : 0.15;
        await playPiece(data, before / rate);
        if (reading !== gen) throw aborted();
      }
      return;
    } catch (e) {
      cancelReading(p);
      if (reading !== gen || e.name === 'AbortError') throw aborted();
      if (!fallbackNoted) {
        fallbackNoted = true;
        toast(`The natural voice is not available (${e.message}); using the system voice.`, 'error', 7000);
      }
    }
  }
  const synth = window.speechSynthesis;
  if (!synth) throw new Error('This computer has no voices for reading aloud.');
  await new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    const voice = readingVoice(lang);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || lang;
    u.rate = Math.max(0.5, Math.min(4, readingSpeed(speed)));
    u.onend = u.onerror = () => (reading === gen ? resolve() : reject(aborted()));
    utterance = u;
    synth.speak(u);
  });
}

function readingVoice(lang) {
  const all = window.speechSynthesis?.getVoices() || [];
  const want = state.settings?.voice?.browserVoice;
  const chosen = want && all.find(v => v.name === want);
  if (chosen && (chosen.lang || '').toLowerCase().startsWith(lang)) return chosen;
  return browserVoices(lang, all)[0] || chosen || null;
}

/** The desktop window may play sound before the first click (its autoplay policy, see desktop/main.js). */
const mayPlay = () => !!window.plymentor || !navigator.userActivation || navigator.userActivation.hasBeenActive;

/** In the Book reader the book's voice reads: the coach does not talk there (its answers stay written in its panel). */
const quietHere = () => /^#\/books(?:[/?]|$)/.test(globalThis.location?.hash || '');

/** The coach's speak tool. */
export function coachSays(ev) {
  if (!state.settings?.voice?.enabled || !ev.text || quietHere()) return;
  if (!mayPlay()) {
    pending = { text: ev.text, at: Date.now() };
    if (!blockedNoted) {
      blockedNoted = true;
      toast('Your coach is talking — click anywhere on the page to hear it.', 'info', 8000);
    }
    return;
  }
  say(ev.text);
}

/** Once per app start: play what the coach said before the first click (if it had to wait), and load the system's voice list. */
export function initVoice() {
  const unlock = () => {
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    const p = pending;
    pending = null;
    if (p && Date.now() - p.at < 90_000 && state.settings?.voice?.enabled && !quietHere()) setTimeout(() => say(p.text), 0);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  try {
    window.speechSynthesis?.getVoices(); // starts loading them (Chrome fills the list asynchronously)
  } catch {
    /* no speech synthesis */
  }
  // load the natural voice in the background when it will be used, so the first sentence is not delayed
  if (state.settings?.voice?.enabled && voiceEngine() === 'natural') voiceWorker().postMessage({ type: 'load' });
}

/** Switches the coach's voice on or off (Settings, the 🔊 button in the coach panel). */
export async function setVoiceEnabled(on) {
  if (!on) stopSpeaking();
  try {
    const settings = await post('/api/settings', { voice: { enabled: !!on } });
    setState({ settings });
    coachVoiceChanged(!!on);
    if (on && settings.voice.engine === 'natural' && !settings.voice.naturalDownloaded && langOf(settings.language) === 'en')
      toast('Coach voice on (the system voice). For the natural voice, download it in Settings → Coach voice.', 'info', 7000);
    else toast(on ? 'Coach voice on' : 'Coach voice off', 'success', 1500);
    if (on && voiceEngine() === 'natural') voiceWorker().postMessage({ type: 'load' });
  } catch (e) {
    toast(e.message, 'error');
  }
}

const SAMPLES = {
  en: "Hi, I'm your chess coach! Knight to f3 is a lovely developing move. Now let's think about castling.",
  tr: 'Merhaba, ben satranç koçunum! Atı f3 karesine getirmek güzel bir gelişim hamlesi. Şimdi rok yapmayı düşünelim.',
  de: 'Hallo, ich bin dein Schachtrainer! Springer nach f3 ist ein schöner Entwicklungszug. Jetzt denken wir an die Rochade.',
  es: '¡Hola, soy tu entrenador de ajedrez! Caballo a f3 es una buena jugada de desarrollo. Ahora pensemos en enrocar.',
  fr: "Bonjour, je suis ton entraîneur d'échecs ! Cavalier en f3 est un joli coup de développement. Pensons maintenant au roque.",
};

/** A test sentence in the coach's language, with the current settings. */
export function sayTest() {
  return say(SAMPLES[langOf(state.settings?.language)] || SAMPLES.en);
}

/** Downloads the natural voice (once) and tests it; onProgress(percent). Marks it as available in the settings. */
export async function installNaturalVoice(onProgress) {
  await new Promise((resolve, reject) => {
    loadWaiters.push({ resolve, reject, onProgress });
    voiceWorker().postMessage({ type: 'load' });
  });
  await speech('Hello! I am your chess coach.');
  const settings = await post('/api/settings', { voice: { naturalDownloaded: true } });
  setState({ settings });
}
