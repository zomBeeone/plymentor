// The window's backend game library (run in Node with the same SQLite build): PGN import, queries, keys, the
// compact PGN, deletion, settings, the local API router, database backup and restore.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openBackend, closeBackend, fixture } from './setup.mjs';
import { run, get, all, dropForeignSchema } from '../../app/js/backend/db.js';
import { PgnImporter, listGames, getGame, deleteGames, collections, explorer, compactPgn, pgnKey, readGame, gameHash } from '../../app/js/backend/games.js';
import { getSettings, updateSettings, publicSettings } from '../../app/js/backend/settings.js';
import { handle } from '../../app/js/backend/router.js';
import { parsePgn } from 'chessops/pgn';

before(openBackend);
after(closeBackend);

let stats;
test('importing a PGN file: games, duplicates, variants, errors and empty games', () => {
  const imp = new PgnImporter({ name: 'fixture', source: 'file' });
  imp.feed(new TextEncoder().encode(fixture('games.pgn')));
  stats = imp.finish();
  assert.equal(stats.imported, 4, JSON.stringify(stats));
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.skipped, 2, 'the variant and the empty game');
  assert.equal(stats.errors, 1, 'the invalid FEN');
  assert.equal(get('SELECT COUNT(*) n FROM games').n, 4);
});

test('a database from elsewhere (a restored backup) loses its triggers and views before the app uses it', () => {
  run('CREATE TABLE trap_log (n INTEGER)');
  run('CREATE TRIGGER trap AFTER INSERT ON collections BEGIN INSERT INTO trap_log VALUES (1); END');
  run('CREATE VIEW peek AS SELECT * FROM games');
  dropForeignSchema();
  assert.deepEqual(all(`SELECT name FROM sqlite_schema WHERE type IN ('trigger', 'view')`), []);
  assert.equal(get('PRAGMA trusted_schema').trusted_schema, 0);
  run(`INSERT INTO collections (name, source, created_at) VALUES ('x', 'test', 0)`);
  assert.equal(get('SELECT COUNT(*) n FROM trap_log').n, 0, 'the trigger no longer runs');
  run(`DELETE FROM collections WHERE name = 'x' AND source = 'test'`);
  run('DROP TABLE trap_log');
});

test('the game key is the same as Chess Coach 1.x computed with node:crypto', () => {
  for (const g of all('SELECT * FROM games')) {
    const ucis = g.moves.split(' ');
    const expected = createHash('sha1').update([g.white, g.black, g.date, g.result, g.start_fen || '', ucis.join(' ')].join('|')).digest('hex');
    assert.equal(g.hash, expected);
  }
});

test('stored fields: clocks, dates, a start position, escaped names, opening names', () => {
  const g1 = getGame(stats.ids[0]);
  assert.equal(g1.white, 'student1');
  assert.equal(g1.date, '2026.09.01');
  assert.deepEqual(g1.clocks, [180, 180, 178, 177, 175, 170, 173]);
  assert.equal(g1.sans.at(-1), 'Qxf7#');
  assert.equal(g1.time_control, '180+2');
  const g2 = getGame(stats.ids[1]);
  assert.equal(g2.start_fen, '8/8/8/4k3/8/8/4P3/4K3 b - - 0 50');
  assert.deepEqual(g2.sans, ['Kd4', 'Kd2', 'Ke4', 'Ke1', 'Kd4']);
  const g3 = getGame(stats.ids[2]);
  assert.equal(g3.white, 'O"Brien, Pat');
  assert.equal(g3.black, 'Back\\slash');
  assert.equal(g3.date, '????.??.??', 'chessops fills in the PGN standard headers (as in 1.x)');
  const g4 = getGame(stats.ids[3]);
  assert.match(g4.opening, /Sicilian/);
  assert.match(g4.pgn, /\(\s*2\. c3 d5\s*\)/, 'variations are kept in the stored PGN');
});

