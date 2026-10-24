// Builds the <board_context> block sent with every student message: what is on the student's screen.
import { posFromFen, fenOf, keyOf, moveFromUci, asciiBoard, pieceList, formatLine, ucisToSans, outcomeText, INITIAL_FEN } from '../chess/core.js';
import { makeSan } from 'chessops/san';
import { lookup } from '../chess/openings.js';
import { getGame, gameSummary, studentColor } from '../games.js';
import { formatScore } from '../chess/evalmath.js';

const MODES = {
  analysis: 'analysis board',
  play: 'training game against the engine',
  openings: 'opening explorer / repertoire',
  drill: 'repertoire drill',
  exercise: 'training exercise',
  lesson: 'lesson',
  report: 'report',
};

/**
 * ctx: { mode, startFen, ucis (moves from startFen to the current position), fen (fallback), gameId,
 *        engine: { depth, lines: [{ score, pv }] }, lastMove: { san, classification, best, ... },
 *        lastComment, play: { level, color }, exercise: { prompt }, orientation, note }
 */
export function buildBoardContext(ctx = {}) {
  const L = ['<board_context>'];
  L.push(`Screen: ${MODES[ctx.mode] || 'analysis board'}`);
  let start;
  try {
    start = posFromFen(ctx.startFen || INITIAL_FEN);
  } catch {
    start = posFromFen(INITIAL_FEN);
  }
  let pos = start.clone();
  const sans = [];
  let lastLabel = null;
  if (Array.isArray(ctx.ucis) && ctx.ucis.length) {
    for (const uci of ctx.ucis.slice(0, 600)) {
      const m = moveFromUci(pos, uci);
      if (!m) break;
      const san = makeSan(pos, m);
      lastLabel = pos.turn === 'white' ? `${pos.fullmoves}. ${san}` : `${pos.fullmoves}... ${san}`;
      sans.push(san);
      pos.play(m);
    }
  } else if (ctx.fen) {
    try {
      pos = posFromFen(ctx.fen);
    } catch {
      /* keep start */
    }
  }
  if (ctx.gameId) {
    const g = getGame(ctx.gameId);
    if (g) {
      const color = studentColor(g);
      L.push(`Loaded game: ${gameSummary(g)}${color ? ` — the student played ${color}` : ''}${g.analysis ? ' (engine-analysed)' : ''}`);
    }
  }
  if (ctx.play) L.push(`Training game vs Stockfish (${ctx.play.level || 'engine'}); the student plays ${ctx.play.color}.`);
  if (ctx.exercise?.prompt) L.push(`Exercise: ${ctx.exercise.prompt}`);
  if (ctx.drill) L.push(`Repertoire drill (${ctx.drill.color}).`);
  if (sans.length) {
    const shown = sans.length > 120 ? `… (${sans.length - 120} earlier plies omitted) ` : '';
    let p = start.clone();
    let tail = sans;
    if (sans.length > 120) {
      for (let i = 0; i < sans.length - 120; i++) p.play(moveFromUci(p, ctx.ucis[i]));
      tail = sans.slice(-120);
    }
    L.push(`Moves${ctx.startFen ? ` from the position ${fenOf(start)}` : ''}: ${shown}${formatLine(p, tail)}`);
  } else if (ctx.startFen) L.push(`Starting position: ${fenOf(start)}`);
  const op = lookup(keyOf(pos));
  L.push(`Current position${lastLabel ? ` (after ${lastLabel})` : ''}: ${fenOf(pos)}`);
  L.push(`${pos.turn === 'white' ? 'White' : 'Black'} to move.${op ? ` Opening: ${op.eco} ${op.name}.` : ''}`);
  const over = outcomeText(pos);
  if (over) L.push(`Game over: ${over}.`);
  L.push(asciiBoard(pos));
  L.push(`White: ${pieceList(pos, 'white')}`);
  L.push(`Black: ${pieceList(pos, 'black')}`);
  const lines = ctx.engine?.lines;
  if (Array.isArray(lines) && lines.length && !over) {
    L.push(`Live engine analysis (Stockfish, depth ${ctx.engine.depth ?? '?'}):`);
    lines.slice(0, 5).forEach((l, i) => {
      const s = ucisToSans(pos, (l.pv || []).slice(0, 12));
      if (s.length) L.push(`  ${i + 1}) ${formatScore(l.score)}: ${formatLine(pos, s)}`);
    });
  }
  if (ctx.lastMove?.san) {
    const lm = ctx.lastMove;
    L.push(
      `Judgement of the last move ${lm.san}: ${lm.classification}${lm.best && lm.best.san !== lm.san ? `; engine preferred ${lm.best.san} (${lm.best.line})` : ''}${lm.scoreAfter ? `; eval after ${formatScore(lm.scoreAfter)}` : ''}.`,
    );
  }
  if (ctx.lastComment) L.push(`Your previous short comment to the student: "${String(ctx.lastComment).slice(0, 600)}"`);
  if (ctx.note) L.push(String(ctx.note).slice(0, 1000));
  L.push('</board_context>');
  return L.join('\n');
}
