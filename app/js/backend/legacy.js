// Brings over the data of Chess Coach 1.x (the local server app): the main process reads its database on the
// student's computer and the page passes the rows here, table by table, in chunks. Games already in this database (same key)
// are not duplicated, so the import can safely run again.
import { run, get, tx, now } from './db.js';

const TABLES = ['collections', 'games', 'positions', 'evals', 'analyses', 'reports', 'repertoire', 'exercises'];
const sessions = new Map(); // session -> { collections: Map(old -> new), games: Map(old -> new), fresh: Set(new game ids) }

const str = (v, max = 1_000_000) => (v === null || v === undefined ? null : String(v).slice(0, max));
const int = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** body: { session, table, rows } — returns { table, inserted, skipped } */
export function importLegacy({ session, table, rows }) {
  if (!/^[\w-]{1,64}$/.test(String(session || ''))) throw Object.assign(new Error('Invalid import session'), { status: 400 });
  if (!TABLES.includes(table)) throw Object.assign(new Error(`Unknown table ${table}`), { status: 400 });
  if (!Array.isArray(rows) || rows.length > 5000) throw Object.assign(new Error('Invalid rows'), { status: 400 });
  let s = sessions.get(session);
  if (!s) {
    if (sessions.size > 20) sessions.clear();
    s = { collections: new Map(), games: new Map(), fresh: new Set() };
    sessions.set(session, s);
  }
  let inserted = 0;
  let skipped = 0;
  tx(() => {
    for (const r of rows) {
      if (!r || typeof r !== 'object') {
        skipped++;
        continue;
      }
      const ok = IMPORTERS[table](r, s);
      if (ok) inserted++;
      else skipped++;
    }
  });
  return { table, inserted, skipped };
}

const IMPORTERS = {
  collections(r, s) {
    const name = str(r.name, 200) || 'Chess Coach 1.x';
    const created = int(r.created_at) || now();
    const existing = get('SELECT id FROM collections WHERE name = ? AND created_at = ?', name, created);
    if (existing) {
      s.collections.set(int(r.id), existing.id);
      return false;
    }
    const id = run('INSERT INTO collections (name, source, created_at) VALUES (?, ?, ?)', name, str(r.source, 40), created).id;
    s.collections.set(int(r.id), id);
    return true;
  },

  games(r, s) {
    const hash = str(r.hash, 64);
    const moves = str(r.moves) || '';
    if (!hash || !/^[0-9a-f]{40}$/.test(hash) || !moves) return false;
    const existing = get('SELECT id FROM games WHERE hash = ?', hash);
    if (existing) {
      s.games.set(int(r.id), existing.id);
      return false;
    }
    const id = run(
      `INSERT INTO games (collection_id, hash, white, black, white_elo, black_elo, result, date, event, site, round,
         eco, opening, time_control, termination, start_fen, ply_count, moves, sans, clocks, pgn, headers, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.collections.get(int(r.collection_id)) ?? null,
      hash,
      str(r.white, 200),
      str(r.black, 200),
      int(r.white_elo),
      int(r.black_elo),
      str(r.result, 10),
      str(r.date, 40),
      str(r.event, 300),
      str(r.site, 300),
      str(r.round, 40),
      str(r.eco, 10),
      str(r.opening, 300),
      str(r.time_control, 40),
      str(r.termination, 100),
      str(r.start_fen, 120),
      int(r.ply_count) || 0,
      moves,
      str(r.sans) || '',
      str(r.clocks),
      str(r.pgn),
      str(r.headers, 100_000),
      int(r.created_at) || now(),
    ).id;
    s.games.set(int(r.id), id);
    s.fresh.add(id);
    return true;
  },

  positions(r, s) {
    const gameId = s.games.get(int(r.game_id));
    if (!gameId || !s.fresh.has(gameId) || !r.key || !r.uci) return false;
    run('INSERT INTO positions (key, game_id, ply, uci) VALUES (?, ?, ?, ?)', str(r.key, 120), gameId, int(r.ply) || 0, str(r.uci, 6));
    return true;
  },

  evals(r) {
    if (!r.key) return false;
    const res = run(
      'INSERT OR IGNORE INTO evals (key, depth, nodes, cp, mate, best, pv, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      str(r.key, 120),
      int(r.depth),
      int(r.nodes),
      int(r.cp),
      int(r.mate),
      str(r.best, 6),
      str(r.pv, 400),
      int(r.updated_at) || now(),
    );
    return res.changes > 0;
  },

  analyses(r, s) {
    const gameId = s.games.get(int(r.game_id));
    if (!gameId || !r.data) return false;
    const local = get('SELECT nodes FROM analyses WHERE game_id = ?', gameId);
    if (local && (local.nodes || 0) >= (int(r.nodes) || 0)) return false;
    run(
      `INSERT INTO analyses (game_id, nodes, data, white_acc, black_acc, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET nodes = excluded.nodes, data = excluded.data, white_acc = excluded.white_acc,
         black_acc = excluded.black_acc, updated_at = excluded.updated_at`,
      gameId,
      int(r.nodes),
      str(r.data, 2_000_000),
      num(r.white_acc),
      num(r.black_acc),
      int(r.updated_at) || now(),
    );
    return true;
  },

  reports(r, s) {
    const title = str(r.title, 200) || 'Report';
    const created = int(r.created_at) || now();
    if (get('SELECT id FROM reports WHERE title = ? AND created_at = ?', title, created)) return false;
    let gameIds = [];
    try {
      gameIds = (JSON.parse(r.game_ids || '[]') || []).map(id => s.games.get(int(id))).filter(Boolean);
    } catch {
      /* keep empty */
    }
    run(
      'INSERT INTO reports (title, player, game_ids, stats, narrative, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      title,
      str(r.player, 300),
      JSON.stringify(gameIds),
      str(r.stats, 5_000_000),
      str(r.narrative, 200_000),
      created,
      int(r.updated_at) || created,
    );
    return true;
  },

  repertoire(r) {
    if (r.color !== 'white' && r.color !== 'black') return false;
    const res = run(
      `INSERT OR IGNORE INTO repertoire (color, key, fen, uci, san, comment, due, interval, ease, reps, lapses, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.color,
      str(r.key, 120),
      str(r.fen, 120),
      str(r.uci, 6),
      str(r.san, 12),
      str(r.comment, 1000),
      int(r.due),
      num(r.interval) ?? 0,
      num(r.ease) ?? 2.5,
      int(r.reps) ?? 0,
      int(r.lapses) ?? 0,
      int(r.created_at) || now(),
    );
    return res.changes > 0;
  },

  exercises(r, s) {
    if (!r.fen || !r.solution) return false;
    const res = run(
      `INSERT OR IGNORE INTO exercises (fen, solution, prompt, themes, source, game_id, ply, data, due, interval, ease, reps, lapses, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      str(r.fen, 120),
      str(r.solution, 10_000),
      str(r.prompt, 500),
      str(r.themes, 2000),
      str(r.source, 20),
      s.games.get(int(r.game_id)) ?? null,
      int(r.ply),
      str(r.data, 10_000),
      int(r.due),
      num(r.interval) ?? 0,
      num(r.ease) ?? 2.5,
      int(r.reps) ?? 0,
      int(r.lapses) ?? 0,
      int(r.created_at) || now(),
    );
    return res.changes > 0;
  },
};

export const LEGACY_TABLES = TABLES;
