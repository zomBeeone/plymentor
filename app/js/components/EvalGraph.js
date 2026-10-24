// Winning chances over the game (White's view), with phase boundaries and mistake/blunder markers.
// The move list is this chart's table view (every evaluation is also shown there).
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { formatScore, GLYPH } from '../util.js';

const MARK = { mistake: { fill: '#ec835a', r: 4 }, blunder: { fill: '#d03b3b', r: 5.5 } };
const SURFACE = '#262421';

/** props: winPercents (per position, White %), scores, moves (analysis moves), division, current (ply), onSelect(ply) */
export function EvalGraph({ winPercents, scores, moves, division, current, onSelect }) {
  const ref = useRef();
  const [w, setW] = useState(520);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const n = (winPercents?.length || 0) - 1;
  const H = 128;
  const top = 16;
  const bottom = 8;
  const left = 4;
  const right = 4;
  const x = i => left + (i / Math.max(1, n)) * (w - left - right);
  const y = wp => top + (1 - wp / 100) * (H - top - bottom);
  const mid = y(50);
  const pts = n >= 1 ? winPercents.map((wp, i) => `${x(i).toFixed(1)},${y(wp).toFixed(1)}`) : [];
  const lineD = pts.length ? `M${pts.join('L')}` : '';
  const areaD = pts.length ? `M${x(0)},${mid}L${pts.join('L')}L${x(n)},${mid}Z` : '';
  const pick = e => {
    const r = ref.current.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - left) / (w - left - right)) * n);
    return Math.max(0, Math.min(n, i));
  };
  const moveAt = ply => moves?.[ply - 1];
  const hv = hover !== null ? moveAt(hover) : null;
  const phases = [
    division?.middle !== undefined && division?.middle !== null ? { ply: division.middle, label: 'Middlegame' } : null,
    division?.end !== undefined && division?.end !== null ? { ply: division.end, label: 'Endgame' } : null,
  ].filter(Boolean);

  return html`
    <div ref=${ref} style="position:relative">
      ${n >= 1 &&
      html`<svg class="eval-graph" width=${w} height=${H} role="img" aria-label="Winning chances over the game, from White's point of view"
        onPointerMove=${e => setHover(pick(e))} onPointerLeave=${() => setHover(null)} onClick=${e => onSelect?.(pick(e))}>
        <line x1=${left} x2=${w - right} y1=${mid} y2=${mid} stroke="#4a4642" stroke-width="1" />
        ${phases.map(
          p => html`<line x1=${x(p.ply)} x2=${x(p.ply)} y1=${top - 4} y2=${H - bottom} stroke="#3d3a36" stroke-width="1" />
            <text x=${x(p.ply) + 3} y=${top - 5} font-size="10" fill="#8d8881">${p.label}</text>`,
        )}
        <path d=${areaD} fill="#3987e5" fill-opacity="0.1" />
        <path d=${lineD} fill="none" stroke="#3987e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <text x=${left + 2} y=${top + 9} font-size="10" fill="#8d8881">White better</text>
        <text x=${left + 2} y=${H - bottom - 3} font-size="10" fill="#8d8881">Black better</text>
        ${current !== null && current !== undefined && current <= n && html`<line x1=${x(current)} x2=${x(current)} y1=${top} y2=${H - bottom} stroke="#c4c1bc" stroke-width="1.5" />`}
        ${(moves || [])
          .filter(m => MARK[m.judgement])
          .map(m => html`<circle cx=${x(m.ply)} cy=${y(winPercents[m.ply])} r=${MARK[m.judgement].r} fill=${MARK[m.judgement].fill} stroke=${SURFACE} stroke-width="2" />`)}
        ${hover !== null && html`<line x1=${x(hover)} x2=${x(hover)} y1=${top} y2=${H - bottom} stroke="#8d8881" stroke-width="1" />`}
      </svg>`}
      ${hover !== null &&
      html`<div style=${{
        position: 'absolute',
        top: '2px',
        left: `${Math.min(Math.max(x(hover) + 10, 0), w - 170)}px`,
        background: '#1d1b18',
        border: '1px solid #3d3a36',
        borderRadius: '6px',
        padding: '4px 8px',
        fontSize: '12px',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}>
        <b style="color:#ece9e4">${formatScore(scores?.[hover])}</b>
        <span class="muted"> ${hv ? `${hv.color === 'white' ? `${hv.moveNumber}.` : `${hv.moveNumber}...`} ${hv.san}${GLYPH[hv.judgement] || ''}${hv.judgement ? ` (${hv.judgement})` : ''}` : 'start'}</span>
      </div>`}
    </div>
  `;
}
