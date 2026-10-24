// Evaluation math ported from lichess:
//   win%: ui/lib/src/ceval/winningChances.ts (lila PR #11148)
//   move/game accuracy: modules/analyse/src/main/AccuracyPercent.scala
//   judgements: modules/tree/src/main/Advice.scala
// Scores are objects { cp } or { mate } from White's point of view; { mated: 'white'|'black' } marks checkmate.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const MULTIPLIER = -0.00368208;
const rawWinningChances = cp => 2 / (1 + Math.exp(MULTIPLIER * cp)) - 1;

/** Winning chances in [-1, 1] for White. */
export function winningChances(score) {
  if (!score) return 0;
  if (score.mated) return score.mated === 'white' ? -1 : 1;
  if (score.mate !== undefined && score.mate !== null) {
    if (score.mate === 0) return 0;
    const cp = (21 - Math.min(10, Math.abs(score.mate))) * 100;
    return rawWinningChances(cp * Math.sign(score.mate));
  }
  return rawWinningChances(clamp(score.cp ?? 0, -1000, 1000));
}

/** Win percentage (0-100) for White. */
export const winPercent = score => 50 + 50 * winningChances(score);
export const povWin = (score, color) => (color === 'white' ? winPercent(score) : 100 - winPercent(score));

/** Accuracy of one move from the mover's win% before and after (lila AccuracyPercent.fromWinPercents). */
export function moveAccuracy(before, after) {
  if (after >= before) return 100;
  const winDiff = before - after;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411;
  return clamp(raw + 1, 0, 100);
}

