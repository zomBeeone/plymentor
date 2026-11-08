// What the coach reads of the student's books (list_books, read_book, search_books): a page as a language model needs it —
// the moves followed in plain notation, diagrams as FENs —, long chapters in parts, and finding words. The books the
// tests read are made up here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMoves } from '../../app/js/books/text.js';
import { trackMoves } from '../../app/js/books/moves.js';
import { coachText, partStarts, partAt, searchTexts, searchPages, pickBook, bookName, bookLine, contentsText, folded, PART } from '../../app/js/books/coachtext.js';
import { BOOK_TOOLS, HOST_TOOLS, TOOL_DEFS, toolDef, toolLabel, validate } from '../../shared/tools.js';
import { buildCliInstructions } from '../../shared/prompts.js';

const followed = (text, diagrams = [], options) => {
  const unit = { index: 0, text, moves: findMoves(text, options), diagrams };
  trackMoves([unit]);
  return unit;
};
const read = (text, diagrams, options) => coachText(followed(text, diagrams, options));

test('a move the book writes as it is played stays as the book writes it, its number and glyphs too', () => {
  const text = '12. Nf3 Nc6';
  assert.equal(coachText({ text, moves: [{ start: 0, end: 7, num: 12, side: 'white', written: { at: 4 }, node: { san: 'Nf3' } }, { start: 8, end: 11, written: { at: 8 }, node: { san: 'Nc6' } }], diagrams: [] }), '12. Nf3 Nc6');
  assert.equal(read('1.e4 e5 2.Nf3! Nc6?! 3.Bb5+'), '1.e4 e5 2.Nf3! Nc6?! 3.Bb5+');
});

test('moves followed to a position: in plain notation however the book writes them', () => {
  assert.equal(read('1.e4 e5 2.Ng1-f3 Nb8-c6 3.Bb5 a6 4.B:c6 dxc6'), '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Bxc6 dxc6', 'long algebraic, a colon for a capture');
  assert.equal(read('1.e4 e5 2.♘f3! ♞c6'), '1.e4 e5 2.Nf3! Nc6', 'figurines, the glyph kept');
  assert.equal(read('1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.0-0'), '1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O', 'castling with zeros');
  assert.equal(read('1. P-K4 P-K4 2. Kt-KB3 Kt-QB3'), '1. e4 e5 2. Nf3 Nc6', 'descriptive notation, its numbers kept');
  // (a move spelled out in a sentence reads well as it is)
  const said = "1.e4 e5 and then knight to f3";
  assert.equal(read(said), said);
});

test("a chess font's lost figurines and an OCR's spellings", () => {
  const glyph = '';
  const moves = [
    { start: 0, end: 6, num: 2, side: 'white', glyph, written: { at: 2 }, node: { san: 'Nf3' } }, // followed
    { start: 7, end: 11, glyph: '', written: { at: 7 }, node: null }, // not followed, but what it is was learnt
    { start: 12, end: 15, glyph: '', written: { at: 12 }, node: null }, // nothing known of it
    { start: 16, end: 20, glyph: '�', written: { at: 16 }, node: null }, // (the character for "some glyph": as it is)
  ];
  const text = `2.${glyph}f3! xb7 d4 �e5+`;
  assert.equal(moves[0].end, '2.'.length + 4);
  assert.equal(coachText({ text, moves, diagrams: [] }, { pieceOf: g => ({ '': 'R' })[g] || null }), '2.Nf3! Rxb7 ?d4 �e5+');
  // an OCR's move number
  const ocr = 'l7 .Re4 1 4.Nxe4';
  const scanned = [
    { start: 0, end: 7, num: 17, side: 'white', ocr: true, written: { at: 4 }, node: { san: 'Re4' } },
    { start: 8, end: 16, num: 14, side: 'black', cut: {}, written: { at: 12 }, node: { san: 'Nxe4' } },
  ];
  assert.equal(coachText({ text: ocr, moves: scanned, diagrams: [] }), '17.Re4 14...Nxe4');
  // a move left unfollowed stays as printed
  assert.equal(coachText({ text: 'Nf3 was possible', moves: [{ start: 0, end: 3, san: 'Nf3', written: { at: 0 }, node: null }], diagrams: [] }), 'Nf3 was possible');
});

