// The game database (desktop/gigabase/): reading Scid 5 files, unpacking 7z archives, the opening index and its
// explorer, and the manager that adds a database (a .si5 file or a .7z archive), remembers it between starts, answers
// the explorer and the coach, and removes it (its utility processes simulated in this process).
// The test database comes from a seeded generator (scid-fixtures.mjs); `PLYMENTOR_TEST_SCID=<path without extension>`
// also checks a real Scid 5 database read-only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Chess, normalizeMove } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import { parseUci, makeUci } from 'chessops/util';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import { ROOT } from './setup.mjs';
import { makeGames, writeScid5, archiveFiles, fenAfter, FAMILIES } from './scid-fixtures.mjs';
import * as S from '../../desktop/gigabase/scid5.js';
import { open7z, extract7z } from '../../desktop/gigabase/sevenzip.js';
import { buildBook, Book, ScidFiles, MAX_PLY, MIN_GAMES, radixSort32 } from '../../desktop/gigabase/book.js';
import { GameDatabase, toUcis } from '../../desktop/gigabase/service.js';
import { runJob, databaseIn } from '../../desktop/gigabase/job.js';
import { handle as queryHandle } from '../../desktop/gigabase/query.js';
import { GameDatabases } from '../../desktop/gigabase/manager.js';

const FIX = join(ROOT, 'test', 'fixtures', 'gigabase');
const tmp = mkdtempSync(join(tmpdir(), 'plymentor-gigabase-'));
const games = makeGames(1);
const base = join(tmp, 'db', 'Test');
const bookFile = join(tmp, 'db', 'openings.book');
let db;

