// The Book reader's reading of chess text: the moves written in it, its sentences, what the voice says, and the
// position each move belongs to (the board follows the book).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMoves, findSentences, spokenParts, speakable } from '../../app/js/books/text.js';
import { trackMoves } from '../../app/js/books/moves.js';
import { pieces } from '../../app/js/voice.js';

const label = t => `${t.num ?? ''}${t.side === 'black' ? '...' : t.side === 'white' && t.num ? '.' : ''}${t.san}`;
const moves = text => findMoves(text).map(label);

test('moves as books write them', () => {
  assert.deepEqual(moves('1.e4 e5 2.Nf3 Nc6 3.Bb5 a6'), ['1.e4', 'e5', '2.Nf3', 'Nc6', '3.Bb5', 'a6']);
  assert.deepEqual(moves('12...Nf6 13. Bg5 h6 14 Bh4 14…g5'), ['12...Nf6', '13.Bg5', 'h6', '14.Bh4', '14...g5']);
  assert.deepEqual(moves('12. ... Nf6! 13.♘xe5+ ♞:e5 14.0-0-0 O-O'), ['12...Nf6', '13.Nxe5', 'Nxe5', '14.O-O-O', 'O-O']);
  assert.deepEqual(moves('After …Nd7 the idea Ng1-f3, then e8=Q+ or exd8Q#!'), ['...Nd7', 'Ng1-f3', 'e8=Q', 'exd8Q']);
  // not moves: results, scores, dates, names, words
  assert.deepEqual(moves('1-0 in 1996, 3.5 points (Game 12), the B2 bomber, Kasparov, ½-½'), []);
  const [t] = findMoves('the d5-square');
  assert.deepEqual([t.san, t.pawn, t.square], ['d5', true, true]);
  // what the voice says
  assert.deepEqual(
    findMoves('12.Nxe5+ 12...Bxf7# O-O-O exd5 Nbd7 e8=Q').map(m => m.words),
    ['12. knight takes e5, check', '12... bishop takes f7, checkmate', 'castles queenside', 'e takes d5', 'knight from b to d7', 'e8, promoting to a queen'],
  );
});

test('sentences: moves keep their dots, headings stand alone, long move lists are cut', () => {
  const text = 'Chapter 3\nThe Najdorf. After 1.e4 c5 2.Nf3 d6 3.d4 cxd4 Black plays 4...Nf6! Dr. Nunn wrote e.g. this. Is it good? Yes.';
  const ss = findSentences(text, findMoves(text)).map(s => text.slice(s.start, s.end).trim());
  assert.deepEqual(ss, ['Chapter 3', 'The Najdorf.', 'After 1.e4 c5 2.Nf3 d6 3.d4 cxd4 Black plays 4...Nf6! Dr. Nunn wrote e.g. this.', 'Is it good?', 'Yes.']);
  const list = Array.from({ length: 30 }, (_, i) => `${i + 1}.Nf3 Nf6 ${i + 1}...Ng8 Ng1`).join(' ');
  assert.ok(findSentences(list, findMoves(list)).length > 1, 'a long list of moves is cut');
});

test('what the voice says: parts that end with a move, lines joined, signs in words', () => {
  const text = 'After 12.Nf3 (12.e5? dxe5) Black is in trouble ±.';
  const all = findMoves(text);
  const [s] = findSentences(text, all);
  assert.deepEqual(spokenParts(text, s, all), [
    { text: 'After 12. knight to f3', move: 0 },
    { text: '12. e5', move: 1 },
    { text: 'd takes e5', move: 2 },
    { text: 'Black is in trouble White is better.', move: null },
  ]);
  assert.equal(speakable('a sacri-\nfice, and\nthen +- (or =)'), 'a sacrifice, and then White is winning, or equal');
  // a move the board does not play (here: a square) is said within its part
  const note = 'White wants the d5 square. Then 14.Nd5 wins.';
  const ms = findMoves(note);
  const plays = m => !m.pawn || !!m.num;
  assert.deepEqual(
    findSentences(note, ms).flatMap(s => spokenParts(note, s, ms, plays)),
    [{ text: 'White wants the d5 square.', move: null }, { text: 'Then 14. knight to d5', move: 1 }, { text: 'wins.', move: null }],
  );
});

