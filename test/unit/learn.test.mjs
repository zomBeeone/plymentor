// Learning a repertoire's lines: the lines, how far each is, what comes next, and what the database keeps of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { linesOf, learningLines, movesOfLines, nextStep, DRILLS_TO_LEARN } from '../../app/js/learn.js';
import { repKey, playUci, INITIAL_FEN } from '../../app/js/chess.js';
import { openBackend, closeBackend } from './setup.mjs';
import { recordLineProgress as record, repertoireProgress as progress } from '../../app/js/backend/training.js';
import { handle } from '../../app/js/backend/router.js';

before(openBackend);
after(closeBackend);

/** Repertoire moves from lines of uci moves: as the database gives them. */
function entriesOf(...lines) {
  const seen = new Map();
  for (const line of lines) {
    let fen = INITIAL_FEN;
    for (const uci of line.split(' ')) {
      const key = `${repKey(fen)} ${uci}`;
      if (!seen.has(key)) seen.set(key, { id: seen.size + 1, key: repKey(fen), fen, uci, san: uci, reps: 0 });
      fen = playUci(fen, uci).fen;
    }
  }
  return [...seen.values()];
}

const FRENCH = 'e2e4 e7e6 d2d4 d7d5';
const CARO = 'e2e4 c7c6 d2d4 d7d5';

test('the lines of a repertoire, from the initial position', () => {
  const lines = linesOf(entriesOf(FRENCH, CARO));
  assert.deepEqual(lines.map(l => l.id), [FRENCH, CARO]);
  assert.equal(lines[0].moves.length, 4);
  assert.equal(movesOfLines(lines).length, 7, 'their shared first move counted once');
  assert.deepEqual(linesOf([]), []);
  assert.equal(linesOf(entriesOf(FRENCH, CARO), 1).length, 1, 'at most so many');
  // a position come back to ends the line (the move after it is one from that position: a line of its own)
  const loop = 'g1f3 g8f6 f3g1 f6g8';
  assert.deepEqual(linesOf(entriesOf(`${loop} e2e4`)).map(l => l.id), [loop, 'e2e4']);
});

test('how far each line is: a line without a move of the student is none to learn; what was drilled before Learn stays', () => {
  const entries = entriesOf(FRENCH, 'd2d4');
  const black = learningLines(entries, {}, 'black');
  assert.deepEqual(black.map(l => l.id), [FRENCH], '1. d4 alone has no move for Black');
  assert.deepEqual([black[0].mine.map(e => e.uci), black[0].shown, black[0].drilled, black[0].learned], [['e7e6', 'd7d5'], 0, 0, false]);
  const progress = { [FRENCH]: { shown: 1, drilled: 1, learned: false } };
  assert.deepEqual(learningLines(entries, progress, 'black').map(l => [l.shown, l.drilled, l.learned]), [[1, 1, false]]);
  assert.equal(learningLines(entries, { [FRENCH]: { shown: 1, drilled: 2, learned: true } }, 'black')[0].learned, true);
  // moves answered right in a drill before there was a Learn: the line counts as learned, unless Learn has progress on it
  const old = entries.map(e => ({ ...e, reps: 1 }));
  assert.equal(learningLines(old, {}, 'black')[0].learned, true);
  assert.equal(learningLines(old, progress, 'black')[0].learned, false);
  assert.equal(learningLines(entries.map(e => ({ ...e, reps: e.uci === 'e7e6' ? 1 : 0 })), {}, 'black')[0].learned, false, 'every one of their moves');
});

const line = (id, more = {}) => ({ id, shown: 0, drilled: 0, learned: false, ...more });
const sometimes = v => () => v; // the random numbers: always this one

test('a Learn session: new lines, in-betweens once in a while', () => {
  const a = line('a');
  const b = line('b');
  assert.deepEqual(nextStep([a, b], {}, sometimes(0.9)), { kind: 'learn', line: a }, 'it starts with a new line');
  const shown = line('a', { shown: 1 });
  assert.equal(nextStep([shown, b], { sinceDrill: 1 }, sometimes(0.9)).kind, 'learn', 'not every time after one new line');
  assert.deepEqual(nextStep([shown, b], { sinceDrill: 1 }, sometimes(0.1)), { kind: 'drill', line: shown }, 'sometimes after one');
  assert.equal(nextStep([shown, line('b', { shown: 1 }), line('c')], { sinceDrill: 2 }, sometimes(0.9)).kind, 'drill', 'always after two');
  assert.equal(nextStep([shown, b], { sinceDrill: 0 }, sometimes(0.1)).kind, 'learn', 'a new line right after an in-between');
  assert.equal(nextStep([shown], {}, sometimes(0.9)).kind, 'drill', 'no new line left: drills');
  const four = ['a', 'b', 'c', 'd'].map(id => line(id, { shown: 1 }));
  assert.equal(nextStep([...four, line('e')], { sinceDrill: 0 }, sometimes(0.9)).kind, 'drill', 'too many waiting: no new line');
  assert.equal(nextStep([line('a', { learned: true, shown: 1 })], {}, sometimes(0.5)), null, 'all learned: the end');
  assert.equal(nextStep([], {}, sometimes(0.5)), null);
});

