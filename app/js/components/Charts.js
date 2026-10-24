// Small chart primitives for the report dashboard (HTML/CSS, values always visible as text).
import { html } from '../../vendor/preact.js';

export function StatTile({ label, value, sub, title }) {
  return html`<div class="stat" title=${title || ''}>
    <div class="v">${value === null || value === undefined || Number.isNaN(value) ? '–' : value}</div>
    <div class="l">${label}</div>
    ${sub ? html`<div class="s">${sub}</div>` : null}
  </div>`;
}

/** Horizontal bars, one series: items [{ label, value, display, title }]. The value is printed at the bar tip. */
export function BarList({ items, max, color = 'var(--series-1)', labelWidth = 120 }) {
  const m = max ?? Math.max(1, ...items.map(i => i.value || 0));
  return html`<div class="barlist">
    ${items.map(
      it => html`<div class="bl-row" style=${{ gridTemplateColumns: `${labelWidth}px 1fr` }} title=${it.title || `${it.label}: ${it.display ?? it.value}`}>
        <div class="bl-label ellipsis">${it.label}</div>
        <div class="bl-track">
          <div class="bl-bar" style=${{ width: `${Math.max(0.5, ((it.value || 0) / m) * 100)}%`, background: color }}></div>
          <span class="bl-val">${it.display ?? it.value}</span>
        </div>
      </div>`,
    )}
  </div>`;
}

/** Win / draw / loss stacked bars (diverging: win and loss poles, neutral draw), labelled when the segment fits. */
export function ResultBars({ rows }) {
  return html`<div class="col" style="gap:10px">
    ${rows.map(r => {
      const total = r.win + r.draw + r.loss;
      if (!total) return html`<div class="bl-row" style="grid-template-columns:90px 1fr"><div class="bl-label">${r.label}</div><div class="muted">no games</div></div>`;
      const seg = (k, v, ink) =>
        v
          ? html`<div class=${k} style=${{ flex: `${v} 1 0`, background: `var(--${k})`, color: ink }} title=${`${k}: ${v} of ${total}`}>${(v / total) * 100 >= 12 ? v : ''}</div>`
          : null;
      return html`<div class="bl-row" style="grid-template-columns:90px 1fr">
        <div class="bl-label">${r.label}</div>
        <div class="stack">${seg('win', r.win, '#fff')}${seg('draw', r.draw, '#e6e3de')}${seg('loss', r.loss, '#1d1b18')}</div>
      </div>`;
    })}
    <div class="legend"><span><i class="sw" style="background:var(--win)"></i>Win</span><span><i class="sw" style="background:var(--draw)"></i>Draw</span><span><i class="sw" style="background:var(--loss)"></i>Loss</span></div>
  </div>`;
}
