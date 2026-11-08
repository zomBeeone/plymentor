// Holding ← or →: one move at once, then a steady pace, one move a frame at most, none after the key is let go.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let frames = [];
let clock = 0;
let ids = 0;
globalThis.requestAnimationFrame = fn => (frames.push({ id: ++ids, fn }), ids);
globalThis.cancelAnimationFrame = id => (frames = frames.filter(f => f.id !== id));
const realNow = performance.now;
performance.now = () => clock;

const { press, pressKey, release, holding, holdable } = await import('../../app/js/hold.js');

/** Runs `ms` of frames, 60 a second (or at `step` ms), as a browser would. */
function run(ms, step = 1000 / 60) {
  const end = clock + ms;
  while (clock + step <= end) {
    clock += step;
    const due = frames;
    frames = [];
    for (const f of due) f.fn(clock);
  }
}

beforeEach(() => {
  release();
  frames = [];
  clock = 0;
});

test('a tap: one move, and no more when the key is let go at once', () => {
  let n = 0;
  press('ArrowRight', () => ++n);
  assert.equal(n, 1);
  assert.equal(holding(), false, 'a tap keeps its animation');
  release('ArrowRight');
  run(1000);
  assert.equal(n, 1);
});

test('held: after a moment about 30 moves a second, drawn one by one, and they stop the moment it is let go', () => {
  let n = 0;
  press('ArrowRight', () => ++n);
  run(200);
  assert.equal(n, 1, 'not yet');
  run(1000 + 30);
  assert.ok(n >= 29 && n <= 32, `${n} moves`);
  assert.equal(holding(), true, 'no animations meanwhile');
  const at = n;
  release('ArrowRight');
  assert.equal(holding(), false);
  run(500);
  assert.equal(n, at, 'not one move after');
});

test('a slow computer: one move a frame at most — none made up for —, every one still made', () => {
  let n = 0;
  press('k', () => ++n);
  run(240, 50);
  const start = n;
  run(1000, 50); // (20 frames a second)
  assert.equal(n - start, 20);
});

test('the line ends: it stops by itself', () => {
  let left = 3;
  press('ArrowLeft', () => (left ? (left--, true) : false));
  run(2000);
  assert.equal(left, 0);
  assert.equal(frames.length, 0, 'no frames asked for any more');
  assert.equal(holding(), false);
  let none = 0;
  press('ArrowLeft', () => (none++, false));
  assert.equal(frames.length, 0, 'nothing to go through at all');
});

test("the keyboard's own repeats do nothing; the other way takes over; letting go of the old key does not stop it", () => {
  let right = 0;
  let left = 0;
  pressKey({ key: 'ArrowRight', repeat: false }, () => ++right);
  for (let i = 0; i < 30; i++) pressKey({ key: 'ArrowRight', repeat: true }, () => ++right);
  assert.equal(right, 1);
  pressKey({ key: 'ArrowLeft', repeat: false }, () => ++left);
  release('ArrowRight');
  run(600);
  assert.equal(right, 1);
  assert.ok(left > 5);
  // a repeat with nothing held (the key was down when the screen came): it starts
  release();
  let late = 0;
  pressKey({ key: 'ArrowRight', repeat: true }, () => ++late);
  assert.equal(late, 1);
});

test('a move that fails or leaves the screen ends it', () => {
  press('ArrowLeft', () => {
    if (holding()) throw new Error('no');
    return true;
  });
  clock = 1000;
  const due = frames;
  frames = [];
  assert.throws(() => due[0].fn(clock), /no/);
  assert.equal(holding(), false);
  assert.equal(frames.length, 0);
  let n = 0;
  press('ArrowLeft', () => {
    n++;
    if (n === 2) release();
    return true;
  });
  run(1000);
  assert.equal(n, 2);
});

test('◀ ▶ pressed down, by the pointer or the keyboard', () => {
  let n = 0;
  const props = holdable(() => ++n);
  const button = { setPointerCapture() {} };
  props.onPointerDown({ button: 2, currentTarget: button, pointerId: 1 });
  assert.equal(n, 0, 'the left button only');
  props.onPointerDown({ button: 0, currentTarget: button, pointerId: 1 });
  assert.equal(n, 1);
  run(600);
  const held = n;
  assert.ok(held > 5);
  props.onPointerUp();
  run(300);
  assert.equal(n, held);
  props.onClick({ detail: 1 });
  assert.equal(n, held, "a press's own click: its move is made");
  props.onClick({ detail: 0 });
  assert.equal(n, held + 1, 'Enter or Space on the button');
});

test.after(() => {
  performance.now = realNow;
});
