// The student's app settings: kept in their games database (on their computer), one set per profile.
// The coach's own settings (which coach, model, start-up prompt) and its notes are kept by the main process instead.
import { kvGet, kvSet } from './db.js';

export const BATCH_PRESETS = {
  fast: { label: 'Fast', nodes: 150_000 },
  standard: { label: 'Standard', nodes: 400_000 },
  deep: { label: 'Deep', nodes: 1_200_000 },
};

export const VOICE_ENGINES = ['natural', 'browser']; // natural: Kokoro in the window; browser: the system's voices (Web Speech)
export const NATURAL_VOICES = {
  af_heart: 'Heart — American English, female',
  af_bella: 'Bella — American English, female',
  af_nicole: 'Nicole — American English, female, soft',
  am_michael: 'Michael — American English, male',
  am_fenrir: 'Fenrir — American English, male',
  am_puck: 'Puck — American English, male',
  bf_emma: 'Emma — British English, female',
  bm_george: 'George — British English, male',
  bm_fable: 'Fable — British English, male',
};

export const cpuThreads = () => Math.max(1, Math.min(32, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4));

function defaults() {
  const cores = cpuThreads();
  return {
    // naturalDownloaded: the natural voice's model is in the window's cache (set by the page after the download)
    voice: { enabled: false, engine: 'natural', naturalVoice: 'af_heart', browserVoice: '', rate: 1, naturalDownloaded: false },
    language: 'English',
    autoComment: 'off', // off | mistakes | all (the coach's comments on moves played on the analysis board)
    profile: { name: '', usernames: [], rating: '', goals: '' },
    engine: {
      liveThreads: Math.max(1, Math.min(8, Math.floor(cores / 2))),
      liveHash: 64,
      liveMultiPv: 3,
      liveMaxSeconds: 60,
      agentThreads: Math.max(1, Math.min(4, Math.floor(cores / 4))),
      agentHash: 32,
      batchWorkers: Math.max(1, Math.min(4, Math.floor(cores / 4))),
      batchThreads: 1,
      batchHash: 16,
      batchPreset: 'standard',
    },
    board: { theme: 'brown', pieces: 'cburnett', sound: true, coords: true, bestArrow: true, evalBar: true },
    lichessToken: '',
  };
}

let settings = null;

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

const int = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const text = (v, max) => String(v ?? '').slice(0, max);

/** Repairs values that are not valid (an older app version, a crafted request). Only known keys are kept. */
function normalize(s) {
  const d = defaults();
  const cores = cpuThreads();
  const usernames = Array.isArray(s.profile?.usernames)
    ? s.profile.usernames
    : String(s.profile?.usernames ?? '')
        .split(',')
        .map(x => x.trim());
  return {
    voice: {
      enabled: !!s.voice?.enabled,
      engine: VOICE_ENGINES.includes(s.voice?.engine) ? s.voice.engine : d.voice.engine,
      naturalVoice: Object.hasOwn(NATURAL_VOICES, s.voice?.naturalVoice) ? s.voice.naturalVoice : d.voice.naturalVoice,
      browserVoice: text(s.voice?.browserVoice, 200),
      rate: Math.max(0.7, Math.min(1.4, Number(s.voice?.rate) || 1)),
      naturalDownloaded: !!s.voice?.naturalDownloaded,
    },
    language: text(s.language, 40).trim() || 'English',
    autoComment: ['off', 'mistakes', 'all'].includes(s.autoComment) ? s.autoComment : d.autoComment,
    profile: {
      name: text(s.profile?.name, 80),
      usernames: [...new Set(usernames.map(x => text(x, 40).trim()).filter(Boolean))].slice(0, 20),
      rating: text(s.profile?.rating, 60),
      goals: text(s.profile?.goals, 1000),
    },
    engine: {
      liveThreads: int(s.engine?.liveThreads, 1, cores, d.engine.liveThreads),
      liveHash: int(s.engine?.liveHash, 1, 512, d.engine.liveHash),
      liveMultiPv: int(s.engine?.liveMultiPv, 1, 5, d.engine.liveMultiPv),
      liveMaxSeconds: int(s.engine?.liveMaxSeconds, 5, 600, d.engine.liveMaxSeconds),
      agentThreads: int(s.engine?.agentThreads, 1, cores, d.engine.agentThreads),
      agentHash: int(s.engine?.agentHash, 1, 512, d.engine.agentHash),
      batchWorkers: int(s.engine?.batchWorkers, 1, 8, d.engine.batchWorkers),
      batchThreads: int(s.engine?.batchThreads, 1, cores, d.engine.batchThreads),
      batchHash: int(s.engine?.batchHash, 1, 256, d.engine.batchHash),
      batchPreset: Object.hasOwn(BATCH_PRESETS, s.engine?.batchPreset) ? s.engine.batchPreset : d.engine.batchPreset,
    },
    board: {
      theme: text(s.board?.theme, 40) || d.board.theme,
      pieces: text(s.board?.pieces, 40) || d.board.pieces,
      sound: s.board?.sound !== false,
      coords: s.board?.coords !== false,
      bestArrow: s.board?.bestArrow !== false,
      evalBar: s.board?.evalBar !== false,
    },
    lichessToken: text(s.lichessToken, 200).trim(),
  };
}

export function loadSettings() {
  settings = normalize(merge(defaults(), kvGet('settings', {})));
  return settings;
}

export function getSettings() {
  return settings || loadSettings();
}

export function updateSettings(patch) {
  settings = normalize(merge(getSettings(), patch && typeof patch === 'object' ? patch : {}));
  kvSet('settings', settings);
  return settings;
}

/** Settings as sent to the page: the Lichess token is replaced by a flag. */
export function publicSettings() {
  const { lichessToken, ...rest } = getSettings();
  return { ...rest, lichessTokenSet: !!lichessToken, batchPresets: BATCH_PRESETS, naturalVoices: NATURAL_VOICES, cpuThreads: cpuThreads() };
}
