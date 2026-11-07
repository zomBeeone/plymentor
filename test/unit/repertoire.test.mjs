// The repertoire's groups — the student's folders of lines ("French"…): made and named, lines put in with what follows
// them and taken out, the lines in no group, deleted with their lines or keeping them, a PGN imported into a new
// group with its comments as the moves' notes —; the coach's repertoire tools with groups; and the training games the
// coach starts (start_training_game) and what it sees of them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openBackend, closeBackend } from './setup.mjs';
import { handle } from '../../app/js/backend/router.js';
import { executeTool } from '../../app/js/backend/coach/tools.js';
import { buildBoardContext } from '../../app/js/backend/coach/context.js';
import { PLAY_LEVELS } from '../../app/js/backend/engine/pool.js';
import { playLine, keyOf, INITIAL_FEN } from '../../app/js/backend/chess/core.js';
import { toolDef } from '../../shared/tools.js';
import { CLI_TASKS } from '../../shared/prompts.js';

before(openBackend);
after(closeBackend);

const rep = color => handle('GET', `/api/repertoire?color=${color}`);
const add = (color, moves, group) => handle('POST', '/api/repertoire/add', { color, moves: moves.split(' '), group });
const keyAfter = moves => keyOf(playLine(INITIAL_FEN, moves ? moves.split(' ') : []).pos);
/** The moves of a group, or of the lines in no group (id 0), as SAN with their move numbers' sides. */
const sans = (entries, id) =>
  entries
    .filter(e => (id ? e.groups.includes(id) : !e.groups.length))
    .map(e => `${e.fen.split(' ')[1] === 'w' ? '' : '…'}${e.san}`)
    .sort();
const coach = (ui = []) => (name, input) => executeTool(name, input, { emit: e => ui.push(e), screen: null });

let french;

test('groups: made once per name (any case) and colour; a line goes in with what the repertoire has after it', async () => {
  french = await handle('POST', '/api/repertoire/groups', { color: 'black', name: '  French \n' });
  assert.deepEqual([french.name, french.color], ['French', 'black']);
  await assert.rejects(handle('POST', '/api/repertoire/groups', { color: 'black', name: 'FRENCH' }), e => e.status === 400 && /already a group called “FRENCH”/.test(e.message));
  await assert.rejects(handle('POST', '/api/repertoire/groups', { color: 'black', name: '  ' }), e => e.status === 400);
  await assert.rejects(handle('POST', '/api/repertoire/groups', { color: 'black', name: 'x'.repeat(61) }), e => e.status === 400);
  await assert.rejects(handle('POST', '/api/repertoire/groups', { color: 'green', name: 'French' }), e => e.status === 400);
  const white = await handle('POST', '/api/repertoire/groups', { color: 'white', name: 'French' });
  assert.notEqual(white.id, french.id, "White's French is another group");

  await add('black', 'e4 c5 Nf3 d6'); // a Sicilian, in no group
  await add('black', 'e4 e6 d4 d5 Nc3 Bb4');
  await add('black', 'e4 e6 d4 d5 e5 c5');
  let r = await rep('black');
  assert.deepEqual(
    r.groups.map(g => [g.name, g.moves]),
    [['French', 0]],
  );
  // 1. e4 e6 into French: the line, and the two French lines after it
  const put = await add('black', 'e4 e6', french.id);
  assert.deepEqual([put.added, put.group.name], [0, 'French']);
  r = await rep('black');
  assert.deepEqual(sans(r.entries, french.id), ['Nc3', 'd4', 'e4', 'e5', '…Bb4', '…c5', '…d5', '…e6']);
  assert.deepEqual(r.groups.map(g => [g.name, g.moves, g.studentMoves]), [['French', 8, 4]]);
  assert.deepEqual(sans(r.entries, 0), ['Nf3', '…c5', '…d6'], '1. e4 is in French, the Sicilian moves after it in no group');
  // a group of the other colour is no group here
  await assert.rejects(add('black', 'e4 e6', white.id), e => e.status === 400 && /no such group/.test(e.message));
  // renamed (not onto another group's name)
  assert.equal((await handle('POST', `/api/repertoire/groups/${white.id}`, { name: 'Against the French' })).name, 'Against the French');
  await assert.rejects(handle('POST', `/api/repertoire/groups/${white.id}`, { name: '' }), e => e.status === 400);
});

