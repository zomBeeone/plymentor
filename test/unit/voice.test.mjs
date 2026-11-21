// The coach's voice in the window: what its speak tool says is read like a book — sentence by sentence, the moves in
// words, paused, gone on, a sentence back or on, from any sentence, faster, the coach's earlier texts kept —, and where
// it says nothing (the Book reader, where the book's voice reads). The system voice is a stand-in here: nothing is said
// out loud.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const said = []; // the utterances given to the system voice
let speaking = null; // the one being said (the stand-in ends it when a test says so: next())
globalThis.window = {
  plymentor: {}, // (the desktop window may play sound before the first click)
  speechSynthesis: {
    speak: u => {
      said.push(u);
      speaking = u;
    },
    // (as Chrome does: the utterance being said ends with an error)
    cancel() {
      const u = speaking;
      speaking = null;
      if (u) queueMicrotask(() => u.onerror?.());
    },
    getVoices: () => [],
  },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text;
  }
};
globalThis.location = { hash: '#/books/1a2b3c' };

const { setState } = await import('../../app/js/store.js');
const { coachSays, coachTurn, coachReading } = await import('../../app/js/coachReading.js');
const { speechDoc } = await import('../../app/js/coachSpeech.js');
const { Tree } = await import('../../app/js/tree.js');
const { sanToUci } = await import('../../app/js/chess.js');

const texts = () => said.map(u => u.text);
const flush = () => new Promise(r => setTimeout(r, 0));
/** The sentence being said ends: the reading goes on. */
async function next() {
  const u = speaking;
  speaking = null;
  u?.onend?.();
  await flush();
}
function reset() {
  coachReading.clear();
  said.length = 0;
  speaking = null;
  coachTurn();
}
setState({ settings: { language: 'English', voice: { enabled: true, engine: 'browser', rate: 1 } } });

test('the coach does not talk in the Book reader; elsewhere it does', async () => {
  coachSays({ text: 'A word from your coach.' });
  location.hash = '#/books';
  coachSays({ text: 'Another word.' });
  assert.deepEqual(texts(), [], 'nothing said in the Book reader (a book, or the list of books)');
  assert.equal(coachReading.texts.length, 2, 'what it said is kept, to be heard elsewhere');
  location.hash = '#/analysis';
  coachSays({ text: 'Knight to f3.' });
  assert.deepEqual(texts(), ['Knight to f3.']);
  // (a screen whose name only begins like it is not the Book reader; the student asked something new meanwhile)
  location.hash = '#/bookshelf';
  coachTurn();
  coachSays({ text: 'Still talking.' });
  await flush();
  assert.deepEqual(texts(), ['Knight to f3.', 'Still talking.']);
});

