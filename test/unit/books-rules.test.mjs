// The Book reader's rules for what a book's pages hold — moves as scans and fonts write them, diagrams named in the
// text, boards in the page's layout and in pictures, a cache kept from before — and for the board following the book:
// one test per rule, on made-up text, positions and drawn pictures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMoves, findSentences, diagramNumber, namedAt, namedDiagram, wordDistance } from '../../app/js/books/text.js';
import { BookMoves, trackMoves, sideMarked } from '../../app/js/books/moves.js';
import { findPictureBoard, packBoard, unpackBoard, readBoards, placement, pieceExample, cellShape } from '../../app/js/books/diagrams.js';
import { ocrText } from '../../app/js/books/ocr.js';
import { boardAt } from '../../app/js/books/pdf.js';
import { scanAgain, SCANNED } from '../../app/js/books/reader.js';
import { drawPlainBoard, blankPage, pieceSquares } from './diagram-picture.mjs';

const PDF = { ocr: true }; // (a PDF's text: it may be a scanner's OCR)
const SCAN = { ocr: true, scan: true }; // (a scanned page the app read by OCR)
const label = t => `${t.num ?? ''}${t.side === 'black' ? '...' : t.side === 'white' && t.num ? '.' : ''}${t.san}`;
const moves = (text, opts = PDF) => findMoves(text, opts).map(label);
/** Each move's number and the square it goes to, as first read. */
const squares = (text, opts = PDF) => findMoves(text, opts).map(t => [t.num, (t.sans || [t.san])[0].slice(-2)]);
const [QUEEN, KNIGHT] = ['\uE025', '\uE028']; // (a chess font's own figurines, in the private-use area)

/**
 * Made-up pages followed by the board as the reader follows a book: each [text, diagrams], a diagram { at: the text it
 * stands before, placement, … }; `scan`: pages the app read by OCR; `pdf`: a PDF's text, else an EPUB's; `font`: the
 * diagrams set in a chess font, else pictures.
 */
function follow(pages, { scan = false, pdf = true, font = true, book = new BookMoves() } = {}) {
  return pages.map(([text, diagrams = []], index) => {
    const unit = { index, text, ocr: scan, moves: findMoves(text, { ocr: pdf, scan }), diagrams: diagrams.map(d => ({ side: null, font, label: null, number: null, alts: [], ...d, at: text.indexOf(d.at) })) };
    book.follow(unit);
    return unit;
  });
}
const at = (units, p, written, k = 0) => units[p].moves.filter(t => label(t) === written)[k];
const placed = t => !!t?.node && !t.shown;
/** Whether the move is on its game's main line (not a variation, not only shown). */
const main = t => {
  if (!placed(t)) return false;
  for (let n = t.node; n.parent; n = n.parent) if (n.parent.children.find(c => !c.bookShown) !== n) return false;
  return true;
};
/** The moves from the game's start to the move. */
const line = t => t.tree.path(t.node).slice(1).map(n => n.san).join(' ');
const RUY = '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6 8.c3 O-O';

// Moves as a scan's OCR writes them

test("a scan's moves glued together are each a move — not a long move, squares named with a slash, nor a number and a square", () => {
  const glued = findMoves('5. *d6Hf3+', PDF);
  assert.deepEqual(glued.map(t => [t.num, t.glyph, t.sans[0].slice(-2), t.check]), [[5, '*', 'd6', ''], [null, 'H', 'f3', '+']]);
  assert.deepEqual(moves('7.b6f4'), ['7.b6', 'f4']);
  assert.equal(findMoves('1.e2e4', PDF).length, 1);
  assert.deepEqual(moves('the squares a3/b4 and e2-e4, Ra8:e8'), ['a3', 'b4', 'e2-e4', 'Ra8xe8']);
  assert.deepEqual(moves('12e4'), []);
});

test("a move spelled with spaces: its first rank read as l, but not a word spelled so", () => {
  assert.deepEqual(squares('36. * f l'), [[36, 'f1']]);
  assert.deepEqual(moves('the H a l l was'), []);
});

test("a figurine read as a digit, or as a digit and a sign: a piece's move to the square after it", () => {
  const digit = findMoves('3.*d7 2d3+ 4.*e6', PDF);
  assert.equal(digit[1].glyph, '2');
  assert.deepEqual(digit[1].sans, ['Nd3', 'Bd3', 'Rd3', 'Qd3', 'Kd3']);
  assert.deepEqual(findMoves('3.1b8la2', PDF).map(t => [t.glyph, t.sans[0].slice(-2)]), [['1', 'b8'], ['l', 'a2']]);
  assert.deepEqual(squares('8.1al#'), [[8, 'a1']]);
  const king = findMoves('4>a8 7 . * c 7', PDF);
  assert.equal(king[0].glyph, '4>');
  assert.ok(!king.some(t => t.san === 'a8'));
});

test("three spaced digits before a move: the whole number, or its last digit as the moves before tell", () => {
  assert.deepEqual(findMoves('1 0 2 . * g l', PDF).map(t => t.num), [102]);
  assert.ok(!findMoves('30 1 1 l .e5', PDF).some(t => t.num === 111));
  assert.deepEqual(findMoves('1 0 1.e4 c5', PDF)[0].cut, { whole: 101, label: '10', num: 1 });
  // (no game at move 101 here: the game's first move)
  const [u] = follow([['Before the game the score was 1 0 1.e4 c5 2.Nf3 d6']]);
  assert.deepEqual(u.moves.map(t => `${label(t)}@${placed(t) ? t.node.ply : '-'}`), ['1.e4@1', 'c5@2', '2.Nf3@3', 'd6@4']);
  // (a stray digit before a number of two: its last two digits, as the line goes on)
  assert.deepEqual(findMoves('11.Nbd2 Bb7 3 1 2.a4 h6', SCAN)[2].cut, { whole: 312, label: '31', num: 2, pair: 12 });
  const [stray] = follow([[`${RUY} 9.h3 Nb8 10.d4 Nbd7 11.Nbd2 Bb7 3 1 2.a4 h6 13.Bc2`]], { scan: true });
  assert.equal(stray.moves.find(t => t.san === 'a4').num, 12);
  assert.ok(main(stray.moves.at(-1)));
});

test("a scan's lone l or I before Black's dots is the number 1; the word I is not", () => {
  assert.deepEqual(findMoves('l...*e6', PDF).map(t => [t.num, t.side]), [[1, 'black']]);
  assert.deepEqual(moves('Then l...Kf7 is forced.'), ['1...Kf7']);
  assert.deepEqual(findMoves('Now l...^f7 2.^e2', PDF).map(t => [t.num, t.side, t.glyph]), [[1, 'black', '^'], [2, 'white', '^']]);
  assert.deepEqual(moves('I .. .Rb8'), ['1...Rb8']);
  assert.deepEqual(moves('then l...b2 2.Kd4'), ['1...b2', '2.Kd4']);
  assert.deepEqual(moves('I. Introduction'), []);
  assert.deepEqual(moves('Should I... d5 now?'), ['d5']);
});

test("a figurine's sign before a square on the first rank read as l: a piece's move, not a word", () => {
  assert.deepEqual(squares('16.Hgl'), [[16, 'g1']]);
  assert.deepEqual(moves('137. Sal'), []);
  assert.deepEqual(moves('7. Marco'), []);
});

test('a small letter for a figurine before a capture or after a move number, not inside a word', () => {
  assert.ok(findMoves('1.e4 e5 Wxdl+', PDF).some(t => t.glyph === 'W' && t.sans[0].endsWith('xd1')));
  assert.deepEqual(squares('3.sfec3!'), [[3, 'c3']]);
  assert.deepEqual(moves('the dual e4'), ['e4']);
  assert.deepEqual(moves('the move andd5 was'), []);
});

test("a promotion whose piece the scan read as a sign: each piece, the queen first", () => {
  assert.deepEqual(findMoves('7.a8=# Kb2', PDF)[0].sans, ['a8=Q', 'a8=N', 'a8=R', 'a8=B']);
  assert.deepEqual(findMoves('the a8 square', PDF).filter(t => !t.square && !t.pawn), []);
});

test('a digit read twice, or a sign for a 5: the rank the board can tell', () => {
  const first = text => findMoves(text, PDF).map(t => t.sans?.[0] || t.san);
  assert.deepEqual(first('1.Kd4 KeS5'), ['Kd4', 'Ke5']);
  assert.deepEqual(first('1.Kd4 Kdé6'), ['Kd4', 'Kd6']);
  assert.deepEqual(first('1.Kg2 Khl1'), ['Kg2', 'Kh1']);
  assert.deepEqual(findMoves('1.Kg2 bxa$', PDF)[1].sans, ['bxa5', 'bxa6']);
});

test("a pawn's file read as a sign: each file it may be", () => {
  const [pawn, king] = findMoves('5.¢6 Ke8', PDF);
  assert.deepEqual([pawn.num, pawn.sans], [5, ['c6', 'e6']]);
  assert.deepEqual([king.num, king.san], [null, 'Ke8']);
  assert.deepEqual(findMoves('10.¢8=Q', PDF)[0].sans, ['c8=Q', 'e8=Q']);
});

test("a king's move with a file too many: as written, and without either file", () => {
  assert.deepEqual(findMoves('5.Keb6', PDF)[0].sans, ['Keb6', 'Ke6', 'Kb6']);
});

test("a pawn's move whose file the app's OCR lost, or read as a digit: each file, only next to a move or on its own line", () => {
  const [lost] = findMoves('31.25 Kd7 32.Bxa6', SCAN);
  assert.deepEqual([lost.num, lost.glyph, lost.fileless], [31, 'file 2', true]);
  assert.deepEqual(lost.sans, ['a5', 'b5', 'c5', 'd5', 'e5', 'f5', 'g5', 'h5']);
  assert.ok(findMoves('text before\n2.15!\ntext after', SCAN).some(t => t.fileless && t.num === 2));
  for (const text of ['(rapid 1.3) 1998', '1. 16', '1.4 Two Bishops']) assert.ok(!findMoves(text, SCAN).some(t => t.fileless), text);
});