test('what the natural voice makes of a long part: pieces cut after a sentence or a clause, not after a move number', () => {
  const part =
    'White now has a choice between several plans, and the most solid of them is to bring the king to safety and complete the development of the queenside pieces before starting any action in the centre. After 12. knight to f3 the position is quiet; Black can choose between 12... bishop to e7 and the sharper 12... h6, which prepares g5 and an attack on the kingside.';
  const p = pieces(part);
  assert.equal(p.join(' '), part, 'nothing left out');
  assert.equal(p[0], 'White now has a choice between several plans,', 'the first piece short: it comes soon');
  assert.ok(p.every(x => x.length <= 220 && !/\d\.+$/.test(x)), p.join(' | '));
  assert.deepEqual(pieces('After 1. e4'), ['After 1. e4']);
});

/** Tracks `pages` (texts) and lists every move as "san@position before it" ("-" when it has none). */
function track(...pages) {
  const units = pages.map(text => ({ text, moves: findMoves(text) }));
  const trees = trackMoves(units);
  return { trees, moves: units.flatMap(u => u.moves), list: units.flatMap(u => u.moves.map(m => (m.node ? `${m.node.san}${m.shown ? '?' : ''}@${m.node.parent.ply}` : '-'))) };
}

test('the board follows the book: a game, its variations in brackets, and back to the main line', () => {
  const r = track('1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6 6.Bg5 (6.Be3 e5 7.Nb3) 6...e6 (6...Nbd7 7.f4) 7.f4');
  assert.deepEqual(r.list, ['e4@0', 'c5@1', 'Nf3@2', 'd6@3', 'd4@4', 'cxd4@5', 'Nxd4@6', 'Nf6@7', 'Nc3@8', 'a6@9', 'Bg5@10', 'Be3@10', 'e5@11', 'Nb3@12', 'e6@11', 'Nbd7@11', 'f4@12', 'f4@12']);
  assert.equal(r.trees.length, 1);
  const main = r.trees[0].mainline().map(n => n.san).slice(1);
  assert.deepEqual(main, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Bg5', 'e6', 'f4']);
  // the last 7.f4 is the main line's (after 6...e6), the one before it in the variation (after 6...Nbd7)
  assert.equal(r.moves.at(-1).node.parent.san, 'e6');
  assert.equal(r.moves.at(-2).node.parent.san, 'Nbd7');
});

test('the board follows the book: notes in their own paragraphs, a move restated, across pages, a new game', () => {
  const r = track(
    '1.d4 Nf6 2.c4 e6 3.Nc3 Bb4 4.e3 O-O\n\n4...O-O is the main move. Instead 4...c5 5.Bd3 is a different story.',
    '5.Bd3 d5 6.Nf3 c5\n\nGame 2\n1.e4 e5 2.Nf3',
  );
  assert.deepEqual(r.list, ['d4@0', 'Nf6@1', 'c4@2', 'e6@3', 'Nc3@4', 'Bb4@5', 'e3@6', 'O-O@7', 'O-O@7', 'c5@7', 'Bd3@8', 'Bd3@8', 'd5@9', 'Nf3@10', 'c5@11', 'e4@0', 'e5@1', 'Nf3@2']);
  // 5.Bd3 on the second page continues the main line (after 4...O-O), not the note's 4...c5
  assert.equal(r.moves[11].node.parent.san, 'O-O');
  assert.equal(r.trees.length, 2, 'Game 2 is a game of its own');
});

test('the board follows the book: moves named in a sentence are only shown; squares are not moves', () => {
  const r = track('1.e4 e5 2.Nf3 Nc6. Here Bc4 is also possible, and ...Nf6 is an idea. White wants the d5 square for a knight on d5. 3.Bb5 a6');
  assert.deepEqual(r.list, ['e4@0', 'e5@1', 'Nf3@2', 'Nc6@3', 'Bc4?@4', 'Nf6?@3', '-', '-', 'Bb5@4', 'a6@5']);
  assert.deepEqual(r.trees[0].mainline().map(n => n.san).slice(1), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
});

test('the board follows the book: a move number going back — to the game after a note, to an alternative in brackets', () => {
  const ruy = '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6 8.c3 O-O';
  // "9.d4?! The usual move is 9.h3. 9...Bg4": the game goes on after 9.d4, where the moves after 9...Bg4 can be played
  let r = track(`${ruy} 9.d4?! The usual move is 9.h3. 9...Bg4 10.d5 Na5 11.Bc2 c6`);
  assert.ok(r.moves.every(m => m.node));
  assert.equal(r.moves.find(m => m.san === 'Bg4').node.parent.san, 'd4');
  assert.equal(r.moves.find(m => m.san === 'h3').node.parent.san, 'O-O');
  // a numbered move in brackets is the alternative to the move before it ("6.d4 (6.Re1 Nc5)": after the note's
  // 5...Nxe4), not a move after the game's 5...Be7
  r = track('1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 5...Nxe4 6.d4 (6.Re1 Nc5) 6...b5 7.Bb3 d5');
  assert.ok(r.moves.every(m => m.node));
  assert.equal(r.moves.find(m => m.san === 'Re1').node.parent.san, 'Nxe4');
  assert.equal(r.moves.find(m => m.san === 'b5').node.parent.san, 'd4');
  // a move that says it takes must take: "2.Bxb5+" with nothing on b5 is not played
  assert.deepEqual(track('1.e4 d5 2.Bxb5+').list, ['e4@0', 'd5@1', '-']);
});

test('the board follows the book: a position it cannot know, and a game from a diagram', () => {
  // a game in the middle (from a diagram the book shows): no position for its moves
  assert.deepEqual(track('21.Nf5 gxf5 22.Qg3+').list, ['-', '-', '-']);
});

test('descriptive notation: compact, spaced and old-style moves, castling, checks, captures named by what they take', () => {
  const said = text => findMoves(text).map(m => m.words);
  assert.deepEqual(said('1. P-K4 P-K4 2. Kt-KB3 Kt-QB3 3. B-N5 PxP e.p. 4. QxQ ch K-B1 5. Castles (Q R)'), [
    '1. pawn to king 4', 'pawn to king 4', "2. knight to king's bishop 3", "knight to queen's bishop 3", '3. bishop to knight 5', 'pawn takes pawn', '4. queen takes queen, check', 'king to bishop 1', '5. castles queenside',
  ]);
  // spaced, as Capablanca's books write them; Black's move after "...", or after a comma
  assert.deepEqual(findMoves('14 B - K 5, K - Kt 6; 15 Kt - K 3 ! 4...K - B 7; 10 R - R 8 mate.').map(m => [m.num, m.side, m.san, m.check]), [
    [14, 'white', 'B - K 5', ''], [null, null, 'K - Kt 6', ''], [15, 'white', 'Kt - K 3', ''], [4, 'black', 'K - B 7', ''], [10, 'white', 'R - R 8', '#'],
  ]);
  // old style, with full stops; "sq" (and a scan's "eq") for the first rank
  assert.deepEqual(findMoves('1. P. to K. 4th. P. to K. 4th. 2. K. Kt. to B. 3rd. 9 K to R sq 10 Rto KBeq 11 Q. takes K. B. P. (ch.)').map(m => m.san), [
    'P. to K. 4th', 'P. to K. 4th', 'K. Kt. to B. 3rd', 'K to R sq', 'Rto KBeq', 'Q. takes K. B. P',
  ]);
  // what a capture takes ends where the next move begins: "KxQ B-K3", "PxP 3. Kt-KB3"
  assert.deepEqual(findMoves('4. PxP QxQ ch 5. KxQ B-K3 6. PxP 7. Kt-KB3').map(m => m.san), ['PxP', 'QxQ', 'KxQ', 'B-K3', 'PxP', 'Kt-KB3']);
  // not moves: words, squares named alone, "castles" in a sentence, a Q-side
  assert.deepEqual(findMoves('White castles on the Q-side; the K R P and the square Q B 4 are weak. P. Morphy won.'), []);
});

test('descriptive notation followed on the board: a game, a game in two columns read by OCR, a capture told by the position', () => {
  const r = track('1 P-K4 P-K4 2 P-KB4 PxP 3 B-B4 Q-R5 ch 4 K-B1 P-QKt4 5 BxKtP Kt-KB3 6 Kt-KB3 Q-R3 7 P-Q3 Kt-R4 8 Kt-R4 Q-Kt4 9 Kt-B5 P-QB3 10 P-KKt4 Kt-B3 11 R-Kt1 PxB 12 P-KR4 Q-Kt3 13 P-R5 Q-Kt4 14 Q-B3 Kt-Kt1 15 BxP Q-B3 16 Kt-B3 B-B4 17 Kt-Q5 QxP 18 B-Q6 BxR 19 P-K5 QxR ch 20 K-K2 Kt-QR3 21 KtxP ch K-Q1 22 Q-B6 ch KtxQ 23 B-K7 mate');
  const main = r.trees[0].mainline().map(n => n.san).slice(1);
  assert.equal(main.join(' '), 'e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ Ke2 Na6 Nxg7+ Kd8 Qf6+ Nxf6 Be7#');
  // said as the moves the board played
  assert.deepEqual(r.moves.slice(0, 4).map(m => m.words), ['1. e4', 'e5', '2. f4', 'e takes f4']);
  assert.equal(r.moves.at(-1).words, '23. bishop to e7, checkmate');
  // two columns on a line, words glued by the OCR ("KttoKB3"), a 7 read as T
  const old = track('1 P to K 4 1 P to K 4\n2 Kt to K B 3 2 Kt to Q B 3\n3PtoQ4 3 P takes P\n(Pawn to Queen\'s fourth.) (Pawn takes Pawn.)\n4 Kt takes P 4BtoQB4\n5 Kt takes Kt 5 Kt P takes Kt\n6 BtoQB4 6 KttoKB3\nTPtoK5 TKttoK 5\n8 Castles 8 Kt takes KB P');
  assert.equal(old.trees[0].mainline().map(n => n.san).slice(1).join(' '), 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Nxc6 bxc6 Bc4 Nf6 e5 Ne4 O-O Nxf2');
  // alternatives on lines of their own are White's moves, not a second column
  const alt = track('1. P-K4 P-K4\n2. Kt-KB3\n2. B-B4\n2. P-Q4');
  assert.deepEqual(alt.list, ['e4@0', 'e5@1', 'Nf3@2', 'Bc4@2', 'd4@2']);
});

test('moves spelled out — in words, or with a square named — are moves, said as written; a move said again under a game is not played again', () => {
  const said = text => findMoves(text).map(m => m.words);
  assert.deepEqual(said("If Black play Pawn to King's fourth, White answers King's Knight to Bishop's third; then Queen takes Pawn, check. The Castle to King's square, and Bishop takes Knight at Queen's Bishop's sixth."), [
    "Pawn to King's fourth",
    "King's Knight to Bishop's third",
    'Queen takes Pawn, check',
    "The Castle to King's square",
    "Bishop takes Knight at Queen's Bishop's sixth",
  ]);
  assert.deepEqual(said('Here the knight to f3 is natural, and the bishop takes on e5 wins. The rook to the seventh rank, the king to the queenside.'), ['the knight to f3', 'the bishop takes on e5']);
  // Cook's primer says each move of a game again under it, in words: the same moves, nothing played twice, and the
  // board plays a move once (the parts of what the voice says end with the moves, not with what says them again)
  const text = "1 P to K 4 1 P to K 4\n(Pawn to King's fourth.) (Pawn to King's fourth.)\n2 Kt to K B 3 2 Kt to Q B 3\n(King's Knight to Bishop's third.) (Queen's Knight to Bishop's third.)\n3 P to Q 4 3 P takes P\n(Pawn to Queen's fourth.) (Pawn takes Pawn.)";
  const cook = track(text);
  assert.equal(cook.trees[0].mainline().map(n => n.san).slice(1).join(' '), 'e4 e5 Nf3 Nc6 d4 exd4');
  assert.deepEqual(cook.moves.filter(m => m.restated).map(m => m.node.san), ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4']);
  const parts = findSentences(text, cook.moves).flatMap(s => spokenParts(text, s, cook.moves, m => !!m.node && !m.restated));
  assert.equal(parts.filter(p => p.move !== null).length, 6);
  assert.ok(parts.some(p => /Pawn to Queen's fourth/.test(p.text)), 'the words said again are read');
  // in a note, its side as the words say: Black's alternative to 2...Nc6, shown from the game
  const note = track("1 P to K 4 1 P to K 4\n2 Kt to K B 3 2 Kt to Q B 3\nIf instead Black play Pawn to Queen's third, the game is quieter.");
  assert.deepEqual([note.moves.at(-1).node.san, note.moves.at(-1).shown, note.moves.at(-1).node.parent.san], ['d6', true, 'Nf3']);
});