before(() => {
  mkdirSync(join(tmp, 'db'), { recursive: true });
  writeScid5(base, games);
});
after(() => {
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const sanLine = (fen, ucis) => {
  const pos = fen ? Chess.fromSetup(parseFen(fen).unwrap()).unwrap() : Chess.default();
  return ucis.map(u => makeSanAndPlay(pos, normalizeMove(pos, parseUci(u))));
};
const mainline = root => {
  const out = [];
  for (let n = root; n.children.length; n = n.children[0]) out.push(n.children[0].uci);
  return out;
};

test('Scid 5 files read back exactly: names, index entries, moves, variations, comments, NAGs, a FEN start', () => {
  const files = new ScidFiles(base);
  const names = new S.Names(readFileSync(base + '.sn5'));
  try {
    assert.equal(files.count, games.length);
    games.forEach((g, id) => {
      const e = files.entry(id);
      assert.equal(names.get(S.NAME_PLAYER, e.white), g.white);
      assert.equal(names.get(S.NAME_PLAYER, e.black), g.black);
      assert.equal(names.get(S.NAME_EVENT, e.event), g.event);
      assert.equal(e.whiteElo, g.whiteElo);
      assert.equal(S.RESULT_PGN[e.result], g.result);
      assert.equal(S.dateString(e.date), `${g.date[0]}.${String(g.date[1]).padStart(2, '0')}.${String(g.date[2]).padStart(2, '0')}`);
      assert.equal(e.plies, g.line.length);
      const tree = S.decodeGameTree(files.gameData(e));
      assert.equal(tree.fen, g.fen || null);
      assert.deepEqual(sanLine(g.fen, mainline(tree.root)), sanLine(g.fen, g.line.map(m => m.uci)), `game ${id}`);
    });
    // the annotated game: variations with their comments and NAGs, in the right places
    const id = games.findIndex(g => g.comment === 'An old Italian game.');
    const tree = S.decodeGameTree(files.gameData(files.entry(id)));
    assert.equal(tree.root.comment, 'An old Italian game.');
    let n = tree.root;
    for (let k = 0; k < 4; k++) n = n.children[0];
    assert.deepEqual(n.children.map(c => c.uci), ['f1c4', 'f1b5', 'd2d4'], 'the main move, then the two variations');
    assert.equal(n.children[0].comment, 'The Italian.');
    assert.deepEqual(n.children[0].nags, [1]);
    assert.equal(n.children[1].comment, 'The Spanish instead');
    assert.deepEqual(n.children[1].nags, [3]);
    assert.equal(n.children[1].children[0].uci, 'a7a6');
    assert.equal(n.children[2].startComment, 'Scotch:');
    assert.deepEqual(tree.tags, [['WhiteFideId', String(1000 + id)]]);
  } finally {
    files.close();
  }
});

test('Scid moves: every piece type, castling both ways, en passant, promotions and underpromotions', () => {
  // a game exercising the special moves, through the writer's encoder and the reader
  const pgnMoves =
    'e4 e6 e5 f5 exf6 Nxf6 d4 Be7 Bd3 O-O Bg5 b6 Nc3 Bb7 Qd2 Na6 O-O-O c5 Bxa6 Bxa6 Qf4 Qc7 Qxc7 Bb7 Nf3 Ne4 Nxe4 Bxe4 Rhe1 Bxf3 gxf3 Rf7 Bxe7 Rxe7 Rxe6 dxe6 Qxe7 h5 Qxe6+ Kh7 Qf5+ Kh6 h4 a5 d5 a4 d6 a3 d7 axb2+ Kxb2 Rxa2+ Kxa2 b5 d8=R b4 R8d5 g6 Qf4+ g5';
  const pos = Chess.default();
  const line = pgnMoves.split(' ').map(san => {
    const m = parseSan(pos, san);
    assert.ok(m, san);
    const r = { uci: makeUci(m), san };
    pos.play(m);
    return r;
  });
  const g = { ...games[0], line, fen: undefined };
  const b = join(tmp, 'special');
  writeScid5(b, [g]);
  const files = new ScidFiles(b);
  try {
    const tree = S.decodeGameTree(files.gameData(files.entry(0)));
    assert.deepEqual(sanLine(null, mainline(tree.root)), sanLine(null, line.map(m => m.uci)));
  } finally {
    files.close();
  }
  // FEN start with the king swapped to index 0 (the example of Scid's documentation)
  const p = new S.ScidPosition().setFen('rnb1k2Q/1p5p/p7/4p3/4q3/8/PPP2R1P/2K5 b - - 0 1');
  assert.equal(p.listPos[56], 3, 'the black rook on a8 gets index 3');
  assert.equal(p.listPos[57], 1, 'the black knight on b8 gets index 1');
  assert.equal(p.listPos[63], 6, 'the white queen on h8 gets index 6');
  assert.equal(p.listPos[8], 1, 'the white pawn on a2 gets index 1');
  assert.equal(p.listPos[60], 0);
  // keys: the same position by two move orders, en passant only when a pawn can take
  const k1 = S.keyOfFen(fenAfter({ line: toUcis(['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6']).map(uci => ({ uci })) }, 6));
  const k2 = S.keyOfFen(fenAfter({ line: toUcis(['c4', 'e6', 'Nc3', 'd5', 'd4', 'Nf6']).map(uci => ({ uci })) }, 6));
  assert.deepEqual(k1, k2);
  assert.deepEqual(S.keyOfFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'), S.keyOfFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'));
  assert.notDeepEqual(S.keyOfFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'), S.keyOfFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'));
  assert.equal(S.ecoString(0), '');
  assert.equal(S.ecoString(((1 * 100 + 90) * 131) + 1), 'B90');
});