test("in a PDF's own text a decimal is no pawn's move without its file", () => {
  assert.deepEqual(moves('14.Nf3 (1.25) Black is fine. 14.Nf3 2.5 Nc6'), ['14.Nf3', '14.Nf3', 'Nc6']);
  assert.deepEqual(moves('11.24 Kd7 12.Kd3', SCAN), ['11.a4', 'Kd7', '12.Kd3']);
});

test("a pawn's file a scan read as a digit and a figurine read as that digit are learnt apart", () => {
  // (the digit 2 a file in "8.25" and a rook's figurine in "9.2d3": what the one teaches, the other does not take)
  const [figurine] = findMoves('9.2d3 Ke7', SCAN);
  const [fileless] = findMoves('8.25 Ke7', SCAN);
  assert.notEqual(figurine.glyph, fileless.glyph);
  const book = new BookMoves();
  const node = { parent: { fen: '4k3/8/8/8/1P6/8/8/4K3 w - - 0 1' } };
  for (let i = 0; i < 3; i++) book.learn({ ...fileless, node });
  assert.equal(book.pieceOf(fileless.glyph), 'b');
  assert.equal(book.pieceOf(figurine.glyph), null);
});

test("a scan's S, B or G for a move number's digit: S a 5 or an 8", () => {
  assert.deepEqual(moves('S . Rb8 Ke7', SCAN), ['5.Rb8', 'Ke7']);
  assert.deepEqual(findMoves('S . Rb8', SCAN)[0].nums, [5, 8]);
  assert.deepEqual(moves('B.Kh7 Kf8', SCAN), ['8.Kh7', 'Kf8']);
});

test("a letter for a move number only in an OCR's text, or where the moves numbered around it lead to it", () => {
  // (a plan, a list of answers: the letters are the text's, in an EPUB's text and in a PDF's)
  for (const opts of [{}, PDF]) {
    assert.deepEqual(moves('Plan B. Nd5 is the sharper one.', opts), ['Nd5']);
    assert.deepEqual(moves('Which is best? A. Kd2 B. Ke2 C. Kf2', opts), ['Kd2', 'Ke2', 'Kf2']);
  }
  // (the moves numbered before or after it lead to it — unless a word stands right before it)
  assert.deepEqual(moves('7.Ke1 Kd7 B.Ke2 Kd6'), ['7.Ke1', 'Kd7', '8.Ke2', 'Kd6']);
  assert.deepEqual(moves('B. Ke2 Kd6 9.Kd3'), ['8.Ke2', 'Kd6', '9.Kd3']);
  assert.deepEqual(moves('7.Ke1 Kd7 Plan B. Ke2'), ['7.Ke1', 'Kd7', 'Ke2']);
  // (nor a list's letter, the letters before and after it heading the lines around it)
  assert.deepEqual(moves('7.Nf3 Nc6\nA. Bb5\nB. Bc4\nC. d4'), ['7.Nf3', 'Nc6', 'Bb5', 'Bc4', 'd4']);
  // (an OCR's text: a page whose moves show its misreadings, or the app's own OCR — after a word too)
  assert.deepEqual(moves('3.Kd2 KdS then S.Kc4'), ['3.Kd2', 'Kd5', '5.Kc4']);
  assert.deepEqual(moves('it was then S.Kc4', SCAN), ['5.Kc4']);
  // (in a game: a plan's move is no move of the game's number)
  const [u] = follow([[`${RUY} 9.h3 Plan B. Nd5 was too slow. 9...Bb7`]]);
  assert.deepEqual(u.moves.slice(-2).map(t => `${label(t)}@${placed(t) ? t.node.ply : '-'}`), ['Nd5@-', '9...Bb7@18']);
});

test("a scan's move number spaced, its dots read as bullets — a number without dots is one as before", () => {
  assert.deepEqual(moves('1 1 . KcS RbS+ l 2.Kc4'), ['11.Kc5', 'Rb5', '12.Kc4']);
  assert.deepEqual(moves('5 • • • Rfl 6.Kd4'), ['5...Rf1', '6.Kd4']);
  assert.deepEqual(moves('12 Nf3 Nf6'), ['12.Nf3', 'Nf6']);
  assert.deepEqual(moves('1 e4 e5'), ['1.e4', 'e5']);
});

test("a scan's first rank read as l or I, or set apart from its file", () => {
  assert.deepEqual(moves('5.h7 bI=Q 6.h8=Q'), ['5.h7', 'b1=Q', '6.h8=Q']);
  assert.deepEqual(moves('3.Kd2 Rb l+ 4.Kc3'), ['3.Kd2', 'Rb1', '4.Kc3']);
  assert.deepEqual(moves('2.Re 1 ! threatening'), ['2.Re1']);
  assert.deepEqual(moves('13.Kh5 RgI 14.Kh4'), ['13.Kh5', 'Rg1', '14.Kh4']);
});

test("an OCR'd move's signs are its own: the reply right after them", () => {
  assert.equal(findMoves('19 RhB! Rd7', PDF)[0].end, '19 RhB!'.length);
});

test('a word read by OCR is most like the move of like shapes', () => {
  assert.ok(wordDistance('13', 'f3') < wordDistance('13', 'h3'));
  assert.ok(wordDistance('Ke?', 'Ke7') < wordDistance('Ke?', 'Ke8'));
  assert.ok(wordDistance('Ngd4+', 'Ng4+') <= 0.5);
  assert.ok(wordDistance('Kco', 'Kc6') < 1 && wordDistance('hxgs', 'hxg5') < 1);
});

test("a scan's move number cut in two or read as a letter: the word read is the move's own, for the moves most like it", () => {
  const cut = 'Then 1 0.Qb3 wins.';
  assert.equal(cut.slice(findMoves(cut, SCAN)[0].written.at, findMoves(cut, SCAN)[0].end), 'Qb3');
  const letter = 'Then S.Kd4 wins.';
  assert.equal(letter.slice(findMoves(letter, SCAN)[0].written.at, findMoves(letter, SCAN)[0].end), 'Kd4');
  // (a word garbled beyond its readings after a number cut in two — "Qh3" for a queen's move to b3 —: the legal move
  // most like it, as for a move numbered plainly)
  const [u] = follow([['White to play.\n1 0.Qh3 Ka7 11.Qa4+', [{ at: 'White to play', placement: 'k7/8/8/8/8/5P2/8/3Q2K1', side: 'w', font: false }]]], { scan: true });
  assert.equal(u.moves[0].node?.san, 'Qb3');
});

test("a scan's move read more than one way: the check sign the book wrote decides, when the book is followed again too", () => {
  // (a rook's move whose rank the scan read as an l, "Rel+": the reading that gives check, Re8+ — also after a first
  // run on a misread board, a pawn in the way, played the move otherwise and said it without check)
  const [u] = follow([['White to play.\n1.Rel+ Kh7 2.Re7+ Kg6', [{ at: 'White to play', placement: '7k/8/4p3/8/4R3/8/8/6K1', side: 'w', font: false }]]], { scan: true });
  u.diagrams[0].placement = '7k/8/8/8/4R3/8/8/6K1';
  new BookMoves().follow(u);
  assert.equal(u.moves[0].node?.san, 'Re8+');
});

test('castling written with a dash, or cut at a line end, is castling', () => {
  const text = '1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.0–0 Nf6 5.d3 O—O 6.Bg5 h6 7.Bh4 d6 8.c3 a6 9.Nbd2 b5 10.Bb3 Ba7 11.Re1 O-\nO-O';
  // (Black's replies without their numbers; the last, "O-⏎O-O", queenside)
  assert.deepEqual(moves(text, {}).filter(m => /O-O/.test(m)), ['4.O-O', 'O-O', 'O-O-O']);
  const cut = '11.Re1 O-\nO-O and Black is fine.';
  assert.equal(findSentences(cut, findMoves(cut)).length, 1);
});

test('castling written with zeros and a dash only where moves stand: a score is written so too', () => {
  for (const opts of [{}, PDF]) {
    assert.deepEqual(moves('The score was 0–0 after two games, and 0—0 again.', opts), []);
    assert.deepEqual(moves('5.0–0 d6 6.c3 0–0 7.h3, or ...0—0 at once', opts), ['5.O-O', 'd6', '6.c3', 'O-O', '7.h3', '...O-O']);
    // (with the letter O, or a hyphen, wherever it stands)
    assert.deepEqual(moves('White chose O–O and then 0-0 was out of the question', opts), ['O-O', 'O-O']);
  }
});

test("a font's own figurine is a piece's move wherever it stands; an OCR's spelling of one is not", () => {
  assert.deepEqual(moves(`The knight takes ${KNIGHT}xd5 at once.`), ['Nxd5']);
  assert.ok(!findMoves('The knight takes @xd5 at once.', PDF).some(t => t.san === 'Nxd5'));
});

test("a promotion written with a font's own figurine after the square: each piece it may be, the queen first", () => {
  const [t] = findMoves(`57.c8${QUEEN}+ Kd7`, PDF);
  assert.deepEqual([t.san, t.sans, t.check, t.promoted], ['c8=Q', ['c8=Q', 'c8=N', 'c8=R', 'c8=B'], '+', QUEEN]);
  const [u] = follow([[`White to move.\n57.c8${QUEEN}+ Kb6 58.Qc2`, [{ at: 'White to move', placement: '8/2P5/k7/8/8/8/8/4K3' }]]], { font: false });
  assert.equal(at([u], 0, '57.c8=Q').node?.san, 'c8=Q+');
  assert.ok(placed(at([u], 0, '58.Qc2')));
});

