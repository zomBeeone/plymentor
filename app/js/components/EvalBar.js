import { html } from '../../vendor/preact.js';
import { winPercent, formatScore, cls } from '../util.js';
import { tryPos } from '../chess.js';

/**
 * Vertical evaluation bar: White's share from the bottom (or top when the board is flipped). fen: at a checkmate the
 * bar is all the winner's, whatever the score. off: Stockfish is off on the screen — no bar, but its room stays, so
 * the board does not move when the student switches it.
 */
export function EvalBar({ score, fen, orientation = 'white', off = false }) {
  const pos = fen ? tryPos(fen) : null;
  const s = pos?.isCheckmate() ? { mated: pos.turn } : score;
  const wp = s ? winPercent(s) : 50;
  const label = s ? formatScore(s) : '';
  const whiteBetter = wp >= 50;
  return html`
    <div class=${cls('eval-bar', orientation === 'black' && 'flipped', off && 'off')} aria-hidden=${off ? 'true' : undefined} title=${label ? `Evaluation ${label}` : 'Evaluation'}>
      <div class="white" style=${{ height: `${wp}%` }}></div>
      <div class="tick"></div>
      ${label &&
      html`<div class="label" style=${whiteBetter ? { bottom: '3px', color: '#333' } : { top: '3px', color: '#eee' }}>${label.replace('+', '')}</div>`}
    </div>
  `;
}
