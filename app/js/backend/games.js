// Games repository: PGN import (streaming, many games at once), queries, and the personal opening explorer.
import { PgnParser, parsePgn, parseComment, makeComment, makePgn, startingPosition } from 'chessops/pgn';
import { parseSan, makeSan } from 'chessops/san';
import { run, get, all, tx, now, json } from './db.js';
import { keyOf, fenOf, uciOf, posFromFen, moveFromUci, INITIAL_FEN } from './chess/core.js';
import { openingOfGame } from './chess/openings.js';
import { getSettings } from './settings.js';
import { sha1Hex } from '../../../shared/sha1.js';

const INDEX_PLIES = 30;

/** The de-duplication key of a game. Same formula as Chess Coach 1.x. */
export const gameHash = ({ white, black, date, result, startFen, ucis }) => sha1Hex([white, black, date, result, startFen || '', ucis.join(' ')].join('|'));

// Collections of imports still running: they have no games yet, but must not be cleaned up as empty.
const activeCollections = new Set();

export class PgnImporter {
  /** onGame({ id, hash, duplicate }) is called for every game read. */
  constructor({ name, source, onGame }) {
    this.collectionId = run('INSERT INTO collections (name, source, created_at) VALUES (?, ?, ?)', String(name).slice(0, 200), source, now()).id;
    activeCollections.add(this.collectionId);
    this.onGame = onGame || null;
    this.stats = { collectionId: this.collectionId, imported: 0, duplicates: 0, errors: 0, skipped: 0, ids: [] };
    this.pending = [];
    this.decoder = null;
    this.parser = new PgnParser((game, err) => {
      if (err) {
        this.stats.errors++;
        return;
      }
      this.pending.push(game);
      if (this.pending.length >= 250) this.flush();
    });
  }