test("a promotion's figurine: the piece learnt for it first, the queen first again when the book is followed anew", () => {
  const [t] = findMoves('1.c8\uE001 Kd7', PDF);
  assert.equal(t.promoted, '\uE001');
  // (the font's figurine learnt as a knight: its promotion first)
  const taught = new BookMoves();
  const node = { parent: { fen: '4k3/8/8/8/8/8/8/1N2K3 w - - 0 1' } };
  for (let i = 0; i < 3; i++) taught.learn({ glyph: '\uE001', sans: [...'NBRQK'].map(p => `${p}c3`), node });
  taught.figure(t);
  assert.equal(t.sans[0], 'c8=N');
  // (followed anew, nothing learnt yet: the queen's)
  new BookMoves().figure(t);
  assert.deepEqual(t.sans, ['c8=Q', 'c8=N', 'c8=R', 'c8=B']);
});

// Diagrams named in the text

test("a diagram's caption number, its digits spaced or not", () => {
  assert.equal(diagramNumber('DIAG RAM 1 0 .'), '10');
  assert.equal(diagramNumber('DIAGRAM 4.'), '4');
  assert.equal(diagramNumber('DIAGRAM 23. White to play'), '23');
  assert.equal(diagramNumber('Rooks behind passed pawns'), null);
  // (`whole`: the caption alone, not a sentence naming it)
  assert.equal(diagramNumber('Diagram 62', true), '62');
  assert.equal(diagramNumber('Diagram 62 shows the idea', true), null);
});

test('where the text names a diagram by its caption number', () => {
  const text = 'The defence holds.\nLook at Diagram 10 again: the white king is too slow. 1.Kb5 Kd4\nDIAGRAM 1 0 .';
  assert.equal(namedAt(text, '10', [text.indexOf('DIAGRAM'), text.length]), text.indexOf('Look at'));
  const trap = 'A quiet move. Diagram 4 hides a trap for White.\nDIAGRAM 4.';
  assert.equal(namedAt(trap, '4', [trap.indexOf('DIAGRAM'), trap.length]), trap.indexOf('Diagram 4 hides'));
  const other = 'Compare Diagram 101 with this one. 1.Kb5\nDIAGRAM 10.';
  assert.equal(namedAt(other, '10', [other.indexOf('DIAGRAM'), other.length]), null);
});

test("a diagram named in a move's sentence: in brackets, after an exercise's number — not a caption beginning a line", () => {
  assert.equal(namedDiagram('If White waits instead (see diagram 62), '), '62');
  assert.equal(namedDiagram('If White waits instead (see diagram 62), ', true), '62');
  assert.equal(namedDiagram('Back at diagram (46): ', true), '46');
  assert.equal(namedDiagram('An endgame to solve. Exercise 2 (Diagram 59): an old study'), '59');
  // (`near`: words right before the move; an exercise's heading names the diagram of its own solution, not of the move)
  assert.equal(namedDiagram('Exercise 4 (Diagram 61): a famous study. The answer: ', true), null);
  assert.equal(namedDiagram('Exercise 4 (Diagram 61): a famous study. The answer: '), '61');
  assert.equal(namedDiagram('\nDiagram 37. Black to play\n', true), null);
  assert.equal(namedDiagram("Diagram 31: Black's turn\n", true), null);
});

test("a long run of spaces after a diagram's word is read at once", () => {
  const spaces = `diagram${' '.repeat(100000)}x`;
  const t0 = performance.now();
  assert.equal(namedDiagram(spaces), null);
  assert.equal(diagramNumber(spaces), null);
  assert.equal(namedAt(spaces, '10', [0, 0]), null);
  assert.ok(performance.now() - t0 < 500, `${Math.round(performance.now() - t0)} ms`);
});

// A page's layout

/** Text items as pageBoxes gives them: their start and end in the text, their box [x0, y0, x1, y1] as shares of the page. */
function page(lines) {
  let text = '';
  const items = [];
  for (const [s, box] of lines) {
    items.push({ start: text.length, end: text.length + s.length, box });
    text += `${s}\n`;
  }
  return { text, items };
}
const BOARD = [0.5, 0.3, 0.85, 0.55];

test('a board set beside the text goes before the first line beside it, its caption number kept', () => {
  const p = page([
    ['Running head', [0.4, 0.05, 0.6, 0.07]],
    ['A full line of text over the board and the lines beside it.', [0.1, 0.25, 0.85, 0.27]],
    ['The first line beside the board:', [0.1, 0.32, 0.45, 0.34]],
    ['1.Ke2 Ke4 2.Be3 Ke5', [0.1, 0.36, 0.45, 0.38]],
    ['DIAGRAM 4.', [0.5, 0.56, 0.6, 0.58]],
    ['The text goes on below the board, across the page.', [0.1, 0.6, 0.85, 0.62]],
    ['12', [0.48, 0.95, 0.52, 0.97]],
  ]);
  const r = boardAt(p.items, p.text, BOARD);
  assert.equal(r.at, p.text.indexOf('The first line beside'));
  assert.equal(r.number, '4');
});

test('a board in a column of its own goes before the line under it', () => {
  // (two columns: nothing over or under the board runs across it and the column beside it)
  const p = page([
    ['Running head running across both columns of the page', [0.1, 0.05, 0.85, 0.07]],
    ['The left column goes on beside the board.', [0.1, 0.32, 0.45, 0.34]],
    ['1.Ke2 Ke4 2.Be3 Ke5', [0.1, 0.36, 0.45, 0.38]],
    ['The right column, over the board.', [0.5, 0.25, 0.85, 0.27]],
    ['DIAGRAM 4.', [0.5, 0.56, 0.6, 0.58]],
  ]);
  assert.equal(boardAt(p.items, p.text, BOARD).at, p.text.indexOf('DIAGRAM'));
});

test('a board whose caption numbers it goes where the page names it, with the side to move its caption gives', () => {
  const p = page([
    ['In Diagram 4, the King is far from the corner.', [0.1, 0.25, 0.85, 0.27]],
    ['1.Ke2 Ke4 2.Be3 Ke5', [0.1, 0.36, 0.45, 0.38]],
    ['DIAGRAM 4. White is to move', [0.5, 0.56, 0.75, 0.58]],
  ]);
  const r = boardAt(p.items, p.text, BOARD);
  assert.equal(r.at, p.text.indexOf('In Diagram'));
  assert.equal(r.caption, 'DIAGRAM 4. White is to move');
  assert.equal(sideMarked('', r.caption), 'w');
});

// (an OCR's line: each word as wide as its letters, a space between — no gaps under each other in every line, which
// would make a false gutter)
const ocrLine = (y, ...spans) => {
  const words = spans.flatMap(([x0, x1, text, confidence = 90]) => {
    const unit = (x1 - x0) / (text.length + 0.0001);
    let x = x0;
    return text.split(' ').map(t => {
      const bbox = { x0: Math.round(x), y0: y, x1: Math.round(x + t.length * unit), y1: y + 18 };
      x += (t.length + 1) * unit;
      return { text: t, confidence, bbox };
    });
  });
  return { words, bbox: { x0: words[0].bbox.x0, y0: y, x1: words.at(-1).bbox.x1, y1: y + 18 } };
};
const ocrPage = lines => ocrText({ blocks: [{ paragraphs: [{ lines }] }] }, { width: 800, height: 1200 }).text;

test("a scanned page in two columns, each with a table of its game's moves: read column by column", () => {
  const left = [['The rooks come off now, and the', 'text'], ['knight has to go back to its post.', 'text'], ['6 Re2 Bg7', 'row'], ['7 h4 Rd8', 'row'], ['8 Rc2 Ke7', 'row'], ['9 h5 Kd6', 'row'], ['White goes on with his plan at once', 'text'], ['and takes the pawn on the queenside.', 'text']];
  const right = [['22 Kf1 Rg7', 'row'], ['23 Nd2 Rf7', 'row'], ['24 b5 axb5', 'row'], ['Black has no defence against it, as', 'text'], ['the king cannot come to the centre', 'text'], ['in time to stop the other pawn now.', 'text'], ['25 axb5 Kd6', 'row'], ['26 Ke2 Re7', 'row']];
  const span = ([t, kind], x0, x1) => (kind === 'row' ? [x0 + 40, x0 + 40 + 16 * t.length, t] : [x0, x1, t]);
  const text = ocrPage(left.map((l, i) => ocrLine(100 + i * 30, span(l, 50, 380), span(right[i], 430, 760))));
  const where = s => text.indexOf(s);
  assert.ok(where('9 h5 Kd6') < where('22 Kf1 Rg7') && where('22 Kf1 Rg7') < where('26 Ke2 Re7'), text);
  assert.ok(where('and takes the pawn') < where('22 Kf1'), 'the left column first');
});

test("a table's row of Black's move whose number and dots the OCR misread: \"N ...\" again", () => {
  const text = ocrPage([
    ocrLine(100, [60, 90, '1'], [110, 190, 'Rfd1']),
    ocrLine(130, [60, 380, 'White takes the open file at once now.']),
    ocrLine(160, [110, 150, 'EI', 20], [260, 320, 'Kf8']),
    ocrLine(190, [60, 90, '2'], [110, 180, 'Kf1']),
    ocrLine(220, [60, 380, 'The kings come to the middle first.']),
    ocrLine(250, [60, 100, '13'], [110, 150, 'ou', 20], [260, 330, 'Rc1+']),
    ocrLine(280, [60, 150, 'and'], [260, 320, 'Kf8']),
  ]);
  assert.ok(text.includes('1 ... Kf8'), text);
  assert.ok(text.includes('13 ... Rc1+'), text);
  assert.ok(text.includes('and Kf8'), 'a word read surely is no misread number');
  assert.ok(findMoves(text, SCAN).some(t => t.num === 1 && t.side === 'black' && t.san === 'Kf8'));
});

// Boards in pictures

