// Game phase division, ported from scalachess Divider (used by lichess for opening / middlegame / endgame).
import { SquareSet } from 'chessops';

const majorsAndMinors = board => board.occupied.diff(board.king.union(board.pawn)).size();

// A sparse back rank means pieces have been developed.
const backrankSparse = board =>
  SquareSet.fromRank(0).intersect(board.white).size() < 4 || SquareSet.fromRank(7).intersect(board.black).size() < 4;

function score(y, white, black) {
  if (white === 0 && black === 0) return 0;
  if (white === 1 && black === 0) return 1 + (8 - y);
  if (white === 2 && black === 0) return y > 2 ? 2 + (y - 2) : 0;
  if (white === 3 && black === 0) return y > 1 ? 3 + (y - 1) : 0;
  if (white === 4 && black === 0) return y > 1 ? 3 + (y - 1) : 0;
  if (white === 0 && black === 1) return 1 + y;
  if (white === 1 && black === 1) return 5 + Math.abs(3 - y);
  if (white === 2 && black === 1) return 4 + y;
  if (white === 3 && black === 1) return 5 + y;
  if (white === 0 && black === 2) return y < 6 ? 2 + (6 - y) : 0;
  if (white === 1 && black === 2) return 4 + (6 - y);
  if (white === 2 && black === 2) return 7;
  if (white === 0 && black === 3) return y < 7 ? 3 + (7 - y) : 0;
  if (white === 1 && black === 3) return 5 + (6 - y);
  if (white === 0 && black === 4) return y < 7 ? 3 + (7 - y) : 0;
  return 0;
}

const regions = [];
for (let y = 0; y < 7; y++)
  for (let x = 0; x < 7; x++) {
    const sq = y * 8 + x;
    regions.push({ y, set: SquareSet.empty().with(sq).with(sq + 1).with(sq + 8).with(sq + 9) });
  }

function mixedness(board) {
  let mix = 0;
  for (const { y, set } of regions)
    mix += score(y + 1, board.white.intersect(set).size(), board.black.intersect(set).size());
  return mix;
}

/**
 * boards[i] is the board after ply i (boards[0] = start). Returns { middle, end } as ply indexes
 * where the middlegame / endgame begin (undefined when the game never reached that phase).
 */
export function divide(boards) {
  let middle;
  for (let i = 0; i < boards.length; i++) {
    const b = boards[i];
    if (majorsAndMinors(b) <= 10 || backrankSparse(b) || mixedness(b) > 150) {
      middle = i;
      break;
    }
  }
  let end;
  if (middle !== undefined)
    for (let i = 0; i < boards.length; i++)
      if (majorsAndMinors(boards[i]) <= 6) {
        end = i;
        break;
      }
  if (middle !== undefined && end !== undefined && middle >= end) middle = undefined;
  return { middle, end };
}

/** Phase of the position reached at `ply` given a division. */
export function phaseAt(division, ply) {
  if (division.end !== undefined && ply >= division.end) return 'endgame';
  if (division.middle !== undefined && ply >= division.middle) return 'middlegame';
  return 'opening';
}

/** Phase of a single position, without game history (for live analysis). */
export function phaseOf(board) {
  if (majorsAndMinors(board) <= 6) return 'endgame';
  if (majorsAndMinors(board) <= 10 || backrankSparse(board) || mixedness(board) > 150) return 'middlegame';
  return 'opening';
}
