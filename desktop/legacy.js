// Chess Coach 1.x (this app's earlier name and version, a local server app) kept its data in
// %LOCALAPPDATA%\ChessCoach\data\coach.db and config.json. The window can bring it over into its own database: the
// main process reads it here, read-only (node:sqlite).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_DIR } from './store.js';

const DB_FILE = () => join(LEGACY_DIR, 'data', 'coach.db');
const TABLES = ['collections', 'games', 'positions', 'evals', 'analyses', 'reports', 'repertoire', 'exercises'];
const ORDER = { collections: 'id', games: 'id', positions: 'rowid', evals: 'key', analyses: 'game_id', reports: 'id', repertoire: 'id', exercises: 'id' };

let db = null;
async function open() {
  if (db) return db;
  if (!existsSync(DB_FILE())) return null;
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(DB_FILE(), { readOnly: true });
  return db;
}

export function closeLegacy() {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
}

/** What there is to bring over: { found, games, analyses, size, memory } (null fields when absent). */
export async function legacyInfo() {
  try {
    const d = await open();
    if (!d) return { found: false };
    const count = t => {
      try {
        return Number(d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
      } catch {
        return 0;
      }
    };
    return {
      found: true,
      games: count('games'),
      analyses: count('analyses'),
      reports: count('reports'),
      exercises: count('exercises'),
      repertoire: count('repertoire'),
      size: statSync(DB_FILE()).size,
      tables: Object.fromEntries(TABLES.map(t => [t, count(t)])),
    };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

/** One chunk of a table, in a stable order. */
export async function legacyRows(table, offset = 0, limit = 1000) {
  if (!TABLES.includes(table)) throw new Error(`Unknown table ${table}`);
  const d = await open();
  if (!d) return [];
  const lim = Math.max(1, Math.min(2000, Number(limit) || 1000));
  const off = Math.max(0, Number(offset) || 0);
  try {
    return d.prepare(`SELECT * FROM ${table} ORDER BY ${ORDER[table]} LIMIT ? OFFSET ?`).all(lim, off).map(r => {
      const out = {};
      for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? null : v;
      return out;
    });
  } catch {
    return []; // a table the old version did not have
  }
}

/** The 1.x settings worth keeping (profile, language, voice, board, Lichess token, coach choice) and the coach's notes. */
export function legacyConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(join(LEGACY_DIR, 'config.json'), 'utf8').replace(/^\u{FEFF}/u, ''));
  } catch {
    /* none */
  }
  let memory = '';
  try {
    memory = readFileSync(join(LEGACY_DIR, 'data', 'coach-memory.md'), 'utf8');
  } catch {
    /* none */
  }
  const coach = cfg.coach || {};
  return {
    settings: {
      profile: cfg.profile || null,
      language: cfg.language || null,
      autoComment: cfg.autoComment || null,
      voice: cfg.voice ? { enabled: !!cfg.voice.enabled, browserVoice: cfg.voice.browserVoice || '', naturalVoice: cfg.voice.naturalVoice || 'af_heart', rate: cfg.voice.rate || 1 } : null,
      board: cfg.board || null,
      lichessToken: typeof cfg.lichessToken === 'string' ? cfg.lichessToken : '',
    },
    coach: {
      provider: ['claude-code', 'codex', 'gemini'].includes(coach.provider) ? coach.provider : null,
      initialPrompt: coach.initialPrompt || '',
      models: { 'claude-code': coach.claude?.model || '', codex: coach.codex?.model || '', gemini: coach.gemini?.model || '' },
    },
    memory,
  };
}