/** Thick strokes from corner to corner of a square: an X marking it. */
function drawCross(img, x0, y0, size) {
  const w = Math.max(3, Math.round(size * 0.1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      if (u < 0.18 || u > 0.82 || v < 0.18 || v > 0.82) continue;
      if (Math.min(Math.abs(u - v), Math.abs(u + v - 1)) * size <= w / 2) img.data[(y0 + y) * img.width + x0 + x] = 0;
    }
}
/** A board drawn with plain squares (and crosses on some), found in its picture as the reader finds one. */
function pictureBoard(fen, crosses = []) {
  const img = blankPage(470, 470);
  drawPlainBoard(img, 20, 20, 52, fen);
  for (const sq of crosses) drawCross(img, 20 + (sq.charCodeAt(0) - 97) * 52, 20 + (8 - Number(sq[1])) * 52, 52);
  return unpackBoard(JSON.parse(JSON.stringify(packBoard(findPictureBoard(img)))));
}
const startExamples = () => pieceSquares(64).map(p => pieceExample(p.type, p.img));

test('a cross drawn on a square is a mark, no piece', () => {
  const fens = ['8/8/8/3k4/8/8/3K4/8', '8/8/8/2k5/8/4K3/8/8'];
  const boards = [pictureBoard(fens[0], ['c4', 'd4', 'e4', 'c3', 'e3']), pictureBoard(fens[1], ['d5', 'e5', 'd4', 'f4', 'b4'])];
  readBoards(boards, { examples: startExamples() });
  assert.deepEqual(boards.map(placement), fens);
});

test('a board of pawns alone gets no kings', () => {
  const boards = [pictureBoard('8/pp3ppp/8/8/8/8/PP3PPP/8')];
  readBoards(boards, { examples: startExamples() });
  assert.equal(placement(boards[0]), '8/pp3ppp/8/8/8/8/PP3PPP/8');
});

test('a cross on a square teaches nothing, even where a known position has a piece', () => {
  // (the position known of the first board a move off: a bishop where the picture has a cross)
  const boards = [pictureBoard('8/8/8/3k4/8/8/3K4/8', ['c4']), pictureBoard('8/8/8/2k5/8/4K3/8/8', ['d4'])];
  const { examples: used } = readBoards(boards, { examples: startExamples(), labels: ['8/8/8/3k4/2B5/8/3K4/8', null] });
  assert.deepEqual(used.filter(e => e.board === 0).map(e => (e.white ? e.type.toUpperCase() : e.type)).sort(), ['K', 'k']);
  assert.equal(placement(boards[1]), '8/8/8/2k5/8/4K3/8/8');
});

test("a white piece's light inside on a plain dark square, its outline hardly darker than the square: its shape whole", () => {
  // (a square of 48 px, grey 120, with a pawn's round head and body of grey 235 inside an outline of grey 100)
  const size = 48;
  const data = new Uint8Array(size * size).fill(120);
  const paint = (inside, v) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (inside(x, y)) data[y * size + x] = v;
  };
  const head = (x, y, r) => (x - 24) ** 2 + (y - 15) ** 2 <= r * r;
  const body = (x, y, g) => y >= 22 - g && y <= 40 + g && Math.abs(x - 24) <= 6 + (y - 22) * 0.45 + g;
  paint((x, y) => head(x, y, 8) || body(x, y, 2), 100);
  paint((x, y) => head(x, y, 6) || body(x, y, 0), 235);
  const lit = cellShape({ width: size, height: size, data }, 0, 0, size, { ink: 90, darkSquare: true, wall: 0, bright: 200 });
  assert.ok(lit.area > 0.3, `area ${lit.area}`);
});

// A book's cache kept from before

test('a cache from before the version of scanned pages: those pages are read again, words and boards; text pages are not', () => {
  const board = { placement: '8/8/8/3k4/8/8/3K4/8' };
  const pages = [
    { text: 'a scanned page the app read', scan: true, scanned: true, diagrams: [{ at: 0, board }] },
    { text: 'a scanned page not read yet', scan: true, scanned: false },
    { text: 'a page of text with no pictures', scanned: true, diagrams: [{ at: 0, font: true }] },
    null,
  ];
  scanAgain(pages, { boards: undefined, scans: undefined });
  assert.deepEqual(pages.map(p => p && [p.scanned, (p.diagrams || []).length]), [[false, 0], [false, 0], [true, 1], null]);
  // (its text stays until the page is read again: a page whose scan cannot be read keeps it)
  assert.equal(pages[0].text, 'a scanned page the app read');
  // (a cache saved today: no page read again; one of the boards' version before: a text page's boards looked for again)
  const kept = () => [
    { text: 'a scanned page the app read', scan: true, scanned: true, diagrams: [{ at: 0, board }] },
    { text: 'a page of text with a picture', scanned: true, diagrams: [{ at: 0, board }] },
  ];
  const today = kept();
  scanAgain(today, { ...SCANNED });
  assert.deepEqual(today.map(p => [p.scanned, p.diagrams.length]), [[true, 1], [true, 1]]);
  const before = kept();
  scanAgain(before, { ...SCANNED, boards: SCANNED.boards - 1 });
  assert.deepEqual(before.map(p => [p.scanned, p.diagrams.length]), [[true, 1], [false, 0]]);
});

// The board following the book: replies, notes and variations

test('a move after a variation in brackets answers the move the bracket went back to', () => {
  const [u] = follow([['1.e4 e5 2.Nf3 (2.Bc4 Nf6) Nc6 3.Bb5 a6']], { pdf: false });
  const reply = u.moves.find(t => t.san === 'Nc6');
  assert.ok(placed(reply));
  assert.equal(line(reply), 'e4 e5 Nf3 Nc6');
  assert.equal(line(u.moves.at(-1)), 'e4 e5 Nf3 Nc6 Bb5 a6');
  // (a solution's last reply, after a bracket: no move after it to take it)
  const [last] = follow([['White to play.\n1.Rd8+ ( 1.Qe8+? Rxe8 ) Rxd8 and Black holds.', [{ at: 'White to play', placement: 'r5k1/5ppp/8/8/8/8/8/3RQ1K1', side: 'w' }]]]);
  const answer = last.moves.find(t => t.san === 'Rxd8');
  assert.ok(placed(answer));
  assert.equal(answer.node.parent.san, 'Rd8+');
});

test("a reply written after a note without its number is the line's when the next numbered move needs it", () => {
  const [u] = follow([['1.e4 e5 2.Nf3 The knight attacks the pawn at once. Nc6 3.Bb5 is the Spanish.']], { pdf: false });
  assert.equal(line(u.moves.find(t => t.san === 'Bb5')), 'e4 e5 Nf3 Nc6 Bb5');
  assert.ok(placed(u.moves.find(t => t.san === 'Nc6')));
  // (a pawn's move, taken for a square)
  const [pawn] = follow([['1.e4 e5 2.Nf3 Black defends the pawn with d6 3.d4 is the most direct.']], { pdf: false });
  assert.equal(line(pawn.moves.find(t => t.san === 'd4')), 'e4 e5 Nf3 d6 d4');
});

test('a reply written after the comments on the move before, the line going on after it past a variation', () => {
  const units = follow([['A game.\n1.e4 e5 2.Nf3! The knight attacks the pawn at once. d6 (2...Nc6 3.Bb5) 3.d4 exd4 4.Nxd4 Nf6']], { font: false });
  const reply = at(units, 0, 'd6');
  assert.ok(placed(reply));
  assert.equal(at(units, 0, '3.d4').node?.parent, reply.node);
  // (a move named in a sentence whose line goes on without it is no reply)
  const other = follow([['A game.\n1.e4 e5 2.Nf3! Here Nc3 was also good. 2...Nc6 3.Bb5']], { font: false });
  assert.ok(!placed(at(other, 0, 'Nc3')));
  assert.ok(placed(at(other, 0, '3.Bb5')));
  // (an OCR's spelling of a figurine is no sure piece: no reply)
  const spelt = follow([['A game.\n1.e4 e5 2.Nf3! The knight attacks the pawn at once. @c6 (2...d6 3.d4) 3.Bb5 a6']], { font: false });
  assert.ok(!placed(spelt[0].moves.find(t => t.glyph === '@')));
});

test("a reply after the comments, its line's next numbered move on the next page: played first", () => {
  const units = follow([['A game.\n1.e4 e5 2.Nf3! The knight attacks the pawn at once. d6'], ['3.d4 exd4 4.Nxd4 Nf6']], { font: false });
  const reply = at(units, 0, 'd6');
  assert.ok(placed(reply));
  assert.equal(at(units, 1, '3.d4').node?.parent, reply.node);
  assert.ok(placed(at(units, 1, '4.Nxd4')));
});

test("a move beginning a note's sentence is no reply when the text writes the reply further on with its number", () => {
  const note = follow([[`${RUY} 9.h3 White wants d4. ...Na5 meets 10.Bc2 c5 11.d4. Black chose instead 9...Bb7 10.d4 Re8 11.Nbd2`]]);
  assert.ok(main(at(note, 0, '9...Bb7')));
  assert.ok(main(at(note, 0, '11.Nbd2')));
  assert.ok(!main(at(note, 0, '10.Bc2')));
  // (the game's reply after the comments, as a database's export writes it — its alternatives in brackets, its moves
  // going on on a line of their own after them —: the reply, though the text names an alternative's number later)
  const kept = follow([[`${RUY} 9.h3 White wants d4. Na5 [ 9...Bb7 10.d4 Re8 ]\n10.Bc2 c5 11.d4 Qc7 Unlike after 9...Bb7, the knight goes to c4.`]]);
  assert.ok(main(at(kept, 0, 'Na5')));
  assert.ok(main(at(kept, 0, 'Qc7')));
  // (nor another game's moves further on, after its first move)
  const games = follow([['1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 The usual retreat. Nf6 5.O-O Be7 1-0. The second game: 1.d4 d5 2.c4 e6 3.Nc3 Nf6 4.Bg5 4...Be7 5.e3']]);
  assert.ok(main(at(games, 0, 'Nf6')));
  assert.ok(main(at(games, 0, '5.O-O')));
  // (nor another puzzle's solution further on, Black's first move: another position's)
  const puzzles = follow([['A position.\n101 1.Qxd6! (1.Nf5+? Qxf5 =) Qxd6 2.Nf5+ Kf6 3.Nxd6.\n102 1...Qd1+ 2.Kxd1', [{ at: 'A position', placement: '8/6k1/3rq2p/6p1/8/4N1QP/8/6K1', side: 'w' }]]]);
  assert.ok(main(at(puzzles, 0, 'Qxd6')));
  assert.ok(main(at(puzzles, 0, '3.Nxd6')));
});

