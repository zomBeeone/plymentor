// The Book reader's diagrams: boards set in a chess font in a PDF's text, boards found in a scanned page's picture and
// read by the book's own pieces, a scanned page's text from its OCR, and the board following the diagrams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fontBoards, findBoards, findPictureBoard, findFigureBoards, grayFrom, packBoard, unpackBoard, readBoards, placement, pieceExample, CELL } from '../../app/js/books/diagrams.js';
import { pageText, pictureBoxes, diagramShaped } from '../../app/js/books/pdf.js';
import { ocrText } from '../../app/js/books/ocr.js';
import { findMoves, findSentences, spokenParts } from '../../app/js/books/text.js';
import { BookMoves, sideMarked, hiddenSquares } from '../../app/js/books/moves.js';
import { posFromFen } from '../../app/js/chess.js';
import { drawBoard, drawPlainBoard, drawCoordinates, drawText, drawMark, shrink, blankPage, pieceSquares } from './diagram-picture.mjs';

// A PDF page's text items: a line of text, a board in a chess font (each row twice, in two fonts, as some books set
// them, with line ends between the rows), its side-to-move mark, and the text under it.
const item = (str, x, y, more = {}) => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10, hasEOL: true, ...more });
function bookPage() {
  const rows = ['._._._M_', '_._._._.', '._._._._', '_._._._.', '._._._._', '_._._._.', '._._J_._', '_._._.k.'];
  const items = [item('White to move. The position was:', 60, 500)];
  rows.forEach((r, i) => {
    const y = 400 - i * 14;
    items.push(item(r, 94, y, { height: 13.5, width: 108, fontName: 'f4' }), item(r, 94, y - 0.01, { height: 13.5, width: 108, fontName: 'f5' }), item('', 202, y));
  });
  items.push(item('\x86', 79.4, 302 + 4, { height: 12 }), item('1.Kf2 Kg7 2.Kf3 wins.', 60, 280));
  return items;
}

test('a board set in a chess font: its position, its side to move, and none of it read aloud', () => {
  const [b] = fontBoards(bookPage());
  assert.equal(b.placement, '6k1/8/8/8/8/8/4p3/6K1');
  assert.equal(b.side, 'w');
  const viewport = { width: 500, height: 700, convertToViewportPoint: (x, y) => [x, 700 - y] };
  const page = pageText({ items: bookPage() }, viewport);
  // (the line end after its last row stays: the text after it is a paragraph of its own)
  assert.equal(page.text, 'White to move. The position was:\n\n1.Kf2 Kg7 2.Kf3 wins.\n');
  assert.equal(page.diagrams.length, 1);
  const [d] = page.diagrams;
  assert.equal(d.at, 'White to move. The position was:\n'.length);
  assert.deepEqual([d.placement, d.side, d.font], ['6k1/8/8/8/8/8/4p3/6K1', 'w', true]);
  // where it is on the page (shares of its width and height), for the box to click
  assert.ok(d.box[0] > 0.18 && d.box[0] < 0.2 && d.box[2] > 0.4 && d.box[2] < 0.41, `box ${d.box}`);
  assert.ok(d.box[1] > 0.4 && d.box[3] < 0.6, `box ${d.box}`);
  // every item keeps its span (the board's rows empty)
  assert.equal(page.items.length, bookPage().length);
  assert.equal(page.items.filter(i => i.skip).length, 8 * 3 + 1 - 1);
});

// A FEN placement's rows in a chess font's characters, a8 a light square: TeX's (the case is the piece's colour, the
// letter the square's: P N B R Q K on light squares, O M A S L J on dark ones; 0 and Z the empty squares), or an
// Alpha's (small letters on light squares, capitals on dark ones; its empty squares "*" and "+")
function fontRows(fen, font) {
  return fen.split('/').map((row, rank) =>
    [...row.replace(/\d/g, d => '.'.repeat(Number(d)))]
      .map((p, file) => {
        const light = !((rank + file) & 1);
        const type = p.toLowerCase();
        if (font === 'tex') {
          if (p === '.') return light ? '0' : 'Z';
          const ch = light ? type : 'omaslj'['pnbrqk'.indexOf(type)];
          return p === type ? ch : ch.toUpperCase();
        }
        if (p === '.') return light ? '*' : '+';
        const ch = p === type ? { k: 'l', q: 'w', r: 't', b: 'v', n: 'm', p: 'o' }[type] : type;
        return light ? ch : ch.toUpperCase();
      })
      .join(''),
  );
}

test('boards in the other chess fonts: TeX’s, with its coordinates (not read aloud); an Alpha’s, drawn square by square', () => {
  const fen = 'r1bqk2r/pp2bppp/2n1pn2/3p4/2PP4/2N2N2/PP2BPPP/R1BQK2R';
  const viewport = { width: 500, height: 700, convertToViewportPoint: (x, y) => [x, 700 - y] };
  // TeX: a row per item, a rank's digit left of it, the files' letters under the board
  const tex = [item('Black to play.', 60, 520)];
  fontRows(fen, 'tex').forEach((r, i) => tex.push(item(String(8 - i), 84, 403 - i * 14, { height: 7, width: 4 }), item(r, 94, 400 - i * 14, { height: 14, width: 112, fontName: 'skak' })));
  tex.push(item('a b c d e f g h', 96, 290, { height: 7, width: 108 }), item('8...O-O 9.O-O', 60, 260));
  let page = pageText({ items: tex }, viewport);
  assert.equal(page.text, 'Black to play.\n8...O-O 9.O-O\n');
  assert.deepEqual(page.diagrams.map(d => [d.at, d.placement]), [['Black to play.\n'.length, fen]]);
  // Alpha: each square an item of its own, "*" the empty light square
  const alpha = [item('The position:', 60, 520)];
  fontRows(fen, 'alpha').forEach((r, i) => [...r].forEach((ch, f) => alpha.push(item(ch, 94 + f * 14, 400 - i * 14, { height: 14, width: 14, fontName: 'alpha', hasEOL: f === 7 }))));
  page = pageText({ items: alpha }, viewport);
  assert.equal(page.text, 'The position:\n');
  assert.deepEqual(page.diagrams.map(d => d.placement), [fen]);
  // an opening's board: rows of pieces only, no empty square in them, are rows of it too
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  const opening = fontRows(start, 'tex').map((r, i) => item(r, 94, 400 - i * 14, { height: 14, width: 112, fontName: 'skak' }));
  assert.deepEqual(pageText({ items: opening }, viewport).diagrams.map(d => d.placement), [start]);
});