test('a line taken out of a group takes the moves only it led to; they stay in the repertoire', async () => {
  // 3. e5 c5 leave French; 1. e4 e6 2. d4 d5 stay, they lead to 3. Nc3 Bb4
  const out = await handle('POST', `/api/repertoire/groups/${french.id}/remove`, { key: keyAfter('e4 e6 d4 d5'), uci: 'e4e5' });
  assert.equal(out.taken, 2);
  let r = await rep('black');
  assert.deepEqual(sans(r.entries, french.id), ['Nc3', 'd4', 'e4', '…Bb4', '…d5', '…e6']);
  assert.equal(r.entries.length, 11, 'no move left the repertoire');
  // the other French line too: nothing of French is left
  assert.equal((await handle('POST', `/api/repertoire/groups/${french.id}/remove`, { key: keyAfter('e4 e6 d4 d5'), uci: 'b1c3' })).taken, 6);
  r = await rep('black');
  assert.deepEqual(r.groups.map(g => [g.name, g.moves]), [['French', 0]]);
  await assert.rejects(handle('POST', `/api/repertoire/groups/${french.id}/remove`, { key: keyAfter(''), uci: 'e2e4' }), e => e.status === 400 && /not in the group “French”/.test(e.message));
});

test('a group deleted with its lines keeps the moves other lines need; or deleted keeping its lines', async () => {
  await add('black', 'e4 e6', french.id);
  let r = await rep('black');
  assert.equal(r.groups[0].moves, 8);
  // keeping its lines: only the group goes
  assert.deepEqual(await handle('DELETE', `/api/repertoire/groups/${french.id}?keep=1`), { removed: 0 });
  r = await rep('black');
  assert.deepEqual([r.groups.length, r.entries.length, sans(r.entries, 0).length], [0, 11, 11]);
  // with its lines: 1. e4 stays, the Sicilian needs it
  french = await handle('POST', '/api/repertoire/groups', { color: 'black', name: 'French' });
  await add('black', 'e4 e6', french.id);
  assert.deepEqual(await handle('DELETE', `/api/repertoire/groups/${french.id}`), { removed: 7 });
  r = await rep('black');
  assert.deepEqual([r.groups.length, r.entries.map(e => e.san)], [0, ['e4', 'c5', 'Nf3', 'd6']]);
  await assert.rejects(handle('DELETE', `/api/repertoire/groups/${french.id}`), e => e.status === 400);
  // a move in two groups: deleting one leaves it in the other
  const a = await handle('POST', '/api/repertoire/groups', { color: 'black', name: 'Sicilian' });
  const b = await handle('POST', '/api/repertoire/groups', { color: 'black', name: 'Caro-Kann' });
  await add('black', 'e4 c5', a.id);
  await add('black', 'e4 c6 d4 d5', b.id);
  assert.deepEqual(await handle('DELETE', `/api/repertoire/groups/${b.id}`), { removed: 3 });
  r = await rep('black');
  assert.deepEqual(r.entries.map(e => [e.san, e.groups]), [['e4', [a.id]], ['c5', [a.id]], ['Nf3', [a.id]], ['d6', [a.id]]]);
  await handle('DELETE', `/api/repertoire/groups/${a.id}?keep=1`);
});

