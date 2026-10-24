// What the app keeps for the coach on the student's computer, per profile:
//   %LOCALAPPDATA%\Plymentor\users\<profile id>\settings.json    the coach's settings (which coach, models, start-up prompt)
//   %LOCALAPPDATA%\Plymentor\users\<profile id>\coach-memory.md  the coach's notes about the student
//                                                  coach-memory.previous.md  the notes before the coach last rewrote them
// (Outside OneDrive. The profile id is a UUID checked before it is used in a path; the app has one profile,
// LOCAL_PROFILE_ID in shared/protocol.js. PLYMENTOR_HOME moves everything elsewhere, e.g. for tests.)
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const localAppData = name => (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, name) : join(homedir(), `.${name.toLowerCase()}`));
export const HOME_DIR = process.env.PLYMENTOR_HOME || localAppData('Plymentor');
// The folder of Chess Coach, this app's earlier name: its version 1.x kept its data there (data\coach.db, config.json),
// the npm copies of the coach programs it installed (cli\) and its portable Node.js (runtime\). Only read, for the 1.x
// import. PLYMENTOR_LEGACY_HOME moves it (tests).
export const LEGACY_DIR = process.env.PLYMENTOR_LEGACY_HOME || localAppData('ChessCoach');
export const PROVIDER_IDS = ['claude-code', 'codex', 'gemini'];
export const MEMORY_SOFT_LIMIT = 12_000;
const MEMORY_HARD_LIMIT = 40_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isAccountId = id => typeof id === 'string' && UUID_RE.test(id);

export function userDir(userId) {
  if (!isAccountId(userId)) throw new Error('Invalid profile id');
  const dir = join(HOME_DIR, 'users', userId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    // a byte-order mark (left by some Windows editors) must not make the file unreadable
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\u{FEFF}/u, ''));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Settings

const DEFAULTS = { provider: 'claude-code', initialPrompt: '', models: { 'claude-code': '', codex: '', gemini: '' } };
// Model names are passed to the CLI as one argument; keep them to plain identifiers.
const MODEL_RE = /^[\w.:@/[\]-]{0,80}$/;

export function normalizeSettings(s = {}) {
  const models = {};
  for (const id of PROVIDER_IDS) {
    const m = String(s.models?.[id] ?? '').trim();
    models[id] = MODEL_RE.test(m) ? m : '';
  }
  return {
    provider: PROVIDER_IDS.includes(s.provider) ? s.provider : DEFAULTS.provider,
    initialPrompt: String(s.initialPrompt ?? '').slice(0, 4000),
    models,
  };
}

export function readSettings(userId) {
  return normalizeSettings(readJson(join(userDir(userId), 'settings.json')) || DEFAULTS);
}

/** Applies a patch from the page; unknown keys and invalid values are dropped. */
export function updateSettings(userId, patch = {}) {
  const cur = readSettings(userId);
  const next = normalizeSettings({
    provider: patch.provider ?? cur.provider,
    initialPrompt: patch.initialPrompt ?? cur.initialPrompt,
    models: { ...cur.models, ...(patch.models && typeof patch.models === 'object' ? patch.models : {}) },
  });
  if (patch.models) for (const id of PROVIDER_IDS) if (patch.models[id] !== undefined && next.models[id] !== String(patch.models[id]).trim()) throw new Error('Model names may only contain letters, digits and . : @ / [ ] - _');
  writeAtomic(join(userDir(userId), 'settings.json'), JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------------------------------------
// The coach's notes about the student

const memoryFile = userId => join(userDir(userId), 'coach-memory.md');

export function readMemory(userId) {
  const f = memoryFile(userId);
  try {
    return existsSync(f) ? readFileSync(f, 'utf8') : '';
  } catch {
    return '';
  }
}

/** keepPrevious: the notes so far are kept in coach-memory.previous.md (the coach rewriting them can be undone). */
export function writeMemory(userId, text, { keepPrevious = false } = {}) {
  const doc = String(text ?? '').slice(0, MEMORY_HARD_LIMIT);
  const before = keepPrevious ? readMemory(userId) : '';
  if (before.trim()) writeAtomic(join(userDir(userId), 'coach-memory.previous.md'), before);
  writeAtomic(memoryFile(userId), doc);
  return doc;
}

/** Appends a note under today's date heading (headings inside the note become bold lines). */
export function appendMemory(userId, note) {
  const clean = String(note ?? '')
    .trim()
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
  if (!clean) return readMemory(userId);
  const doc = readMemory(userId).trimEnd() || '# What the coach knows about the student';
  const heading = `### ${new Date().toLocaleDateString('sv')}`; // YYYY-MM-DD, local time
  const body = /^([-*]|\*\*|\d+\.)\s?/.test(clean) ? clean : `- ${clean}`;
  const sameDay = doc.match(/^### .*$/gm)?.at(-1) === heading;
  return writeMemory(userId, `${doc}${sameDay ? '\n' : `\n\n${heading}\n`}${body}\n`);
}

export const memoryPath = userId => memoryFile(userId);