test('what the voice says: the moves in words, as a coach says them; Markdown, links and FENs left out', () => {
  const say = text => speechDoc(text).sentences.map(s => s.said);
  assert.deepEqual(say('After 14...Nd7 15.f4 exf4 16.Bxf4 White attacks. Instead 14...Rad8! Black is fine.'), [
    'After 14... knight to d7, 15. f4, e takes f4, 16. bishop takes f4, White attacks.',
    'Instead 14... a-rook to d8. Black is fine.',
  ]);
  assert.deepEqual(say('1. e4 e5 2. Nf3 Nc6 3. Bb5 is the Ruy Lopez; 5. O-O Be7 6. Re1 and O-O-O are castling.'), [
    '1. e4, e5, 2. knight to f3, knight to c6, 3. bishop to b5, is the Ruy Lopez; 5. castles kingside, bishop to e7, 6. rook to e1, and castles queenside are castling.',
  ]);
  // (the file a is said as a letter, not as the word "a"; checks, mates, promotions, long algebraic, figurines)
  assert.deepEqual(say('With axb5 the file opens, then Qxf7+ Kxf7 and e8=Q#. The moves e2-e4 and ♘f3.'), [
    'With a-pawn takes b5 the file opens, then queen takes f7, check, king takes f7, and e8, promoting to a queen, checkmate.',
    'The moves e2 to e4 and knight to f3.',
  ]);
  // (evaluations, Stockfish's mates, results, scores, en passant)
  assert.deepEqual(say('Stockfish says +1.4 (or −0.5), #3 here and #-2 there. It ended ½-½, 6½/9; exd6 e.p. was legal.'), [
    'Stockfish says plus 1.4, or minus 0.5, mate in 3 here and mate in 2 for Black there.',
    'It ended a draw, 6 and a half out of 9; e takes d6 en passant was legal.',
  ]);
  // a heading, list items (their bullets and numbers shown, not said), emphasis, a link, code, a table, a FEN
  const doc = speechDoc(
    '## The plan\n\n- Play **Nf3** first.\n1. Then [castle](https://example.com/a) early.\n2) See https://lichess.org/x.\n\n```\nr . . k\n```\nThe position 8/8/4k3/8/8/4K3/4P3/8 w - - 0 1 is a draw 🙂.\n| Move | Eval |\n|---|---|\n| Nf3 | +0.3 |',
  );
  assert.deepEqual(
    doc.blocks.map(b => [b.kind, b.mark ?? '', b.text]),
    [
      ['h', '', 'The plan'],
      ['li', '•', 'Play Nf3 first.'],
      ['li', '1.', 'Then castle early.'],
      ['li', '2)', 'See https://lichess.org/x.'],
      ['p', '', 'The position 8/8/4k3/8/8/4K3/4P3/8 w - - 0 1 is a draw 🙂.'],
      ['p', '', 'Move, Eval'],
      ['p', '', 'Nf3, +0.3'],
    ],
  );
  assert.deepEqual(
    doc.sentences.map(s => s.said),
    ['The plan', 'Play knight to f3 first.', 'Then castle early.', 'See.', 'The position is a draw.', 'Move, Eval', 'knight to f3, plus 0.3'],
  );
  // "1. e4 e5" at a line's start is a move number, not a list
  assert.deepEqual(
    speechDoc('1. e4 e5 2. Nf3\n\n1. Develop first.').blocks.map(b => b.kind),
    ['p', 'li'],
  );
  // the moves marked in the text — not a square named alone
  const marked = speechDoc('The knight on d5 is strong after 12. Nd5 Bxd5 13. exd5.').blocks[0];
  assert.deepEqual(
    marked.marks.map(m => marked.text.slice(m.start, m.end)),
    ['12. Nd5', 'Bxd5', '13. exd5'],
  );
});

test('a long text is read whole, sentence by sentence: paused, gone on, a sentence back and on, from any sentence, faster', async () => {
  reset();
  location.hash = '#/analysis';
  const lines = Array.from({ length: 120 }, (_, i) => `Idea ${i + 1}: after ${i + 1}. Nf3 the knight watches e5 and d4.`);
  coachSays({ text: lines.join(' ') });
  assert.ok(lines.join(' ').split(/\s+/).length > 1000, 'far more than 80 words');
  assert.deepEqual(texts(), ['Idea 1: after 1. knight to f3 the knight watches e5 and d4.']);
  await next();
  await next();
  await next();
  assert.deepEqual(texts().slice(1), [2, 3, 4].map(i => `Idea ${i}: after ${i}. knight to f3 the knight watches e5 and d4.`));
  // paused: nothing more is said; ▶ goes on with the sentence it stopped in
  coachReading.pause();
  await flush();
  assert.equal(said.length, 4);
  assert.deepEqual([coachReading.playing, coachReading.held, coachReading.text.at.s], [false, true, 3]);
  coachReading.play();
  assert.equal(texts().at(-1), 'Idea 4: after 4. knight to f3 the knight watches e5 and d4.');
  // a sentence on, a sentence back
  coachReading.step(1);
  assert.match(texts().at(-1), /^Idea 5:/);
  coachReading.step(-1);
  assert.match(texts().at(-1), /^Idea 4:/);
  // a sentence clicked (or the slider): read from there
  coachReading.seek(coachReading.cur, 116, true);
  assert.match(texts().at(-1), /^Idea 117:/);
  // faster: the next sentence at 1.5× the voice's rate
  coachReading.setSpeed(1.5);
  await next();
  assert.deepEqual([texts().at(-1).slice(0, 9), said.at(-1).rate], ['Idea 118:', 1.5]);
  coachReading.setSpeed(1);
  // to the end, then from its start again
  await next();
  await next();
  await next();
  assert.match(texts().at(-1), /^Idea 120:/);
  assert.equal(coachReading.playing, false, 'the end of the text');
  coachReading.play();
  assert.match(texts().at(-1), /^Idea 1:/);
});