test('a PDF page’s pictures: where it draws them, and the ones shaped like a diagram (one cut in strips joined)', () => {
  const OPS = { save: 1, restore: 2, transform: 3, paintFormXObjectBegin: 4, paintFormXObjectEnd: 5, paintImageXObject: 6, paintInlineImageXObject: 7, paintImageMaskXObject: 8 };
  const viewport = { width: 600, height: 800, convertToViewportPoint: (x, y) => [x, 800 - y] };
  const ops = { fnArray: [], argsArray: [] };
  const op = (fn, args = []) => {
    ops.fnArray.push(fn);
    ops.argsArray.push(args);
  };
  const picture = (matrix, paint) => {
    op(OPS.save);
    op(OPS.transform, matrix);
    paint();
    op(OPS.restore);
  };
  // a diagram: a picture 240 points square, its corner at (60, 480)
  picture([240, 0, 0, 240, 60, 480], () => op(OPS.paintImageXObject, ['img1', 800, 800]));
  // one in a form moved right, cut in three strips one under the other
  op(OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 300, 0], [0, 0, 240, 240]]);
  for (const k of [0, 1, 2]) picture([240, 0, 0, 80, 0, 400 - k * 80], () => op(OPS.paintImageXObject, [`strip${k}`, 600, 200]));
  op(OPS.paintFormXObjectEnd);
  // not diagrams: a photo across the page, a figurine in a line of text
  picture([560, 0, 0, 200, 20, 40], () => op(OPS.paintImageXObject, ['photo', 1400, 500]));
  picture([9, 0, 0, 9, 100, 300], () => op(OPS.paintInlineImageXObject, [{ width: 24, height: 24 }]));
  const pictures = pictureBoxes(ops, OPS, viewport);
  assert.deepEqual(pictures[0], { box: [0.1, 0.1, 0.5, 0.4], w: 800, h: 800 });
  assert.equal(pictures.length, 6);
  assert.deepEqual(diagramShaped(pictures, viewport), [[0.1, 0.1, 0.5, 0.4], [0.5, 0.4, 0.9, 0.7]]);
});

/** A unit (a page) with diagrams, followed by a book's moves; returns the unit. */
function follow(book, text, diagrams = []) {
  const moves = findMoves(text);
  const unit = { text, moves, sentences: findSentences(text, moves), diagrams: diagrams.map((d, index) => ({ kind: 'diagram', index, ...d })) };
  book.follow(unit);
  for (const s of unit.sentences) s.parts = spokenParts(text, s, moves, m => !!m.node, unit.diagrams);
  return unit;
}

