// Engine-backed features of the in-browser backend, run in Node with native Stockfish (same UCI protocol as the
// browser's Stockfish WebAssembly): evaluations, move judgement, sparring, batch analysis, statistics, reports,
// exercises, and the coach's tools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openBackend, closeBackend, fixture, STOCKFISH } from './setup.mjs';
import { get, all } from '../../app/js/backend/db.js';
import { PgnImporter } from '../../app/js/backend/games.js';
import { updateSettings } from '../../app/js/backend/settings.js';
import { evaluate, evaluateMove, playMove, live } from '../../app/js/backend/engine/pool.js';
import { jobs } from '../../app/js/backend/analysis/batch.js';
import { handle } from '../../app/js/backend/router.js';
import { executeTool } from '../../app/js/backend/coach/tools.js';
import { playLine, INITIAL_FEN } from '../../app/js/backend/chess/core.js';

const skip = STOCKFISH ? false : 'Stockfish (native) not found';
let ids = [];

before(async () => {
  await openBackend();
  updateSettings({ profile: { usernames: ['student1'] }, engine: { batchWorkers: 2, batchThreads: 1, agentThreads: 1, liveThreads: 1 } });
  const imp = new PgnImporter({ name: 'fixture', source: 'file' });
  imp.feed(fixture('games.pgn'));
  ids = imp.finish().ids;
});
after(closeBackend);

test('evaluate: lines in SAN, White-POV scores, mate and game-over positions', { skip }, async () => {
  const start = await evaluate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 10, multipv: 3 });
  assert.equal(start.lines.length, 3);
  assert.ok(start.lines[0].san.length > 0);
  assert.ok(Math.abs(start.lines[0].score.cp) < 100);
  // Black to move and mate in 1 (…Qh4#): the score must be negative (White's point of view)
  const mate = await evaluate('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2', { depth: 6 });
  assert.equal(mate.lines[0].score.mate, -1);
  assert.equal(mate.lines[0].san[0], 'Qh4#');
  const over = await evaluate('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  assert.match(over.gameOver, /checkmate/);
  // cached: the same single-line request comes from the evaluation cache
  const again = await evaluate('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2', { depth: 6 });
  assert.equal(again.cached, true);
  await assert.rejects(evaluate('not a fen'));
});