test('a candidate named in a note is no reply when the text writes the reply further on with its number', () => {
  // (moves named one after the other, a pawn's square last: the game's own reply comes after the note's move)
  const units = follow([[`${RUY} 9.h3 Black can choose from Na5, Bb7 and h6; after 10.d4 each is fine. 9...Nb8 10.d4 Nbd7`]]);
  assert.ok(main(at(units, 0, '9...Nb8')));
  assert.ok(main(at(units, 0, '10.d4', 1)));
  assert.ok(main(at(units, 0, 'Nbd7')));
  // (a reply named without its number after a note, the next numbered move after it, no other reply written: it)
  const reply = follow([[`${RUY} 9.h3 The quiet way. After that, h6 10.d4 Re8 11.Nbd2`]]);
  assert.ok(main(at(reply, 0, '10.d4')));
  assert.ok(main(at(reply, 0, '11.Nbd2')));
});

test("a move a note names is no reply when the note's words go on to the next numbered move, or the game's move is said again", () => {
  // (the note's move, words between it and the numbered move: the game goes on after the note, its reply unnumbered)
  const note = follow([['1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Black may play b5 at some point; then 5.d4 does little.'], ['The usual line is 4...Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6']]);
  assert.ok(!placed(at(note, 0, 'b5')));
  assert.ok(main(at(note, 1, '4...Nf6')));
  assert.ok(main(at(note, 1, '7.Bb3')));
  // (a move of the note written between them, the game going on on the next page)
  const between = follow([['1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Black may play b5 later, not 4...dxc6 5.d4.'], ['4...Nf6 5.O-O Be7']]);
  assert.ok(!placed(at(between, 0, 'b5')));
  assert.ok(main(at(between, 1, '5.O-O')));
  // (the note's move right before the numbered one, and the game's own move written again after the note)
  const again = follow([['1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Black may play b5 5.Bb3 at once. The usual line is 4.Ba4 Nf6 5.O-O Be7 6.Re1']]);
  assert.ok(!main(at(again, 0, '5.Bb3')));
  assert.ok(main(at(again, 0, 'Nf6')));
  assert.ok(main(at(again, 0, '6.Re1')));
  // (in a note's own line, off the game's main line: the move the note names is the reply its next numbered move needs)
  const side = follow([['1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5\nInstead 4...b5 5.Bb3 is sharper, and on Na5 White has 6.Bxf7+ when Black is worse.']]);
  assert.equal(at(side, 0, '6.Bxf7').node.parent.san, 'Na5');
  assert.ok(placed(at(side, 0, '6.Bxf7')) && placed(at(side, 0, 'Na5')));
  assert.ok(main(at(side, 0, 'b5')));
});

test("a side's next move joined to its move before by 'and', the other side's left out, is that side's plan in a note's line — not the game's", () => {
  const units = follow([[`${RUY} 9.h3 Na5\nThe open way is 5...Nxe4 6.d4 b5 7.Bb3 d5 8.dxe5 Be6, when White plays 9.c3 and 10.Bc2 next.\n10.d4 Bb7`]]);
  assert.ok(!main(at(units, 0, '10.Bc2')));
  assert.ok(main(at(units, 0, '10.d4')));
  assert.ok(main(at(units, 0, 'Bb7')));
});

test('a reply after its move: signs set apart, a number of moves to mate in brackets', () => {
  const units = follow([['White to play.\n1.Kd3 [27] Rc6 [26] 2.Qg5+ ! Kd6 3.Qd8+', [{ at: 'White to play', placement: '8/8/8/2rk4/8/4Q3/3K4/8' }]]], { font: false });
  assert.ok(placed(at(units, 0, 'Rc6')));
  assert.ok(placed(at(units, 0, 'Kd6')));
  assert.ok(placed(at(units, 0, '3.Qd8')));
  // (the reply after its count, an alternative to it written next with its number: the reply still)
  const counted = follow([['White to play.\n1.Kd3 [27] Rc6 [26]\nAs good was 1...Rc8 [26]; but the rook stays active.\n2.Qg5+ Kd6', [{ at: 'White to play', placement: '8/8/8/2rk4/8/4Q3/3K4/8' }]]], { font: false });
  assert.ok(placed(at(counted, 0, 'Rc6')));
  assert.equal(at(counted, 0, 'Rc6').node.parent.san, 'Kd3');
});

test('"followed by": a side\'s plan, the other side\'s reply left out, in a game of its own', () => {
  const [u] = follow([['White to play.\n1.Qd7 h6 2.Ra3 Kh7 3.Rf3 followed by 4.Rxf7 Kg6', [{ at: 'White to play', placement: '6k1/5ppp/8/8/8/8/8/R2Q2K1', side: 'w' }]]], { font: false });
  const plan = u.moves.find(t => t.san === 'Rxf7');
  assert.ok(plan?.node, 'the plan is played');
  assert.equal(plan.node.fen.split(' ')[1], 'b');
  assert.notEqual(plan.tree, u.diagrams[0].tree);
});

test("in a book that writes its captures with x, a piece's move written without one takes nothing where a position is matched loosely", () => {
  // (ten short games, twenty captures written with x; then a game and a picture of its position read with two squares
  // wrong — the e5 pawn gone, one on h3 —: "3.Ne5" takes nothing, so the picture is its own position, not the game's)
  const games = Array.from({ length: 10 }, () => '1.e4 d5 2.exd5 Qxd5').join('\n');
  const units = follow([[games], ['1.e4 e5 2.Nf3 d6\nThe picture.\n3.Ne5 Qe7 4.Nc4', [{ at: 'The picture', placement: 'rnbqkbnr/ppp2ppp/3p4/8/4P3/5N1P/PPPP1PPP/RNBQKB1R', font: false }]]]);
  const d = units[1].diagrams[0];
  assert.ok(!d.known);
  assert.equal(at(units, 1, '3.Ne5')?.node?.parent, d.node);
});

// The board following the book: moves the text lost or misread

test('a lost reply among several that would do: the one a garbled word between the moves names', () => {
  // (Black's 2nd move lost — "2...g6" read as junk —; 3.Bc4 Nf6 can follow many of Black's moves: g6 is the one named)
  const [u] = follow([['1.e4 e5 2.Nf3 2.7g6 3.Bc4 Nf6']]);
  assert.equal(line(u.moves.at(-1)), 'e4 e5 Nf3 g6 Bc4 Nf6');
  assert.ok(u.moves.at(-1).node.parent.parent.bookInferred);
});

test("the bridge's hint: a move written well that found no place names its own piece's move, or a lost move's square", () => {
  // (a threat a note names, White's 13th while Black is to move: no Black move to its square is made up, and the game's
  // own move after the note stays the main line)
  const g = '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 d6 5.c3 Bd7 6.d4 Nge7 7.Bb3 h6 8.Nbd2 Ng6 9.Nc4 Be7 10.Ne3 O-O 11.O-O Re8 12.Nd5';
  const units = follow([[`${g}\nThe knight eyes two squares: 13.Nb6 at once, or 13.Bxh6 gxh6 14.Nxe7+ first.\n12...Bf8 13.Bg5`]]);
  assert.ok(!placed(at(units, 0, '13.Bxh6')));
  assert.ok(main(at(units, 0, '12...Bf8')));
  assert.ok(main(at(units, 0, '13.Bg5')));
  // (a move that could not be played where the line is — the pawn it takes misread as gone —, its number and
  // side a lost move's: its square tells which of the moves that fit was lost, the knight's to e5, not to h4)
  const misread = follow([['A position.\n1.Nxe5 Kh8 2.Ng6+ Kg8 3.Ne7+ Kh8', [{ at: 'A position', placement: '5rk1/5ppp/8/8/8/5N2/5PPP/5RK1', side: 'w' }]]]);
  assert.equal(at(misread, 0, '2.Ng6')?.node?.parent?.parent?.san, 'Ne5');
  assert.ok(placed(at(misread, 0, '3.Ne7')));
});

test("a lost move made up only where the checks written along the line hold on the board", () => {
  // (a pawn read on g7 that is not there: the reply the text lost made up, the rook's checks on the seventh rank fail)
  const units = follow([['White to play.\n1.Ra8+ 2.Ra7+ Kg8 3.Ra8+ Kh7 4.Ra7+ Kh6', [{ at: 'White to play', placement: '7k/6p1/8/8/8/8/8/R1K5', side: 'w' }]]], { font: false });
  assert.ok(placed(at(units, 0, '1.Ra8')));
  assert.ok(!placed(at(units, 0, '2.Ra7')));
  assert.ok(!placed(at(units, 0, '4.Ra7')));
  // (a text that writes no check signs: the checks it leaves out tell nothing against the line)
  const unsigned = follow([['White to play.\n1.Ra8 2.Ra7 Kg8 3.Ra8 Kh7 4.Ra7 Kh6', [{ at: 'White to play', placement: '7k/6p1/8/8/8/8/8/R1K5', side: 'w' }]]], { font: false });
  assert.ok(placed(at(unsigned, 0, '2.Ra7')));
  assert.ok(placed(at(unsigned, 0, '4.Ra7')));
});