test('what the coach says in one turn is read one part after the other; a new turn’s at once; the earlier texts stay, each where it was left', async () => {
  reset();
  location.hash = '#/analysis';
  coachSays({ text: 'Part one. It has two sentences.' });
  coachSays({ text: 'Part two follows.' }); // (the same turn, while part one is read: after it)
  assert.deepEqual(texts(), ['Part one.']);
  await next();
  await next();
  assert.deepEqual(texts(), ['Part one.', 'It has two sentences.', 'Part two follows.']);
  assert.equal(coachReading.cur, 1);
  // paused in a part: the turn's next part waits for ▶, which goes on with both
  reset();
  coachSays({ text: 'A lesson. Its second sentence.' });
  coachReading.pause();
  coachSays({ text: 'The lesson goes on.' });
  await flush();
  assert.deepEqual(texts(), ['A lesson.']);
  coachReading.play();
  await next();
  await next();
  assert.deepEqual(texts(), ['A lesson.', 'A lesson.', 'Its second sentence.', 'The lesson goes on.']);
  // a new turn (the student asked something): its answer at once, the lesson kept where it was
  reset();
  coachSays({ text: 'A long lesson. Second. Third. Fourth.' });
  await next();
  coachTurn();
  coachSays({ text: 'Your answer.' });
  await flush();
  assert.deepEqual(texts(), ['A long lesson.', 'Second.', 'Your answer.']);
  await next();
  assert.equal(coachReading.playing, false);
  coachReading.show(0, true);
  assert.equal(texts().at(-1), 'Second.', 'the lesson goes on where it was left');
});

/** A screen's board (coachTerm.js coachBoard) with `sans` played: what it was made to show, in `shown` ("♪" with the move's sound). */
function boardWith(sans) {
  const tree = new Tree();
  let node = tree.root;
  for (const san of sans) node = tree.addMove(node, sanToUci(node.fen, san)).node;
  const b = { tree, node, shown: [] };
  b.show = (n, sound) => {
    b.shown.push(`${sound ? '♪' : ''}${n.san || 'start'}`);
    b.node = n;
  };
  return b;
}

test('the board plays each move once it has been said; a sentence gone to puts it where the text is there', async () => {
  reset();
  location.hash = '#/analysis';
  const b = boardWith(['e4']);
  coachSays({ text: 'After 1. e4 c5 2. Nf3 d6 Black is fine. White wants Nd5 later. Instead 2...Nc6 is classical.' }, () => b);
  // each part ends with a move the board plays: said, then played
  assert.deepEqual(texts(), ['After 1. e4']);
  assert.deepEqual(b.shown, [], 'nothing played before it is said');
  await next();
  assert.deepEqual(b.shown, ['♪e4'], 'the move on the board: it stays there');
  assert.deepEqual(texts().at(-1), 'c5');
  await next();
  await next();
  await next();
  assert.deepEqual(texts().slice(1), ['c5', '2. knight to f3', 'd6', 'Black is fine.']);
  assert.deepEqual(b.shown, ['♪e4', '♪c5', '♪Nf3', '♪d6']);
  assert.deepEqual(b.tree.mainline().map(n => n.san).slice(1), ['e4', 'c5', 'Nf3', 'd6'], 'the moves are on the board’s game');
  // ("Nd5" named on its own: no knight can go there from the position the line is at — only said)
  await next();
  assert.deepEqual(texts().at(-1), 'White wants knight to d5 later.');
  await next();
  assert.deepEqual(texts().at(-1), 'Instead 2... knight to c6');
  assert.equal(b.shown.length, 4);
  await next();
  assert.deepEqual(b.shown.at(-1), '♪Nc6');
  assert.deepEqual(b.tree.path(b.node).map(n => n.san).slice(1), ['e4', 'c5', 'Nf3', 'Nc6'], 'the other move there: a variation');
  // a sentence clicked: the board where the text is there — after the last move of its line said before it
  coachReading.seek(coachReading.cur, 1);
  assert.deepEqual(b.shown.at(-1), 'd6');
  coachReading.seek(coachReading.cur, 0);
  assert.deepEqual(b.shown.at(-1), 'e4', 'where the board was when the coach said it');
  coachReading.pause();
  // another game on the board: nothing played on it
  const other = boardWith(['d4']);
  coachTurn();
  coachSays({ text: 'After 1. d4 d5 2. c4 the Queen’s Gambit.' }, () => other);
  const shown = other.shown.length;
  other.tree = new Tree();
  await next();
  await next();
  assert.equal(other.shown.length, shown, 'the board shows another game now');
  // no board (a screen without one): the sentences as they were, one part each
  reset();
  coachSays({ text: 'After 1. e4 c5 2. Nf3 Black is fine.' });
  assert.deepEqual(texts(), ['After 1. e4, c5, 2. knight to f3, Black is fine.']);
});
