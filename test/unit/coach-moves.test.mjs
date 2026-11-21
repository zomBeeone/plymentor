// The moves the coach says, played on the student's board as its voice says them (coachMoves.js): followed as the Book
// reader follows a book's, from the board the student had — its game the line read —, with what a coach writes
// otherwise than a book: a move named on its own only from where the line is (and not with the other side named),
// moves without numbers one after the other a line, a numbered move back in the game where the game made it, a
// position the coach set up numbered by its first move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMoves, findSentences } from '../../app/js/books/text.js';
import { followMoves, nodeOn } from '../../app/js/coachMoves.js';
import { Tree } from '../../app/js/tree.js';
import { sanToUci, sanOf, playUci, INITIAL_FEN } from '../../app/js/chess.js';

/** A board with the moves `sans` played (from `fen`), at its last one — or at its `at`-th. */
function board(sans, { fen = INITIAL_FEN, at = sans.length } = {}) {
  const tree = new Tree(fen);
  let n = tree.root;
  for (const san of sans) n = tree.addMove(n, sanToUci(n.fen, san)).node;
  return { tree, node: tree.mainline()[at] };
}

/** Where the board plays each move of `text` (blocks: its paragraphs): "Nf3 → <its line's last 4 moves>", "Nf3 —" when not. */
function follow(b, text) {
  const blocks = text.split('\n\n').map(t => {
    const moves = findMoves(t);
    return { text: t, moves, sentences: findSentences(t, moves) };
  });
  followMoves(blocks, b);
  return blocks.flatMap(bl =>
    bl.moves.map(t => {
      const written = bl.text.slice(t.start, t.end);
      if (!t.line) return `${written} —`;
      let fen = t.line.start;
      const sans = t.line.ucis.map(u => [sanOf(fen, u), (fen = playUci(fen, u).fen)][0]);
      return `${written} → ${sans.slice(-4).join(' ')}${sans.length > 4 ? ` (${sans.length})` : ''}`;
    }),
  );
}

const BREYER = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7'.split(' ');

test('the coach’s lines from the position on the board; the other move of one there; back in the game', () => {
  // (the board at 10...Nbd7: White's 11th move)
  assert.deepEqual(follow(board(BREYER), "White's plan is 11. Nbd2 followed by Nf1. After 11. Nbd2 Bb7 12. Bc2 Re8, Black's idea is ...c5. Instead 11. c4 c6 12. c5 is sharper."), [
    '11. Nbd2 → Nb8 d4 Nbd7 Nbd2 (21)',
    'Nf1 —', // (a plan: no move of the position there)
    '11. Nbd2 → Nb8 d4 Nbd7 Nbd2 (21)',
    'Bb7 → d4 Nbd7 Nbd2 Bb7 (22)',
    '12. Bc2 → Nbd7 Nbd2 Bb7 Bc2 (23)',
    'Re8 → Nbd2 Bb7 Bc2 Re8 (24)',
    '...c5 —', // (Black's idea, White to move there: not the other move of 12...Re8)
    '11. c4 → Nb8 d4 Nbd7 c4 (21)',
    'c6 → d4 Nbd7 c4 c6 (22)',
    '12. c5 → Nbd7 c4 c6 c5 (23)',
  ]);
  // the last move judged: the move on the board, the better one there, and the line after the move played
  assert.deepEqual(follow(board(BREYER), '10...Nbd7 is the main line. 10...Bb7 was possible too. After 10...Nbd7 White plays 11. Nbd2.'), [
    '10...Nbd7 → h3 Nb8 d4 Nbd7 (20)',
    '10...Bb7 → h3 Nb8 d4 Bb7 (20)',
    '10...Nbd7 → h3 Nb8 d4 Nbd7 (20)',
    '11. Nbd2 → Nb8 d4 Nbd7 Nbd2 (21)',
  ]);
  // a review: moves back in the game, a line that leaves it, and the game's own move after it (not the line's)
  assert.deepEqual(follow(board(BREYER), 'Your 9. h3 was important: without it, 9. d4 Bg4 is annoying. Then 9...Nb8 is the Breyer.\n\nLater 10. d4 Nbd7 reached the main line.'), [
    '9. h3 → d6 c3 O-O h3 (17)',
    '9. d4 → d6 c3 O-O d4 (17)',
    'Bg4 → c3 O-O d4 Bg4 (18)',
    '9...Nb8 → c3 O-O h3 Nb8 (18)',
    '10. d4 → O-O h3 Nb8 d4 (19)',
    'Nbd7 → h3 Nb8 d4 Nbd7 (20)',
  ]);
  // the board at an earlier move of the game (a review): the game's later moves are found too
  assert.deepEqual(follow(board(BREYER, { at: 12 }), 'Here 7. Bb3 is forced. Later 10. d4 Nbd7 came. 12. Nbd2 would be fine.'), [
    '7. Bb3 → Be7 Re1 b5 Bb3 (13)',
    '10. d4 → O-O h3 Nb8 d4 (19)',
    'Nbd7 → h3 Nb8 d4 Nbd7 (20)',
    '12. Nbd2 —', // (the game has no 12th move: no position for it)
  ]);
});