test('the board follows the diagrams: a game from one, its side and move number, a known position, a misread square', () => {
  const book = new BookMoves();
  // a diagram with its side to move: the moves after it are played from its position, numbered as the text says
  let u = follow(book, 'Exercise 1\n\n63...a3?? 64.Nf3 Ka1', [{ at: 12, placement: '8/8/8/8/p6N/8/k1K5/8', side: 'b', font: true }]);
  assert.equal(u.diagrams[0].node.fen, '8/8/8/8/p6N/8/k1K5/8 b - - 0 63');
  assert.deepEqual(u.moves.map(m => !!m.node && m.tree === u.diagrams[0].tree), [true, true, true]);
  // no mark: the side to move from the first move after it, Black's here
  u = follow(book, 'Next\n\n1...Kh8 2.Qf8#', [{ at: 6, placement: '6k1/8/8/8/8/8/5Q2/6K1', font: true }]);
  assert.equal(u.diagrams[0].node.fen, '6k1/8/8/8/8/8/5Q2/6K1 b - - 0 1');
  assert.ok(u.moves.every(m => m.node));
  // a diagram at the end of a page, its moves on the next: its move number and side to move are theirs
  const pages = new BookMoves();
  const end = follow(pages, 'Exercise 42\n\n', [{ at: 13, placement: '8/8/8/8/2Rk4/8/8/4K3', font: true }]);
  const next = follow(pages, '44...Kxc4 45.Ke2 Kd4');
  assert.equal(end.diagrams[0].node.fen, '8/8/8/8/2Rk4/8/8/4K3 b - - 0 44');
  assert.ok(next.moves.every(m => m.node && m.tree === end.diagrams[0].tree));
  // the position the text just reached: the same game goes on (whatever the move after it says)
  u = follow(book, '1.e4 e5 2.Nf3 Nc6\n\nNow 3.Bb5 is the Spanish.', [{ at: 18, placement: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R', font: true }]);
  assert.equal(u.diagrams[0].node, u.moves[3].node);
  assert.equal(u.moves[4].node.parent, u.moves[3].node);
  // a picture read with a square wrong (a bishop taken for a pawn on f4): the move after it puts it right
  u = follow(book, '1.Bg5+ Kc8', [{ at: 0, placement: '3k4/8/3K4/8/5P2/8/8/7B', alts: [{ sq: 37, options: ['P', 'B', '.'] }] }]);
  assert.equal(u.diagrams[0].node.fen.split(' ')[0], '3k4/8/3K4/8/5B2/8/8/7B');
  assert.ok(u.moves.every(m => m.node));
  // what the voice says: the board shows the diagram before the moves after it
  u = follow(book, 'Look at this.\n\nWhite wins: 1.Kf2 Kg7 2.Kf3.', [{ at: 15, placement: '6k1/8/8/8/8/8/4p3/6K1', side: 'w', font: true }]);
  const parts = u.sentences.flatMap(s => s.parts);
  assert.deepEqual(parts.map(p => [p.text, p.move, p.diagram]), [
    ['Look at this.', null, undefined],
    ['', null, 0],
    ['White wins: 1. king to f2', 0, undefined],
    ['king to g7', 1, undefined],
    ['2. king to f3', 2, undefined],
  ]);
});

test('the board follows the diagrams: the side the book marks, a caption, the position just read, the other side’s what-if, a puzzle’s solution far after it', () => {
  // the side to move as books mark it: on a line of its own, under the diagram's number, a scan's "w" over it, a
  // caption, before the first move — not two captions on one line, nor words in a sentence
  assert.equal(sideMarked('Kasparian 1946\n', '\n\n\n9-63\nW\nFor the time being'), 'w');
  assert.equal(sideMarked('', '\n1-36\n1/5\nB?\nThe correspondence'), 'b');
  assert.equal(sideMarked('in the next there are seven.\nw\n', 'This position arose'), 'w');
  assert.equal(sideMarked('', '\nDIAGRAM 14. White to play\nSpassky'), 'w');
  assert.equal(sideMarked('', '\nDIAGRAM 14. White to play DIAGRAM 15. Black to play\n'), null);
  assert.equal(sideMarked('', '\n10-11\nB?23...Ke4 24.Nxf6+'), 'b');
  assert.equal(sideMarked('', '\nWe have reached the reciprocal zugzwang: Black to move loses here.'), null);
  // a W under the diagram, though the moves after it begin with Black's: what would happen if Black were to move,
  // a game of its own; then White's moves, back in the diagram's game
  let book = new BookMoves();
  let u = follow(book, 'A study.\nW\nIf Black were to move, 1...Kb8 2.Rh8# would follow. Here 1.Kc6 Kb8 2.Rh8+ Ka7 3.Kc7 wins.', [{ at: 9, placement: 'k7/8/1K6/8/8/8/8/7R', font: true }]);
  const study = u.diagrams[0];
  assert.equal(study.node.fen, 'k7/8/1K6/8/8/8/8/7R w - - 0 1');
  assert.equal(u.moves[0].tree.root.fen, 'k7/8/1K6/8/8/8/8/7R b - - 0 1');
  assert.ok(posFromFen(u.moves[1].node.fen).isCheckmate());
  assert.deepEqual([u.moves[2].tree, u.moves[2].node.parent], [study.tree, study.node]);
  assert.ok(u.moves.every(m => m.node && !m.shown));
  // the what-if after White's line: from the diagram's position, the first of its game
  u = follow(new BookMoves(), 'A study.\nW\nHere 1.Kc7 Ka7 2.Ra1+ wins. With Black to move, 1...Kb8 2.Rh8# would follow.', [{ at: 9, placement: 'k7/8/1K6/8/8/8/8/7R', font: true }]);
  assert.equal(u.moves[3].tree.root.fen, 'k7/8/1K6/8/8/8/8/7R b - - 0 1');
  assert.ok(u.moves.every(m => m.node && !m.shown));
  // a caption under the diagram, "Position after: 2... Nc6": the move that led to it, said again; the game goes on
  // from it with White to move
  book = new BookMoves();
  const ruy = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R';
  u = follow(book, 'After the second moves:\nPosition after: 2... Nc6\n3. Bb5 a6 4. Ba4', [{ at: 24, placement: ruy, font: true }]);
  assert.equal(u.diagrams[0].node.fen, `${ruy} w KQkq - 0 3`);
  assert.deepEqual([u.moves[0].restated, u.moves[0].node], [true, u.diagrams[0].node]);
  assert.equal(u.moves[1].node.parent, u.diagrams[0].node);
  assert.ok(u.moves.slice(1).every(m => m.node && !m.shown));
  // the position the text just reached: the same game, though the words after it say "Black to move"
  book = new BookMoves();
  u = follow(book, "1.e4 e5 2.Nf3 Nc6\nBlack to move would play 3...a6 here, but it is White's move: 3.Bb5 a6", [{ at: 18, placement: ruy, font: true }]);
  assert.equal(u.diagrams[0].node, u.moves[3].node);
  assert.equal(u.moves.find(m => m.san === 'Bb5').node.parent, u.moves[3].node);
  // puzzles numbered over their diagrams, their solutions far after them: each from its own diagram (Black's too,
  // whose side to move was a guess) — "1 1.Rd8#" is puzzle 1's first move, not an 11th
  book = new BookMoves();
  const puzzles = follow(book, 'Mate in one\n1\n\n2\n', [
    { at: 14, placement: '6k1/5ppp/8/8/8/8/5PPP/3R2K1', font: true },
    { at: 17, placement: '3r2k1/5ppp/8/8/8/8/5PPP/6K1', font: true },
  ]);
  u = follow(book, 'Solutions\n1 1.Rd8#\n2 1...Rd1#\n');
  assert.deepEqual(
    u.moves.map(m => [m.num, m.side, m.node.parent, m.tree]),
    puzzles.diagrams.map((d, i) => [1, i ? 'black' : 'white', d.node, d.tree]),
  );
  assert.ok(u.moves.every(m => posFromFen(m.node.fen).isCheckmate()));
});

test('the board follows the diagrams: a caption on the next page; a game from the start after a diagram that looked like one', () => {
  // a diagram at the end of a page, "My last move was 1...Qc7" on the next: the move that led to it — the game goes on
  // from the diagram with White to move
  let book = new BookMoves();
  const end = follow(book, 'Test 1.\n', [{ at: 8, placement: '6k1/2q5/8/8/8/8/5PPP/6K1', font: true }]);
  let u = follow(book, 'My last move was 1...Qc7, attacking the pawn. After 2.g3 Qc6 3.h4 the game is level.');
  assert.equal(end.diagrams[0].node.fen, '6k1/2q5/8/8/8/8/5PPP/6K1 w - - 0 2');
  assert.deepEqual([u.moves[0].restated, u.moves[0].node], [true, end.diagrams[0].node]);
  assert.ok(u.moves.slice(1).every(m => m.node && m.tree === end.diagrams[0].tree));
  // an opening's diagram with nothing after it (its side and number a guess), another game (one the diagram has no
  // h-pawns for), then "After 1.c4 c5 …": a game from the initial position — not the diagram's, where its moves can be
  // played too
  book = new BookMoves();
  follow(book, 'The structure:\n', [{ at: 15, placement: 'rnbqkbnr/ppppppp1/8/8/8/8/PPPPPPP1/RNBQKBNR', font: true }]);
  follow(book, '1.h4 h5 2.d4 d5');
  u = follow(book, 'After 1.c4 c5 2.b3 Nf6 3.Bb2 g6 the game is a different one.');
  assert.ok(u.moves.every(m => m.node && m.tree.isStandardStart));
});

test('a scanned page: its words from the OCR, in lines and paragraphs, without the running head, the folio and the labels of a diagram', () => {
  const W = 1000;
  const H = 1500;
  let x = 0;
  const word = (text, y, x0 = (x += 60) - 60, confidence = 90) => ({ text, confidence, bbox: { x0, y0: y, x1: x0 + 50, y1: y + 24 } });
  const line = (y, ...words) => {
    x = 100;
    const ws = words.map(w => word(w, y));
    return { words: ws, bbox: { x0: 100, y0: y, x1: x, y1: y + 24 } };
  };
  const data = {
    blocks: [
      { paragraphs: [{ lines: [line(60, '12', 'THE', 'CHESS', 'PRIMER.')] }] },
      { paragraphs: [{ lines: [line(200, 'The', 'following', 'position'), line(232, 'arose', 'in', 'a', 'game:')] }] },
      { paragraphs: [{ lines: [line(300, 'BLACK.')] }] },
      { paragraphs: [{ lines: [line(820, 'WHITE.')] }] },
      { paragraphs: [{ lines: [line(900, '1.e4', 'e5', '2.Nf3', 'Nc6.')] }] },
      { paragraphs: [{ lines: [line(1400, 'Digitized', 'by', 'Google')] }, { lines: [line(1440, '12')] }] },
    ],
  };
  const boards = [{ x: 100, y: 340, width: 440, height: 440, board: { rows: 8, cols: 8, cells: [] } }];
  const page = ocrText(data, { width: W, height: H, boards });
  assert.equal(page.text, 'The following position\narose in a game:\n\n1.e4 e5 2.Nf3 Nc6.');
  assert.equal(page.items.length, 11);
  assert.deepEqual(page.items[0], { start: 0, end: 3, box: [0.1, 0.1333, 0.15, 0.1493] });
  // the board goes before the first line under it, with what is on its squares
  assert.equal(page.diagrams.length, 1);
  assert.equal(page.diagrams[0].at, page.text.indexOf('1.e4'));
  assert.deepEqual(page.diagrams[0].box, [0.1, 0.2267, 0.54, 0.52]);
  assert.equal(page.diagrams[0].board, boards[0].board);
});

test('moves read by OCR: digits read as letters put right by the position, words left as words', () => {
  const book = new BookMoves();
  const text = 'It was as good as that, ha! A bad idea.\n\n1 ed e5 2 fa exfa 3 Nf3 g5 4 Bc4 g4 5 0-0 gxf3 6 Qxf3 Qfé 7 e5 Qxe5 8 d3 Bh6\n\nNow 9 Ncs is met by ...Ne7 and 9 Bxfa by ...Bxf4.';
  const u = follow(book, text);
  const ocr = { text, moves: findMoves(text, { ocr: true }) };
  assert.deepEqual(u.moves.map(m => m.san), ['e5', 'Nf3', 'g5', 'Bc4', 'g4', 'O-O', 'gxf3', 'Qxf3', 'e5', 'Qxe5', 'd3', 'Bh6', 'Ne7', 'Bxf4'], 'without OCR: only what is written as moves');
  new BookMoves().follow(Object.assign(ocr, { sentences: findSentences(text, ocr.moves) }));
  assert.deepEqual(
    ocr.moves.map(m => `${m.san}${m.node ? '' : '✗'}`),
    ['e4', 'e5', 'f4', 'exf4', 'Nf3', 'g5', 'Bc4', 'g4', 'O-O', 'gxf3', 'Qxf3', 'Qf6', 'e5', 'Qxe5', 'd3', 'Bh6', 'Nc5✗', 'Ne7', 'Bxf4', 'Bxf4'],
  );
  // what the voice says: the move played, and the word as it is written for a word that is no move there
  assert.deepEqual(ocr.moves.slice(0, 4).map(m => m.words), ['1. e4', 'e5', '2. f4', 'e takes f4']);
  assert.equal(ocr.moves[11].words, 'queen to f6');
  assert.equal(ocr.moves[16].words, '9 Ncs');
});

test('boards in a picture: found by their hatching, read by the book’s own pieces (or a font’s), kept in few bytes', () => {
  const page = blankPage(1300, 1900);
  const fens = ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R', '6k1/5ppp/8/8/8/8/1Q3PPP/6K1'];
  drawBoard(page, 120, 100, 56, fens[0]);
  drawBoard(page, 120, 700, 56, fens[1]);
  drawBoard(page, 700, 1300, 50, fens[2]);
  const found = findBoards(page);
  assert.equal(found.length, 3);
  for (const [i, [x, y, size]] of [[120, 100, 56], [120, 700, 56], [700, 1300, 50]].entries()) {
    assert.ok(Math.abs(found[i].x - x) < 6 && Math.abs(found[i].y - y) < 6 && Math.abs(found[i].width - size * 8) < 12, `board ${i}: ${found[i].x},${found[i].y} ${found[i].width}`);
    assert.deepEqual([found[i].rows, found[i].cols], [8, 8]);
  }
  // (as kept with the page: the pieces' silhouettes in bytes)
  const boards = found.map(packBoard).map(p => unpackBoard(JSON.parse(JSON.stringify(p))));
  // the start position teaches the pieces; the other boards are read by them
  readBoards(boards);
  assert.deepEqual(boards.map(placement), fens);
  // no start position in the book (yet): a chess font's pieces to start from
  const later = found.slice(1).map(packBoard).map(unpackBoard);
  readBoards(later, { examples: pieceSquares(64).map(p => pieceExample(p.type, p.img)) });
  assert.deepEqual(later.map(placement), fens.slice(1));
});

test('an EPUB’s pictures: a whole board found — plain grey or coloured squares, or hatched — and read; other pictures are none', () => {
  const fens = ['r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R', '6k1/5ppp/8/8/8/8/1Q3PPP/6K1', '8/8/4k3/8/2R5/8/4K3/8'];
  const pictures = [];
  // grey squares, a margin and a frame around the board
  let img = blankPage(470, 480);
  drawPlainBoard(img, 30, 34, 52, fens[0]);
  pictures.push({ img, at: [30, 34, 52], hatched: false });
  // dark squares of a darker colour (a green's grey), the board filling the picture
  img = blankPage(400, 400);
  drawPlainBoard(img, 4, 4, 49, fens[1], { dark: 118, light: 225 });
  pictures.push({ img, at: [4, 4, 49], hatched: false });
  // an old book's board, scanned: hatched
  img = blankPage(520, 510);
  drawBoard(img, 20, 18, 60, fens[2]);
  pictures.push({ img, at: [20, 18, 60], hatched: true });
  const boards = pictures.map(({ img, at: [x, y, size], hatched }, i) => {
    const b = findPictureBoard(img);
    assert.ok(b, `picture ${i}: a board`);
    assert.ok(Math.abs(b.x - x) < 6 && Math.abs(b.y - y) < 6 && Math.abs(b.width - size * 8) < 12, `picture ${i}: ${b.x},${b.y} ${b.width}`);
    assert.equal(b.hatched, hatched, `picture ${i}: hatched`);
    return unpackBoard(JSON.parse(JSON.stringify(packBoard(b))));
  });
  readBoards(boards, { examples: pieceSquares(64).map(p => pieceExample(p.type, p.img)) });
  assert.deepEqual(boards.map(placement), fens);
  // not boards: a cover (a picture with a frame and text-like lines), a photo-like gradient, a grid of lines
  const cover = blankPage(300, 400);
  for (let y = 0; y < 400; y++) for (let x = 0; x < 300; x++) cover.data[y * 300 + x] = x < 6 || x > 293 || y < 6 || y > 393 ? 0 : (y % 40 < 10 && x > 40 && x < 260 && (x * 7) % 23 < 15 ? 30 : 250);
  const photo = blankPage(320, 320);
  for (let y = 0; y < 320; y++) for (let x = 0; x < 320; x++) photo.data[y * 320 + x] = Math.round(128 + 100 * Math.sin(x / 23) * Math.cos(y / 31));
  const grid = blankPage(320, 320);
  for (let y = 0; y < 320; y++) for (let x = 0; x < 320; x++) grid.data[y * 320 + x] = x % 40 < 2 || y % 40 < 2 ? 0 : 255;
  for (const [name, p] of Object.entries({ cover, photo, grid })) assert.equal(findPictureBoard(p), null, name);
});

test('a side without its king gets the piece most like one (its colour misread on a dark square)', () => {
  // a white king on a dark square drawn black: read as Black's — but Black has its king, White none
  const img = blankPage(420, 420);
  drawPlainBoard(img, 10, 10, 50, '4k3/8/8/8/8/8/8/R3k3');
  const b = unpackBoard(JSON.parse(JSON.stringify(packBoard(findPictureBoard(img)))));
  readBoards([b], { examples: pieceSquares(64).map(p => pieceExample(p.type, p.img)) });
  assert.equal(placement(b), '4k3/8/8/8/8/8/8/R3K3');
});

// A book's squares as cellShape makes them, without a picture: each piece's silhouette (the test pieces' shapes), its
// area and height, its colour's fill (white: `white`, black: 0.95), on its square's colour.
const PIECES = Object.fromEntries(pieceSquares(64).map(p => [p.type, pieceExample(p.type, p.img).silhouette]));
function squaresOf(fen, { white = {}, shapes = {} } = {}) {
  const rows = fen.split('/').map(r => r.replace(/\d/g, d => '.'.repeat(Number(d))));
  const cells = rows.map((row, r) =>
    [...row].map((ch, c) => {
      const darkSquare = (r + c) % 2 === 1;
      if (ch === '.') return { darkSquare, shape: { silhouette: new Float32Array(CELL * CELL), area: 0, height: 0, fill: 0, ink: 0 } };
      const s = shapes[`${'abcdefgh'[c]}${8 - r}`] || PIECES[ch.toLowerCase()];
      const area = s.reduce((n, v) => n + v, 0) / s.length;
      const rowsInked = [...Array(CELL).keys()].filter(y => s.slice(y * CELL, y * CELL + CELL).some(v => v > 0.5));
      const isWhite = ch !== ch.toLowerCase();
      return { darkSquare, shape: { silhouette: s, area, height: (rowsInked.at(-1) - rowsInked[0] + 1) / CELL, fill: isWhite ? (white[ch.toLowerCase()] ?? 0.3) : 0.95, ink: area } };
    }),
  );
  return { cells, rows: 8, cols: 8 };
}

test('a book’s own pieces: pawns told from bishops by their shapes, each piece’s colours by its own ink, at most a game’s pieces a side', () => {
  // a font whose pawn and bishop look alike (the same example for both); the book's white bishops much inked (a
  // window in them, as in Kotov's): its pawns and bishops fall in two groups by their shapes, its white bishops are
  // white by the bishops' own ink (two black bishops a side at most)
  const blob = PIECES.p.map((v, i) => (v + PIECES.b[i]) / 2);
  const examples = [...['p', 'b'].map(type => ({ type, silhouette: blob })), ...['n', 'r', 'q', 'k'].map(type => ({ type, silhouette: PIECES[type] }))];
  const fens = [
    'r1b1k3/pp3ppp/2n5/8/8/2N5/PP3PPP/R1B1K3',
    '2b1kb2/p4ppp/1p6/8/8/1P6/P4PPP/2B1KB2',
    '4kb2/pp3pp1/7p/8/8/7P/PP3PP1/4KB2',
    '2b1k3/pp2pp2/8/8/8/8/PP2PP2/2B1K3',
    '3k1b2/1pp2p2/8/8/8/8/1PP2P2/3K1B2',
    'r3k3/1b3ppp/8/8/8/8/1B3PPP/R3K3',
  ];
  let boards = fens.map(fen => squaresOf(fen, { white: { b: 0.82 } }));
  readBoards(boards, { examples });
  assert.deepEqual(boards.map(placement), fens);
  // a book that has the start of a game (its own pieces the examples): a white pawn drawn much like its bishops (a
  // hatched square grows a piece's outline) is read as a bishop — but White has its two
  const swollen = PIECES.b.map((v, i) => 0.6 * v + 0.4 * PIECES.p[i]);
  boards = [squaresOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'), squaresOf('4k3/8/8/8/8/2BB4/3P4/4K3', { shapes: { d2: swollen } })];
  readBoards(boards, { examples: [] });
  assert.equal(placement(boards[1]), '4k3/8/8/8/8/2BB4/3P4/4K3');
});

test('a picture’s board with what books put around and on it: coordinates, a move’s squares coloured, coloured dark squares, faint ones', () => {
  const examples = pieceSquares(64).map(p => pieceExample(p.type, p.img));
  const pictures = [
    // its coordinates beside and under it
    { fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R', coords: true },
    // the last move's squares coloured, darker than the dark squares (the ink of the pawn on one darker still)
    { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR', marks: { e2: [140, 160], e4: [120, 160] } },
    // dark squares of a colour (a green), light ones a pale one
    { fen: '6k1/5ppp/8/8/8/8/1Q3PPP/6K1', dark: 140, light: 236, darkSat: 110, lightSat: 30 },
    // faint squares
    { fen: 'r4rk1/1pp2ppp/p1n5/3q4/3P4/2P2N2/P4PPP/R2Q1RK1', dark: 222, light: 252 },
  ];
  const boards = pictures.map(({ fen, coords, ...opts }, i) => {
    const img = blankPage(480, 480, { sat: true });
    drawPlainBoard(img, 40, 16, 52, fen, opts);
    if (coords) drawCoordinates(img, 40, 16, 52);
    const b = findPictureBoard(img);
    assert.ok(b, `picture ${i}: a board`);
    assert.ok(Math.abs(b.x - 40) < 6 && Math.abs(b.y - 16) < 6 && Math.abs(b.width - 416) < 12, `picture ${i}: ${b.x},${b.y} ${b.width}`);
    return unpackBoard(JSON.parse(JSON.stringify(packBoard(b))));
  });
  readBoards(boards, { examples });
  assert.deepEqual(boards.map(placement), pictures.map(p => p.fen));
  // (a picture's saturation, from its colours: none for a grey, all for a pure colour)
  const g = grayFrom(Uint8ClampedArray.from([128, 128, 128, 255, 255, 0, 0, 255, 240, 217, 181, 255]), 3, 1);
  assert.deepEqual([[...g.data], [...g.sat]], [[128, 76, 219], [0, 255, 63]]);
});

test('a scanned page’s boards: in a frame, whatever its squares, and hatched — each once; a figure’s board on a page of text', () => {
  const examples = pieceSquares(64).map(p => pieceExample(p.type, p.img));
  const fens = ['r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R', '8/8/4k3/8/2R5/8/4K3/8'];
  const page = blankPage(1100, 1500);
  drawText(page, 80, 60, 940, 8);
  drawPlainBoard(page, 150, 300, 50, fens[0]);
  drawText(page, 80, 760, 940, 4);
  drawBoard(page, 600, 900, 50, fens[1]);
  drawText(page, 80, 1340, 940, 5);
  const at = (b, x, y) => Math.abs(b.x - x) < 6 && Math.abs(b.y - y) < 6 && Math.abs(b.width - 400) < 12;
  const scan = findFigureBoards(page, [], { whole: true });
  assert.equal(scan.length, 2, scan.map(b => `${b.x},${b.y} ${b.width}`).join(' | '));
  assert.ok(at(scan[0], 150, 300) && at(scan[1], 600, 900), scan.map(b => `${b.x},${b.y} ${b.width}`).join(' | '));
  const boards = scan.map(packBoard).map(unpackBoard);
  readBoards(boards, { examples });
  assert.deepEqual(boards.map(placement), fens);
  // a PDF's figure (where the page draws a picture): its board, and nothing else looked for on the page — unless a
  // figure shows none
  const figure = [140 / 1100, 290 / 1500, 560 / 1100, 710 / 1500];
  const found = findFigureBoards(page, [figure], { whole: false });
  assert.equal(found.length, 1);
  assert.ok(at(found[0], 150, 300));
  assert.equal(findFigureBoards(page, [figure, [0.05, 0.03, 0.95, 0.15]], { whole: false }).length, 2);
});

// Tesseract's lines (one block, as it reads a page): each word with its box.
const ocrLine = (y, ...spans) => {
  const words = spans.flatMap(([x0, x1, text]) => {
    const parts = text.split(' ');
    const w = (x1 - x0) / parts.length;
    return parts.map((t, k) => ({ text: t, confidence: 90, bbox: { x0: Math.round(x0 + k * w), y0: y, x1: Math.round(x0 + (k + 1) * w - 8), y1: y + 18 } }));
  });
  return { words, bbox: { x0: words[0].bbox.x0, y0: y, x1: words.at(-1).bbox.x1, y1: y + 18 } };
};

test('a scanned page in two columns: the left column read before the right one; a table of moves in two columns and a centred head are read across', () => {
  const left = ['The knight on f6 has to move or', 'be defended before White plays', 'his queen to the long diagonal,', 'and after that the attack on', 'the king will be very hard to', 'meet: Black needs a plan now.'];
  const right = ['and the bishop comes to e6 at', 'once, with the idea of taking', 'on d5 when the white knight', 'arrives there. Then the black', 'rooks will be ready for the', 'open c-file and the pressure.'];
  const lines = [ocrLine(40, [330, 410, 'Chapter'], [418, 470, 'Two'])];
  left.forEach((t, i) => lines.push(ocrLine(100 + i * 30, [50, 395, t], [430, 770, right[i]])));
  const page = ocrText({ blocks: [{ paragraphs: [{ lines }] }] }, { width: 800, height: 1200 });
  // (the columns a paragraph after the head; the right column goes on with the left one's sentence: it begins with a
  // small letter)
  assert.equal(page.text, `Chapter Two\n\n${left.join('\n')}\n${right.join('\n')}`);
  // the same lines in Tesseract's order, read across: the two columns' lines one after the other, mixed
  const across = ocrText({ blocks: [{ paragraphs: [{ lines: lines.map(l => ({ ...l, words: l.words.map(w => ({ ...w, bbox: { ...w.bbox, x0: w.bbox.x0 / 3, x1: w.bbox.x1 / 3 } })) })) }] }] }, { width: 800, height: 1200 });
  assert.ok(across.text.includes(`${left[0]} ${right[0]}`), 'one column: read across');
  // a page of two pages side by side: the same; a table of moves (White's and Black's in columns): line by line
  const moves = [['1 P to K 4', '1 P to Q B 4'], ['2 Kt to K B 3', '2 P to K 3'], ['3 Kt to Q B 3', '3 P to Q R 3'], ['4 P to Q R 4', '4 Kt to Q B 3'], ['5 P to Q 4', '5 P takes P'], ['6 Kt takes P', '6 B to Kt 5']];
  const table = moves.map(([w, b], i) => ocrLine(100 + i * 30, [60, 60 + 14 * w.length, w], [430, 430 + 14 * b.length, b]));
  assert.equal(ocrText({ blocks: [{ paragraphs: [{ lines: table }] }] }, { width: 800, height: 1200 }).text, moves.map(m => m.join(' ')).join('\n'));
});

test('a picture read with squares wrong in a game: the game’s position, when the moves after it go on from there; it teaches the book’s pieces', () => {
  const book = new BookMoves();
  // after 3...a6 (the bishop on b5 read as a pawn, the knight on c6 as a king, a pawn on h7 lost): the game's position
  const misread = 'r1bqkbnr/1ppp1pp1/p1k5/1P2p3/4P3/5N2/PPPP1PPP/RNBQK2R';
  const u = follow(book, '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6\n\nThe Ruy Lopez.\n\n4.Ba4 Nf6 5.O-O Be7', [{ at: 27, placement: misread }]);
  const [d] = u.diagrams;
  assert.equal(d.node, u.moves[5].node, 'the position after 3...a6');
  assert.equal(d.known, 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R');
  assert.ok(u.moves.slice(6).every(m => m.node && m.tree === d.tree && !m.shown));
  // the same picture in a book whose moves after it do not go on from the game: a game of its own from it
  const other = new BookMoves();
  const v = follow(other, '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6\n\nAnother position.\n\n1.Kd1', [{ at: 27, placement: '4k3/8/8/8/8/8/8/4K3', side: 'w' }]);
  assert.equal(v.diagrams[0].known, null);
  assert.notEqual(v.diagrams[0].tree, v.moves[0].tree);
});

test('the positions known of some boards teach the book’s pieces: a rook drawn like no piece of the font is read as a rook', () => {
  // the book's rook: the font's knight turned round
  const rook = Float32Array.from({ length: CELL * CELL }, (_, i) => PIECES.n[Math.floor(i / CELL) * CELL + (CELL - 1 - (i % CELL))]);
  const fens = ['r3k3/8/8/8/8/8/8/4K2R', '4k2r/8/8/8/2n5/8/8/R3K3', '1r2k3/8/8/8/8/8/8/2R1K1N1'];
  const at = { 0: ['a8', 'h1'], 1: ['h8', 'a1'], 2: ['b8', 'c1'] };
  const boards = () => fens.map((f, i) => squaresOf(f, { shapes: Object.fromEntries(at[i].map(sq => [sq, rook])) }));
  const examples = pieceSquares(64).map(p => pieceExample(p.type, p.img));
  const unknown = boards();
  readBoards(unknown, { examples });
  assert.notDeepEqual(unknown.map(placement), fens, 'not read by the font alone');
  const taught = boards();
  readBoards(taught, { examples, labels: [fens[0], null, null] });
  assert.deepEqual(taught.map(placement), fens);
});

test('a known position of another moment of its game teaches nothing where its picture plainly shows another piece: a pawn labelled a bishop', () => {
  // a pawn on a hatched square come out a little like a bishop, on two boards: on one of them, the last known, the line
  // read's position — some moves on from the picture's — has a white bishop there (no other white bishop known on a
  // dark square to be unlike); the other is not known
  const pawn = PIECES.p.map((v, i) => 0.75 * v + 0.25 * PIECES.b[i]);
  const fens = ['4k3/pp1b1ppp/8/8/8/8/PP1B1PPP/4K3', '2b1k3/1pp2pp1/8/8/8/8/1PP2PP1/2B1K3', '4kb2/p1p2p1p/8/8/8/8/P1P2P1P/4KB2', '3bk3/pp4pp/8/8/8/8/PP4PP/3BK3'];
  const boards = () => [...fens.map(f => squaresOf(f)), squaresOf('4k3/8/8/8/8/6P1/8/4K3', { shapes: { g3: pawn } }), squaresOf('4k3/8/8/8/8/8/1P6/4K3', { shapes: { b2: pawn } })];
  const examples = pieceSquares(64).map(p => pieceExample(p.type, p.img));
  const read = boards();
  readBoards(read, { examples, labels: [...fens, '4k3/8/8/8/8/6B1/8/4K3', null] });
  assert.equal(placement(read[5]), '4k3/8/8/8/8/8/1P6/4K3');
});

test('OCR: ¢ for e (or c), € for e — the board plays the reading that is legal', () => {
  const book = new BookMoves();
  const text = 'White has just played 2.e6.\n\n2...fx¢6 3.Kd1 €5';
  const u = { text, moves: findMoves(text, { ocr: true }), diagrams: [{ kind: 'diagram', index: 0, at: 0, placement: '4k3/5p2/4P3/8/8/8/8/4K3', side: 'b', font: true }] };
  u.sentences = findSentences(text, u.moves);
  book.follow(u);
  // (2.e6 in the sentence is the move that led to the diagram)
  assert.deepEqual(u.moves.map(m => `${m.san}${m.node ? '' : '✗'}`), ['e6', 'fxe6', 'Kd1', 'e5']);
  assert.equal(u.moves[3].node.fen.split(' ')[0], '4k3/8/8/4p3/8/8/8/3K4');
});

// A board in a symbol font as The Woodpecker Method sets it: the font's characters in Unicode's private use area (its
// code plus F000), each row a border glyph with its rank ("À"…"Ç"), the squares (an Alpha's: small letters on light
// squares, capitals on dark ones, "+" the empty dark square) and the right border ("5"); an empty light square is a
// space, which pdf.js gives as an item of its own a point wide; a frame row over and under it; the side to move a
// triangle in another font, by the top row (Black, U+F071) or the bottom one (White, U+F072).
function woodpeckerBoard(fen, x0, top, mark) {
  const pua = s => [...s].map(ch => String.fromCharCode(0xf000 + ch.charCodeAt(0))).join('');
  const glyph = (str, x, y, w = 18) => ({ str, transform: [18, 0, 0, 18, x, y], width: w, height: 18, hasEOL: false, fontName: 'wood' });
  const eol = (x, y) => ({ str: '', transform: [18, 0, 0, 18, x, y], width: 0, height: 0, hasEOL: true, fontName: 'wood' });
  const items = [eol(x0, top + 18), glyph(pua('1222222223'), x0, top + 18, 180)];
  const alpha = { k: 'l', q: 'w', r: 't', b: 'v', n: 'm', p: 'o' };
  fen.split('/').forEach((row, r) => {
    const y = top - r * 18;
    items.push(eol(x0, y), glyph(pua(String.fromCharCode(0xc7 - r)), x0, y));
    [...row.replace(/\d/g, d => '.'.repeat(Number(d)))].forEach((p, f) => {
      const light = !((r + f) & 1);
      const x = x0 + 18 * (f + 1);
      if (p === '.') items.push(light ? { str: ' ', transform: [18, 0, 0, 18, x, y], width: 1, height: 0, hasEOL: false, fontName: 'wood' } : glyph(pua('+'), x, y));
      else {
        const ch = p === p.toLowerCase() ? alpha[p] : p.toLowerCase();
        items.push(glyph(pua(light ? ch : ch.toUpperCase()), x, y));
      }
    });
    items.push(glyph(pua('5'), x0 + 162, y));
  });
  items.push(eol(x0, top - 144), glyph(pua('7ÈÉÊËÌÍÎÏ9'), x0, top - 144, 180));
  items.push({ str: mark === 'b' ? '\uF071' : '\uF072', transform: [15, 0, 0, 15, x0 + 166, mark === 'b' ? top + 4 : top - 122], width: 14.7, height: 15, hasEOL: false, fontName: 'marks' });
  return items;
}

test('a board in a symbol font’s private use characters (The Woodpecker Method’s): its narrow spaces, frame, row of pieces, mark and number — its solution far after it', () => {
  const viewport = { width: 450, height: 700, convertToViewportPoint: (x, y) => [x, 700 - y] };
  const fens = ['3r2k1/5ppp/8/8/8/8/5PPP/6K1', '6rk/6pp/8/6N1/8/8/PPPPPPPP/4K3'];
  // (a board's number at its top left corner — a column's numbers come first in the text, then its boards)
  const number = (str, y) => ({ str, transform: [11, 0, 0, 11, 22, y], width: 6, height: 11, hasEOL: true, fontName: 'serif' });
  const items = [number('7', 595), number('8', 395), ...woodpeckerBoard(fens[0], 37.6, 588, 'b'), ...woodpeckerBoard(fens[1], 37.6, 388, 'w')];
  items.push({ str: 'Ashford – Brennan, Lisbon 1931', transform: [10, 0, 0, 10, 60, 200], width: 150, height: 10, hasEOL: true, fontName: 'serif' });
  const page = pageText({ items }, viewport);
  assert.deepEqual(
    page.diagrams.map(d => [d.placement, d.side, d.label]),
    [
      [fens[0], 'b', '7'],
      [fens[1], 'w', '8'],
    ],
  );
  // (its glyphs, frame and number are no text)
  assert.equal(page.text.trim(), 'Ashford – Brennan, Lisbon 1931');
  // the solutions, pages later: each from its own puzzle — "7. Players, place" on the line before its first move
  const book = new BookMoves();
  const puzzles = follow(book, page.text, page.diagrams.map(d => ({ ...d })));
  follow(book, 'Some other pages.\n\n1.e4 e5 2.Nf3 Nc6 3.Bb5 a6');
  const u = follow(book, 'Solutions\n7. Tom Ashford – Paul Brennan, Lisbon 1931\n30...Rd1# 0–1\n8. Paul Brennan – J. Corder, Oporto 1932\n25.Nf7#\n');
  assert.deepEqual(
    u.moves.map(m => [m.node?.parent, m.tree]),
    puzzles.diagrams.map(d => [d.node, d.tree]),
  );
  assert.ok(u.moves.every(m => posFromFen(m.node.fen).isCheckmate()));
});

test('a diagram that leaves out a king (a puzzle book’s, a beginner’s book’s): its moves played with the king put in where nothing attacks it', () => {
  // CT-Art's: the attacker's king left out — 1.Qg7# from it
  let u = follow(new BookMoves(), 'Puzzle 89\n\n1.Qg7#', [{ at: 11, placement: '7k/5p1p/5PpQ/8/8/8/8/8', font: true }]);
  const [d] = u.diagrams;
  assert.ok(d.node, 'a position');
  // (the diagram's pieces where they are, a white king more, attacked by nothing)
  assert.equal(d.node.fen.split(' ')[0].replace('K', '1').replace(/\d+/g, n => '1'.repeat([...n].reduce((s, c) => s + Number(c), 0))), '7k/5p1p/5PpQ/8/8/8/8/8'.replace(/\d+/g, n => '1'.repeat(Number(n))));
  assert.ok(!posFromFen(d.node.fen.replace(' w ', ' b ')).isCheck());
  assert.ok(posFromFen(u.moves[0].node.fen).isCheckmate());
  // (the board does not show it — the book's diagram has none —, before the moves and after them)
  const hidden = hiddenSquares(d.tree, d.node.fen);
  assert.equal(hidden.length, 1);
  assert.deepEqual(hiddenSquares(u.moves[0].tree, u.moves[0].node.fen), hidden);
  // (a king no longer on that square — moved by the book's moves — shows)
  assert.deepEqual(hiddenSquares(u.moves[0].tree, '7k/8/8/8/8/8/8/8 w - - 0 1'), []);
  // a beginner's book: no king at all — the rook's move played
  u = follow(new BookMoves(), 'The rook moves along files and ranks:\n\n1.Ra8', [{ at: 39, placement: '8/8/8/8/8/8/8/R7', font: true }]);
  assert.ok(u.diagrams[0].node && /K/.test(u.diagrams[0].node.fen) && /k/.test(u.diagrams[0].node.fen));
  assert.ok(u.moves.every(m => m.node));
  // the position the text just reached, drawn without White's king: that position
  u = follow(new BookMoves(), '1.e4 e5 2.Nf3 Nc6\n\nNow 3.Bb5 is the Spanish.', [{ at: 18, placement: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQ1B1R', font: true }]);
  assert.equal(u.diagrams[0].node, u.moves[3].node);
});

test('an ebook’s small pictures: white pieces’ thin grey outlines keep them whole; the side to move a square beside the board', () => {
  const examples = pieceSquares(64).map(p => pieceExample(p.type, p.img));
  const fens = ['r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R', '6k1/5ppp/8/3B4/8/1P6/P4PPP/2R3K1', '4k3/8/8/8/8/8/3PP3/4K3', '2r3k1/5ppp/8/8/8/1P2B3/P4PPP/2R3K1'];
  // drawn four times larger and shrunk: squares of 25 pixels, outlines half a pixel wide (grey, mostly lighter than
  // ink) — the side to move a filled square right of the top row (Black), an outline with a shadow left of it (White),
  // or none
  const pictures = fens.map((fen, i) => {
    const big = blankPage(1312, 840);
    drawPlainBoard(big, i === 1 ? 192 : 20, 20, 100, fen, { stroke: 2 });
    if (i === 0) drawMark(big, 870, 40, 72, true);
    if (i === 1) drawMark(big, 60, 40, 72, false, 4);
    return shrink(big, 4);
  });
  const boards = pictures.map((img, i) => {
    const b = findPictureBoard(img);
    assert.ok(b, `picture ${i}: a board`);
    return unpackBoard(JSON.parse(JSON.stringify(packBoard(b))));
  });
  assert.deepEqual(boards.map(b => b.side), ['b', 'w', null, null]);
  readBoards(boards, { examples });
  assert.deepEqual(boards.map(placement), fens);
  // (rank numbers beside a board's rows are no mark)
  const big = blankPage(1312, 840);
  drawPlainBoard(big, 192, 20, 100, fens[1], { stroke: 2 });
  drawCoordinates(big, 192, 20, 100);
  assert.equal(findPictureBoard(shrink(big, 4)).side, undefined);
});

test('a scan of two pages side by side, each in two columns — notes beginning with their moves too: read column by column', () => {
  const prose = ['The knight on f6 has to move or', 'be defended before White plays', 'his queen to the long diagonal,', 'and after that the attack on', 'the king will be very hard to', 'meet: Black needs a plan now.'];
  const col = k => prose.map((t, i) => (k === 1 ? t : prose[(i + k) % 6]));
  // (the second column's lines are notes, each beginning with a move)
  const notes = ['10 0-0 is much stronger than', '11 Nxe6 fxe6 12 Qh5+ Ke7 with', '13 Qg5+ Kd6 14 Nf3 and the', '15 Rad1+ wins for White, as', '16 Qxd8 shows. The text move', '17 Bd3 was hardly worse here.'];
  const columns = [col(1), notes, col(3), col(4)];
  const xs = [[50, 380], [420, 750], [850, 1180], [1220, 1550]];
  const lines = [0, 1, 2, 3, 4, 5].map(i => ocrLine(100 + i * 30, ...xs.map(([a, b], k) => [a, b, columns[k][i]])));
  const page = ocrText({ blocks: [{ paragraphs: [{ lines }] }] }, { width: 1600, height: 1200 });
  assert.equal(page.text.replace(/\n+/g, '\n'), columns.flat().join('\n'));
});

test('an ebook’s small hatched picture: its white pieces’ grey outlines keep the hatching out', () => {
  const examples = pieceSquares(64).map(p => pieceExample(p.type, p.img));
  const fens = ['2r3k1/5ppp/8/8/8/1P2B3/P4PPP/2R3K1', '6k1/5ppp/8/3B4/8/1P6/P4PPP/2R3K1', '4k3/8/8/8/8/8/3PP3/4K3'];
  // drawn three times larger and shrunk: squares of 30 pixels, strokes and outlines a pixel wide (grey where they fall
  // between pixels)
  const boards = fens.map(fen => {
    const big = blankPage(90 * 8 + 64, 90 * 8 + 64);
    drawBoard(big, 32, 32, 90, fen, { period: 10, hatch: 3, stroke: 3 });
    return unpackBoard(JSON.parse(JSON.stringify(packBoard(findPictureBoard(shrink(big, 3), { hatchWall: true })))));
  });
  readBoards(boards, { examples });
  assert.deepEqual(boards.map(placement), fens);
});

test('a scan’s text: a b-pawn’s capture written as a bishop’s, an exclamation mark read as an l — played as the position has them', () => {
  const text = '1.d4 Nf6 2.c4 e6 3.Nc3 Bb4 4.e3 Bxc3+ 5.Bxc3 d5 6.cxd5l exd5';
  const u = { text, moves: findMoves(text, { ocr: true }), diagrams: [] };
  u.sentences = findSentences(text, u.moves);
  new BookMoves().follow(u);
  assert.deepEqual(
    u.moves.map(m => `${m.san}${m.node ? '' : '✗'}`),
    ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'Bxc3', 'bxc3', 'd5', 'cxd5', 'exd5'],
  );
  // (said as played)
  assert.equal(u.moves[8].words, '5. b takes c3');
});

test('exercises, their answers pages later: each answer on the diagram where its moves go on, its move number from them', () => {
  const book = new BookMoves();
  // two exercises (their numbers drawn, not text; no move after them on their page: their move numbers guesses)
  const ex = follow(book, 'Exercises\n\nWhat is going on?\n', [
    { at: 11, placement: '6k1/5ppp/8/8/8/8/5PPP/3R2K1', side: 'w', font: true },
    { at: 11, placement: 'r5k1/5ppp/8/8/8/8/5PPP/6K1', side: 'b', font: true },
  ]);
  const u = follow(book, 'Answers\n\n1. The rook comes to the seventh: 25. Rd7 h6 26. Rd8+ Kh7.\n\n2. Black takes the second rank: 31... Ra2 32. h3 Ra1+ 33. Kh2.');
  assert.deepEqual([u.moves[0].node.parent, u.moves[4].node.parent], ex.diagrams.map(d => d.node));
  assert.deepEqual(ex.diagrams.map(d => d.node.fen.split(' ')[5]), ['25', '31']);
  assert.ok(u.moves.every(m => m.node && !m.shown));
});

test('an OCR’s figurines: its W a queen, its & a king, until the book’s moves show otherwise', () => {
  // (a queen and a knight can both go to h5, nothing after it tells which: the W's queen)
  let u = follow(new BookMoves(), 'Position:\n\n1.Wh5 Kd7', [{ at: 11, placement: '4k3/8/8/8/5N2/8/8/3QK3', side: 'w', font: true }]);
  assert.equal(u.moves[0].node?.san, 'Qh5+');
  // (the king and a rook can both go to f1)
  u = follow(new BookMoves(), 'Position:\n\n1.&f1 Kd7', [{ at: 11, placement: '4k3/8/8/8/8/8/8/4K2R', side: 'w', font: true }]);
  assert.equal(u.moves[0].node?.san, 'Kf1');
  // (a scan's commercial OCR: "l:t" its rook — a rook and a bishop can both go to d2)
  u = follow(new BookMoves(), 'Position:\n\n1.l:td2 Kd7', [{ at: 11, placement: '4k3/8/8/8/5B2/8/8/3RK3', side: 'w', font: true }]);
  assert.equal(u.moves[0].node?.san, 'Rd2');
  // a glyph the book's moves showed three times as often as any other piece, half the times — from eight of them
  const book = new BookMoves();
  book.glyphs.set('Zz', new Map([['R', 9], ['N', 3], ['B', 3]]));
  book.glyphs.set('Qq', new Map([['R', 6], ['N', 2], ['B', 2]]));
  assert.deepEqual([book.pieceOf('Zz'), book.pieceOf('Qq')], ['R', null]);
});

test('a picture’s unsure square read otherwise when more of the moves after it can be played then', () => {
  // a white rook on f1 read as a knight (a rook its next likeliest piece): 1. h3 h6 can be played as read, 2. Re1
  // only with the rook
  const u = follow(new BookMoves(), 'Later:\n\n1. h3 h6 2. Re1 Kh7', [{ at: 8, placement: '6k1/5ppp/8/8/8/8/5PPP/5NK1', alts: [{ sq: 61, options: ['N', 'R'] }] }]);
  assert.equal(u.diagrams[0].node.fen.split(' ')[0], '6k1/5ppp/8/8/8/8/5PPP/5RK1');
  assert.ok(u.moves.every(m => m.node));
});
