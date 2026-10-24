// The app's local API, served inside the backend worker: the same /api/... requests the screens made to the local
// server of Chess Coach 1.x, answered in the window from the games database and the Stockfish workers. Nothing here
// goes over the network (except the optional Lichess / Chess.com requests in online.js).
import { run, get, all, now, json, exportDatabase, restoreDatabase } from './db.js';
import { getSettings, updateSettings, publicSettings } from './settings.js';
import { evaluate, evaluateMove, playMove, PLAY_LEVELS, engineInfo, restartEngines } from './engine/pool.js';
import { PgnImporter, listGames, getGame, collections, players, explorer, myNames, allGameIds, deleteGames } from './games.js';
import { importFromLichess, importFromChessCom, lichessExplorer } from './online.js';
import { lookup, bookMoves, search as searchOpenings, openingCount } from './chess/openings.js';
import { posFromFen, keyOf, INITIAL_FEN, ChessError } from './chess/core.js';
import { describePosition } from './chess/features.js';
import { jobs } from './analysis/batch.js';
import { playerStats } from './analysis/stats.js';
import { executeTool } from './coach/tools.js';
import { importLegacy } from './legacy.js';
import {
  addLineToRepertoire,
  addMoveToRepertoire,
  repertoire,
  removeFromRepertoire,
  importRepertoirePgn,
  reviewRepertoireMove,
  repertoireStats,
  listExercises,
  deleteExercise,
  reviewExercise,
  checkExercise,
  generateExercises,
} from './training.js';
import { APP_VERSION } from '../../../shared/protocol.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

const obj = body => (body && typeof body === 'object' && !Array.isArray(body) && !(body instanceof Blob) ? body : {});
const ids = list => (Array.isArray(list) ? [...new Set(list.map(Number).filter(n => Number.isInteger(n) && n > 0))] : []);
const fenParam = q => q.fen || INITIAL_FEN;
const storage = { persistent: false };
export const setStorageInfo = info => Object.assign(storage, info);

// ---------------------------------------------------------------------------------------------
// Status & settings

route('GET', '/api/status', async () => ({
  version: APP_VERSION,
  engine: await engineInfo(),
  openings: openingCount(),
  games: get('SELECT COUNT(*) n FROM games').n,
  analyzed: get('SELECT COUNT(*) n FROM analyses').n,
  storage,
}));

route('GET', '/api/settings', () => publicSettings());

route('POST', '/api/settings', ({ body }) => {
  const patch = { ...obj(body) };
  if (patch.lichessToken === undefined || patch.lichessToken === null) delete patch.lichessToken;
  else patch.lichessToken = String(patch.lichessToken).trim();
  const before = JSON.stringify(getSettings().engine);
  updateSettings(patch);
  if (JSON.stringify(getSettings().engine) !== before) restartEngines();
  return publicSettings();
});

// ---------------------------------------------------------------------------------------------
// Engine (live analysis streams through the worker's 'live' messages, see worker.js)

route('POST', '/api/engine/eval', ({ body }) => {
  const { fen, depth = 18, multipv = 1 } = obj(body);
  return evaluate(fen, { depth: Math.max(1, Math.min(Number(depth) || 18, 30)), multipv: Number(multipv) || 1 });
});

route('POST', '/api/engine/move', ({ body }) => {
  const { fen, uci, depth } = obj(body);
  return evaluateMove(fen, uci, { depth: Math.max(1, Math.min(Number(depth) || 16, 24)), maxTime: 8_000 });
});

route('POST', '/api/engine/play', ({ body }) => {
  const { fen, level } = obj(body);
  return playMove(fen, level);
});

route('GET', '/api/engine/levels', () => PLAY_LEVELS);

route('GET', '/api/position/features', ({ query }) => ({ text: describePosition(posFromFen(fenParam(query))) }));

// ---------------------------------------------------------------------------------------------
// Games