test('an opening from its first move, its other lines; moves named on their own, lines without numbers', () => {
  assert.deepEqual(follow(board(BREYER), 'The Ruy Lopez begins 1. e4 e5 2. Nf3 Nc6 3. Bb5.\n\nThe Berlin goes 3...Nf6 4. O-O Nxe4 instead.'), [
    '1. e4 → e4',
    'e5 → e4 e5',
    '2. Nf3 → e4 e5 Nf3',
    'Nc6 → e4 e5 Nf3 Nc6',
    '3. Bb5 → e5 Nf3 Nc6 Bb5 (5)',
    '3...Nf6 → Nf3 Nc6 Bb5 Nf6 (6)',
    '4. O-O → Nc6 Bb5 Nf6 O-O (7)',
    'Nxe4 → Bb5 Nf6 O-O Nxe4 (8)',
  ]);
  // named on their own: shown from the position the line is at, when the side to move can play them
  assert.deepEqual(follow(board(BREYER), 'White wants Nbd2. Bc2 is useful too. Black should answer with Bb7.'), [
    'Nbd2 → Nb8 d4 Nbd7 Nbd2 (21)',
    'Bc2 → Nb8 d4 Nbd7 Bc2 (21)',
    'Bb7 —',
  ]);
  // one after the other without numbers: a line
  assert.deepEqual(follow(board(BREYER), 'The main line goes Nbd2 Bb7 Bc2 Re8.'), [
    'Nbd2 → Nb8 d4 Nbd7 Nbd2 (21)',
    'Bb7 → d4 Nbd7 Nbd2 Bb7 (22)',
    'Bc2 → Nbd7 Nbd2 Bb7 Bc2 (23)',
    'Re8 → Nbd2 Bb7 Bc2 Re8 (24)',
  ]);
  // a move the side to move can play, its sentence naming the other side last: not played (Black to move; both sides'
  // knights can go to d5)
  const fourKnights = board('e4 e5 Nf3 Nc6 Nc3 Nf6 d3'.split(' '));
  assert.deepEqual(follow(fourKnights, 'White wants Nd5 here. Black can play Nd5 at once.'), ['Nd5 —', 'Nd5 → Nc3 Nf6 d3 Nd5 (8)']);
});

test('a position the coach set up: its move number from the first numbered move; no board, nothing played', () => {
  const fen = 'r1b2rk1/pp1nqppp/2p1p3/3p4/2PPn3/2NBPN2/PPQ2PPP/R4RK1 w - - 0 1';
  const want = ['cxd5', 'cxd5 exd5', 'cxd5 exd5 Nxe4', 'cxd5 exd5 Nxe4 dxe4'];
  const lines = text => follow(board([], { fen }), text).map(s => s.split(' → ')[1]);
  assert.deepEqual(lines('12. cxd5 exd5 13. Nxe4 dxe4 wins a pawn.'), want, 'the game’s numbers');
  assert.deepEqual(lines('1. cxd5 exd5 2. Nxe4 dxe4 wins a pawn.'), want, 'numbered from 1');
  const moves = findMoves('1. e4 e5');
  followMoves([{ text: '1. e4 e5', moves, sentences: findSentences('1. e4 e5', moves) }], null);
  assert.deepEqual(moves.map(t => t.line), [null, null]);
});

test('a line on the board’s tree: its moves added as a variation, the game left as it was; another game’s, none', () => {
  const b = board(BREYER);
  const text = '10...Bb7 11. Nbd2 is another way.';
  const blocks = [{ text, moves: findMoves(text) }];
  blocks[0].sentences = findSentences(text, blocks[0].moves);
  followMoves(blocks, b);
  const end = nodeOn(b.tree, blocks[0].moves[1].line);
  assert.equal(end.san, 'Nbd2');
  assert.deepEqual(b.tree.path(end).slice(-3).map(n => n.san), ['d4', 'Bb7', 'Nbd2']);
  assert.deepEqual(b.tree.mainline().slice(1).map(n => n.san), BREYER, 'the game’s moves are still its main line');
  assert.equal(nodeOn(b.tree, blocks[0].moves[1].line), end, 'played again: the same position');
  assert.equal(nodeOn(new Tree('8/8/4k3/8/8/4K3/4P3/8 w - - 0 1'), blocks[0].moves[1].line), null, 'another game');
  assert.equal(nodeOn(b.tree, { start: INITIAL_FEN, ucis: ['e2e4', 'e2e4'] }), null, 'a move that cannot be played');
  assert.deepEqual(b.tree.root.children.map(n => n.san), ['e4'], 'nothing added for it');
});
