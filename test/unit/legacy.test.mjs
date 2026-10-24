// Bringing over Chess Coach 1.x data: the main process reads the old database (read-only) and the backend imports it.
// A database in the 1.x format is built in a temporary folder; the real one on this computer (if any) is only read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openBackend, closeBackend } from './setup.mjs';
import { get, all } from '../../app/js/backend/db.js';
import { importLegacy, LEGACY_TABLES } from '../../app/js/backend/legacy.js';

const home = mkdtempSync(join(tmpdir(), 'cc-legacy-'));
process.env.PLYMENTOR_HOME = home;
process.env.PLYMENTOR_LEGACY_HOME = home; // the 1.x data below sits in the old folder's place
let helperLegacy;

function makeV1Db() {
  mkdirSync(join(home, 'data'), { recursive: true });
  const db = new DatabaseSync(join(home, 'data', 'coach.db'));
  db.exec(`
    CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE games (id INTEGER PRIMARY KEY, collection_id INTEGER, hash TEXT UNIQUE, white TEXT, black TEXT, white_elo INTEGER, black_elo INTEGER,
      result TEXT, date TEXT, event TEXT, site TEXT, round TEXT, eco TEXT, opening TEXT, time_control TEXT, termination TEXT, start_fen TEXT,
      ply_count INTEGER NOT NULL DEFAULT 0, moves TEXT NOT NULL DEFAULT '', sans TEXT NOT NULL DEFAULT '', clocks TEXT, pgn TEXT, headers TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE positions (key TEXT NOT NULL, game_id INTEGER NOT NULL, ply INTEGER NOT NULL, uci TEXT NOT NULL);
    CREATE TABLE evals (key TEXT PRIMARY KEY, depth INTEGER, nodes INTEGER, cp INTEGER, mate INTEGER, best TEXT, pv TEXT, updated_at INTEGER);
    CREATE TABLE analyses (game_id INTEGER PRIMARY KEY, nodes INTEGER, data TEXT NOT NULL, white_acc REAL, black_acc REAL, updated_at INTEGER NOT NULL);
    CREATE TABLE reports (id INTEGER PRIMARY KEY, title TEXT, player TEXT, game_ids TEXT NOT NULL, stats TEXT, narrative TEXT, thread_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER);
    CREATE TABLE repertoire (id INTEGER PRIMARY KEY, color TEXT NOT NULL, key TEXT NOT NULL, fen TEXT NOT NULL, uci TEXT NOT NULL, san TEXT NOT NULL, comment TEXT, due INTEGER,
      interval REAL NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(color, key, uci));
    CREATE TABLE exercises (id INTEGER PRIMARY KEY, fen TEXT NOT NULL UNIQUE, solution TEXT NOT NULL, prompt TEXT, themes TEXT, source TEXT, game_id INTEGER, ply INTEGER, data TEXT, due INTEGER,
      interval REAL NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO collections (id, name, source, created_at) VALUES (7, ?, ?, ?)').run('Lichess: me', 'lichess', 1700000000000);
  const games = [];
  for (let i = 0; i < 30; i++) {
    const moves = i % 2 ? 'e2e4 e7e5 g1f3' : 'd2d4 d7d5';
    const sans = i % 2 ? 'e4 e5 Nf3' : 'd4 d5';
    const white = `me${i % 3}`;
    const hash = createHash('sha1').update([white, 'opp', `2026.01.${String(i + 1).padStart(2, '0')}`, '1-0', '', moves].join('|')).digest('hex');
    const id = 100 + i;
    db.prepare(
      `INSERT INTO games (id, collection_id, hash, white, black, result, date, ply_count, moves, sans, pgn, headers, created_at) VALUES (?, 7, ?, ?, 'opp', '1-0', ?, ?, ?, ?, ?, '{}', ?)`,
    ).run(id, hash, white, `2026.01.${String(i + 1).padStart(2, '0')}`, moves.split(' ').length, moves, sans, `[White "${white}"]\n\n${sans} 1-0`, 1700000000000 + i);
    db.prepare('INSERT INTO positions (key, game_id, ply, uci) VALUES (?, ?, 0, ?)').run('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', id, moves.slice(0, 4));
    db.prepare('INSERT INTO analyses (game_id, nodes, data, white_acc, black_acc, updated_at) VALUES (?, 1000000, ?, 90.5, 80.25, 1)').run(id, JSON.stringify({ version: 1, moves: [] }));
    games.push({ id, hash });
  }
  // a broken row: no key
  db.prepare(`INSERT INTO games (id, hash, white, black, result, moves, sans, created_at) VALUES (999, NULL, 'x', 'y', '*', 'e2e4', 'e4', 1)`).run();
  db.prepare('INSERT INTO evals (key, depth, nodes, cp, mate, best, pv, updated_at) VALUES (?, 20, 1000000, 25, NULL, ?, ?, 1)').run('k1', 'e2e4', 'e2e4 e7e5');
  db.prepare('INSERT INTO reports (id, title, player, game_ids, stats, narrative, created_at) VALUES (5, ?, ?, ?, ?, ?, 1700000000500)').run('Old report', 'me0', JSON.stringify([100, 101, 4242]), '{"games":2}', '# Notes');
  db.prepare(`INSERT INTO repertoire (color, key, fen, uci, san, created_at) VALUES ('white', 'k', 'f', 'e2e4', 'e4', 1)`).run();
  db.prepare(`INSERT INTO exercises (fen, solution, prompt, game_id, created_at) VALUES ('8/8/8/8/8/8/8/K6k w - - 0 1', '{"ucis":["a1a2"],"sans":["Ka2"]}', 'p', 101, 1)`).run();
  db.close();
  writeFileSync(join(home, 'config.json'), '\u{FEFF}' + JSON.stringify({ profile: { usernames: ['me0'] }, language: 'Deutsch', coach: { provider: 'codex', codex: { model: 'gpt-5.5' } }, lichessToken: 'lip_x' }));
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data', 'coach-memory.md'), '# Notes\n- likes the Caro-Kann\n');
  return games;
}

let v1Games;
before(async () => {
  v1Games = makeV1Db();
  helperLegacy = await import('../../desktop/legacy.js');
  await openBackend();
});
after(() => {
  closeBackend();
  helperLegacy?.closeLegacy();
  rmSync(home, { recursive: true, force: true });
});

async function runImport(session) {
  const totals = {};
  for (const table of LEGACY_TABLES) {
    for (let offset = 0; ; offset += 7) {
      const rows = await helperLegacy.legacyRows(table, offset, 7);
      if (!rows.length) break;
      const r = importLegacy({ session, table, rows });
      totals[table] = (totals[table] || 0) + r.inserted;
    }
  }
  return totals;
}

test('the main process finds the 1.x data and describes it', async () => {
  const info = await helperLegacy.legacyInfo();
  assert.equal(info.found, true);
  assert.equal(info.games, 31);
  assert.equal(info.tables.analyses, 30);
  const cfg = helperLegacy.legacyConfig();
  assert.deepEqual(cfg.settings.profile, { usernames: ['me0'] });
  assert.equal(cfg.settings.language, 'Deutsch');
  assert.equal(cfg.coach.provider, 'codex');
  assert.equal(cfg.coach.models.codex, 'gpt-5.5');
  assert.equal(cfg.settings.lichessToken, 'lip_x');
  assert.match(cfg.memory, /Caro-Kann/);
  await assert.rejects(helperLegacy.legacyRows('users; DROP TABLE games', 0, 10), /Unknown table/);
});

test('importing brings over games, analyses, evaluations, reports, repertoire and exercises with new ids', async () => {
  const totals = await runImport('first');
  assert.equal(totals.games, 30, 'the row without a key is skipped');
  assert.equal(totals.analyses, 30);
  assert.equal(totals.evals, 1);
  assert.equal(totals.reports, 1);
  assert.equal(totals.repertoire, 1);
  assert.equal(totals.exercises, 1);
  assert.equal(get('SELECT COUNT(*) n FROM games').n, 30);
  for (const g of v1Games) assert.ok(get('SELECT id FROM games WHERE hash = ?', g.hash), g.hash);
  const report = get('SELECT game_ids FROM reports');
  const ids = JSON.parse(report.game_ids);
  assert.equal(ids.length, 2, 'unknown game ids are dropped from the report');
  for (const id of ids) assert.ok(get('SELECT id FROM games WHERE id = ?', id));
  const ex = get('SELECT game_id FROM exercises');
  assert.equal(get('SELECT hash FROM games WHERE id = ?', ex.game_id).hash, v1Games[1].hash, 'the exercise points to the same game');
  assert.equal(get('SELECT COUNT(*) n FROM collections WHERE name = ?', 'Lichess: me').n, 1);
  assert.equal(all('SELECT * FROM games WHERE collection_id IS NULL').length, 0);
});

test('importing again adds nothing', async () => {
  const totals = await runImport('second');
  assert.equal(totals.games || 0, 0);
  assert.equal(totals.reports || 0, 0);
  assert.equal(totals.analyses || 0, 0);
  assert.equal(get('SELECT COUNT(*) n FROM games').n, 30);
  assert.equal(get('SELECT COUNT(*) n FROM reports').n, 1);
  assert.equal(get('SELECT COUNT(*) n FROM collections').n, 1);
});

test('bad requests are refused', () => {
  assert.throws(() => importLegacy({ session: '../x', table: 'games', rows: [] }), /session/);
  assert.throws(() => importLegacy({ session: 's', table: 'users', rows: [] }), /Unknown table/);
  assert.throws(() => importLegacy({ session: 's', table: 'games', rows: 'x' }), /Invalid rows/);
  const r = importLegacy({ session: 's', table: 'games', rows: [null, 5, { hash: 'zz' }, { hash: 'a'.repeat(40), moves: '' }] });
  assert.equal(r.inserted, 0);
});

test('the real 1.x database on this computer (read-only), if there is one', { skip: !existsSync(join(process.env.LOCALAPPDATA || '', 'ChessCoach', 'data', 'coach.db')) && 'no 1.x data here' }, () => {
  const db = new DatabaseSync(join(process.env.LOCALAPPDATA, 'ChessCoach', 'data', 'coach.db'), { readOnly: true });
  try {
    const n = Number(db.prepare('SELECT COUNT(*) n FROM games').get().n);
    const rows = db.prepare('SELECT * FROM games LIMIT 50').all();
    const r = importLegacy({ session: 'real', table: 'games', rows: rows.map(x => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))) });
    assert.equal(r.inserted + r.skipped, rows.length);
    assert.ok(n >= rows.length);
  } finally {
    db.close();
  }
});