test('a diagram at its place in the text: its FEN, and what may be wrong with it', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
  const at = (d, text = 'Before\nAfter') => coachText({ text, moves: [], diagrams: [{ at: 7, ...d }] });
  assert.equal(at({ font: true, node: { fen } }), `Before\n\n[Diagram: ${fen}]\nAfter`);
  for (const sure of [{ fixed: true }, { known: 'x' }]) assert.match(at({ ...sure, node: { fen } }), /\[Diagram: r1bq/, 'set right by the student, or found in the line read');
  assert.match(at({ node: { fen }, sure: 0.7 }), /\[Diagram, read from a picture \(a piece may be wrong\): r1bq/);
  assert.match(at({ placement: '8/8/8/8/8/8/8/8' }), /\[Diagram, read from a picture but not a legal position \(some pieces are wrong\): 8\/8\/8/);
  assert.match(at({}), /\[Diagram: its position could not be read\]/);
  // a king the reader added for a legal position
  assert.match(coachText({ text: 'x', moves: [], diagrams: [{ at: 0, font: true, node: { fen } }] }, { hidden: () => ['h1'] }), /; the book's diagram has no king on h1, the app added it\]/);
  // at the very end of the text, and among its own coordinates
  assert.match(coachText({ text: 'x', moves: [], diagrams: [{ at: 1, font: true, node: { fen } }] }), /^x\n\[Diagram/);
  const page = 'Top\na b c d e f g h\n8\n7\n6\n5\n4\n3\n2\n1\nBottom';
  assert.equal(coachText({ text: page, moves: [], diagrams: [{ at: 6, font: true, node: { fen } }] }), `Top\n\n[Diagram: ${fen}]\nBottom`);
});

test('a page tidied: words broken at lines’ ends, a board’s coordinates, what only a font knows', () => {
  const t = text => coachText({ text, moves: [], diagrams: [] });
  assert.equal(t('an iso-\nlated pawn'), 'an isolated pawn');
  assert.equal(t('the a-\npawn and g2-\ng3'), 'the a-\npawn and g2-\ng3', 'a pawn’s name, a pawn’s move');
  assert.equal(t('a b c d e f g h\nText\n8\n7\n6\n5\nmore'), 'Text\nmore');
  assert.equal(t('Only\n8\n7\nnumbers'), 'Only\n8\n7\nnumbers', 'a few short lines are not a board’s ranks');
  assert.equal(t('signs gone   \n\n\n\nand a gap'), 'signs gone\n\nand a gap');
});

test('a long chapter in parts: the moves and diagrams of each', () => {
  const line = 'Some words about the position.\n';
  const text = line.repeat(1500);
  const starts = partStarts(text);
  assert.ok(starts.length >= 2 && starts[0] === 0);
  for (const s of starts.slice(1)) assert.equal(text[s - 1], '\n', 'cut at a line’s end');
  starts.forEach((s, i) => assert.ok((starts[i + 1] ?? text.length) - s <= PART * 1.2));
  assert.deepEqual(partStarts('short'), [0]);
  assert.equal(partAt(text, 0), 1);
  assert.equal(partAt(text, 0.99), starts.length);
  const fen = '8/8/8/8/8/8/8/K1k5 w - - 0 1';
  const unit = { text, moves: [{ start: starts[1], end: starts[1] + 4, glyph: 'S', written: { at: starts[1] }, node: { san: 'Nf3' } }], diagrams: [{ at: starts[1] + 1, font: true, node: { fen } }, { at: text.length, font: true, node: { fen: 'END' } }] };
  const first = coachText(unit, { from: 0, to: starts[1] });
  assert.ok(!first.includes('Nf3') && !first.includes(fen) && !first.includes('END'), 'what is in the next parts');
  const second = coachText(unit, { from: starts[1], to: starts[2] ?? Infinity });
  assert.ok(second.startsWith('Nf3') && second.includes(fen));
  assert.ok(coachText(unit, { from: starts.at(-1) }).includes('END'), 'a diagram at the very end comes with the last part');
});

test('finding words on a book’s pages', () => {
  const items = [
    { index: 0, text: 'The rook goes behind the passed pawn.' },
    { index: 1, text: 'An iso-\nlated queen pawn on d4, and a knight far from it, and more text about a queen.' },
    { index: 2, text: 'Nothing here but words.' },
    { index: 3, text: '' },
    { index: 4, text: 'The isolated queen pawn again: an isolated queen pawn is strong in the middlegame.' },
    { index: 5, text: 'Réti played a study; a queen and an isolated pawn stood far apart from each other on this very long line of prose about nothing much at all, then some more of it.' },
  ];
  const r = searchTexts(items, 'isolated queen pawn');
  assert.deepEqual(r.hits.map(h => h.index), [4, 1, 5], 'the whole phrase first, then the closest');
  assert.equal(r.matched, 3);
  assert.equal(r.searched, 5, 'pages with text');
  assert.deepEqual(
    searchTexts([{ index: 0, text: 'pawn queen isolated pawn queen isolated pawn queen isolated' }, { index: 1, text: 'one isolated queen pawn' }], 'isolated queen pawn').hits.map(h => h.index),
    [1, 0],
    'the whole phrase before the same words more often, in another order',
  );
  assert.match(r.hits[0].snippet, /isolated queen pawn/);
  assert.match(searchTexts(items, 'isolated').hits.find(h => h.index === 1).snippet, /An isolated queen/, 'a word broken at a line’s end');
  assert.deepEqual(searchTexts(items, 'reti').hits.map(h => h.index), [5], 'accents');
  assert.deepEqual(searchTexts(items, 'RÉTI').hits.map(h => h.index), [5]);
  assert.deepEqual(searchTexts(items, 'the passed pawn of a rook').hits.map(h => h.index), [0], 'little words are not looked for');
  assert.deepEqual(searchTexts(items, '"passed pawn"').hits.map(h => h.index), [0]);
  assert.deepEqual(searchTexts(items, '"pawn passed"').hits, [], 'a phrase is that phrase');
  assert.deepEqual(searchTexts(items, 'rook bishop').hits, [], 'every word on the page');
  assert.deepEqual(searchTexts(items, '   ').hits, []);
  assert.equal(searchTexts([{ index: 0, text: 'pawn '.repeat(40) }], 'pawn', 5).hits.length, 1);
  assert.equal(searchTexts([0, 1, 2, 3].map(index => ({ index, text: 'pawn' })), 'pawn', 2).hits.length, 2, 'the best few');
  assert.equal(searchTexts([0, 1, 2, 3].map(index => ({ index, text: 'pawn' })), 'pawn', 2).matched, 4);
  const page = { index: 0, text: 'a b c d e f g h\n8\n7\n6\n5\n4\n3\n2\n1\nLong words before the pawn and words after it.' };
  assert.equal(searchTexts([page], 'pawn').hits[0].snippet, 'Long words before the pawn and words after it.', 'no coordinates, nothing only a font knows');
  // the snippet of a long page: the words around it
  const long = `${'word '.repeat(200)}pawn${' word'.repeat(200)}`;
  const s = searchTexts([{ index: 0, text: long }], 'pawn').hits[0];
  assert.match(s.snippet, /^… ?word.*pawn.*word ?…$/);
  assert.ok(s.snippet.length < 260);
  assert.ok(Math.abs(s.share - 0.5) < 0.02);
  // a PDF's pages as they are kept
  const kept = searchPages([null, { text: 'a pawn' }, { text: '', scan: true }, { text: 'a scanned pawn', scan: true, scanned: true }, { text: 'none' }], 'pawn');
  assert.deepEqual([kept.hits.map(h => h.index), kept.unread, kept.total, kept.searched], [[1, 3], 2, 5, 3]);
  assert.equal(folded('Çeşme İ Réti'.normalize('NFC')).length, 'Çeşme İ Réti'.length, 'a position in it is one in the text');
});

test('a book by its id or the words of its title', () => {
  const books = [
    { id: 'aaaaaaaaaaaaaaaaaaaa', title: 'Pawn Chains and Patient Plans', author: 'Tomas Ellery', format: 'pdf', pages: 528, at: { unit: 142, sentence: 3 }, progress: 0.27 },
    { id: 'bbbbbbbbbbbbbbbbbbbb', title: 'Rooks Behind the Lines', author: 'Tomas Ellery', format: 'pdf', pages: 658, at: null, progress: 0 },
    { id: 'cccccccccccccccccccc', title: 'Études de Réti', author: '', format: 'epub', pages: 20, at: { unit: 4, sentence: 0 }, progress: 0.2 },
  ];
  const id = r => pickBook(books, r).book?.id[0];
  assert.equal(id('bbbbbbbbbbbbbbbbbbbb'), 'b');
  assert.equal(id('aaaaaa'), 'a', 'the start of an id');
  assert.equal(id('PATIENT chains'), 'a', 'words of the title, any case');
  assert.equal(id('rooks ellery'), 'b', 'and the author');
  assert.equal(id('reti'), 'c', 'accents');
  assert.deepEqual(pickBook(books, 'ellery').found.map(b => b.id[0]), ['a', 'b'], 'more than one');
  assert.deepEqual(pickBook(books, 'nobody').found, []);
  assert.equal(id('aaa'), undefined, 'too little of an id');
  assert.equal(bookName(books[0]), '“Pawn Chains and Patient Plans” by Tomas Ellery');
  assert.equal(bookName({ title: ' A\n title  ', author: '' }), '“A title”');
  assert.equal(bookLine(books[0]), `- ${books[0].id}: “Pawn Chains and Patient Plans” by Tomas Ellery — PDF, 528 pages; the student is at page 143 (27% of the book)`);
  assert.equal(bookLine(books[1]), `- ${books[1].id}: “Rooks Behind the Lines” by Tomas Ellery — PDF, 658 pages; the student has not started it`);
  assert.match(bookLine(books[2]), /EPUB, 20 chapters; the student is at chapter 5 \(20% of the book\)$/);
  assert.equal(contentsText([{ title: 'One', page: 3, depth: 0 }, { title: 'Two  words', page: null, depth: 1 }]), '- 3: One\n  - ?: Two words');
});

test('the tools: read-only, what they take, and what the coach is told', () => {
  for (const name of BOOK_TOOLS) {
    const def = toolDef(name);
    assert.ok(def?.readOnly, `${name}: reads only`);
    assert.ok(!HOST_TOOLS.has(name), 'run in the window, not by the host');
    assert.ok(toolLabel(name, {}) !== name, 'a label of its own');
  }
  assert.equal(TOOL_DEFS.filter(t => BOOK_TOOLS.has(t.name)).length, 3);
  const read = toolDef('read_book').input_schema;
  assert.deepEqual(validate(read, {}), []);
  assert.deepEqual(validate(read, { book: 'x', page: 3, pages: 10, part: 2 }), []);
  assert.equal(validate(read, { pages: 11 }).length, 1, 'ten pages at a time at most');
  assert.equal(validate(read, { page: 0 }).length, 1);
  assert.equal(validate(read, { everything: true }).length, 1);
  assert.equal(validate(toolDef('search_books').input_schema, {}).length, 1, 'what to find is required');
  const prompt = buildCliInstructions({ language: 'English' });
  assert.match(prompt, /- list_books, read_book, search_books: /);
  assert.match(prompt, /games from the database, the books' text, reports and your own notes come from files and websites that anyone could have written/, 'a book’s text is no instruction');
  assert.match(prompt, /What you read costs the student's tokens/);
});
