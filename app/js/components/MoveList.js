// Move list with variations (lichess column style). A move with comments gets a small mark — its comments are its
// tooltip —, and the comments of the move on the board are read in MoveComment, under the list: one move's at a time,
// so a richly annotated game stays a list of moves.
import { html, useEffect, useRef } from '../../vendor/preact.js';
import { cls, GLYPH, formatScore } from '../util.js';
import { commentsOf } from '../tree.js';

const NAG_GLYPH = { 1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!' };
const NAG_CLASS = { 1: 'best', 2: 'mistake', 3: 'great', 4: 'blunder', 6: 'inaccuracy' };
// the assessments a PGN gives a move or its position, as books print them
const NAG_SIGN = {
  7: ['□', 'the only move'],
  10: ['=', 'equal'],
  13: ['∞', 'unclear'],
  14: ['⩲', 'White is slightly better'],
  15: ['⩱', 'Black is slightly better'],
  16: ['±', 'White is better'],
  17: ['∓', 'Black is better'],
  18: ['+−', 'White is winning'],
  19: ['−+', 'Black is winning'],
  22: ['⨀', 'zugzwang'],
  23: ['⨀', 'zugzwang'],
  32: ['⟳', 'lead in development'],
  33: ['⟳', 'lead in development'],
  36: ['↑', 'initiative'],
  37: ['↑', 'initiative'],
  40: ['→', 'attack'],
  41: ['→', 'attack'],
  132: ['⇆', 'counterplay'],
  133: ['⇆', 'counterplay'],
  140: ['∆', 'with the idea'],
  146: ['N', 'novelty'],
};

function glyphOf(node) {
  const c = node.judge?.classification;
  if (c && GLYPH[c]) return html`<span class=${cls('glyph', c)} title=${c}>${GLYPH[c]}</span>`;
  const nag = node.nags?.find(n => NAG_GLYPH[n]);
  if (nag) return html`<span class=${cls('glyph', NAG_CLASS[nag])}>${NAG_GLYPH[nag]}</span>`;
  return null;
}

function signsOf(node) {
  const signs = (node.nags || []).map(n => NAG_SIGN[n]).filter(Boolean);
  return signs.length ? html`<span class="nag-sign" title=${signs.map(s => s[1]).join(', ')}>${signs.map(s => s[0]).join(' ')}</span>` : null;
}

/** The mark of a move with comments (a small speech bubble). */
export const commentMark = () => html`<svg class="cm" viewBox="0 0 16 16" aria-label="has a comment"><path d="M3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7.2L4 13.8V11h-.5A1.5 1.5 0 0 1 2 9.5v-6A1.5 1.5 0 0 1 3.5 2z" /></svg>`;

/** A move's comments as its tooltip. */
const tooltip = texts => {
  const t = texts.join('\n\n');
  return t ? (t.length > 600 ? `${t.slice(0, 600)}…` : t) : undefined;
};

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

function VarLine({ start, current, onSelect, notes }) {
  const out = [];
  let n = start;
  let first = true;
  while (n) {
    const node = n;
    const num = node.color === 'white' ? `${node.moveNumber}.` : first ? `${node.moveNumber}...` : '';
    const texts = notes(node);
    out.push(
      html`<span class=${cls('vm', node === current && 'active')} title=${tooltip(texts)} onClick=${() => onSelect(node)}><span class="num">${num}</span>${node.san}${glyphOf(node)}${signsOf(node)}${texts.length ? commentMark() : null}</span> `,
    );
    const p = node.parent;
    if (!first && p.children[0] === node && p.children.length > 1) {
      for (const alt of p.children.slice(1)) out.push(html`(<${VarLine} start=${alt} current=${current} onSelect=${onSelect} notes=${notes} />) `);
    }
    first = false;
    n = node.children[0];
  }
  return out;
}

/** props: tree, current, onSelect(node), result, comments (a node's comments; default its own from the PGN) */
export function MoveList({ tree, current, onSelect, result, comments: notes = commentsOf }) {
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
    if (alternatives.length) {
      rows[rows.length - 1].closed = true;
      rows.push({ extra: true, node, alternatives });
    }
  }

  const cell = node => {
    if (!node) return html`<div class="ml-move empty">…</div>`;
    const ev = node.score ? formatScore(node.score) : node.judge?.scoreAfter ? formatScore(node.judge.scoreAfter) : '';
    const texts = notes(node);
    return html`<div class=${cls('ml-move', node === current && 'active')} title=${tooltip(texts)} onClick=${() => onSelect(node)}>
      <span>${node.san}</span>${glyphOf(node)}${signsOf(node)}${texts.length ? commentMark() : null}${ev && html`<span class="ev">${ev}</span>`}
    </div>`;
  };
  const intro = notes(tree.root);

  return html`
    <div class="movelist" ref=${ref}>
      ${intro.length ? html`<div class=${cls('ml-intro', current === tree.root && 'active')} title=${tooltip(intro)} onClick=${() => onSelect(tree.root)}>${commentMark()}<span>Before the first move</span></div>` : null}
      ${!main.length && html`<div class="empty">No moves yet — play a move on the board.</div>`}
      ${rows.map(r =>
        r.extra
          ? html`<div class="ml-vars">${r.alternatives.map(a => html`<div class="ml-var"><${VarLine} start=${a} current=${current} onSelect=${onSelect} notes=${notes} /></div>`)}</div>`
          : html`<div class="ml-line"><div class="ml-idx">${r.num}</div>${cell(r.white)}${cell(r.black)}</div>`,
      )}
      ${result && result !== '*' && main.length ? html`<div class="ml-result">${result}</div>` : null}
    </div>
  `;
}

/**
 * Under the move list: the comments of the move on the board (at the start, those before the first move), or nothing.
 * comments: as for MoveList.
 */
export function MoveComment({ node, comments: notes = commentsOf }) {
  const texts = node ? notes(node) : [];
  if (!texts.length) return null;
  return html`<div class="move-comment">
    <div class="mc-head">${commentMark()}<span>${node.san ? node.label : 'Before the first move'}</span></div>
    ${texts.map(t => html`<p>${t}</p>`)}
  </div>`;
}