test('every stored game round-trips through its PGN and the compact PGN to the same key', () => {
  for (const row of all('SELECT * FROM games')) {
    assert.equal(pgnKey(row.pgn), row.hash, `stored PGN of ${row.white}`);
    const compact = compactPgn(row);
    assert.equal(pgnKey(compact), row.hash, `compact PGN of ${row.white}:\n${compact}`);
    // the compact PGN keeps the clocks
    const g = readGame(parsePgn(compact)[0]);
    const clocks = JSON.parse(row.clocks || 'null');
    if (clocks) assert.deepEqual(g.clocks, clocks);
  }
  assert.equal(pgnKey('not a pgn'), null);
  assert.equal(pgnKey(''), null);
});

test('a Windows-1252 file is read correctly', () => {
  const text = '[White "Müller"]\n[Black "Ståhl"]\n[Result "1/2-1/2"]\n\n1. e4 e5 1/2-1/2\n';
  const bytes = Uint8Array.from([...text].map(c => c.charCodeAt(0))); // Latin-1 = Windows-1252 for these letters
  const imp = new PgnImporter({ name: 'cp1252', source: 'file' });
  imp.feed(bytes);
  const r = imp.finish();
  assert.equal(r.imported, 1);
  const g = get('SELECT white, black FROM games WHERE id = ?', r.ids[0]);
  assert.deepEqual(g, { white: 'Müller', black: 'Ståhl' });
});

test('chunked input split anywhere gives the same games', () => {
  const text = fixture('games.pgn').replace(/student1/g, 'chunky');
  const bytes = new TextEncoder().encode(text);
  const imp = new PgnImporter({ name: 'chunks', source: 'file' });
  for (let i = 0; i < bytes.length; i += 7) imp.feed(bytes.subarray(i, i + 7));
  const r = imp.finish();
  assert.equal(r.imported, 3, 'games without "student1" are duplicates of the first import');
  assert.equal(r.duplicates, 2);
});

test('queries: player, colour, results from the player’s side, opening, text, paging', () => {
  updateSettings({ profile: { usernames: 'Student1, other' } });
  const mine = listGames({ player: 'student1' });
  assert.equal(mine.total, 3);
  assert.equal(listGames({ player: 'student1', color: 'black' }).total, 1);
  assert.equal(listGames({ player: 'student1', result: 'win' }).total, 2);
  assert.equal(listGames({ player: 'student1', result: 'loss' }).total, 0);
  assert.equal(listGames({ opening: 'Sicilian' }).total >= 1, true);
  assert.equal(listGames({ text: 'Brien' }).total, 1);
  assert.equal(listGames({ text: "%' OR 1=1 --" }).total, 0, 'text is a value, never SQL');
  const page = listGames({ limit: 2, offset: 1, sort: 'added', dir: 'asc' });
  assert.equal(page.games.length, 2);
  assert.equal(listGames({ limit: 100000 }).games.length <= 1000, true);
  assert.equal(listGames({ sort: 'x; DROP TABLE games' }).total > 0, true, 'unknown sort columns fall back');
});

