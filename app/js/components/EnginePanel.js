// Live Stockfish lines for the current position.
import { html } from '../../vendor/preact.js';
import { formatScore, scoreSide, cls } from '../util.js';
import { formatSanLine } from '../chess.js';

/** props: fen, data (from useLiveEval), enabled, onToggle, multipv, onMultipv, onPlay(uci) */
export function EnginePanel({ fen, data, enabled, onToggle, multipv, onMultipv, onPlay, compact }) {
  const lines = data?.lines || [];
  const top = lines[0];
  const knps = data?.nps ? Math.round(data.nps / 1000) : null;
  return html`
    <div class="engine">
      <div class="engine-head">
        <button class=${cls('switch', enabled && 'on')} title="Toggle Stockfish (local)" onClick=${onToggle}></button>
        <div class="big">${enabled ? (data?.gameOver ? '–' : top ? formatScore(top.score) : '…') : ''}</div>
        <div class="info grow ellipsis">
          ${!enabled
            ? 'Stockfish off'
            : data?.error
              ? html`<span style="color:#f0a0a0">${data.error}</span>`
              : data?.gameOver
                ? data.gameOver
                : html`Stockfish · depth ${data?.depth || 0}${knps ? ` · ${knps.toLocaleString()} kN/s` : ''}${data?.done ? ' · done' : ''}`}
        </div>
        ${!compact &&
        html`<div class="btn-group">
          ${[1, 2, 3, 5].map(n => html`<button class=${cls('btn small', multipv === n && 'active')} title=${`${n} line${n > 1 ? 's' : ''}`} onClick=${() => onMultipv(n)}>${n}</button>`)}
        </div>`}
      </div>
      ${enabled &&
      lines.map(
        l => html`
          <div class="pv" onClick=${() => l.pv?.[0] && onPlay?.(l.pv[0])} title="Click to play the first move">
            <span class=${cls('score', scoreSide(l.score))}>${formatScore(l.score)}</span>
            <span class="moves-text">${renderLine(fen, l.san || [])}</span>
          </div>
        `,
      )}
      ${enabled && !lines.length && !data?.gameOver && !data?.error && html`<div class="pv muted">Thinking…</div>`}
    </div>
  `;
}

function renderLine(fen, sans) {
  const parts = formatSanLine(fen, sans.slice(0, 14)).split(' ');
  const n = /\.$/.test(parts[0]) ? 2 : 1;
  return html`<b>${parts.slice(0, n).join(' ')}</b> ${parts.slice(n).join(' ')}`;
}