test('a PGN into a new group: every variation, its comments as notes (also before a variation), its arrows left out', async () => {
  const pgn = `[Event "Caro-Kann: Advance"]

{The Caro-Kann} 1. e4 c6 2. d4 d5 3. e5 {[%cal Ge5e6] The Advance} (3. Nc3 {The main line} dxe4) 3... Bf5 {The bishop comes out first} ( {Also good:} 3... c5 ) *`;
  const r = await handle('POST', '/api/repertoire/import', { color: 'black', pgn, groupName: 'Caro-Kann' });
  assert.deepEqual([r.added, r.moves, r.group.name], [8, 9, 'Caro-Kann'], '1. e4 was there already');
  const after = await rep('black');
  const notes = Object.fromEntries(after.entries.filter(e => e.comment).map(e => [e.san, e.comment]));
  assert.deepEqual(notes, { e5: 'The Advance', Nc3: 'The main line', Bf5: 'The bishop comes out first', c5: 'Also good:' });
  const g = after.groups.find(x => x.name === 'Caro-Kann');
  assert.equal(g.moves, 9);
  assert.deepEqual(sans(after.entries, 0), ['Nf3', '…c5', '…d6'], 'the Sicilian, in no group; its 1. e4 is the Caro-Kann’s too');
  // notes already there stay; a move without one takes the new one
  await handle('POST', '/api/repertoire/import', { color: 'black', pgn: '1. e4 {Mine} c6 {Solid} *' });
  const again = await rep('black');
  assert.deepEqual(
    again.entries.filter(e => ['e4', 'c6'].includes(e.san)).map(e => [e.san, e.comment]),
    [
      ['e4', 'Mine'],
      ['c6', 'Solid'],
    ],
  );
  await handle('POST', '/api/repertoire/import', { color: 'black', pgn: '1. e4 {Other} c6 {Other} 2. d4 *' });
  assert.equal((await rep('black')).entries.find(e => e.san === 'c6').comment, 'Solid');
  // a PGN with no moves leaves no new group behind
  await assert.rejects(handle('POST', '/api/repertoire/import', { color: 'black', pgn: 'hello', groupName: 'Nothing' }), e => e.status === 400 && /No moves/.test(e.message));
  assert.ok(!(await rep('black')).groups.some(x => x.name === 'Nothing'));
  // into a group that exists: by its id, or by its name (any case)
  await handle('POST', '/api/repertoire/import', { color: 'black', pgn: '1. e4 c6 2. Nc3 d5 *', group: g.id });
  assert.equal((await rep('black')).groups.find(x => x.id === g.id).moves, 11);
  const byName = await handle('POST', '/api/repertoire/import', { color: 'black', pgn: '1. e4 c6 2. Nf3 d5 *', groupName: 'caro-kann' });
  assert.deepEqual([byName.group.id, byName.added], [g.id, 2]);
  assert.equal((await rep('black')).groups.length, 1);
});

