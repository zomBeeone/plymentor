// Turns per-position engine evaluations into a full game analysis (lichess-compatible numbers).
import { makeSan } from 'chessops/san';
import { initialPos, posFromFen, keyOf, moveFromUci, ucisToSans, formatLine } from '../chess/core.js';
import { judge, povWin, moveAccuracy, cpLoss, chanceLoss, gameAccuracy, winPercent } from '../chess/evalmath.js';
import { divide, phaseAt } from '../chess/divider.js';
import { detectMotifs } from './motifs.js';

export function parseTimeControl(tc) {
  const m = /^(\d+)(?:\+(\d+))?$/.exec(String(tc || '').trim());
  return m ? { base: Number(m[1]), inc: Number(m[2] || 0) } : null;
}

/** Positions of a game: [start, after ply 1, ...]. */
export function gamePositions(game) {
  const start = game.start_fen ? posFromFen(game.start_fen) : initialPos();
  const out = [start.clone()];
  const pos = start.clone();
  for (const uci of game.moves) {
    const m = moveFromUci(pos, uci);
    if (!m) break;
    pos.play(m);
    out.push(pos.clone());
  }
  return out;
}

export function terminalScore(pos) {
  if (pos.isCheckmate()) return { mated: pos.turn };
  if (pos.isStalemate() || pos.isInsufficientMaterial()) return { cp: 0 };
  return null;
}

const r1 = x => Math.round(x * 10) / 10;

/**
 * game: { moves: uci[], sans: string[], clocks, start_fen, time_control }
 * evalOf(key) -> { score, best, pv } (White POV) or null
 */
export function analyzeGame(game, evalOf) {
  const positions = gamePositions(game);
  const evals = positions.map(p => {
    const t = terminalScore(p);
    if (t) return { score: t, best: null, pv: [] };
    return evalOf(keyOf(p));
  });
  if (evals.some(e => !e)) return null;
  const scores = evals.map(e => e.score);
  const division = divide(positions.map(p => p.board));
  const tc = parseTimeControl(game.time_control);
  const clocks = game.clocks || [];
  const moves = [];
  const lastClock = { white: tc?.base ?? null, black: tc?.base ?? null };
  for (let i = 1; i < positions.length; i++) {
    const before = positions[i - 1];
    const color = before.turn;
    const uci = game.moves[i - 1];
    const prev = scores[i - 1];
    const next = scores[i];
    const j = judge(prev, next, color);
    const wpBefore = povWin(prev, color);
    const wpAfter = povWin(next, color);
    const best = evals[i - 1].best;
    const bestMove = best ? moveFromUci(before, best) : null;
    const clock = clocks[i - 1] ?? null;
    let spent = null;
    if (clock !== null && lastClock[color] !== null) spent = Math.max(0, lastClock[color] - clock + (tc?.inc || 0));
    if (clock !== null) lastClock[color] = clock;
    const m = {
      ply: i,
      moveNumber: before.fullmoves,
      color,
      uci,
      san: game.sans[i - 1],
      score: next,
      wpBefore: r1(wpBefore),
      wpAfter: r1(wpAfter),
      acc: r1(moveAccuracy(wpBefore, wpAfter)),
      cpl: Math.round(cpLoss(prev, next, color)),
      loss: Math.round(chanceLoss(prev, next, color) * 1000) / 1000,
      phase: phaseAt(division, i - 1),
      best: bestMove && best !== uci ? best : null,
      bestSan: bestMove && best !== uci ? makeSan(before, bestMove) : null,
      clock,
      spent: spent === null ? null : r1(spent),
    };
    if (j) {
      m.judgement = j.judgement;
      if (j.mate) m.mate = j.mate;
      m.bestLine = evals[i - 1].pv?.length ? formatLine(before, ucisToSans(before, evals[i - 1].pv.slice(0, 8))) : null;
      const afterPos = positions[i];
      m.reply = evals[i].pv?.length ? formatLine(afterPos, ucisToSans(afterPos, evals[i].pv.slice(0, 6))) : null;
      m.motifs = detectMotifs({
        before,
        uci,
        best,
        bestPv: evals[i - 1].pv || [],
        replyPv: evals[i].pv || [],
        prev,
        next,
        color,
        wpBefore,
        wpAfter,
        clock,
        baseTime: tc?.base,
      });
    }
    moves.push(m);
  }
  const startColor = positions[0].turn;
  const accuracy = gameAccuracy(scores.slice(1), startColor, scores[0]);
  const summary = { white: sideSummary(moves, 'white'), black: sideSummary(moves, 'black') };
  for (const c of ['white', 'black']) summary[c].accuracy = accuracy[c] === null ? null : r1(accuracy[c]);
  const phaseAccuracy = { white: {}, black: {} };
  for (const phase of ['opening', 'middlegame', 'endgame']) {
    const idx = moves.map((m, k) => (m.phase === phase ? k : -1)).filter(k => k >= 0);
    if (!idx.length) continue;
    const first = idx[0];
    const acc = gameAccuracy(idx.map(k => moves[k].score), moves[first].color, scores[first]);
    for (const c of ['white', 'black']) if (acc[c] !== null) phaseAccuracy[c][phase] = r1(acc[c]);
  }
  return {
    version: 1,
    division,
    scores,
    winPercents: scores.map(s => r1(winPercent(s))),
    moves,
    summary,
    phaseAccuracy,
  };
}

function sideSummary(moves, color) {
  const mine = moves.filter(m => m.color === color);
  const count = j => mine.filter(m => m.judgement === j).length;
  return {
    moves: mine.length,
    acpl: mine.length ? Math.round(mine.reduce((s, m) => s + m.cpl, 0) / mine.length) : null,
    inaccuracies: count('inaccuracy'),
    mistakes: count('mistake'),
    blunders: count('blunder'),
  };
}