  /** Feed raw bytes (Buffer/Uint8Array) or text. */
  feed(chunk) {
    if (typeof chunk === 'string') return this.parser.parse(chunk, { stream: true });
    if (!this.decoder) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(0, Math.max(0, chunk.length - 4)));
        this.decoder = new TextDecoder('utf-8');
      } catch {
        this.decoder = new TextDecoder('windows-1252');
      }
    }
    this.parser.parse(this.decoder.decode(chunk, { stream: true }), { stream: true });
  }

  finish() {
    try {
      if (this.decoder) this.parser.parse(this.decoder.decode(), { stream: true });
      this.parser.parse('');
      this.flush();
    } finally {
      this.close();
    }
    return this.stats;
  }

  /** Ends the import (also after a failure): an empty collection is removed. */
  close() {
    if (!activeCollections.delete(this.collectionId)) return;
    if (!this.stats.imported) run('DELETE FROM collections WHERE id = ? AND NOT EXISTS (SELECT 1 FROM games WHERE collection_id = ?)', this.collectionId, this.collectionId);
  }

  flush() {
    const batch = this.pending;
    this.pending = [];
    if (batch.length) tx(() => batch.forEach(g => this.insert(g)));
  }

  /** Imports the games of a PGN text right away. Returns one { id, hash, duplicate } or { skip } per game. */
  addPgn(text) {
    const games = parsePgn(String(text));
    return tx(() => games.map(g => this.insert(g)));
  }

  insert(game) {
    const g = readGame(game);
    if (g.skip) {
      if (g.skip === 'error') this.stats.errors++;
      else this.stats.skipped++;
      return { skip: g.skip };
    }
    const { h, hash, startFen, ucis, sans, clocks, index } = g;
    const opening = openingOfGame(g.startPos, ucis);
    const r = run(
      `INSERT OR IGNORE INTO games (collection_id, hash, white, black, white_elo, black_elo, result, date, event, site, round,
         eco, opening, time_control, termination, start_fen, ply_count, moves, sans, clocks, pgn, headers, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.collectionId,
      hash,
      g.white,
      g.black,
      parseInt(h.WhiteElo) || null,
      parseInt(h.BlackElo) || null,
      g.result,
      g.date,
      h.Event || null,
      h.Site || null,
      h.Round || null,
      opening?.eco || h.ECO || null,
      opening?.name || h.Opening || null,
      h.TimeControl || null,
      h.Termination || null,
      startFen,
      ucis.length,
      ucis.join(' '),
      sans.join(' '),
      clocks.some(c => c !== null) ? JSON.stringify(clocks) : null,
      makePgn(game),
      JSON.stringify(h),
      now(),
    );
    if (!r.changes) {
      this.stats.duplicates++;
      const id = get('SELECT id FROM games WHERE hash = ?', hash)?.id ?? null;
      this.onGame?.({ id, hash, duplicate: true });
      return { id, hash, duplicate: true };
    }
    for (const [key, ply, uci] of index) run('INSERT INTO positions (key, game_id, ply, uci) VALUES (?, ?, ?, ?)', key, r.id, ply, uci);
    this.stats.imported++;
    if (this.stats.ids.length < 5000) this.stats.ids.push(r.id);
    this.onGame?.({ id: r.id, hash, duplicate: false });
    return { id: r.id, hash, duplicate: false };
  }
}

/**
 * Reads one parsed PGN game (chessops): its players, result, moves, clocks and key. Returns { skip: 'variant' |
 * 'error' | 'empty' } for games the app cannot use.
 */
export function readGame(game) {
  const h = Object.fromEntries(game.headers);
  if (h.Variant && !/^(standard|chess|from position)$/i.test(h.Variant.trim())) return { skip: 'variant' };
  const start = startingPosition(game.headers);
  if (start.isErr) return { skip: 'error' };
  const pos = start.value;
  const startPos = pos.clone();
  const startFen = h.FEN ? fenOf(pos) : null;
  const ucis = [];
  const sans = [];
  const clocks = [];
  const index = [];
  for (const node of game.moves.mainline()) {
    const move = parseSan(pos, node.san);
    if (!move || !pos.isLegal(move)) break;
    const uci = uciOf(pos, move);
    if (ucis.length < INDEX_PLIES) index.push([keyOf(pos), ucis.length, uci]);
    sans.push(makeSan(pos, move));
    pos.play(move);
    ucis.push(uci);
    let clock = null;
    for (const c of node.comments || []) {
      const parsed = parseComment(c);
      if (parsed.clock !== undefined) clock = parsed.clock;
    }
    clocks.push(clock);
  }
  if (!ucis.length) return { skip: 'empty' };
  const white = (h.White || '?').trim();
  const black = (h.Black || '?').trim();
  const date = h.UTCDate || h.Date || null;
  const result = h.Result || '*';
  return { h, white, black, date, result, startPos, startFen, ucis, sans, clocks, index, hash: gameHash({ white, black, date, result, startFen, ucis }) };
}

/** The key of the first game of a PGN text, or null when it has no usable game. */
export function pgnKey(text) {
  const game = parsePgn(String(text))[0];
  if (!game) return null;
  const g = readGame(game);
  return g.skip ? null : g.hash;
}

const pgnEscape = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');

/** A compact PGN of a stored game: its headers, the main line and the clock times (no comments or variations). */
export function compactPgn(g) {
  // Only headers the game has: a missing date must stay missing, or the game's key would change.
  const headers = [];
  if (g.event) headers.push(['Event', g.event]);
  if (g.site) headers.push(['Site', g.site]);
  if (g.date) headers.push(['Date', g.date]);
  if (g.round) headers.push(['Round', g.round]);
  headers.push(['White', g.white || '?'], ['Black', g.black || '?'], ['Result', g.result || '*']);
  if (g.white_elo) headers.push(['WhiteElo', g.white_elo]);
  if (g.black_elo) headers.push(['BlackElo', g.black_elo]);
  if (g.eco) headers.push(['ECO', g.eco]);
  if (g.opening) headers.push(['Opening', g.opening]);
  if (g.time_control) headers.push(['TimeControl', g.time_control]);
  if (g.termination) headers.push(['Termination', g.termination]);
  if (g.start_fen) headers.push(['SetUp', '1'], ['FEN', g.start_fen]);
  const sans = typeof g.sans === 'string' ? (g.sans ? g.sans.split(' ') : []) : g.sans || [];
  const clocks = (typeof g.clocks === 'string' ? json(g.clocks, null) : g.clocks) || [];
  const fullmoves = g.start_fen ? Number(g.start_fen.split(' ')[5]) || 1 : 1;
  let white = g.start_fen ? g.start_fen.split(' ')[1] !== 'b' : true;
  let n = fullmoves;
  const parts = [];
  sans.forEach((san, i) => {
    if (white) parts.push(`${n}.`);
    else if (i === 0) parts.push(`${n}...`);
    parts.push(san);
    const c = clocks[i];
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) parts.push(`{ ${makeComment({ clock: c })} }`);
    if (!white) n++;
    white = !white;
  });
  parts.push(g.result || '*');
  return `${headers.map(([k, v]) => `[${k} "${pgnEscape(v)}"]`).join('\n')}\n\n${parts.join(' ')}\n`;
}

export function importPgnText(text, opts) {
  const imp = new PgnImporter(opts);
  imp.feed(text);
  return imp.finish();
}

/** Usernames that identify the student (from settings). */
export const myNames = () => (getSettings().profile.usernames || []).map(s => s.toLowerCase());

function playerClause(player, color, params) {
  const names = (Array.isArray(player) ? player : [player]).filter(Boolean).map(s => s.toLowerCase());
  if (!names.length) return '';
  const ph = names.map(() => '?').join(',');
  if (color === 'white') {
    params.push(...names);
    return ` AND lower(g.white) IN (${ph})`;
  }
  if (color === 'black') {
    params.push(...names);
    return ` AND lower(g.black) IN (${ph})`;
  }
  params.push(...names, ...names);
  return ` AND (lower(g.white) IN (${ph}) OR lower(g.black) IN (${ph}))`;
}

/** Filtered, paginated game list. */
export function listGames(q = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (q.player) where += playerClause(String(q.player).split(',').map(s => s.trim()), q.color, params);
  if (q.collection) {
    where += ' AND g.collection_id = ?';
    params.push(Number(q.collection));
  }
  if (q.result) {
    if (['1-0', '0-1', '1/2-1/2'].includes(q.result)) {
      where += ' AND g.result = ?';
      params.push(q.result);
    } else if (q.player && ['win', 'loss', 'draw'].includes(q.result)) {
      const names = String(q.player).split(',').map(s => s.trim().toLowerCase());
      const ph = names.map(() => '?').join(',');
      if (q.result === 'draw') where += " AND g.result = '1/2-1/2'";
      else {
        const wantWhiteWin = q.result === 'win';
        where += ` AND ((lower(g.white) IN (${ph}) AND g.result = '${wantWhiteWin ? '1-0' : '0-1'}') OR (lower(g.black) IN (${ph}) AND g.result = '${wantWhiteWin ? '0-1' : '1-0'}'))`;
        params.push(...names, ...names);
      }
    }
  }
  if (q.opening) {
    where += ' AND (g.opening LIKE ? OR g.eco LIKE ?)';
    params.push(`%${q.opening}%`, `${q.opening}%`);
  }
  if (q.text) {
    where += ' AND (g.white LIKE ? OR g.black LIKE ? OR g.event LIKE ? OR g.opening LIKE ?)';
    params.push(...Array(4).fill(`%${q.text}%`));
  }
  if (q.analyzed === '1' || q.analyzed === true) where += ' AND a.game_id IS NOT NULL';
  if (q.analyzed === '0') where += ' AND a.game_id IS NULL';
  if (q.ids) {
    const ids = String(q.ids).split(',').map(Number).filter(Boolean).slice(0, 5000);
    where += ` AND g.id IN (${ids.map(() => '?').join(',') || 'NULL'})`;
    params.push(...ids);
  }
  const sort = { date: 'g.date', white: 'g.white', black: 'g.black', opening: 'g.opening', moves: 'g.ply_count', added: 'g.id' }[q.sort] || 'g.date';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.max(1, Math.min(Number(q.limit) || 50, 1000));
  const offset = Math.max(0, Number(q.offset) || 0);
  const total = get(`SELECT COUNT(*) n FROM games g LEFT JOIN analyses a ON a.game_id = g.id ${where}`, ...params).n;
  const rows = all(
    `SELECT g.id, g.white, g.black, g.white_elo, g.black_elo, g.result, g.date, g.event, g.eco, g.opening, g.time_control,
            g.ply_count, g.collection_id, a.white_acc, a.black_acc, (a.game_id IS NOT NULL) analyzed
     FROM games g LEFT JOIN analyses a ON a.game_id = g.id ${where}
     ORDER BY ${sort} ${dir}, g.id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return { total, games: rows.map(r => ({ ...r, analyzed: !!r.analyzed })) };
}

export function allGameIds(q = {}) {
  return listGames({ ...q, limit: 1000, offset: 0 }).games.map(g => g.id);
}

export function getGame(id) {
  const g = get('SELECT * FROM games WHERE id = ?', Number(id));
  if (!g) return null;
  const a = get('SELECT data, nodes, updated_at FROM analyses WHERE game_id = ?', g.id);
  return {
    ...g,
    moves: g.moves ? g.moves.split(' ') : [],
    sans: g.sans ? g.sans.split(' ') : [],
    clocks: json(g.clocks),
    headers: json(g.headers, {}),
    analysis: a ? { ...json(a.data), nodes: a.nodes, updatedAt: a.updated_at } : null,
  };
}

/** Deletes games (their positions and analyses go with them). Returns { deleted }. */
export function deleteGames(ids) {
  let deleted = 0;
  tx(() => {
    for (const id of ids) deleted += run('DELETE FROM games WHERE id = ?', Number(id)).changes;
    const keep = [...activeCollections];
    run(
      `DELETE FROM collections WHERE id NOT IN (SELECT DISTINCT collection_id FROM games WHERE collection_id IS NOT NULL)${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`,
      ...keep,
    );
  });
  return { deleted };
}

export function collections() {
  return all(
    `SELECT c.id, c.name, c.source, c.created_at, COUNT(g.id) games FROM collections c
     LEFT JOIN games g ON g.collection_id = c.id GROUP BY c.id ORDER BY c.id DESC`,
  );
}

export function players(limit = 30) {
  return all(
    `SELECT name, COUNT(*) games FROM (SELECT white name FROM games UNION ALL SELECT black name FROM games)
     WHERE name IS NOT NULL AND name != '?' GROUP BY lower(name) ORDER BY games DESC LIMIT ?`,
    limit,
  );
}

export function gameSummary(g) {
  return `#${g.id} ${g.white}${g.white_elo ? ` (${g.white_elo})` : ''} – ${g.black}${g.black_elo ? ` (${g.black_elo})` : ''}, ${g.result}, ${g.date || '?'}${g.opening ? `, ${g.eco || ''} ${g.opening}` : ''}${g.time_control ? `, TC ${g.time_control}` : ''}, ${Math.ceil(g.ply_count / 2)} moves`;
}

/** Colour of the student in a game, if one of their usernames played it. */
export function studentColor(g, names = myNames()) {
  if (!names.length) return null;
  if (names.includes(String(g.white).toLowerCase())) return 'white';
  if (names.includes(String(g.black).toLowerCase())) return 'black';
  return null;
}

/** Move statistics for a position from imported games (first 30 plies). */
export function explorer({ fen, player, color, collection }) {
  const key = keyOf(posFromFen(fen || INITIAL_FEN));
  const params = [key];
  let where = 'p.key = ?';
  if (collection) {
    where += ' AND g.collection_id = ?';
    params.push(Number(collection));
  }
  if (player) where += playerClause(String(player).split(',').map(s => s.trim()), color, params);
  const rows = all(
    `SELECT p.uci, COUNT(*) n,
       SUM(g.result = '1-0') white, SUM(g.result = '1/2-1/2') draws, SUM(g.result = '0-1') black,
       AVG(NULLIF(g.white_elo, 0)) welo, AVG(NULLIF(g.black_elo, 0)) belo, MAX(g.id) last_id
     FROM positions p JOIN games g ON g.id = p.game_id WHERE ${where}
     GROUP BY p.uci ORDER BY n DESC LIMIT 30`,
    ...params,
  );
  const pos = posFromFen(fen || INITIAL_FEN);
  const moves = rows.map(r => {
    const move = moveFromUci(pos, r.uci);
    return {
      uci: r.uci,
      san: move ? makeSan(pos, move) : r.uci,
      games: r.n,
      white: r.white,
      draws: r.draws,
      black: r.black,
      avgElo: Math.round(((r.welo || 0) + (r.belo || 0)) / ((r.welo ? 1 : 0) + (r.belo ? 1 : 0) || 1)) || null,
    };
  });
  const recent = all(
    `SELECT DISTINCT g.id, g.white, g.black, g.result, g.date, g.white_elo, g.black_elo FROM positions p JOIN games g ON g.id = p.game_id
     WHERE ${where} ORDER BY g.date DESC LIMIT 8`,
    ...params,
  );
  return { moves, games: recent };
}