test('the coach reads the groups, puts lines into them, takes them out, and makes, renames and deletes groups', async () => {
  const ui = [];
  const t = coach(ui);
  const made = await t('add_to_repertoire', { color: 'white', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], group: 'Spanish' });
  assert.equal(made.content, 'Added to the white repertoire, in the group "Spanish" (a new group): 1. e4 e5 2. Nf3 Nc6 3. Bb5 (5 new moves).');
  assert.deepEqual(ui.at(-1), { type: 'ui', action: 'repertoire_updated', color: 'white' });
  assert.match((await t('add_to_repertoire', { color: 'white', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], group: 'spanish' })).content, /, in the group "Spanish": 1\. e4 .* \(1 new moves\)\.$/, 'any case');
  await t('add_to_repertoire', { color: 'white', moves: ['d4', 'd5', 'c4'] });
  const all = (await t('get_repertoire', { color: 'white' })).content;
  assert.equal(
    all,
    [
      "The student's white repertoire: 9 moves, 6 of them white's (6 due for review), in 2 groups — each group's lines from the initial position, then the lines in no group:",
      'Group "Against the French" (0 moves, 0 of them white\'s, 0 due):',
      '(no lines yet)',
      'Group "Spanish" (6 moves, 4 of them white\'s, 4 due):',
      '- 1. e4 e5 2. Nf3 Nc6 3. Bb5',
      '- 1. e4 e5 2. Nf3 Nc6 3. Bc4',
      'In no group:',
      '- 1. d4 d5 2. c4',
    ].join('\n'),
  );
  assert.match((await t('get_repertoire', { color: 'white', group: 'SPANISH' })).content, /^The student's white repertoire, group "Spanish" \(6 moves, .*\n- 1\. e4 e5 2\. Nf3 Nc6 3\. Bb5\n- 1\. e4 e5 2\. Nf3 Nc6 3\. Bc4$/);
  const none = await t('get_repertoire', { color: 'white', group: 'Dutch' });
  assert.deepEqual([none.isError, none.content], [true, `The student's white repertoire has no group called "Dutch"; its groups: "Against the French", "Spanish".`]);
  // a line out of a group (its moves stay), not a line the group does not have
  const out = await t('remove_from_repertoire', { color: 'white', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], group: 'Spanish' });
  assert.equal(out.content, `Took 3. Bc4 out of the group "Spanish" of the student's white repertoire, with the line it is on: 1 move left the group and stays in the repertoire.`);
  const notThere = await t('remove_from_repertoire', { color: 'white', moves: ['d4'], group: 'Spanish' });
  assert.match(notThere.content, /^1\. d4 is not in the group "Spanish" of the student's white repertoire after the initial position; there it has e4\./);
  // the groups themselves
  assert.match((await t('edit_repertoire_group', { color: 'white', action: 'rename', group: 'spanish', new_name: 'Ruy Lopez' })).content, /^Renamed the group "Spanish" .* to "Ruy Lopez"\.$/);
  assert.match((await t('edit_repertoire_group', { color: 'white', action: 'rename', group: 'Ruy Lopez' })).content, /Give new_name/);
  assert.match((await t('edit_repertoire_group', { color: 'white', action: 'create', group: "Queen's Gambit" })).content, /^Made the group "Queen's Gambit"/);
  assert.match((await t('edit_repertoire_group', { color: 'white', action: 'create', group: "queen's gambit" })).content, /already a group/);
  await t('add_to_repertoire', { color: 'white', moves: ['d4', 'd5', 'c4'], group: "Queen's Gambit" });
  const kept = await t('edit_repertoire_group', { color: 'white', action: 'delete', group: 'ruy lopez', keep_lines: true });
  assert.match(kept.content, /^Deleted the group "Ruy Lopez" .*; its lines stay in the repertoire/);
  const gone = await t('edit_repertoire_group', { color: 'white', action: 'delete', group: "Queen's Gambit" });
  assert.equal(gone.content, `Deleted the group "Queen's Gambit" of the student's white repertoire, with its lines: 3 moves left the repertoire (the moves other lines need stay).`);
  assert.match((await t('get_repertoire', { color: 'white' })).content, /in 1 group .*\n.*\n\(no lines yet\)\nIn no group:\n- 1\. e4 e5 2\. Nf3 Nc6 3\. Bb5\n- 1\. e4 e5 2\. Nf3 Nc6 3\. Bc4$/);
  const n = ui.length;
  assert.equal((await t('edit_repertoire_group', { color: 'white', action: 'delete', group: 'Nope' })).isError, true);
  assert.equal((await t('edit_repertoire_group', { color: 'white', action: 'merge', group: 'x' })).isError, true, 'the input is checked');
  assert.equal(ui.length, n, 'nothing changes on the screen after an error');
});

