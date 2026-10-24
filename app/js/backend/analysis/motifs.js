// Heuristic tags explaining *why* a move was an error — used to find recurring patterns across games.
// Material tags are based on real material swings along the engine lines (exchanges are netted out).
import { makeSan } from 'chessops/san';
import { moveFromUci } from '../chess/core.js';
import { forks, see } from '../chess/features.js';
import { MOTIF_LABELS } from '../../../../shared/motifs.js';

export { MOTIF_LABELS };

const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
const squareName = sq => 'abcdefgh'[sq & 7] + ((sq >> 3) + 1);

function materialBalance(board, color) {
  let s = 0;
  for (const sq of board.occupied) {
    const p = board.get(sq);
    s += (p.color === color ? 1 : -1) * VALUE[p.role];
  }
  return s;
}

/** Material change for `color` after playing up to `plies` moves of `line` (rounded down to an even count). */
function swing(pos, line, plies, color) {
  const n = Math.min(plies, line.length) - (Math.min(plies, line.length) % 2);
  const p = pos.clone();
  const start = materialBalance(p.board, color);
  let played = 0;
  for (let i = 0; i < n; i++) {
    const m = moveFromUci(p, line[i]);
    if (!m) break;
    p.play(m);
    played++;
  }
  if (played % 2) return 0;
  return materialBalance(p.board, color) - start;
}

/**
 * ctx: { before (Position before the move), uci, best (uci), bestPv (uci[]), replyPv (uci[] best line after the move),
 *        prev, next (scores, White POV), color, wpBefore, wpAfter, clock, baseTime }
 */
export function detectMotifs(ctx) {
  const tags = [];
  const { before, uci, best, bestPv = [], replyPv = [], prev, next, color, wpBefore, wpAfter, clock, baseTime } = ctx;
  const opp = color === 'white' ? 'black' : 'white';
  const sign = color === 'white' ? 1 : -1;
  const prevMate = prev?.mate !== undefined && prev?.mate !== null ? prev.mate * sign : null;
  const nextMate = next?.mate !== undefined && next?.mate !== null ? next.mate * sign : null;
  if (nextMate !== null && nextMate < 0) tags.push('allowed_mate');
  if (prevMate !== null && prevMate > 0 && !(nextMate !== null && nextMate > 0)) tags.push('missed_mate');

  // What the played move allowed: material lost over the move + the opponent's best line (4 plies).
  const after = before.clone();
  const played = moveFromUci(after, uci);
  if (played) after.play(played);
  const reply = replyPv[0] ? moveFromUci(after, replyPv[0]) : null;
  if (played && reply && !tags.includes('allowed_mate')) {
    const lost = -swing(before, [uci, ...replyPv.slice(0, 3)], 4, color);
    const afterReply = after.clone();
    afterReply.play(reply);
    const fork = forks(afterReply.board, opp).some(f => f.piece.endsWith(squareName(reply.to)));
    if (lost >= 2) {
      if (fork) tags.push('allowed_fork');
      else if (after.board.has(reply.to) && makeSan(after, reply).includes('x')) tags.push('hung_piece');
      else tags.push('allowed_tactic');
    }
  }

  // What the best move would have achieved.
  if (best && best !== uci) {
    const bm = moveFromUci(before, best);
    if (bm) {
      const gain = swing(before, bestPv.slice(0, 4), 4, color);
      if (gain >= 2 && !tags.includes('missed_mate')) {
        const b3 = before.clone();
        b3.play(bm);
        const capturedRole = before.board.getRole(bm.to);
        const immediate = capturedRole ? VALUE[capturedRole] - see(b3.board, bm.to, opp) : 0;
        if (forks(b3.board, color).some(f => f.piece.endsWith(squareName(bm.to)))) tags.push('missed_fork');
        else if (immediate >= 2) tags.push('missed_capture');
        else tags.push('missed_tactic');
      }
    }
  }

  if (wpBefore >= 70 && wpAfter < 55) tags.push('failed_conversion');
  if (clock !== null && clock !== undefined && clock < Math.max(30, (baseTime || 0) * 0.1)) tags.push('time_trouble');
  const material = ['allowed_mate', 'missed_mate', 'hung_piece', 'allowed_fork', 'allowed_tactic', 'missed_capture', 'missed_fork', 'missed_tactic'];
  if (!tags.some(t => material.includes(t))) tags.push('positional');
  return tags;
}
