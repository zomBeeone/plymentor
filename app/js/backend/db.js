// The student's games database: SQLite compiled to WebAssembly, stored in the origin-private file system (OPFS) of
// the Plymentor window — on the student's computer, in %LOCALAPPDATA%\Plymentor\app — one database per profile. It
// runs inside the backend worker, where OPFS file handles can be used synchronously, so the API stays synchronous
// (run / get / all / tx), as it was with node:sqlite. In Node (unit tests) the same SQLite build runs in memory.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  hash TEXT UNIQUE,
  white TEXT, black TEXT, white_elo INTEGER, black_elo INTEGER,
  result TEXT, date TEXT, event TEXT, site TEXT, round TEXT,
  eco TEXT, opening TEXT, time_control TEXT, termination TEXT,
  start_fen TEXT,
  ply_count INTEGER NOT NULL DEFAULT 0,
  moves TEXT NOT NULL DEFAULT '',
  sans TEXT NOT NULL DEFAULT '',
  clocks TEXT,
  pgn TEXT,
  headers TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS games_white ON games(white COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS games_black ON games(black COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS games_collection ON games(collection_id);

CREATE TABLE IF NOT EXISTS positions (
  key TEXT NOT NULL,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  uci TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_key ON positions(key);
CREATE INDEX IF NOT EXISTS positions_game ON positions(game_id);

CREATE TABLE IF NOT EXISTS evals (
  key TEXT PRIMARY KEY,
  depth INTEGER, nodes INTEGER,
  cp INTEGER, mate INTEGER,
  best TEXT, pv TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS analyses (
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  nodes INTEGER,
  data TEXT NOT NULL,
  white_acc REAL, black_acc REAL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  params TEXT,
  progress TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  title TEXT,
  player TEXT,
  game_ids TEXT NOT NULL,
  stats TEXT,
  narrative TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS repertoire (
  id INTEGER PRIMARY KEY,
  color TEXT NOT NULL,
  key TEXT NOT NULL,
  fen TEXT NOT NULL,
  uci TEXT NOT NULL,
  san TEXT NOT NULL,
  comment TEXT,
  due INTEGER,
  interval REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(color, key, uci)
);
CREATE INDEX IF NOT EXISTS repertoire_key ON repertoire(color, key);

CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY,
  fen TEXT NOT NULL UNIQUE,
  solution TEXT NOT NULL,
  prompt TEXT,
  themes TEXT,
  source TEXT,
  game_id INTEGER,
  ply INTEGER,
  data TEXT,
  due INTEGER,
  interval REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- app settings and small bits of state (JSON values)
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let sqlite3 = null;
export let db = null;
let pool = null;
const cache = new Map();

const DB_FILE = '/coach.db';

/**
 * Opens the database of one profile. userId: the profile id (a UUID); memory: an in-memory database (tests).
 * Returns { persistent }.
 */
export async function openDatabase({ userId, memory = false, wasmUrl } = {}) {
  if (db) throw new Error('The database is already open');
  if (!memory && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(userId))) throw new Error('Invalid profile id');
  // Only the "opfs-sahpool" storage is used; the other OPFS back-ends would start helper workers for nothing.
  globalThis.sqlite3ApiConfig = { ...globalThis.sqlite3ApiConfig, disable: { vfs: { opfs: true, 'opfs-vfs': true, 'opfs-wl': true } } };
  sqlite3 ||= await sqlite3InitModule({
    print: () => {},
    printErr: (...a) => console.warn('[sqlite]', ...a),
    ...(wasmUrl ? { locateFile: () => wasmUrl } : {}),
  });
  let persistent = false;
  if (!memory) {
    if (typeof sqlite3.installOpfsSAHPoolVfs !== 'function') throw new Error('The database cannot be stored (OPFS is missing).');
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: `plymentor-${userId}`, directory: `/plymentor/${userId}`, initialCapacity: 6 });
    db = new pool.OpfsSAHPoolDb(DB_FILE);
    persistent = true;
  } else db = new sqlite3.oo1.DB(':memory:', 'c');
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA journal_mode = ${persistent ? 'TRUNCATE' : 'MEMORY'};`);
  dropForeignSchema();
  db.exec(SCHEMA);
  const version = get('PRAGMA user_version')?.user_version || 0;
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  // Jobs interrupted by closing the page can never finish.
  run(`UPDATE jobs SET status = 'interrupted', finished_at = ? WHERE status IN ('queued', 'running')`, now());
  return { persistent };
}

/**
 * The app makes no triggers or views: any in the file came with a backup from elsewhere (a trigger runs its own SQL
 * whenever the app writes), so they go before anything else runs; and the file's schema may not call functions with
 * side effects (trusted_schema off).
 */
export function dropForeignSchema() {
  db.exec('PRAGMA trusted_schema = OFF;');
  for (const { type, name } of all(`SELECT type, name FROM sqlite_schema WHERE type IN ('trigger', 'view')`))
    db.exec(`DROP ${type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS "${String(name).replace(/"/g, '""')}"`);
}

export function closeDatabase() {
  for (const s of cache.values()) {
    try {
      s.finalize();
    } catch {
      /* already finalized */
    }
  }
  cache.clear();
  try {
    db?.close();
  } finally {
    db = null;
  }
}

/**
 * A copy of the database file, for a backup. It is consistent: transactions are synchronous in this worker, so none is
 * half done while the copy is made.
 */
export function exportDatabase() {
  if (!pool || !db) throw Object.assign(new Error('There is no database file to back up.'), { status: 400 });
  return pool.exportFile(DB_FILE);
}

const SQLITE_HEADER = 'SQLite format 3\0';

/** Replaces the database with a backup (the bytes of a SQLite file). The database stays closed: reload the window. */
export function restoreDatabase(bytes) {
  if (!pool) throw Object.assign(new Error('The database cannot be restored here.'), { status: 400 });
  const head = new TextDecoder().decode(bytes.subarray(0, SQLITE_HEADER.length));
  if (bytes.length < 512 || head !== SQLITE_HEADER) throw Object.assign(new Error('This file is not a Plymentor backup (not a SQLite database).'), { status: 400 });
  closeDatabase();
  pool.importDb(DB_FILE, bytes);
}

// Prepared statements are cached; queries built with a variable number of placeholders can create many, so the
// cache keeps the 300 most recently used.
const stmt = sql => {
  let s = cache.get(sql);
  if (s) {
    cache.delete(sql);
    cache.set(sql, s);
    return s;
  }
  s = db.prepare(sql);
  cache.set(sql, s);
  if (cache.size > 300) {
    const [oldSql, old] = cache.entries().next().value;
    cache.delete(oldSql);
    try {
      old.finalize();
    } catch {
      /* already finalized */
    }
  }
  return s;
};
const norm = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : v);
const bind = (s, params) => {
  if (params.length) s.bind(params.map(norm));
};
const plain = row => {
  for (const k in row) if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  return row;
};

export function run(sql, ...params) {
  const s = stmt(sql);
  try {
    bind(s, params);
    s.step();
  } finally {
    s.reset(true);
  }
  return { changes: Number(db.changes()), id: Number(sqlite3.capi.sqlite3_last_insert_rowid(db.pointer)) };
}

export function get(sql, ...params) {
  const s = stmt(sql);
  try {
    bind(s, params);
    return s.step() ? plain(s.get({})) : undefined;
  } finally {
    s.reset(true);
  }
}

export function all(sql, ...params) {
  const s = stmt(sql);
  const out = [];
  try {
    bind(s, params);
    while (s.step()) out.push(plain(s.get({})));
  } finally {
    s.reset(true);
  }
  return out;
}

/** Runs fn inside a transaction (nested calls join the outer one). fn must be synchronous. */
let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const now = () => Date.now();
export const json = (s, fallback = null) => {
  if (s == null) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

export function kvGet(key, fallback = null) {
  const r = get('SELECT value FROM kv WHERE key = ?', key);
  return r ? json(r.value, fallback) : fallback;
}

export function kvSet(key, value) {
  run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