test('7z archives (LZMA2, LZMA, stored) unpack exactly, and damage is found', () => {
  const want = archiveFiles();
  for (const method of ['lzma2', 'lzma1', 'store']) {
    const archive = join(FIX, `files-${method}.7z`);
    const a = open7z(archive);
    a.close();
    assert.deepEqual(a.files.filter(f => !f.dir).map(f => f.name).sort(), Object.keys(want).sort(), method);
    const out = join(tmp, `x-${method}`);
    mkdirSync(out, { recursive: true });
    const progress = [];
    extract7z(archive, f => (f.dir ? null : join(out, f.name.replace(/\//g, '_'))), { onProgress: (d, t) => progress.push([d, t]) });
    for (const [name, data] of Object.entries(want)) assert.deepEqual(readFileSync(join(out, name.replace(/\//g, '_'))), data, `${method} ${name}`);
    assert.deepEqual(progress.at(-1), [progress.at(-1)[1], progress.at(-1)[1]]);
  }
  // only the chosen files are written
  const some = join(tmp, 'x-some');
  mkdirSync(some);
  extract7z(join(FIX, 'files-lzma2.7z'), f => (f.name === 'b.bin' ? join(some, 'b.bin') : null));
  assert.deepEqual(readdirSync(some), ['b.bin']);
  // a damaged archive: a byte changed in the packed data
  const bad = join(tmp, 'bad.7z');
  const bytes = readFileSync(join(FIX, 'files-lzma2.7z'));
  bytes[200] ^= 0x55;
  writeFileSync(bad, bytes);
  assert.throws(() => extract7z(bad, f => (f.dir ? null : join(tmp, 'bad-' + f.name.replace(/\//g, '_')))), /damaged|LZMA|CRC/i);
  writeFileSync(bad, bytes.subarray(0, 100));
  assert.throws(() => open7z(bad), /incomplete|cut short/i);
  writeFileSync(bad, Buffer.from('PK not a 7z archive'));
  assert.throws(() => open7z(bad), /not a 7z/);
  // the test database archive holds a Scid 5 database in a folder, the way big databases are published
  const a = open7z(join(FIX, 'test-db.7z'));
  a.close();
  assert.equal(databaseIn(a.files).name, 'Test_Base');
});

test('the opening index: counts like the games themselves, transpositions, top games', () => {
  const r = buildBook(base, bookFile, { tmpDir: join(tmp, 'booktmp') });
  assert.equal(r.games, games.length);
  assert.ok(!existsSync(join(tmp, 'booktmp')), 'the temporary files are removed');
  db = new GameDatabase({ base, bookFile, info: { title: 'Test' } });
  const std = games.filter(g => !g.fen);
  // the games reaching a position after 1..MAX_PLY-1 moves (once per time they reach it, as the index counts)
  const key4 = fen => fen.split(' ').slice(0, 4).join(' ');
  const reached = fen => std.flatMap(g => g.line.slice(0, MAX_PLY - 1).map((_, k) => k + 1).filter(ply => key4(fenAfter(g, ply)) === key4(fen)).map(() => g));
  // the start position: every standard game, split by first move
  const start = db.explore({ fen: S.STANDARD_FEN });
  assert.equal(start.source, 'index');
  assert.equal(start.white + start.draws + start.black, std.filter(g => g.result !== '*').length);
  const firsts = {};
  for (const g of std) firsts[g.line[0].san] = (firsts[g.line[0].san] || 0) + 1;
  for (const m of start.moves) {
    const n = m.white + m.draws + m.black;
    const played = std.filter(g => g.line[0].san === m.san);
    assert.equal(n, played.filter(g => g.result !== '*').length, m.san);
    assert.equal(m.white, played.filter(g => g.result === '1-0').length);
  }
  assert.deepEqual(start.moves.map(m => m.san).sort(), Object.keys(firsts).sort());
  // the QGD reached by two move orders counts both
  const qgd = fenAfter({ line: toUcis(FAMILIES[2][1].split(' ')).map(uci => ({ uci })) }, 6);
  const q = db.explore({ fen: qgd });
  assert.equal(q.source, 'index');
  const occ = reached(qgd);
  assert.ok(occ.length >= 85, `${occ.length}`);
  assert.equal(q.white + q.draws + q.black, occ.filter(g => g.result !== '*').length);
  assert.equal(q.moves.reduce((n, m) => n + m.white + m.draws + m.black, 0), occ.filter(g => g.result !== '*').length, 'every game goes on from here');
  // top games: both players rated, the lower rating first
  const low = id => Math.min(games[id].whiteElo, games[id].blackElo);
  assert.ok(start.topGames.length > 0 && start.topGames.length <= 5);
  for (const g of start.topGames) assert.ok(games[g.id].whiteElo > 0 && games[g.id].blackElo > 0);
  for (let k = 1; k < start.topGames.length; k++) assert.ok(low(start.topGames[k - 1].id) >= low(start.topGames[k].id));
  const best = Math.max(...std.filter(g => g.whiteElo && g.blackElo).map(g => Math.min(g.whiteElo, g.blackElo)));
  assert.equal(low(start.topGames[0].id), best);
  // a summary as the explorer shows it
  const s = start.topGames[0];
  assert.equal(s.white, games[s.id].white);
  assert.match(s.date, /^\d{4}\.\d{2}\.\d{2}$/);
});

test('beyond the index: a rare line is followed through its games; without the line nothing is found', () => {
  // a long game from a family: deep in it, its position is reached by it alone
  const id = games.findIndex(g => !g.fen && g.line.length > 45 && g.line[0].san === 'e4' && g.line[2]?.san === 'Nf3');
  const g = games[id];
  const ply = 30;
  const ucis = g.line.slice(0, ply).map(m => m.uci);
  const fen = fenAfter(g, ply);
  const r = db.explore({ fen, moves: ucis });
  assert.equal(r.source, 'games');
  assert.ok(r.topGames.some(t => t.id === id), 'the game itself is listed');
  const next = r.moves.find(m => m.uci === S.moveToUci(moveOf(fen, g.line[ply].uci)));
  assert.ok(next, 'its next move is there');
  // SAN works too, and so does no line at all
  const sans = sanLine(null, ucis);
  assert.equal(db.explore({ fen, moves: sans }).source, 'games');
  assert.equal(db.explore({ fen }).source, 'none');
  assert.equal(db.explore({ fen, moves: ['e4', 'e5', 'Ke2'] }).source, 'none', 'a line that does not lead here');
  // a whole game as PGN, with its variations and comments
  const annotated = games.findIndex(x => x.comment === 'An old Italian game.');
  const pgn = db.game(annotated).pgn;
  assert.match(pgn, /\[White "/);
  assert.match(pgn, /\{ An old Italian game\. \}/);
  assert.match(pgn, /3\. Bc4 \$1 \{ The Italian\. \} \( 3\. Bb5 \$3 \{ The Spanish instead \} 3\.\.\. a6 \) \( \{ Scotch: \} 3\. d4 \)/);
  assert.match(pgn, /Bb4\+ \$2 \$14 \{ Check! not a brace \}/);
  const promo = db.game(games.findIndex(x => x.fen));
  assert.match(promo.pgn, /\[FEN "8\/P6k\/8\/8\/8\/8\/6Kp\/8 w - - 0 1"\]/);
  assert.match(promo.pgn, /1\. a8=N h1=Q\+ 2\. Kxh1/);
  assert.throws(() => db.summary(games.length), /No such game/);
});

/** A move as the index writes it (castling as the king's two squares). */
function moveOf(fen, uci) {
  const p = new S.ScidPosition().setFen(fen);
  p.playUci(uci);
  return p.move16();
}

/** Electron's utility processes, simulated: job.js and query.js run in this process. */
function fakeFork(script) {
  const child = new EventEmitter();
  child.postMessage = msg => {
    setImmediate(() => {
      if (child.killed) return;
      if (script === 'job') {
        try {
          const r = runJob(msg, m => child.emit('message', m));
          child.emit('message', { type: 'done', ...r });
        } catch (e) {
          child.emit('message', { type: 'error', message: e.message });
        }
        child.emit('exit', 0);
      } else {
        try {
          child.emit('message', { id: msg.id, result: queryHandle(msg) });
        } catch (e) {
          child.emit('message', { id: msg.id, error: e.message });
        }
      }
    });
  };
  child.kill = () => {
    child.killed = true;
    if (script === 'query') queryHandle({ type: 'close' });
    child.emit('exit', 1);
  };
  return child;
}

const settle = async (m, pred = s => !s.job) => {
  for (let i = 0; i < 400 && !pred(m.status()); i++) await new Promise(r => setTimeout(r, 25));
  return m.status();
};
const manager = (home, extra = {}) => new GameDatabases({ home, jobScript: 'job', queryScript: 'query', fork: fakeFork, ...extra });

test('a .7z archive with a Scid 5 database is unpacked, answers the explorer and the coach, and stays added after a restart', async () => {
  const home = join(tmp, 'home');
  const pushed = [];
  let m = manager(home, { onStatus: s => pushed.push(s) });
  assert.equal(m.status().installed, null);
  await assert.rejects(m.request('explore', { fen: S.STANDARD_FEN }), /No game database has been added/);
  const archive = join(FIX, 'test-db.7z');
  m.add(archive);
  assert.equal(m.status().job.stage, 'unpack', 'the progress shows at once');
  let s = await settle(m);
  assert.equal(s.error, null);
  assert.equal(s.installed.title, 'Test Base');
  assert.equal(s.installed.source, 'archive');
  assert.equal(s.installed.games, games.length);
  assert.equal(s.installed.missing, false);
  assert.equal(s.installed.needsIndex, false);
  assert.ok(['unpack', 'index'].every(stage => pushed.some(p => p.job?.stage === stage)), 'each step is reported');
  assert.ok(existsSync(archive), 'the archive itself is left as it is');
  const state = JSON.parse(readFileSync(join(home, 'gigabase', 'state.json'), 'utf8'));
  assert.ok(state.installed.base.startsWith(join(home, 'gigabase')), 'unpacked into the app’s folder');
  assert.ok(existsSync(state.installed.base + '.sg5') && existsSync(state.installed.book));
  assert.deepEqual(readdirSync(join(home, 'gigabase')).filter(n => n.includes('.new-')), []);
  assert.equal((await m.request('explore', { fen: S.STANDARD_FEN })).source, 'index');
  const g = await m.request('game', { id: 0 });
  assert.match(g.pgn, /\[Event "/);
  assert.equal(g.database, 'Test Base');
  // the coach's tools, through the host
  const { CoachHost } = await import('../../desktop/host.js');
  const host = new CoachHost({ mcpScript: 'unused', databases: m });
  const answer = await host.callTool({ userId: 'x' }, 'database_explorer', { fen: S.STANDARD_FEN });
  assert.equal(answer.isError, false);
  assert.match(answer.content, /^Test Base \(342 games\): \d+ games reached this position/);
  assert.match(answer.content, /- e4: \d+ games, White \d+% \/ draw \d+% \/ Black \d+%/);
  const game = await host.callTool({ userId: 'x' }, 'get_database_game', { game_id: 1 });
  assert.match(game.content, /game #1:\n\n\[Event/);
  // the app is closed and opened again: the database is still there, nothing to add again
  m.close();
  m = manager(home);
  s = m.status();
  assert.equal(s.installed.title, 'Test Base');
  assert.equal(s.installed.missing, false);
  assert.equal((await m.request('explore', { fen: S.STANDARD_FEN })).source, 'index');
  host.databases = m;
  // removing deletes the unpacked copy and the index
  await m.remove();
  assert.equal(m.status().installed, null);
  assert.deepEqual(readdirSync(join(home, 'gigabase')), ['state.json']);
  const none = await host.callTool({ userId: 'x' }, 'database_explorer', { fen: S.STANDARD_FEN });
  assert.equal(none.isError, true);
  assert.match(none.content, /has not added a game database/);
  m.close();
  assert.equal(manager(home).status().installed, null, 'and it stays removed');
});

test('a .si5 file is read where it is and remembered; moved files are reported, not forgotten', async () => {
  const home = join(tmp, 'home2');
  // folders left by an earlier start (work that stopped, a replaced database) are removed
  for (const d of ['db-Old.new-abc', 'db-Older']) mkdirSync(join(home, 'gigabase', d), { recursive: true });
  let m = manager(home);
  assert.deepEqual(readdirSync(join(home, 'gigabase')), []);
  m.add(base + '.si5');
  assert.equal(m.status().job.stage, 'index');
  let s = await settle(m);
  assert.equal(s.error, null);
  assert.equal(s.installed.source, 'file');
  assert.equal(s.installed.title, 'Test');
  assert.equal(s.installed.path, base + '.si5');
  assert.equal((await m.request('explore', { fen: S.STANDARD_FEN })).source, 'index');
  m.close();
  // the files are moved away (or their drive is not connected): the database stays remembered, with a warning
  for (const e of ['.si5', '.sn5', '.sg5']) renameSync(base + e, base + e + '.away');
  try {
    m = manager(home);
    s = m.status();
    assert.equal(s.installed.title, 'Test');
    assert.equal(s.installed.missing, true);
    await assert.rejects(m.request('explore', { fen: S.STANDARD_FEN }), /are not there any more/);
    m.close();
  } finally {
    for (const e of ['.si5', '.sn5', '.sg5']) renameSync(base + e + '.away', base + e);
  }
  // back again: it works without adding it again (its index was kept)
  m = manager(home);
  assert.equal(m.status().installed.missing, false);
  assert.equal((await m.request('explore', { fen: S.STANDARD_FEN })).source, 'index');
  // another database replaces it when ready; removing keeps the student's own files
  m.add(join(FIX, 'test-db.7z'));
  s = await settle(m);
  assert.equal(s.installed.title, 'Test Base');
  await m.remove();
  assert.ok(existsSync(base + '.si5'), 'the student’s own files are kept');
  m.add(join(tmp, 'nothing.pgn'));
  s = await settle(m);
  assert.match(s.error, /is not there|Choose a Scid 5 database/);
  writeFileSync(join(tmp, 'games.pgn'), '[Event "x"]\n\n1. e4 *\n');
  m.add(join(tmp, 'games.pgn'));
  s = await settle(m);
  assert.match(s.error, /Choose a Scid 5 database/);
  const lone = join(tmp, 'lone');
  mkdirSync(lone);
  copyFileSync(base + '.si5', join(lone, 'Lone.si5'));
  m.add(join(lone, 'Lone.si5'));
  s = await settle(m);
  assert.match(s.error, /Lone\.sn5 must be in the same folder/);
  m.close();
});

test('a radix sort of 32-bit numbers sorts like Array.sort', () => {
  const a = new Uint32Array(100000);
  let x = 12345;
  for (let i = 0; i < a.length; i++) a[i] = x = (Math.imul(x, 1103515245) + 12345) >>> 0;
  const sorted = Uint32Array.from(a).sort();
  assert.deepEqual(radixSort32(a), sorted);
});

test('a real Scid 5 database (PLYMENTOR_TEST_SCID, read-only), if given', { skip: !process.env.PLYMENTOR_TEST_SCID }, () => {
  const real = process.env.PLYMENTOR_TEST_SCID;
  const files = new ScidFiles(real);
  try {
    let checked = 0;
    const pos = new S.ScidPosition();
    files.scan(
      (g, ib, o, data) => {
        const at = S.skipTags(data, 0);
        if (data[at] & 1) return;
        pos.standard();
        assert.ok(S.playMainline(pos, data, at + 1, 1000, null) >= 0, `game ${g}`);
        checked++;
      },
      { to: Math.min(files.count, 200000) },
    );
    assert.ok(checked > 0);
  } finally {
    files.close();
  }
});