test("a scan's table of moves: misread digits, words read as no move and a lost first move put right by the board", () => {
  // (a rook ending's moves as a small scan's OCR reads them, after its diagram: Black's first move lost, "¢3" for c3,
  // "Kd?" for Kd7, "Kdl" for Kd3, "Rai" for Ra1, "Nb64+" for Nb4+, "Nc8" for Nc6 — no knight goes to c8 there)
  const table = ['2 Rhel Rxe2', '3 Rxe2 Kc8', '4 ¢3 Kd?', '5 Kc2 a5!', '6 Kdl b5', '7 Ra2 Re8', '8 Rai b4', '9 cxb4 Nxb4+', '10 Kd2 Nc8', '11 Kd3 Re4', '12 Rc1 Nb64+', '13 Kd2 Kc8'].join('\n\n');
  const right = 'Rce8 Rhe1 Rxe2 Rxe2 Kc8 c3 Kd7 Kc2 a5 Kd3 b5 Ra2 Re8 Ra1 b4 cxb4 Nxb4+ Kd2 Nc6 Kd3 Re4 Rc1 Nb4+ Kd2 Kc8';
  const read = scan => follow([[table, [{ at: '2 Rhel', placement: '1kr2r2/ppp4p/2np2p1/3p4/3P1P2/1P3NP1/1KP1R2P/7R' }]]], { scan, font: false })[0].diagrams[0].tree?.mainline().map(n => n.san).slice(1).join(' ');
  assert.equal(read(true), right);
  // (not on a page the app read by OCR: its words are as written)
  assert.notEqual(read(false), right);
});

test("moves given their place after their page was followed: the pages before are returned, a scan's reply said as played", () => {
  // (moves at a page's foot, their diagram heading the next page: following it returns the page before)
  const book = new BookMoves();
  const pages = [['An endgame.\n41.Kf2 Kd7 42.Ke3'], ['The kings walk up. 42...Ke7 43.Kd4 Kd6 44.a4', [{ at: 'The kings walk', placement: '4k3/7p/8/8/8/8/P7/4K3', side: null, font: true, alts: [] }]]];
  const units = pages.map(([text, diagrams = []], index) => ({ index, text, moves: findMoves(text, PDF), diagrams: diagrams.map(d => ({ ...d, at: text.indexOf(d.at) })) }));
  assert.deepEqual(book.follow(units[0]), []);
  assert.deepEqual(book.follow(units[1]), [units[0]]);
  assert.ok(placed(at(units, 0, '41.Kf2')));
  // (a reply a later numbered move showed — "gS", g5 —: said as the move played)
  const [u] = follow([['1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3, when gS 5.d4']], { scan: true });
  const reply = u.moves.find(t => /S/.test(u.text.slice(t.start, t.end)));
  assert.equal(reply?.node?.san, 'g5');
  assert.equal(reply.words, 'g5');
});

test("a scan's S, a 5 or an 8: the number the line read goes on with", () => {
  const units = follow([[RUY.replace('8.c3', 'S.c3')]], { font: false });
  assert.equal(at(units, 0, '8.c3')?.num, 8);
  assert.ok(placed(at(units, 0, '8.c3')));
});

test('a number cut in two goes back to a move of the game read, not to a puzzle before its start', () => {
  const text = 'Black to play.\n13...Kd5 14.Ke7\nA mistake was 14.Nc7+? Kxd4 15.Nxb5+ Kc4 16.Nd6+ Kb3, a draw.\n1 4 ... Bh1 15.Kd7 Kc4';
  const units = follow([[text, [{ at: 'Black to play', placement: '8/8/N2k1K2/1p6/1P1P4/P4b2/8/8' }]]], { font: false });
  const t = units[0].moves.find(m => m.san === 'Bh1');
  assert.equal(t.num, 14);
  assert.ok(placed(t));
  assert.ok(placed(at(units, 0, '15.Kd7')));
});

test('a promotion whose piece the text lost: the piece the moves after it can be played after, else the queen', () => {
  // (a knight's promotion with check, the king's reply only possible then — a queen on c8 would hold e8)
  const units = follow([['A study.\n1.c8 Ke8 2.Qg6+ Kf8 3.Qf6+', [{ at: '1.c8', placement: '8/2P1k3/8/5Q2/8/3pp3/4rp2/3K4', side: 'w' }]]], { pdf: false });
  assert.equal(at(units, 0, '1.c8=N')?.node?.san, 'c8=N+');
  assert.ok(placed(at(units, 0, 'Ke8')));
  assert.ok(placed(at(units, 0, '3.Qf6')));
  // (a queen's, when the moves after it go on as well)
  const queen = follow([['A study.\n1.c8 Kd6 2.Qd8+', [{ at: '1.c8', placement: '8/2P1k3/8/8/8/8/8/K7', side: 'w' }]]], { pdf: false });
  assert.equal(at(queen, 0, '1.c8=Q')?.node?.san, 'c8=Q');
});

// The board following the book: a diagram's position, its side to move and its first moves