test('the in-betweens: lines not learned first, learned ones still among them', () => {
  const waiting = line('w', { shown: 1 });
  const learned = line('l', { shown: 1, drilled: 2, learned: true });
  assert.equal(nextStep([waiting, learned], {}, sometimes(0.9)).line, waiting, 'priority');
  assert.equal(nextStep([waiting, learned], {}, sometimes(0.09)).line, learned, 'but learned lines too');
  assert.equal(nextStep([waiting, learned], {}, sometimes(0.11)).line, waiting, 'one in-between in ten at most');
  assert.equal(nextStep([learned, line('n')], { sinceDrill: 2 }, sometimes(0.9)).line, learned, 'only a learned one to drill');
  // not the line just done when another can be; among the others those drilled least
  const again = line('x', { shown: 1, drilled: 1 });
  assert.equal(nextStep([waiting, again], { last: 'w' }, sometimes(0.9)).line, again);
  assert.equal(nextStep([waiting], { last: 'w' }, sometimes(0.9)).line, waiting);
  assert.equal(nextStep([waiting, again, line('y', { shown: 1 })], { last: 'y' }, sometimes(0.9)).line, waiting, 'the one drilled least');
});

test('a learned line comes back once a session at most, and never right after it was done', () => {
  const waiting = line('w', { shown: 1 });
  const a = line('a', { shown: 1, drilled: 2, learned: true });
  const b = line('b', { shown: 1, drilled: 2, learned: true });
  const takesLearned = sometimes(0.05);
  assert.equal(nextStep([waiting, a], {}, takesLearned).line, a, 'it can come back');
  assert.equal(nextStep([waiting, a], { last: 'a' }, takesLearned).line, waiting, 'not right after it was done, though the only learned one');
  assert.equal(nextStep([waiting, a], { reviewed: new Set(['a']) }, takesLearned).line, waiting, 'once a session');
  assert.equal(nextStep([waiting, a, b], { reviewed: new Set(['a']) }, takesLearned).line, b, 'the others have their turn');
  assert.equal(nextStep([a, line('n')], { sinceDrill: 2, reviewed: new Set(['a']) }, sometimes(0.9)).kind, 'learn', 'nothing to drill: the new line');
  assert.equal(nextStep([a, b], { reviewed: new Set(['a']) }, takesLearned), null, 'all learned: the end, whatever came back');
});

test('over whole sessions no learned line comes back twice, or right after it was done', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let run = 0; run < 50; run++) {
    const lines = Array.from({ length: 12 }, (_, i) => line(`l${i}`));
    const session = { reviewed: new Set() };
    let steps = 0;
    for (let step; (step = nextStep(lines, session, rnd)); steps++) {
      assert.ok(steps < 500, 'it ends');
      if (step.kind === 'learn') {
        step.line.shown++;
        session.sinceDrill = (session.sinceDrill || 0) + 1;
      } else {
        session.sinceDrill = 0;
        if (step.line.learned) {
          assert.notEqual(step.line.id, session.last, 'not right after it was done');
          assert.ok(!session.reviewed.has(step.line.id), 'once a session');
          session.reviewed.add(step.line.id);
        } else if (++step.line.drilled >= DRILLS_TO_LEARN) step.line.learned = true;
      }
      session.last = step.line.id;
    }
    assert.ok(lines.every(l => l.learned));
  }
});

test('a whole session ends with every line learned, each gone through once and drilled right twice', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const lines = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => line(id));
  const counts = Object.fromEntries(lines.map(l => [l.id, { learn: 0, drill: 0 }]));
  const session = {};
  let steps = 0;
  for (let step; (step = nextStep(lines, session, rnd)); steps++) {
    assert.ok(steps < 200, 'it ends');
    counts[step.line.id][step.kind]++;
    if (step.kind === 'learn') {
      step.line.shown++;
      session.sinceDrill = (session.sinceDrill || 0) + 1;
    } else {
      session.sinceDrill = 0;
      assert.ok(step.line.shown || step.line.learned, 'only lines already gone through are drilled');
      if (!step.line.learned && ++step.line.drilled >= DRILLS_TO_LEARN) step.line.learned = true;
    }
    session.last = step.line.id;
  }
  assert.ok(lines.every(l => l.learned));
  assert.ok(Object.values(counts).every(c => c.learn === 1 && c.drill >= 2));
});

test('the database: gone through once and drilled right twice, a line is learned, and says so once', async () => {
  assert.deepEqual(record('black', FRENCH, 'drilled'), { shown: 0, drilled: 1, learned: false, justLearned: false });
  assert.deepEqual(record('black', FRENCH, 'drilled'), { shown: 0, drilled: 2, learned: false, justLearned: false }, 'not without having gone through it');
  assert.deepEqual(record('black', FRENCH, 'shown'), { shown: 1, drilled: 2, learned: true, justLearned: true });
  assert.deepEqual(record('black', FRENCH, 'drilled'), { shown: 1, drilled: 2, learned: true, justLearned: false }, 'learned: nothing more counts');
  assert.deepEqual(record('white', FRENCH, 'shown'), { shown: 1, drilled: 0, learned: false, justLearned: false }, 'each colour its own');
  assert.deepEqual(progress('black'), { [FRENCH]: { shown: 1, drilled: 2, learned: true } });
  assert.deepEqual(progress('white'), { [FRENCH]: { shown: 1, drilled: 0, learned: false } });
  for (const [c, l, e] of [['red', FRENCH, 'shown'], ['white', 'DROP TABLE', 'shown'], ['white', FRENCH, 'learned']]) assert.throws(() => record(c, l, e), { status: 400 });
  // the window reads it with the repertoire, and writes it through its route
  assert.deepEqual((await handle('GET', '/api/repertoire?color=black')).progress[FRENCH], { shown: 1, drilled: 2, learned: true });
  assert.equal((await handle('POST', '/api/repertoire/lines', { color: 'black', line: CARO, event: 'shown' })).shown, 1);
});