test('the coach makes the student play: a position, an opening line or a whole game, against the strength it chooses', async () => {
  const ui = [];
  const t = input => executeTool('start_training_game', input, { emit: e => ui.push(e), screen: null });
  // an endgame: the student plays the side to move
  const rook = '8/8/8/4k3/8/8/8/R3K3 w - - 0 1';
  const end = await t({ fen: rook, level: 4, goal: '  Mate with the\nrook ', comments: 'off' });
  assert.equal(end.isError, false, end.content);
  assert.deepEqual(ui.at(-1), { type: 'ui', action: 'start_game', fen: rook, path: null, color: 'white', level: 4, comments: 'off', goal: 'Mate with the rook' });
  assert.equal(
    end.content,
    "Started a training game on the student's Board screen: they play white against Stockfish (Club 1500) from the position 8/8/8/4k3/8/8/8/R3K3 w - - 0 1; the goal shown to them: Mate with the rook. It is their move. You are not asked about their moves during the game. When the game ends you get a message with the result: review it with them then (get_board_state shows the game). A training game they were in the middle of is paused: they can go back to it.",
  );
  // an opening played on from its moves: Stockfish moves first
  const opening = await t({ moves_from_start: ['e4', 'e5', 'Nf3'], color: 'white' });
  assert.deepEqual([ui.at(-1).path.map(m => m.san), ui.at(-1).color, ui.at(-1).level, ui.at(-1).comments, ui.at(-1).goal], [['e4', 'e5', 'Nf3'], 'white', null, 'mistakes', null]);
  assert.match(opening.content, /\(the strength they last chose for a game\) from the position after 1\. e4 e5 2\. Nf3\. Stockfish moves first\. You are asked to comment on their mistakes/);
  // a whole game
  assert.match((await t({ color: 'black', comments: 'all' })).content, /they play black .* from the initial position\. Stockfish moves first\. You are asked to comment on each of their moves/);
  assert.equal(ui.at(-1).fen, INITIAL_FEN);
  // refused: a finished position, illegal moves, moves that lead elsewhere, a strength there is not
  const n = ui.length;
  assert.match((await t({ fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3' })).content, /already over in that position \(checkmate/);
  assert.equal((await t({ moves_from_start: ['e4', 'e4'] })).isError, true);
  assert.match((await t({ fen: INITIAL_FEN, moves_from_start: ['e4'] })).content, /not to the fen you gave/);
  assert.equal((await t({ level: 12 })).isError, true);
  assert.equal((await t({ fen: '8/8/8/8/8/8/8/8 w - - 0 1' })).isError, true, 'no kings');
  assert.equal(ui.length, n, 'nothing happens on the screen after an error');
  // the strengths it names are the app's
  const levels = toolDef('start_training_game').input_schema.properties.level.description;
  for (const l of PLAY_LEVELS) assert.ok(levels.includes(`${l.id} ${l.label}`), l.label);
});

test('the coach sees the group being drilled, the game it started with its goal, and the note on a move', () => {
  assert.match(buildBoardContext({ mode: 'drill', ucis: ['e2e4'], drill: { color: 'black', group: 'French' } }), /\nRepertoire drill \(black, the group "French"\)\.\n/);
  assert.match(buildBoardContext({ mode: 'drill', ucis: [], drill: { color: 'white' } }), /\nRepertoire drill \(white, all its lines\)\.\n/);
  assert.match(
    buildBoardContext({ mode: 'play', ucis: [], play: { level: 'Club 1500', color: 'white', byCoach: true, goal: 'Win' } }),
    /\nTraining game vs Stockfish \(Club 1500\); the student plays white\. You started it \(start_training_game\) with the goal: Win\.\n/,
  );
  assert.match(buildBoardContext({ mode: 'play', ucis: [], play: { level: 'Club 1500', color: 'black' } }), /\nTraining game vs Stockfish \(Club 1500\); the student plays black\.\n/);
  assert.match(buildBoardContext({ mode: 'analysis', ucis: ['e2e4'], comment: 'Best by test' }), /\nThe note on this move that the student sees \(from the game's PGN, not written by you\): "Best by test"\n/);
  assert.match(buildBoardContext({ mode: 'openings', ucis: ['e2e4'], comment: 'Mine', commentFrom: 'repertoire' }), /\(in their repertoire, not written by you\): "Mine"/);
  // the end of a game it started: the result and the goal
  assert.match(CLI_TASKS.gameEnd({ result: '1-0, checkmate', goal: 'Mate with the rook' }), /^\[App\] My training game just ended \(1-0, checkmate\)\. The goal you gave me: Mate with the rook\. .*: whether I reached the goal, the turning points/);
  assert.doesNotMatch(CLI_TASKS.gameEnd({ result: '1-0, checkmate' }), /goal/);
});
