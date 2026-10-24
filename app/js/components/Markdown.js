// Renders the coach's Markdown. ```board blocks become clickable mini-boards; special links
// (game:ID@PLY, lesson:topic) navigate inside the app. Raw HTML is escaped.
import { html, useMemo } from '../../vendor/preact.js';
import { Marked } from '../../vendor/marked.js';
import { Board } from './Board.js';
import { tryPos, fenOf } from '../chess.js';
import { escapeHtml } from '../util.js';

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    html(token) {
      return escapeHtml(token.text ?? token.raw ?? '');
    },
    image(token) {
      return escapeHtml(token.text || '');
    },
    link(token) {
      const href = String(token.href || '');
      const text = this.parser.parseInline(token.tokens);
      if (/^https?:\/\//i.test(href)) return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      if (/^(game|lesson|fen):/i.test(href)) return `<a href="#" class="special" data-href="${escapeHtml(href)}">${text}</a>`;
      if (/^#\//.test(href)) return `<a href="${escapeHtml(href)}">${text}</a>`;
      return text;
    },
  },
});

const BOARD_RE = /```board[^\n]*\n([\s\S]*?)(```|$)/g;

/** Splits text into markdown and diagram segments (an unclosed block while streaming is marked pending). */
export function splitDiagrams(text) {
  const out = [];
  let last = 0;
  let m;
  BOARD_RE.lastIndex = 0;
  while ((m = BOARD_RE.exec(text))) {
    if (m.index > last) out.push({ type: 'md', text: text.slice(last, m.index) });
    out.push({ type: 'board', spec: m[1], complete: m[2] === '```' });
    last = m.index + m[0].length;
    if (!m[0].length) break;
  }
  if (last < text.length) out.push({ type: 'md', text: text.slice(last) });
  return out;
}

const BRUSH = { g: 'green', r: 'red', b: 'blue', y: 'yellow' };

export function parseDiagram(spec) {
  const d = { fen: null, shapes: [], caption: '', orientation: null };
  for (const raw of spec.split('\n')) {
    const line = raw.trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'fen') d.fen = val;
    else if (key === 'arrows' || key === 'arrow')
      for (const a of val.split(',')) {
        const mm = /([a-h][1-8])\s*-?\s*([a-h][1-8])?\s*([grby])?/i.exec(a.trim());
        if (mm) d.shapes.push({ orig: mm[1].toLowerCase(), dest: mm[2]?.toLowerCase(), brush: BRUSH[(mm[3] || 'g').toLowerCase()] });
      }
    else if (key === 'highlight' || key === 'highlights')
      for (const sq of val.split(/[\s,]+/)) if (/^[a-h][1-8]$/i.test(sq)) d.shapes.push({ orig: sq.toLowerCase(), brush: 'yellow' });
    else if (key === 'caption') d.caption = val;
    else if (key === 'orientation' || key === 'flip') d.orientation = /black|true|yes/i.test(val) ? 'black' : 'white';
  }
  const pos = d.fen && tryPos(d.fen);
  d.valid = !!pos;
  if (pos) d.fen = fenOf(pos);
  if (!d.orientation && pos) d.orientation = pos.turn;
  return d;
}

function Diagram({ spec, complete, onPosition }) {
  const d = useMemo(() => (complete ? parseDiagram(spec) : null), [spec, complete]);
  if (!complete) return html`<div class="diagram bad"><span class="spinner"></span> preparing diagram…</div>`;
  if (!d.valid) return html`<div class="diagram bad">⚠ invalid diagram position</div>`;
  return html`<div class="diagram" title="Click to load on the main board" onClick=${() => onPosition?.(d)}>
    <div class="mini"><${Board} fen=${d.fen} orientation=${d.orientation} shapes=${d.shapes} viewOnly=${true} /></div>
    ${d.caption && html`<div class="cap">${d.caption}</div>`}
  </div>`;
}

/** props: text, onPosition(diagram), onLink(href) */
export function Markdown({ text, onPosition, onLink }) {
  const segments = useMemo(() => splitDiagrams(text || ''), [text]);
  const click = e => {
    const a = e.target.closest('a[data-href]');
    if (!a) return;
    e.preventDefault();
    onLink?.(a.dataset.href);
  };
  return html`<div class="md" onClick=${click}>
    ${segments.map((s, i) =>
      s.type === 'md'
        ? html`<div key=${'m' + i} dangerouslySetInnerHTML=${{ __html: md.parse(s.text) }}></div>`
        : html`<${Diagram} key=${'d' + i} spec=${s.spec} complete=${s.complete} onPosition=${onPosition} />`,
    )}
  </div>`;
}