test('the personal explorer counts moves from a position', () => {
  const r = explorer({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' });
  const e4 = r.moves.find(m => m.san === 'e4');
  assert.ok(e4.games >= 2);
  assert.ok(r.moves.some(m => m.san === 'd4'));
});

test('deleting games counts them and removes empty collections', () => {
  const imp = new PgnImporter({ name: 'to delete', source: 'file' });
  imp.feed('[White "del1"]\n[Black "x"]\n[Result "*"]\n\n1. e4 *\n\n[White "del2"]\n[Black "x"]\n[Result "*"]\n\n1. d4 *\n');
  const r = imp.finish();
  const res = deleteGames([...r.ids, 999_999]);
  assert.deepEqual(res, { deleted: 2 }, 'a game that does not exist is not counted');
  assert.equal(get('SELECT COUNT(*) n FROM games WHERE id IN (?, ?)', ...r.ids).n, 0);
  assert.equal(get('SELECT COUNT(*) n FROM positions WHERE game_id IN (?, ?)', ...r.ids).n, 0, 'positions go with their game');
  assert.ok(!collections().some(c => c.name === 'to delete'));
});

test('an import that is still running keeps its (empty) collection', () => {
  const imp = new PgnImporter({ name: 'running', source: 'file' });
  deleteGames([]); // would clean up empty collections
  assert.ok(get('SELECT id FROM collections WHERE id = ?', imp.collectionId), 'kept while running');
  imp.feed('[White "late"]\n[Black "x"]\n[Result "*"]\n\n1. c4 *\n');
  const r = imp.finish();
  assert.equal(r.imported, 1);
  assert.equal(get('SELECT collection_id FROM games WHERE id = ?', r.ids[0]).collection_id, imp.collectionId);
  const empty = new PgnImporter({ name: 'nothing', source: 'file' });
  empty.feed('no games here');
  empty.finish();
  assert.equal(get('SELECT id FROM collections WHERE id = ?', empty.collectionId), undefined, 'an import without games leaves no collection');
});

test('settings: defaults, normalisation, unknown keys and prototype pollution', () => {
  const s = updateSettings(JSON.parse('{"__proto__":{"polluted":true},"engine":{"liveThreads":-5,"liveHash":"lots","batchPreset":"insane"},"voice":{"rate":9,"engine":"robot"},"autoComment":"sometimes","unknown":1,"language":""}'));
  assert.equal({}.polluted, undefined);
  assert.equal(s.engine.liveThreads, 1);
  assert.ok(s.engine.liveHash >= 1);
  assert.equal(s.engine.batchPreset, 'standard');
  assert.equal(s.voice.rate, 1.4);
  assert.equal(s.voice.engine, 'natural');
  assert.equal(s.autoComment, 'off', 'unknown values fall back to the default: off');
  assert.equal(s.unknown, undefined);
  assert.equal(s.language, 'English');
  assert.deepEqual(getSettings().profile.usernames, ['Student1', 'other']);
  updateSettings({ lichessToken: '  lip_abc  ' });
  assert.equal(getSettings().lichessToken, 'lip_abc');
  assert.equal(publicSettings().lichessToken, undefined, 'the token is not sent to the page');
  assert.equal(publicSettings().lichessTokenSet, true);
});

test('the local API router: games, openings, errors', async () => {
  const list = await handle('GET', '/api/games?player=student1&limit=5', undefined);
  assert.equal(list.total, 3);
  const g = await handle('GET', `/api/games/${list.games[0].id}`);
  assert.ok(g.moves.length > 0);
  await assert.rejects(handle('GET', '/api/games/999999'), e => e.status === 404);
  await assert.rejects(handle('GET', '/api/nope'), e => e.status === 404);
  await assert.rejects(handle('GET', '/api/openings/lookup?fen=garbage'), e => e.status === 400);
  const op = await handle('GET', `/api/openings/lookup?fen=${encodeURIComponent('rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2')}`);
  assert.match(op.name, /Sicilian/);
  const search = await handle('GET', '/api/openings/search?q=najdorf&limit=3');
  assert.ok(search.length > 0 && search.length <= 3);
  const imported = await handle('POST', '/api/games/import?name=pasted', '[White "router"]\n[Black "x"]\n[Result "*"]\n\n1. e4 e5 *\n');
  assert.equal(imported.imported, 1);
  const blob = await handle('POST', '/api/games/import?name=file', new Blob(['[White "blob"]\n[Black "x"]\n[Result "*"]\n\n1. Nf3 *\n']));
  assert.equal(blob.imported, 1);
  await assert.rejects(handle('POST', '/api/games/import', { not: 'a pgn' }), e => e.status === 400);
  const del = await handle('POST', '/api/games/delete', { ids: [imported.ids[0], blob.ids[0], 'x', -1] });
  assert.equal(del.ok, true);
});

test('exported helper functions behave on odd input', () => {
  assert.equal(gameHash({ white: 'a', black: 'b', date: null, result: '*', startFen: null, ucis: ['e2e4'] }), createHash('sha1').update('a|b||*||e2e4').digest('hex'));
});