/** body: a File/Blob (one PGN file, any size) or a string. */
route('POST', '/api/games/import', async ({ body, query }) => {
  const name = String(query.name || '').trim() || `Import ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const importer = new PgnImporter({ name, source: 'file' });
  try {
    if (body instanceof Blob) {
      if (body.size > 2 * 1024 * 1024 * 1024) throw new HttpError(413, 'File too large');
      const reader = body.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        importer.feed(value);
      }
    } else if (typeof body === 'string') importer.feed(body);
    else throw new HttpError(400, 'Nothing to import');
    const stats = importer.finish();
    return { ...stats, ids: stats.ids.slice(0, 2000) };
  } finally {
    importer.close();
  }
});

route('POST', '/api/games/import-online', async ({ body }) => {
  const { site, username, max, months, perfType } = obj(body);
  const stats = site === 'chesscom' ? await importFromChessCom({ username, months }) : await importFromLichess({ username, max, perfType });
  return { ...stats, ids: stats.ids.slice(0, 2000) };
});

route('GET', '/api/games', ({ query }) => listGames(query));
route('GET', '/api/games/ids', ({ query }) => ({ ids: allGameIds(query) }));
route('GET', '/api/games/players', () => players());
route('GET', '/api/collections', () => collections());

route('GET', '/api/games/:id', ({ params }) => {
  const g = getGame(params.id);
  if (!g) throw new HttpError(404, 'Game not found');
  return g;
});

route('POST', '/api/games/delete', ({ body }) => ({ ok: true, ...deleteGames(ids(obj(body).ids)) }));

route('GET', '/api/explorer', ({ query }) => {
  const player = query.player === 'me' ? myNames().join(',') : query.player;
  if (query.player === 'me' && !player) return { moves: [], games: [], noNames: true };
  return explorer({ fen: query.fen, player, color: query.color, collection: query.collection });
});

route('GET', '/api/explorer/lichess', ({ query }) => lichessExplorer({ db: query.db === 'lichess' ? 'lichess' : 'masters', fen: fenParam(query) }));

// ---------------------------------------------------------------------------------------------
// Openings

route('GET', '/api/openings/lookup', ({ query }) => lookup(keyOf(posFromFen(fenParam(query)))));
route('GET', '/api/openings/book', ({ query }) => bookMoves(fenParam(query)));
route('GET', '/api/openings/search', ({ query }) => searchOpenings(String(query.q || ''), Math.max(1, Math.min(Number(query.limit) || 25, 50))));

// ---------------------------------------------------------------------------------------------
// Batch analysis jobs (progress is pushed on the 'jobs' topic)

route('POST', '/api/jobs/analyze', ({ body }) => {
  const { gameIds, preset, force } = obj(body);
  const list = ids(gameIds);
  if (!list.length) throw new HttpError(400, 'No games selected');
  return jobs.startAnalysis({ gameIds: list, preset, force: !!force });
});
route('GET', '/api/jobs', () => ({ active: jobs.active(), recent: jobs.list() }));
route('POST', '/api/jobs/:id/cancel', ({ params }) => ({ ok: jobs.cancel(params.id) }));

// ---------------------------------------------------------------------------------------------
// Reports

function reportRow(r, withStats = false) {
  return {
    id: r.id,
    title: r.title,
    player: r.player,
    gameIds: json(r.game_ids, []),
    narrative: r.narrative,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(withStats ? { stats: json(r.stats) } : { summary: summaryOf(json(r.stats)) }),
  };
}
const summaryOf = st => (st ? { games: st.games, accuracy: st.accuracy, score: st.results?.score, period: st.period } : null);

route('POST', '/api/reports', ({ body }) => {
  const b = obj(body);
  const names = b.player
    ? String(b.player)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : myNames();
  if (!names.length) throw new HttpError(400, 'Set your usernames in Settings (or choose a player) so the report knows which side you played.');
  let list = ids(b.gameIds);
  if (!list.length) list = allGameIds({ player: names.join(','), analyzed: '1' });
  const stats = playerStats({ names, gameIds: list });
  if (!stats.games) throw new HttpError(400, 'None of these games are analysed games of this player yet. Analyse them first.');
  list = stats.gameList.map(g => g.id);
  const display = b.player ? names[0] : getSettings().profile.usernames?.[0] || names[0];
  const title = String(b.title || `${display} — ${stats.games} games`).slice(0, 200);
  const id = run(
    'INSERT INTO reports (title, player, game_ids, stats, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    title,
    names.join(', '),
    JSON.stringify(list),
    JSON.stringify(stats),
    now(),
    now(),
  ).id;
  return reportRow(get('SELECT * FROM reports WHERE id = ?', id), true);
});

route('GET', '/api/reports', () => all('SELECT * FROM reports ORDER BY id DESC').map(r => reportRow(r)));

route('GET', '/api/reports/:id', ({ params }) => {
  const r = get('SELECT * FROM reports WHERE id = ?', Number(params.id));
  if (!r) throw new HttpError(404, 'Report not found');
  return reportRow(r, true);
});

route('DELETE', '/api/reports/:id', ({ params }) => {
  run('DELETE FROM reports WHERE id = ?', Number(params.id));
  return { ok: true };
});

// ---------------------------------------------------------------------------------------------
// The coach's tools (the page forwards the calls it receives from the coach host). UI actions of the tools are
// pushed on the 'coach-ui' topic.

route('POST', '/api/agent/tools/:name', async ({ params, body, push }) => {
  const b = obj(body);
  const input = b.arguments && typeof b.arguments === 'object' && !Array.isArray(b.arguments) ? b.arguments : {};
  return executeTool(params.name, input, { emit: ev => push('coach-ui', ev), screen: b.screen || null });
});

// Bringing over the data of Chess Coach 1.x (the main process reads the old database, the page passes the rows on)
route('POST', '/api/legacy/import', ({ body }) => importLegacy(obj(body)));

// A backup of the games database (Settings → Your data), and restoring one (the window reloads afterwards)
route('GET', '/api/backup', () => ({ bytes: exportDatabase() }));
route('POST', '/api/backup/restore', async ({ body }) => {
  if (!(body instanceof Blob)) throw new HttpError(400, 'Choose a backup file.');
  restoreDatabase(new Uint8Array(await body.arrayBuffer()));
  return { ok: true };
});

// ---------------------------------------------------------------------------------------------
// Training: repertoire & exercises

route('GET', '/api/repertoire', ({ query }) => {
  const color = query.color === 'black' ? 'black' : 'white';
  return { color, entries: repertoire(color), stats: repertoireStats(color) };
});
route('POST', '/api/repertoire/add', ({ body }) => {
  const { color, moves, fen, uci, comment } = obj(body);
  if (color !== 'white' && color !== 'black') throw new HttpError(400, 'color must be white or black');
  if (moves) {
    if (!Array.isArray(moves) || moves.length > 80) throw new HttpError(400, 'Invalid moves');
    return addLineToRepertoire(color, moves.map(String), comment ? String(comment).slice(0, 500) : null);
  }
  addMoveToRepertoire(color, fen, uci, comment ? String(comment).slice(0, 500) : null);
  return { ok: true };
});
route('POST', '/api/repertoire/remove', ({ body }) => {
  const { color, key, uci } = obj(body);
  removeFromRepertoire(color === 'black' ? 'black' : 'white', String(key || ''), String(uci || ''));
  return { ok: true };
});
route('POST', '/api/repertoire/import', ({ body }) => {
  const { color, pgn } = obj(body);
  if (color !== 'white' && color !== 'black') throw new HttpError(400, 'color must be white or black');
  return importRepertoirePgn(color, String(pgn || '').slice(0, 5_000_000));
});
route('POST', '/api/repertoire/review', ({ body }) => {
  const { id, grade } = obj(body);
  return reviewRepertoireMove(id, Math.max(0, Math.min(3, Number(grade) || 0)));
});

route('GET', '/api/exercises', ({ query }) => {
  const list = listExercises({ dueOnly: query.due === '1' });
  return { exercises: list, total: get('SELECT COUNT(*) n FROM exercises').n, due: get('SELECT COUNT(*) n FROM exercises WHERE due IS NULL OR due <= ?', now()).n };
});
route('POST', '/api/exercises/generate', ({ body }) => {
  const names = myNames();
  if (!names.length) throw new HttpError(400, 'Set your usernames in Settings first.');
  const given = ids(obj(body).gameIds);
  const list = given.length ? given : allGameIds({ player: names.join(','), analyzed: '1' });
  return generateExercises({ names, gameIds: list, max: 20 });
});
route('POST', '/api/exercises/:id/check', ({ body, params }) => checkExercise(params.id, String(obj(body).uci || '')));
route('POST', '/api/exercises/:id/review', ({ body, params }) => reviewExercise(params.id, Math.max(0, Math.min(3, Number(obj(body).grade) || 0))));
route('DELETE', '/api/exercises/:id', ({ params }) => {
  deleteExercise(params.id);
  return { ok: true };
});

// ---------------------------------------------------------------------------------------------

/**
 * Answers one request. ctx: { push(topic, data) }. Resolves with the data; rejects with an error carrying
 * `status` (4xx: shown to the student as is).
 */
export async function handle(method, path, body, ctx = {}) {
  const url = new URL(path, 'http://local');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      return await r.handler({ params, query: Object.fromEntries(url.searchParams), body, push: ctx.push || (() => {}) });
    } catch (e) {
      if (e instanceof ChessError) e.status = 400;
      if (!Number.isInteger(e.status)) {
        console.error(`${method} ${url.pathname}:`, e);
        e.status = 500;
      }
      throw e;
    }
  }
  throw new HttpError(404, `Unknown endpoint ${method} ${url.pathname}`);
}
