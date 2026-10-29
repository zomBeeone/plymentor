// The Book reader's diagrams: boards set in a chess font in a PDF's text, boards found in a scanned page's picture and
// read by the book's own pieces, a scanned page's text from its OCR, and the board following the diagrams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fontBoards, findBoards, findPictureBoard, findFigureBoards, grayFrom, packBoard, unpackBoard, readBoards, placement, pieceExample } from '../../app/js/books/diagrams.js';
import { pageText, pictureBoxes, diagramShaped } from '../../app/js/books/pdf.js';
import { ocrText } from '../../app/js/books/ocr.js';
import { findMoves, findSentences, spokenParts } from '../../app/js/books/text.js';
import { BookMoves } from '../../app/js/books/moves.js';
import { drawBoard, drawPlainBoard, drawCoordinates, drawText, blankPage, pieceSquares } from './diagram-picture.mjs';

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