test('a diagram set over the moves that lead to it is the position of the line read they reach', () => {
  // (the game at 3...Nf6; the picture shows the position after 4.d3 Bc5, written after it)
  const [u] = follow([['1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 Now the position: 4.d3 Bc5 5.c3 d6', [{ at: 'Now', placement: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R' }]]], { pdf: false, font: false });
  const d = u.diagrams[0];
  assert.ok(d.known);
  assert.equal(line({ tree: d.tree, node: d.node }), 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5');
  assert.equal(line(u.moves.at(-1)), 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5 c3 d6');
});

test('a picture whose pieces stand elsewhere is not a position of the line read, though moves after it go on there — one with marks read as pieces is', () => {
  // (the game at 2...Kd3 — K f3, R e4, k d3 —; the picture has the same three pieces on other squares)
  const ending = ['An ending.\n1.Kf3 Kd4 2.Re4+ Kd3', [{ at: '1.Kf3', placement: '8/8/8/4k3/8/8/4K3/4R3', font: true }]];
  const [, u] = follow([ending, ['The picture.\n3.Rd4+ Kc3 4.Ke3', [{ at: '3.Rd4', placement: 'k7/8/8/8/8/8/8/K6R' }]]], { pdf: false, font: false });
  assert.ok(!u.diagrams[0].known);
  assert.equal(u.diagrams[0].node.fen.split(' ')[0], 'k7/8/8/8/8/8/8/K6R');
  // (the picture shows them, and three marks on its top row read as pawns)
  const [, marked] = follow([ending, ['The picture.\n3.Rd4+ Kc3 4.Ke3', [{ at: '3.Rd4', placement: 'PPP5/8/8/8/4R3/3k1K2/8/8' }]]], { pdf: false, font: false });
  assert.equal(marked.diagrams[0].known, '8/8/8/8/4R3/3k1K2/8/8');
});

test("a picture's unsure square put right by a move further on — and not known for that", () => {
  // (the c5 piece read as a bishop, a pawn maybe: 3.c6 says the pawn — the line read so far stays playable)
  const [u] = follow([['A study.\n1.Kd5 Kg5 2.Kd6 Kg6 3.c6 Kf7 4.c7 Ke8', [{ at: '1.Kd5', placement: '8/8/8/2B4k/3K4/8/8/8', alts: [{ sq: 26, options: ['B', 'P'] }] }]]], { pdf: false, font: false });
  assert.deepEqual(u.moves.filter(placed).map(t => t.san), ['Kd5', 'Kg5', 'Kd6', 'Kg6', 'c6', 'Kf7', 'c7', 'Ke8']);
  assert.equal(u.diagrams[0].tree.root.fen.split(' ')[0], '8/8/8/2P4k/3K4/8/8/8');
  assert.ok(!u.diagrams[0].known);
});

test("a picture is not the line read's position its next move gets to from it, as read", () => {
  // (the line read has the rook go to g1 from g2; a picture of the rook on c1, its next move "4...Rg1": the picture is
  // the position before that move, not the line's after it — taught as one, the picture would be read with g1)
  const text = 'The ending.\n4...Rg1 5.Kh7 Ra1 6.Rb8+ Ke7 7.f6+\nThe same ending, the rook elsewhere.\n4...Rg1 5.Rb8+ Ke7 6.f6+ Kd7';
  const [u] = follow([[text, [{ at: 'The ending', placement: '5k2/1R3p2/7K/4PP2/8/8/6r1/8', side: 'b' }, { at: 'The same ending', placement: '5k2/1R3p2/7K/4PP2/8/8/8/2r5', font: false }]]]);
  assert.notEqual(u.diagrams[1].node?.fen.split(' ')[0], '5k2/1R3p2/7K/4PP2/8/8/8/6r1');
});

test("a picture far from the line read's position, one move after it: a game of its own", () => {
  const units = follow([
    ['A game.\n1.Kd2 Kd7 2.Kc3 Kc7 3.Kb4', [{ at: 'A game', placement: '2k5/8/8/8/8/8/8/3K4' }]],
    ['A second ending.\n3.Kb4', [{ at: 'A second ending', placement: '2k5/1p6/1P6/8/8/2K2r2/8/5R2' }]],
  ], { font: false });
  const d = units[1].diagrams[0];
  assert.ok(d.node && !d.node.parent);
  assert.equal(at(units, 1, '3.Kb4').node?.parent, d.node);
});

test('a king in check: its side is to move, whatever the words after the diagram say', () => {
  const units = follow([['Black must wait; White to move must bring the king.\n23...Kd8 24.Kd6 Kc8', [{ at: 'Black must wait', placement: '8/2k5/4K3/1B1N4/8/8/8/8' }]]], { font: false });
  assert.equal(units[0].diagrams[0].node?.fen.split(' ')[1], 'b');
  assert.ok(placed(at(units, 0, '24.Kd6')));
});

test("the words after a diagram say a side, its first move is the other one's: that side to move", () => {
  const units = follow([['Our study.\nWhite to play wins, but first the defence: 1...Kd7 2.Kf4 Ke6 3.Kg5', [{ at: 'White to play', placement: '8/8/4k3/8/8/4K3/4P3/8' }]]], { font: false });
  const d = units[0].diagrams[0];
  assert.equal(d.node?.fen, '8/8/4k3/8/8/4K3/4P3/8 b - - 0 1');
  assert.equal(at(units, 0, '1...Kd7').node?.parent, d.node);
  assert.ok(placed(at(units, 0, '3.Kg5')));
});

test("moves named before a diagram's first numbered move are no reply: its side to move from the numbered one", () => {
  const units = follow([['The position.\nBlack plans ...Ke6 and ...f5. 1.Nd4! Kd7 2.Nf3 Ke6', [{ at: 'Black plans', placement: '8/4kp2/8/8/8/1N6/8/4K3' }]]], { font: false });
  const d = units[0].diagrams[0];
  assert.equal(d.node?.fen, '8/4kp2/8/8/8/1N6/8/4K3 w - - 0 1');
  assert.equal(at(units, 0, '1.Nd4').node?.parent, d.node);
  assert.ok(placed(at(units, 0, '2.Nf3')));
  // (an OCR's spelling of a figurine may be the game's first move misread: it still tells the side to move)
  const spelt = follow([['The position.\n...@xf7 2.Rd6 Ke7 3.Rh6', [{ at: 'The position', placement: 'r3k3/8/8/8/8/8/8/3RK3' }]]], { font: false });
  assert.match(spelt[0].diagrams[0].node?.fen ?? '', / b /);
});

test("a diagram's first numbered move that cannot be played: a later one starts its game only when the moves before it are not its line", () => {
  // (the game's own first moves, from a picture misread — the king already where the first move takes it —: not
  // played from it as if they had not been)
  const misread = follow([['White to play.\n1.Kc6 Kd7 2.Kb6 The pawn is near its square.\n2...Kd6 3.Ka7', [{ at: 'White to play', placement: '8/1P2k3/2K5/8/8/8/8/8', side: 'w' }]]]);
  assert.ok(!placed(at(misread, 0, '2.Kb6')));
  assert.ok(!placed(at(misread, 0, '3.Ka7')));
  // (another example's last moves heading the page, before the diagram's own, numbered from 1 again: from it)
  const restart = follow([['The picture.\n5...Kf8 6.Kc1 Ke8 and that is the end.\n1.Kd4 Kd6 2.Kc4 Kc6', [{ at: 'The picture', placement: '8/8/4k3/8/8/3K4/8/8' }]]]);
  const f = restart[0].diagrams[0].node.fen.split(' ');
  assert.equal(`${f[1]} ${f[5]}`, 'w 1');
  assert.ok(main(at(restart, 0, '2.Kc4')));
});

test("a diagram's first numbered move that cannot be played: a later move that can, going no further, ends the search", () => {
  // (1.Ra1 cannot be played — no rook —; 2.Ke2 can, but Kf8 not after it: the king moves further on, numbered on from
  // another move, are a note's)
  const [u] = follow([['A diagram.\nNot 1.Ra1 Rb1 2.Ke2 Kf8 but 5.Kd4 Kd6 6.Kc4 Kc6', [{ at: 'Not 1.Ra1', placement: '8/8/4k3/8/8/3K4/8/8' }]]], { pdf: false });
  const f = u.diagrams[0].node.fen.split(' ');
  assert.equal(`${f[1]} ${f[5]}`, 'w 1');
  assert.ok(!placed(at([u], 0, '5.Kd4')));
});

test("a diagram of a side line's position a few moves on: its moves stay a variation when the game's own move comes", () => {
  // (a note's moves lead to the diagram, the game's own move with the same number after them: the game's is the main line)
  const italian = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R';
  const units = follow([['1.e4 e5 2.Nf3 Nc6\nAfter 3.Bc4 Bc5 the bishops face each other; but here 3.Bb5 a6 4.Ba4', [{ at: 'After 3.Bc4', placement: italian }]]]);
  assert.equal(units[0].diagrams[0].node?.fen.split(' ')[0], italian);
  assert.ok(placed(at(units, 0, '3.Bc4')) && !main(at(units, 0, '3.Bc4')));
  assert.ok(main(at(units, 0, '3.Bb5')));
  assert.ok(main(at(units, 0, '4.Ba4')));
  // (the game's own move on a line of its own after the diagram, a note's other move after it: the game's)
  const game = follow([['1.e4 e5 2.Nf3 Nc6\n3.Bb5\nThe quieter 3.Bc4 is played too.\n3...a6 4.Ba4', [{ at: '3.Bb5', placement: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R' }]]]);
  assert.ok(main(at(game, 0, '3.Bb5')));
  assert.ok(main(at(game, 0, '4.Ba4')));
  assert.ok(placed(at(game, 0, '3.Bc4')) && !main(at(game, 0, '3.Bc4')));
});

// The board following the book: moves written before their diagram

test('moves written before their diagram are followed again from it', () => {
  // (an ending's moves, then its picture — the column's last —, after a game read to its last move; the next page has
  // none of its moves)
  const text = '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7. An ending: 1.Kd2 Kf7 2.Kd3 Ke7 3.Ke4 Ke6 4.Kd4 Kd6 and the picture.';
  const [u] = follow([[text, [{ at: 'and the picture', placement: '8/8/6k1/8/8/8/4K3/8' }]], ['The next section.']], { pdf: false });
  assert.equal(u.diagrams[0].node, u.diagrams[0].tree.root);
  const last = u.moves.find(t => t.san === 'Kd6');
  assert.equal(last.tree, u.diagrams[0].tree);
  assert.equal(line(last), 'Kd2 Kf7 Kd3 Ke7 Ke4 Ke6 Kd4 Kd6');
});

test("a diagram after its game's first moves on the same page: those moves are followed from it — not two moves a sentence names", () => {
  const units = follow([['An endgame.\n41.Kf2 Kd7 42.Ke3 Ke7\nThe kings walk up. 43.Kd4 Kd6 44.a4', [{ at: 'The kings walk', placement: '4k3/7p/8/8/8/8/P7/4K3' }]]], { font: false });
  const d = units[0].diagrams[0];
  assert.equal(d.node?.fen, '4k3/7p/8/8/8/8/P7/4K3 w - - 0 41');
  assert.equal(at(units, 0, '41.Kf2').node?.parent, d.node);
  assert.ok(placed(at(units, 0, '44.a4')));
  const named = follow([['An endgame.\nHere 41.Kf2? fails to Kd7 and the game went on.\nThe kings walk up. 43.Kd4 Kd6', [{ at: 'The kings walk', placement: '4k3/7p/8/8/8/8/P7/4K3' }]]], { font: false });
  assert.ok(!placed(at(named, 0, '41.Kf2')));
});

test("an example's first moves at a page's foot, its diagram heading the next page: followed from it", () => {
  const units = follow([['An endgame.\n41.Kf2 Kd7 42.Ke3'], ['The kings walk up. 42...Ke7 43.Kd4 Kd6 44.a4', [{ at: 'The kings walk', placement: '4k3/7p/8/8/8/8/P7/4K3' }]]], { pdf: false });
  const d = units[1].diagrams[0];
  assert.equal(d.node?.fen, '4k3/7p/8/8/8/8/P7/4K3 w - - 0 41');
  assert.equal(at(units, 0, '41.Kf2').node?.parent, d.node);
  assert.ok(placed(at(units, 1, '42...Ke7')));
  assert.ok(placed(at(units, 1, '44.a4')));
});

test("a diagram's game followed again from the moves written before it keeps the diagram's root: no move outside its tree", () => {
  const units = follow([['An endgame.\n41.Kf2 Kd7 42.Ke3'], ['The kings walk up. 42...Ke7 43.Kd4 Kd6 44.a4\nInstead 42...Kf8 43.Kf2 Kg7 was passive.', [{ at: 'The kings walk', placement: '4k3/7p/8/8/8/8/P7/4K3' }]]]);
  const d = units[1].diagrams[0];
  assert.equal(d.node, d.tree.root);
  assert.equal(at(units, 0, '41.Kf2')?.node?.parent, d.node);
  for (const t of units.flatMap(u => u.moves)) if (t.node) assert.equal(t.tree.path(t.node)[0], t.tree.root, `${label(t)} outside its game`);
});

test('moves before a diagram are its own when the first numbered move after it is another move for the last of them', () => {
  // (after a game read up to its second move: the example's moves, numbered above it, may be that game's lost ones)
  const units = follow([['A game.\n1.e4 e5 2.Nf3 Nc6\nAn endgame.\n41.Kf2 Kd7 42.Ke3 Ke7\nBetter is 42...Kd6 43.Kd4 Ke6 44.a4', [{ at: 'Better is', placement: '4k3/7p/8/8/8/8/P7/4K3' }]]], { pdf: false });
  assert.equal(at(units, 0, '41.Kf2').node?.parent, units[0].diagrams[0].node);
  assert.equal(at(units, 0, '42...Kd6').node?.parent, at(units, 0, '42.Ke3').node);
  assert.ok(placed(at(units, 0, '44.a4')));
  // (the moves the game read lost, its later diagram after them, its moves going on from it: not the diagram's own)
  const game = follow([['A game.\n1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7\nAn ending later. 31.Kf2 Kd7 32.Ke3 Ke7\nNow 35.Kd4 Kd6 36.a4', [{ at: 'Now', placement: '4k3/7p/8/8/8/8/P7/4K3' }]]], { pdf: false });
  assert.ok(!placed(at(game, 0, '31.Kf2')));
});

test("moves written before a diagram are not its own when they are an unread diagram's line, or its own moves come next page", () => {
  const kp = '8/8/8/4k3/8/3K4/3P4/8';
  // (an example whose diagram was not read, its moves, then another's diagram with nothing after it, nor on the next page)
  const unread = follow([
    ['First example.\n1.Ke2 Ke6 2.Ke3 Kd5 3.Kd3 Ke6 4.Ke4 and White wins.\nSecond example.\nWhite to play.', [{ at: 'First example', placement: null }, { at: 'White to play', placement: kp }]],
    ['Answers follow later.'],
  ]);
  assert.ok(!placed(at(unread, 0, '1.Ke2')));
  assert.ok(!placed(at(unread, 0, '4.Ke4')));
  // (its line ends where the numbers begin again: the moves after that are the next diagram's, written before it)
  const restart = follow([['First example.\n1.Kd2 Kd6 2.Ke3 Ke5 3.Kf3\nSecond example: 1.Kc3 Ke4 2.Kc4 Ke5 3.d4+ and the picture.\n3...Kd6 4.Kb5', [{ at: 'First example', placement: null }, { at: 'and the picture', placement: kp }]]]);
  assert.equal(at(restart, 0, '1.Kc3')?.node?.parent, restart[0].diagrams[1].node);
  assert.ok(main(at(restart, 0, '4.Kb5')));
  assert.ok(!placed(at(restart, 0, '1.Kd2')));
  // (a diagram that ends a page, the moves before it: its own moves on the next page go on from it as read)
  const foot = follow([
    ['Some king moves first: 1.Ke2 Ke6 2.Ke3 Kd5 3.Kd3 Ke6 4.Ke4 and White wins.\nAnother example.', [{ at: 'Another example', placement: kp }]],
    ['1.Kc3 Ke4 2.Kc4 Ke5 3.d4+ Kd6 4.Kb5'],
  ]);
  assert.ok(!placed(at(foot, 0, '1.Ke2')));
  assert.ok(main(at(foot, 1, '1.Kc3')));
  assert.ok(main(at(foot, 1, '4.Kb5')));
});

test('moves written before a diagram are not its own for a move written again and again', () => {
  // (the same first move in three notes: one position, not three — the diagram a page's last, its next page none of its
  // moves)
  const [u] = follow([['1.e4 e5 2.Nf3 Nc6. Black has 1...Kf7. Or 1...Kf7. Again 1...Kf7. The picture.', [{ at: 'The picture', placement: '4k3/8/8/8/8/8/8/4K3' }]], ['Another chapter.']], { pdf: false });
  assert.ok(u.moves.filter(t => t.san === 'Kf7').every(t => !placed(t)));
  assert.equal(u.diagrams[0].node.fen.split(' ')[1], 'w');
});

test("a variation's moves in brackets closed before a diagram begin no game of the diagram's", () => {
  // (a note's king walk that would fit the diagram, the diagram at a page's foot, nothing after it there either)
  const units = follow([['A note: (1...Kd5 2.Kc3 Kc5 3.Kb3) and so on.\nBlack to move.', [{ at: 'Black to move', placement: '8/8/8/4k3/8/3K4/3P4/8', side: 'b' }]], ['Another chapter.']]);
  assert.ok(!placed(at(units, 0, '1...Kd5')));
  assert.ok(!placed(at(units, 0, '3.Kb3')));
});

test('two moves written before a diagram are not its own when its own moves go on from it as read as far, and the move that led to it is left out', () => {
  // (a note's two moves, the game's move that led to the diagram, the diagram's moves after it: from the diagram)
  const units = follow([['Instead, 9...Qb6?! 10.Na4 is good for White.\n10.Be3\nThe position.\n10...Nxe5 11.Nxe5', [{ at: 'The position', placement: '3q2k1/8/2n5/4P3/8/2N1BN2/8/6K1' }]]]);
  assert.ok(!placed(at(units, 0, '9...Qb6')));
  assert.equal(at(units, 0, '10...Nxe5')?.node?.parent, units[0].diagrams[0].node);
  assert.ok(main(at(units, 0, '11.Nxe5')));
});

test('two moves written before a diagram are its own when the last of them before it is one of them, though its moves go on from it too', () => {
  // (the solution's first move and a try, the diagram set between them and the rest of its moves)
  const units = follow([['1.Rb7+! A check. 1.Rxc6? fails at once.\nThe position.\n1...a5 is weak; 1...Kc3 2.Kc7 holds.', [{ at: 'The position', placement: '1K6/2R5/p1p5/8/1k6/8/8/8' }]]]);
  assert.equal(at(units, 0, '1.Rb7')?.node?.parent, units[0].diagrams[0].node);
  assert.ok(main(at(units, 0, '2.Kc7')));
});

test("an example written from its first move before its diagram is the diagram's, though the line read is at its first move too", () => {
  // (the line read at the first diagram's position, nothing played from it; the second example's moves from 1, before its
  // diagram, a page's last, nothing after it)
  const units = follow([
    ['First example.\nNothing is played here.\nSecond example: 1.Kf4 Kf7 2.Ke4 Ke6 3.Kd4 Kd6 holds.\nThe picture.', [{ at: 'First example', placement: 'k7/8/8/8/8/8/7P/K7', side: 'w' }, { at: 'The picture', placement: '6k1/8/8/8/8/6K1/7P/8', side: 'w' }]],
    ['Another chapter.'],
  ]);
  assert.equal(at(units, 0, '1.Kf4')?.node?.parent, units[0].diagrams[1].node);
  assert.ok(main(at(units, 0, '3.Kd4')));
});

test("the last move before a diagram leaves out a variation's in brackets closed before it: the moves before are still its own", () => {
  // (the diagram's first moves, a note in brackets with a move that fits nowhere, the diagram, its moves after it — as
  // far from where its first moves got to as from the picture as read)
  const units = follow([['The start: 1...Kd5 2.Ke2 (2.Qa4 fails.)\nThe picture.\n2...h5 3.Kf1', [{ at: 'The picture', placement: '8/7p/4k3/8/8/8/3P4/4K3', side: 'b' }]]]);
  assert.equal(at(units, 0, '1...Kd5')?.node?.parent, units[0].diagrams[0].node);
  assert.ok(main(at(units, 0, '3.Kf1')));
});

// The board following the book: diagrams named by their number

test("moves sent back to a diagram the sentence names by its number — not an alternative in the game read, as far as it goes", () => {
  // (the game read could take 1...Kf7 2.Kf4 Kf6 3.h4 too, in place of its own 1...Kg7: the sentence says where they go)
  const units = follow([
    ['Diagram 61\nWhite to play.\n1.Kd5 Ke7 2.Ke5', [{ at: 'Diagram 61', placement: '8/3k4/8/8/2K5/8/3P4/8', side: 'w' }]],
    ['Diagram 62\nWhite to play.\n1.Kf3 Kg7 2.Kg4', [{ at: 'Diagram 62', placement: '6k1/8/8/8/8/4K3/7P/8', side: 'w' }]],
    ['If Black moves first instead (see diagram 62), 1...Kf7 2.Kf4 Kf6 3.h4'],
  ], { font: false });
  const t = at(units, 2, '1...Kf7');
  assert.equal(t.node?.parent, t.tree.root);
  assert.equal(t.tree.root.fen, '6k1/8/8/8/8/4K3/7P/8 b - - 0 1');
  assert.ok(placed(at(units, 2, '3.h4')));
});

test("a move whose sentence names an earlier diagram is the game's being read when its moves go on as far there", () => {
  // (the second game reaches the same move number; the sentence compares it with the first game's diagram)
  const g1 = '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6 8.c3 O-O 9.h3 Na5 10.Bc2 c5 11.d4 Qc7';
  const g2 = '1.d4 d5 2.c4 e6 3.Nc3 Nf6 4.Bg5 Be7 5.e3 O-O 6.Nf3 Nbd7 7.Rc1 c6 8.Bd3 dxc4 9.Bxc4 Nd5 10.Bxe7 Qxe7 11.O-O Nxc3';
  const units = follow([
    [`The first game.\n${g1}\nDiagram 5\nWhite to move.`, [{ at: 'Diagram 5', placement: 'r1b2rk1/2q1bppp/p2p1n2/npp1p3/3PP3/2P2N1P/PPB2PP1/RNBQR1K1' }]],
    [`The second game.\n${g2} 12.Rxc3 The plan of diagram 5 works here too: 12...Rb8 13.Qe2 h6 14.Rd1`],
  ]);
  assert.equal(at(units, 1, '12...Rb8').tree, at(units, 1, '12.Rxc3').tree);
  assert.ok(main(at(units, 1, '14.Rd1')));
  // (an alternative in the game read, the diagram at White's move: Black's move goes there only when the words say
  // Black moves first)
  const pages = sentence => [
    [`The first game.\n${g1}\nDiagram 5\nWhite to move.`, [{ at: 'Diagram 5', placement: 'r1b2rk1/2q1bppp/p2p1n2/npp1p3/3PP3/2P2N1P/PPB2PP1/RNBQR1K1', side: 'w' }]],
    [`The second game.\n${g2} 12.Rxc3 e5 ${sentence} 12...Rb8 13.Qe2 is natural. 13...h6 14.Rd1`],
  ];
  const unlike = follow(pages('Unlike in diagram 5, here'));
  assert.equal(at(unlike, 1, '12...Rb8').tree, at(unlike, 1, '12.Rxc3').tree);
  assert.ok(placed(at(unlike, 1, '14.Rd1')));
  const first = follow(pages('If Black moves first in diagram 5,'));
  assert.equal(at(first, 1, '12...Rb8').node.parent, at(first, 1, '12...Rb8').tree.root);
});

test("a solution after words naming its diagram by its caption's number, pages later — not the last diagram it fits", () => {
  // (the solution fits both studies; the words before it name the first by the number its caption gives it)
  const units = follow([
    ['A study.', [{ at: 'A study', placement: '1r6/8/5k2/5b2/8/5B2/5RPP/6K1', number: '158' }]],
    ['Another study.', [{ at: 'Another study', placement: '1r6/p6p/5k2/5b2/8/5B2/P4RPP/6K1', number: '159' }]],
    ['Another position. 1.e4 e5 2.Nf3 Nc6'],
    ['The study of Diagram 158 is a draw. The answer is 1...Rb1+! 2.Rf1 Rxf1+ 3.Kxf1 Bh3 with a draw.'],
  ]);
  const t = at(units, 3, '1...Rb1');
  assert.equal(t.tree, units[0].diagrams[0].tree);
  assert.equal(t.node?.parent, t.tree.root);
});
