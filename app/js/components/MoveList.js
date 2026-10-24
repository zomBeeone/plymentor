// Move list with variations and comments (lichess column style).
import { html, useEffect, useRef } from '../../vendor/preact.js';
import { cls, GLYPH, formatScore } from '../util.js';

const NAG_GLYPH = { 1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!' };
const NAG_CLASS = { 1: 'best', 2: 'mistake', 3: 'great', 4: 'blunder', 6: 'inaccuracy' };

function glyphOf(node) {
  const c = node.judge?.classification;
  if (c && GLYPH[c]) return html`<span class=${cls('glyph', c)} title=${c}>${GLYPH[c]}</span>`;
  const nag = node.nags?.find(n => NAG_GLYPH[n]);
  if (nag) return html`<span class=${cls('glyph', NAG_CLASS[nag])}>${NAG_GLYPH[nag]}</span>`;
  return null;
}

/**
 * Brings the current move into view by scrolling the list's own panel only. (scrollIntoView would also scroll the
 * page around it — the window's whole content, which cannot be scrolled back.)
 */
function reveal(el) {
  let box = el.parentElement;
  while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box) return;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top);
}

function VarLine({ start, current, onSelect }) {
  const out = [];
  let n = start;
  let first = true;
  while (n) {
    const node = n;
    const num = node.color === 'white' ? `${node.moveNumber}.` : first ? `${node.moveNumber}...` : '';
    out.push(
      html`<span class=${cls('vm', node === current && 'active')} onClick=${() => onSelect(node)}><span class="num">${num}</span>${node.san}${glyphOf(node)}</span> `,
    );
    const p = node.parent;
    if (!first && p.children[0] === node && p.children.length > 1) {
      for (const alt of p.children.slice(1)) out.push(html`(<${VarLine} start=${alt} current=${current} onSelect=${onSelect} />) `);
    }
    if (node.comments?.length) out.push(html`<span class="muted">{${node.comments.join(' ')}} </span>`);
    first = false;
    n = node.children[0];
  }
  return out;
}

/** props: tree, current, onSelect(node), result, showEvals */
export function MoveList({ tree, current, onSelect, result }) {
  const ref = useRef();
  useEffect(() => {
    const el = ref.current?.querySelector('.active');
    if (el) reveal(el);
  }, [current, tree.version]);

  const rows = [];
  const main = tree.mainline().slice(1);
  for (const node of main) {
    if (node.color === 'white') rows.push({ num: node.moveNumber, white: node, black: null });
    else {
      const last = rows[rows.length - 1];
      if (last && !last.extra && last.white && !last.black && !last.closed && last.num === node.moveNumber) last.black = node;
      else rows.push({ num: node.moveNumber, white: null, black: node });
    }
    const alternatives = node.parent.children.slice(1);
    if (node.comments?.length || alternatives.length) {
      rows[rows.length - 1].closed = true;
      rows.push({ extra: true, node, alternatives });
    }
  }

  const cell = node => {
    if (!node) return html`<div class="ml-move empty">…</div>`;
    const ev = node.score ? formatScore(node.score) : node.judge?.scoreAfter ? formatScore(node.judge.scoreAfter) : '';
    return html`<div class=${cls('ml-move', node === current && 'active')} onClick=${() => onSelect(node)}>
      <span>${node.san}</span>${glyphOf(node)}${ev && html`<span class="ev">${ev}</span>`}
    </div>`;
  };

  return html`
    <div class="movelist" ref=${ref}>
      ${!main.length && html`<div class="empty">No moves yet — play a move on the board.</div>`}
      ${rows.map(r =>
        r.extra
          ? html`${r.node.comments?.length ? html`<div class="ml-comment">${r.node.comments.join(' ')}</div>` : null}
            ${r.alternatives.length
              ? html`<div class="ml-vars">${r.alternatives.map(a => html`<div class="ml-var"><${VarLine} start=${a} current=${current} onSelect=${onSelect} /></div>`)}</div>`
              : null}`
          : html`<div class="ml-line"><div class="ml-idx">${r.num}</div>${cell(r.white)}${cell(r.black)}</div>`,
      )}
      ${result && result !== '*' && main.length ? html`<div class="ml-result">${result}</div>` : null}
    </div>
  `;
}
