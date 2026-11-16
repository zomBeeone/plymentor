// What the coach is told about the student's board having changed since it last looked (coachTerm.js boardChange): a
// coach that goes on with the position it saw last — a weaker model above all — is told the moves played since, a step
// back, another line, another game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardChange } from '../../app/js/coachTerm.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const line = (ucis, mode = 'analysis', start = START) => ({ mode, start, ucis: ucis.split(' ').filter(Boolean) });
const ruy = 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6';

test('the coach is told what changed on the board since it last looked', () => {
  const was = line(ruy);
  assert.equal(boardChange(was, line(ruy)), '', 'nothing changed: nothing said');
  assert.equal(boardChange(null, line(ruy)), '', 'its first look');
  assert.equal(
    boardChange(was, line(`${ruy} b5a4 g8f6`)),
    'Since you last looked at the board, 2 more moves were played: 4. Ba4 Nf6. What follows is the board now — not the position you saw before.',
  );
  assert.equal(boardChange(was, line(`${ruy} b5a4`)), 'Since you last looked at the board, 1 more move was played: 4. Ba4. What follows is the board now — not the position you saw before.');
  assert.equal(boardChange(was, line('e2e4 e7e5 g1f3')), 'Since you last looked at the board, it went back 3 moves, to the position after 2. Nf3. What follows is the board now.');
  assert.equal(boardChange(was, line('')), 'Since you last looked at the board, it went back 6 moves, to the first position. What follows is the board now.');
  assert.equal(
    boardChange(was, line('e2e4 e7e5 g1f3 b8c6 f1c4 f8c5')),
    'Since you last looked at the board, it went into another line: from the position after 2... Nc6 it now goes 3. Bc4 Bc5 (when you looked: 3. Bb5 a6). What follows is the board now.',
  );
  // another game (a training game after the analysis board), another first position
  assert.match(boardChange(was, line('e2e4', 'play')), /another game or position has come on it/);
  assert.match(boardChange(was, line('', 'analysis', '8/8/4k3/8/8/4K3/4P3/8 w - - 0 1')), /another game or position has come on it/);
  // many moves since: the last 16 of them
  const long = boardChange(was, line(`${ruy} b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8 h2h3 c6b8 d2d4 b8d7 b1d2 c8b7 b3c2 f8e8`));
  assert.match(long, /^Since you last looked at the board, 18 more moves were played: … 5\. O-O Be7 .* 12\. Bc2 Re8\. /);
});