test('move judgement: a blunder and the best move', { skip }, async () => {
  // 1.f3 e5 2.g4?? allows …Qh4#
  const blunder = await evaluateMove('rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2', 'g2g4', { depth: 10 });
  assert.equal(blunder.classification, 'blunder');
  assert.equal(blunder.reply.san, 'Qh4#');
  const best = await evaluateMove('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2', 'd8h4', { depth: 8 });
  assert.ok(['best', 'great'].includes(best.classification));
  await assert.rejects(evaluateMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2e5'), e => e.status === 400);
});

test('sparring moves at different strengths are legal', { skip }, async () => {
  for (const level of [1, 5, 11]) {
    const r = await playMove('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', level);
    assert.match(r.uci, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
  }
  assert.deepEqual(await playMove('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', 5), { uci: null, gameOver: 'checkmate — Black wins' });
});

test('live analysis streams lines and stops', { skip }, async () => {
  const events = [];
  const on = e => events.push(e);
  live.on('event', on);
  live.analyze({ id: 7, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', multipv: 2 });
  await new Promise(r => setTimeout(r, 1500));
  live.stop();
  await new Promise(r => setTimeout(r, 300));
  live.off('event', on);
  const infos = events.filter(e => e.type === 'info' && e.id === 7);
  assert.ok(infos.length > 0);
  assert.ok(infos.at(-1).lines.length >= 1);
  assert.ok(infos.at(-1).depth > 3);
});

test('batch analysis of the student’s games, then statistics, a report and exercises', { skip, timeout: 240_000 }, async () => {
  const done = new Promise((resolve, reject) => {
    const on = e => {
      if (e.type !== 'job' || e.status === 'running') return;
      jobs.off('event', on);
      e.status === 'done' ? resolve(e) : reject(new Error(e.error || e.status));
    };
    jobs.on('event', on);
  });
  const job = jobs.startAnalysis({ gameIds: ids, preset: 'fast', force: false });
  assert.ok(job.id);
  const finished = await done;
  assert.equal(finished.progress.gamesDone, ids.length);
  assert.equal(get('SELECT COUNT(*) n FROM analyses').n, ids.length);
  const a = JSON.parse(get('SELECT data FROM analyses WHERE game_id = ?', ids[0]).data);
  assert.equal(a.moves.length, 7);
  assert.equal(a.moves.at(-1).san, 'Qxf7#');
  assert.ok(a.summary.black.blunders >= 1, 'the Scholar’s mate defence blunders');
  // re-analysing at the same depth is skipped (cached)
  const again = jobs.startAnalysis({ gameIds: ids, preset: 'fast' });
  await new Promise(resolve => {
    const on = e => e.type === 'job' && e.id === again.id && e.status !== 'running' && (jobs.off('event', on), resolve());
    jobs.on('event', on);
  });

  const report = await handle('POST', '/api/reports', {});
  assert.equal(report.stats.games, 3);
  assert.ok(report.stats.accuracy > 0);
  const list = await handle('GET', '/api/reports');
  assert.equal(list[0].id, report.id);
  await assert.rejects(handle('POST', '/api/reports', { player: 'nobody-here' }), e => e.status === 400);

  const ex = await handle('POST', '/api/exercises/generate', {});
  assert.ok(ex.checked >= 0);
  const exercises = await handle('GET', '/api/exercises');
  for (const e of exercises.exercises) {
    const wrongCheck = await handle('POST', `/api/exercises/${e.id}/check`, { uci: 'a1a1' });
    assert.equal(wrongCheck.correct, false);
    const right = await handle('POST', `/api/exercises/${e.id}/check`, { uci: e.solution.ucis[0] });
    assert.equal(right.correct, true);
    const rev = await handle('POST', `/api/exercises/${e.id}/review`, { grade: 2 });
    assert.ok(rev.due > Date.now());
  }
});

test('the coach’s tools run here and validate their input', { skip, timeout: 120_000 }, async () => {
  const ui = [];
  const ctx = { emit: ev => ui.push(ev), screen: { view: 'analysis', context: { mode: 'analysis', ucis: ['e2e4', 'e7e5'] } } };
  const t = (name, input) => executeTool(name, input, ctx);

  const play = await t('play_moves', { fen: 'startpos', moves: ['e4', 'e5', 'Nf3', 'Ke7??', 'Nc6'] });
  assert.equal(play.isError, false);
  // "Ke7??" is legal (annotation glyphs are ignored); White's "Nc6" is not, and the legal moves are listed
  assert.match(play.content, /2\.\.\. Ke7 → /);
  assert.match(play.content, /ERROR: Illegal or unreadable move "Nc6" .* Legal moves: .*Nxe5/);
  const bad = await t('analyze_position', { fen: 'xx', depth: 10 });
  assert.equal(bad.isError, true);
  const invalid = await t('analyze_position', { fen: 'startpos', depth: 99 });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content, /≤ 28/);
  const unknown = await t('rm_rf', {});
  assert.equal(unknown.isError, true);
  const helperOnly = await t('get_player_memory', {});
  assert.equal(helperOnly.isError, true, 'the notes are answered by the coach host, not the window');

  const ana = await t('analyze_position', { fen: 'startpos', depth: 10, multipv: 2 });
  assert.equal(ana.isError, false);
  assert.match(ana.content, /^Position .* White to move\.\n1\) /);
  const feat = await t('get_position_features', { fen: 'startpos' });
  assert.match(feat.content, /Material/i);
  const ev = await t('evaluate_move', { fen: 'startpos', move: 'e4' });
  assert.match(ev.content, /Move: 1\. e4 by white/);
  const ill = await t('evaluate_move', { fen: 'startpos', move: 'Ke2' });
  assert.equal(ill.isError, true);

  const board = await t('get_board_state', {});
  assert.match(board.content, /Active screen: Board/);
  assert.match(board.content, /1\. e4 e5/);
  const noPage = await executeTool('get_board_state', {}, { emit: () => {}, screen: null });
  assert.match(noPage.content, /not showing a screen/);

  const set = await t('set_board', { fen: 'startpos', moves: ['e4', 'c5'], arrows: ['e2e4 g', 'zz'], highlights: ['d5', 'x9'], caption: 'Sicilian', ask_move: true });
  assert.equal(set.isError, false);
  const ev1 = ui.find(e => e.action === 'set_board');
  assert.equal(ev1.line.length, 2);
  assert.deepEqual(ev1.shapes, [{ orig: 'e2', dest: 'e4', brush: 'green' }, { orig: 'd5', brush: 'yellow' }]);
  assert.equal(ev1.askMove, true);
  const badLine = await t('set_board', { fen: 'startpos', moves: ['e5'] });
  assert.equal(badLine.isError, true);

  const games = await t('search_games', {});
  assert.match(games.content, /games match/);
  const game = await t('get_game', { game_id: ids[0] });
  assert.match(game.content, /Qxf7#/);
  assert.equal((await t('get_game', { game_id: 99999 })).isError, true);
  const mistakes = await t('find_mistakes', { min_judgement: 'inaccuracy' });
  assert.equal(mistakes.isError, false);
  const statsText = await t('get_player_stats', {});
  assert.match(statsText.content, /Player: student1/);
  const rep = await t('get_report', {});
  assert.match(rep.content, /Report #\d+/);
  const save = await t('save_report', { report_id: Number(/Report #(\d+)/.exec(rep.content)[1]), markdown: '## My report\nGood.' });
  assert.equal(save.isError, false);
  assert.ok(ui.some(e => e.action === 'report_saved'));
  const ex = await t('create_exercise', { fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2', solution: ['Qh4#'], prompt: 'Black to move and mate' });
  assert.match(ex.content, /Exercise saved to the training deck \(id \d+\)/);
  const exAgain = await t('create_exercise', { fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2', solution: ['Qh4#'], prompt: 'Again' });
  assert.equal(/id (\d+)/.exec(exAgain.content)[1], /id (\d+)/.exec(ex.content)[1], 'the same position keeps its exercise id');
  const repAdd = await t('add_to_repertoire', { color: 'black', moves: ['e4', 'c5', 'Nf3', 'd6'] });
  assert.match(repAdd.content, /Added to the black repertoire/);
  const repBad = await t('add_to_repertoire', { color: 'black', moves: ['e4', 'e4'] });
  assert.equal(repBad.isError, true);
  const open = await t('open_game', { game_id: ids[1], ply: 99 });
  assert.match(open.content, /after ply 5/);
  const opening = await t('opening_info', { fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2' });
  assert.match(opening.content, /Sicilian/);
  updateSettings({ voice: { enabled: false } });
  const quiet = await t('speak', { text: 'Hello' });
  assert.match(quiet.content, /switched off/);
  updateSettings({ voice: { enabled: true } });
  const loud = await t('speak', { text: 'Hello' });
  assert.equal(loud.isError, false);
  assert.ok(ui.some(e => e.action === 'speak' && e.text === 'Hello'));
  assert.equal(all('SELECT * FROM exercises').length >= 1, true);
});

test('the coach shows a position with the moves that lead to it, and takes the student to another screen', async () => {
  const ui = [];
  const t = (name, input, screen = null) => executeTool(name, input, { emit: e => ui.push(e), screen });
  const last = () => ui.at(-1);
  const openings = { view: 'openings', context: { mode: 'openings', ucis: [] } };
  const NAJDORF = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];
  const najdorf = playLine(INITIAL_FEN, NAJDORF).fen;

  // the coach's own move order (fen can be left out): on the Openings screen the board plays it out
  const own = await t('set_board', { moves_from_start: NAJDORF, caption: 'The Najdorf' }, openings);
  assert.equal(own.isError, false, own.content);
  assert.match(own.content, /plays it out from the initial position: 1\. e4 c5 2\. Nf3 d6 3\. d4 cxd4 4\. Nxd4 Nf6 5\. Nc3 a6\.$/);
  assert.deepEqual([last().fen, last().pathFrom, last().caption], [najdorf, 'moves', 'The Najdorf']);
  assert.deepEqual(last().path.map(m => m.san), NAJDORF);
  // a named position alone: its moves come from the opening book, in the opening's own order
  const named = await t('set_board', { fen: najdorf });
  assert.equal(last().pathFrom, 'book');
  assert.deepEqual(last().path.map(m => m.san), NAJDORF);
  assert.match(named.content, /Its moves from the initial position are in the move list: 1\. e4 c5/);
  // a position a move or two after the line on the student's board continues that line (here out of the book)
  const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
  const after = await t('set_board', { fen: playLine(INITIAL_FEN, [...line, 'Ke2', 'Ke7']).fen }, { view: 'analysis', context: { mode: 'analysis', ucis: line } });
  assert.deepEqual([last().pathFrom, last().path.map(m => m.uci)], ['board', [...line, 'e1e2', 'e8e7']]);
  assert.doesNotMatch(after.content, /initial position/);
  // no known way there: the position alone, and on the Openings screen a word about moves_from_start
  const alone = await t('set_board', { fen: '8/8/4k3/8/8/4K3/4P3/8 w - - 0 1' }, openings);
  assert.deepEqual([last().path, last().pathFrom], [null, null]);
  assert.match(alone.content, /give moves_from_start/);
  // the coach's moves must be legal and lead to its fen
  assert.match((await t('set_board', { fen: najdorf, moves_from_start: ['e4', 'c5'] })).content, /not to the fen you gave/);
  assert.equal((await t('set_board', { moves_from_start: ['e4', 'e4'] })).isError, true);
  assert.match((await t('set_board', {})).content, /Give the position/);

  // switch_screen: the window goes to the screen's route; Openings opens with the coach next to the board
  const sw = await t('switch_screen', { screen: 'openings' });
  assert.deepEqual(last(), { type: 'ui', action: 'switch_screen', view: 'openings', tab: 'coach' });
  assert.match(sw.content, /^Switched the app to the Openings screen \(coach tab\)\.$/);
  await t('switch_screen', { screen: 'train', tab: 'lessons' });
  assert.deepEqual([last().view, last().tab], ['train', 'lessons']);
  assert.match((await t('switch_screen', { screen: 'games' })).content, /not shown there/);
  assert.match((await t('switch_screen', { screen: 'openings', tab: 'repertoire' })).content, /not shown there/);
  const n = ui.length;
  assert.match((await t('switch_screen', { screen: 'board', tab: 'lessons' })).content, /has the tabs moves, explorer, game/);
  assert.equal((await t('switch_screen', { screen: 'garden' })).isError, true);
  assert.equal(ui.length, n, 'nothing happens on the screen after an error');
});

test('the coach reads the repertoire, adds lines and removes them', async () => {
  const ui = [];
  const t = (name, input) => executeTool(name, input, { emit: e => ui.push(e), screen: null });
  assert.match((await t('get_repertoire', { color: 'white' })).content, /white repertoire is empty/);
  for (const moves of [['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], ['d4', 'd5', 'c4']]) assert.equal((await t('add_to_repertoire', { color: 'white', moves })).isError, false);
  const all = await t('get_repertoire', { color: 'white' });
  assert.match(all.content, /^The student's white repertoire: 9 moves, 6 of them white's/);
  assert.match(all.content, /\n- 1\. e4 e5 2\. Nf3 Nc6 3\. Bb5\n- 1\. e4 e5 2\. Nf3 Nc6 3\. Bc4\n- 1\. d4 d5 2\. c4$/);
  // the last move of the line goes, with what follows it
  const one = await t('remove_from_repertoire', { color: 'white', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] });
  assert.match(one.content, /^Removed 3\. Bc4 from the student's white repertoire, with what followed it: 1 move in all\.$/);
  assert.deepEqual(ui.at(-1), { type: 'ui', action: 'repertoire_updated', color: 'white' }, 'the Openings screen reloads it');
  assert.match((await t('remove_from_repertoire', { color: 'white', moves: ['d4'] })).content, /Removed 1\. d4 .*: 3 moves in all/);
  assert.match((await t('get_repertoire', { color: 'white' })).content, /: 5 moves, .*\n- 1\. e4 e5 2\. Nf3 Nc6 3\. Bb5$/);
  // a move that is not there: what the repertoire has instead
  const missing = await t('remove_from_repertoire', { color: 'white', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /3\. Bc4 is not in the student's white repertoire after 1\. e4 e5 2\. Nf3 Nc6; there it has Bb5\./);
  assert.equal((await t('remove_from_repertoire', { color: 'white', moves: ['e4', 'e4'] })).isError, true);
  assert.equal((await t('remove_from_repertoire', { color: 'green', moves: ['e4'] })).isError, true);
});

test('the coach runs the analysis of games itself, one analysis at a time', { skip, timeout: 240_000 }, async () => {
  const t = (name, input) => executeTool(name, input, { emit: () => {}, screen: null });
  // (the games are analysed by the batch test above)
  assert.match((await t('get_analysis_status', {})).content, /^Analysis #\d+ \(\d+ games?, fast: 150k nodes per position\) is finished\./);
  assert.match((await t('analyze_games', {})).content, /games are analysed already/);
  assert.equal((await t('analyze_games', { game_ids: [99999] })).isError, true);
  assert.equal((await t('analyze_games', { depth: 'brutal' })).isError, true, 'the input is validated');

  // a deeper analysis of one game: waits for it and lists the game with its accuracy
  const one = await t('analyze_games', { game_ids: [ids[0]], depth: 'standard' });
  assert.equal(one.isError, false);
  assert.match(one.content, /\(1 game, standard: 400k nodes per position\) is finished\.\nAnalysed \(accuracy White \/ Black\):\n- #\d+ .* — [\d.]+% \/ [\d.]+%/);
  assert.equal(get('SELECT nodes FROM analyses WHERE game_id = ?', ids[0]).nodes, 400_000);

  // started without waiting; while it runs, no second analysis starts (from the coach or from the Games screen)
  const started = await t('analyze_games', { game_ids: ids, depth: 'fast', reanalyse: true, wait_seconds: 0 });
  assert.match(started.content, /has started and is still running: \d+ of \d+ games done/);
  const busy = await t('analyze_games', { game_ids: [ids[1]], depth: 'deep' });
  assert.match(busy.content, /already analysing games \(analysis #\d+: \d+ of \d+ games done\) — one analysis runs at a time/);
  await assert.rejects(handle('POST', '/api/jobs/analyze', { gameIds: [ids[1]] }), e => e.status === 409);
  const finished = await t('get_analysis_status', { wait_seconds: 200 });
  assert.match(finished.content, new RegExp(`\\(${ids.length} games, fast: 150k nodes per position\\) is finished\\.`));
  assert.equal(get('SELECT nodes FROM analyses WHERE game_id = ?', ids[0]).nodes, 150_000, 'analysed again');
});
