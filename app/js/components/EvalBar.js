import { html } from '../../vendor/preact.js';
import { winPercent, formatScore, cls } from '../util.js';

/** Vertical evaluation bar: White's share from the bottom (or top when the board is flipped). */
export function EvalBar({ score, orientation = 'white' }) {
  const wp = score ? winPercent(score) : 50;
  const label = score ? formatScore(score) : '';
  const whiteBetter = wp >= 50;
  return html`
    <div class=${cls('eval-bar', orientation === 'black' && 'flipped')} title=${label ? `Evaluation ${label}` : 'Evaluation'}>
      <div class="white" style=${{ height: `${wp}%` }}></div>
      <div class="tick"></div>
      ${label &&
      html`<div class="label" style=${whiteBetter ? { bottom: '3px', color: '#333' } : { top: '3px', color: '#eee' }}>${label.replace('+', '')}</div>`}
    </div>
  `;
}