/** Centipawn value with mates folded to ±1000 (lila forceAsCp / ceiled). */
export function cpOf(score) {
  if (!score) return 0;
  if (score.mated) return score.mated === 'white' ? -1000 : 1000;
  if (score.mate !== undefined && score.mate !== null) return score.mate > 0 ? 1000 : score.mate < 0 ? -1000 : 0;
  return clamp(score.cp ?? 0, -1000, 1000);
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const stdDev = a => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

/**
 * Game accuracy per colour: mean of a volatility-weighted mean and a harmonic mean of move accuracies.
 * `scores` holds the evaluation after each ply; `initial` is the evaluation before the first ply.
 */
export function gameAccuracy(scores, startColor = 'white', initial = { cp: 15 }) {
  const all = [initial, ...scores].map(s => (s ? 50 + 50 * rawWinningChances(cpOf(s)) : null));
  const windowSize = clamp(Math.floor(scores.length / 10), 2, 8);
  const windows = [];
  for (let i = 0; i < Math.min(windowSize, all.length) - 2; i++) windows.push(all.slice(0, windowSize));
  if (all.length < windowSize) windows.push(all.slice());
  else for (let i = 0; i + windowSize <= all.length; i++) windows.push(all.slice(i, i + windowSize));
  const weights = windows.map(w => (w.some(x => x === null) ? null : clamp(stdDev(w), 0.5, 12)));
  const per = { white: [], black: [] };
  for (let i = 0; i + 1 < all.length; i++) {
    const color = (i % 2 === 0) === (startColor === 'white') ? 'white' : 'black';
    const prev = all[i];
    const next = all[i + 1];
    const w = weights[i];
    if (prev === null || next === null || w === null || w === undefined) continue;
    const acc = color === 'white' ? moveAccuracy(prev, next) : moveAccuracy(100 - prev, 100 - next);
    per[color].push([acc, w]);
  }
  const result = {};
  for (const color of ['white', 'black']) {
    const arr = per[color];
    if (!arr.length) {
      result[color] = null;
      continue;
    }
    const weighted = arr.reduce((s, [a, w]) => s + a * w, 0) / arr.reduce((s, [, w]) => s + w, 0);
    const harmonic = arr.length / arr.reduce((s, [a]) => s + 1 / Math.max(1, a), 0);
    result[color] = (weighted + harmonic) / 2;
  }
  return result;
}

/**
 * lila's move judgement for the move that led from `prev` to `next`, made by `color`.
 * Returns { judgement: 'inaccuracy'|'mistake'|'blunder', mate?: 'created'|'lost' } or null.
 */
export function judge(prev, next, color) {
  if (!prev || !next) return null;
  if (next.mated) return null; // the move delivered checkmate
  const isCp = s => s.mate === undefined || s.mate === null;
  if (!prev.mated && isCp(prev) && isCp(next)) {
    const d = rawWinningChances(clamp(next.cp, -1000, 1000)) - rawWinningChances(clamp(prev.cp, -1000, 1000));
    const delta = color === 'white' ? -d : d;
    if (delta >= 0.3) return { judgement: 'blunder' };
    if (delta >= 0.2) return { judgement: 'mistake' };
    if (delta >= 0.1) return { judgement: 'inaccuracy' };
    return null;
  }
  // Mate sequences, from the mover's point of view
  const pov = s => (s.mated ? { mated: s.mated } : color === 'white' ? { ...s } : { cp: s.cp === undefined ? undefined : -s.cp, mate: s.mate === undefined || s.mate === null ? undefined : -s.mate });
  const p = pov(prev);
  const n = pov(next);
  const pMate = p.mate !== undefined && p.mate !== null ? p.mate : null;
  const nMate = n.mate !== undefined && n.mate !== null ? n.mate : null;
  if (pMate === null && nMate !== null && nMate < 0) {
    const pcp = p.cp ?? 0;
    return { judgement: pcp < -999 ? 'inaccuracy' : pcp < -700 ? 'mistake' : 'blunder', mate: 'created' };
  }
  if (pMate !== null && pMate > 0 && nMate === null) {
    const ncp = n.cp ?? 0;
    return { judgement: ncp > 999 ? 'inaccuracy' : ncp > 700 ? 'mistake' : 'blunder', mate: 'lost' };
  }
  if (pMate !== null && pMate > 0 && nMate !== null && nMate < 0) return { judgement: 'blunder', mate: 'lost' };
  return null;
}

/** Loss of winning chances (0..1 scale, as lila's liveAnnotate) for the mover. */
export function chanceLoss(prev, next, color) {
  const sign = color === 'white' ? 1 : -1;
  return Math.max(0, (sign * (winningChances(prev) - winningChances(next))) / 2);
}

/** Centipawn loss for the mover, with evaluations capped at ±1000 (lila AccuracyCP). */
export function cpLoss(prev, next, color) {
  const d = cpOf(next) - cpOf(prev);
  return Math.max(0, color === 'white' ? -d : d);
}

/** Human-readable score from White's point of view: "+1.25", "-0.40", "#3", "#-2". */
export function formatScore(score) {
  if (!score) return '?';
  if (score.mated) return score.mated === 'white' ? '0-1 (mate)' : '1-0 (mate)';
  if (score.mate !== undefined && score.mate !== null) return `#${score.mate}`;
  const v = (score.cp ?? 0) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

export function describeScore(score) {
  if (!score) return 'unknown';
  if (score.mated) return 'checkmate';
  if (score.mate !== undefined && score.mate !== null)
    return score.mate > 0 ? `White mates in ${score.mate}` : `Black mates in ${-score.mate}`;
  const cp = score.cp ?? 0;
  const side = cp > 0 ? 'White' : 'Black';
  const a = Math.abs(cp);
  if (a < 30) return 'equal';
  if (a < 80) return `slightly better for ${side}`;
  if (a < 180) return `clearly better for ${side}`;
  if (a < 400) return `${side} is winning`;
  return `${side} is completely winning`;
}

/** Classification shown to the student for a played move (positive grades extend lila's judgements). */
export function classifyMove({ prev, next, color, isBest, onlyMove }) {
  const j = judge(prev, next, color);
  if (j) return j.judgement;
  if (isBest) return onlyMove ? 'great' : 'best';
  const loss = chanceLoss(prev, next, color);
  if (loss < 0.02) return 'excellent';
  return 'good';
}

export const GLYPHS = { great: '!!', best: '!', excellent: '', good: '', inaccuracy: '?!', mistake: '?', blunder: '??' };
