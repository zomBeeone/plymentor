// The board's move tree read from a PGN — the comments after a move, before a variation's first move and before the
// first move, the arrows and circles drawn in comments, the NAGs — and written back as PGN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tree, commentsOf } from '../../app/js/tree.js';

const PGN = `[Event "?"]

{Before it all} 1. e4 {Best by test [%cal Ge2e4,Rd7d5][%csl Yd5]} e5 (1... c5 {The Sicilian}) ( {Or} 1... e6 ) 2. Nf3 $16 {[%clk 0:05:00]} *`;

/** What the student reads and sees of a tree: per move, its comments, arrows and NAGs. */
function marks(tree) {
  const out = [['start', commentsOf(tree.root)]];
  const walk = n => {
    for (const c of n.children) {
      out.push([c.san, c.preComments, c.comments, c.shapes.map(s => `${s.brush} ${s.orig}${s.dest || ''}`).sort(), c.nags]);
      walk(c);
    }
  };
  walk(tree.root);
  return out;
}

test('a PGN’s comments stay on their moves — before the first move, after a move, before a variation — with its arrows', () => {
  const { tree } = Tree.fromPgn(PGN);
  assert.deepEqual(marks(tree), [
    ['start', ['Before it all']],
    ['e4', [], ['Best by test'], ['green e2e4', 'red d7d5', 'yellow d5'], []],
    ['e5', [], [], [], []],
    ['Nf3', [], [], [], [16]],
    ['c5', [], ['The Sicilian'], [], []],
    ['e6', ['Or'], [], [], []],
  ]);
  const nf3 = tree.mainline()[3];
  assert.equal(nf3.clock, 300, 'a clock is no comment');
  assert.deepEqual(commentsOf(tree.root.children[0].children[2]), ['Or'], 'what the student reads of 1... e6');
  // written back, and read again: the same
  const again = Tree.fromPgn(tree.toPgn()).tree;
  assert.deepEqual(marks(again), marks(tree));
  assert.match(tree.toPgn(), /\n\n\{Before it all\} 1\. e4 \{Best by test\} \{\[%csl Yd5\] \[%cal Ge2e4,Rd7d5\]\} 1\.\.\. e5 /);
  assert.match(tree.toPgn(), /\(\{Or\} 1\.\.\. e6\)/);
});
