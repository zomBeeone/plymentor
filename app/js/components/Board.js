// Chessground (lichess board) wrapped as a Preact component, with a promotion picker.
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { Chessground } from '../../vendor/chessground.js';
import { tryPos, dests as destsOf, isPromotion, turnOf } from '../chess.js';
import { pieceUrl } from '../board-theme.js';
import { state } from '../store.js';

const GLYPH_COLORS = { great: '#0ca30c', inaccuracy: '#fab219', mistake: '#ec835a', blunder: '#d03b3b' };
const GLYPHS = { great: '!!', inaccuracy: '?!', mistake: '?', blunder: '??' };

/** A judgement badge drawn in the corner of a square (chessground custom SVG, 100x100 square space). */
export function glyphShape(square, classification) {
  const g = GLYPHS[classification];
  if (!g) return null;
  const fill = GLYPH_COLORS[classification];
  const fontSize = g.length > 1 ? 40 : 52;
  return {
    orig: square,
    customSvg: {
      html: `<g transform="translate(64 -6) scale(0.42)"><circle cx="50" cy="50" r="46" fill="${fill}" stroke="#1d1b18" stroke-width="7"/><text x="50" y="50" dy="0.35em" font-size="${fontSize}" font-weight="700" font-family="system-ui,sans-serif" text-anchor="middle" fill="#fff">${g}</text></g>`,
    },
  };
}

/** A FEN's piece placement with the pieces on `squares` (names: "h1") left out. */
function without(placement, squares) {
  if (!squares?.length) return placement;
  const rows = placement.split('/').map(r => [...r.replace(/\d/g, d => '.'.repeat(Number(d)))]);
  for (const sq of squares) if (rows[8 - Number(sq[1])]) rows[8 - Number(sq[1])]['abcdefgh'.indexOf(sq[0])] = '.';
  return rows.map(r => r.join('').replace(/\.+/g, m => String(m.length))).join('/');
}

function cgConfig(p) {
  const pos = tryPos(p.fen);
  const turn = turnOf(p.fen);
  const canMove = !!pos && !p.viewOnly && !!p.movable && (p.movable === 'both' || p.movable === turn);
  return {
    fen: without(String(p.fen).split(' ')[0], p.hide),
    orientation: p.orientation || 'white',
    turnColor: turn,
    lastMove: p.lastMove && p.lastMove.length === 2 ? p.lastMove : undefined,
    check: pos && pos.isCheck() ? turn : false,
    coordinates: p.coordinates !== false && state.settings?.board?.coords !== false,
    viewOnly: !!p.viewOnly,
    movable: { free: false, color: canMove ? turn : undefined, dests: canMove ? destsOf(pos) : new Map(), showDests: true },
    drawable: { enabled: !p.viewOnly, visible: true, autoShapes: (p.shapes || []).filter(Boolean) },
    highlight: { lastMove: true, check: true, custom: new Map(Object.entries(p.highlights || {})) },
    animation: { enabled: p.animation !== false, duration: 180 },
    premovable: { enabled: false },
    draggable: { enabled: !p.viewOnly, showGhost: true },
    selectable: { enabled: !p.viewOnly },
  };
}

/**
 * props: fen, orientation, lastMove [orig, dest], movable ('both'|'white'|'black'|false), onMove(uci),
 *        shapes (auto shapes), highlights { square: class }, viewOnly, banner, onClick, hide (squares whose pieces
 *        are not shown — the position keeps them: a king the Book reader put in where a book's diagram has none)
 */
export function Board(props) {
  const el = useRef();
  const cg = useRef();
  const propsRef = useRef(props);
  propsRef.current = props;
  const [promo, setPromo] = useState(null);
  const lastFen = useRef(props.fen);
  const lastOrientation = useRef(props.orientation);
  const resyncing = useRef(false);

  // chessground rebuilds the board on redrawAll() (a resize, a new orientation). A redraw it had already scheduled
  // for the old board can then run later and leave the arrows (SVG layer) out of date — e.g. the engine's arrow from
  // the previous position stays on screen. Rebuilding once more, two frames later, puts the screen back in sync.
  const resyncSoon = () => {
    if (resyncing.current) return;
    resyncing.current = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        resyncing.current = false;
        const e = el.current;
        if (cg.current && e?.isConnected && e.offsetWidth > 0 && e.offsetHeight > 0) cg.current.redrawAll();
      }),
    );
  };

  useEffect(() => {
    const config = cgConfig(props);
    config.movable.events = {
      after: (orig, dest) => {
        const p = propsRef.current;
        const pos = tryPos(p.fen);
        if (pos && isPromotion(pos, orig, dest)) {
          setPromo({ orig, dest, color: pos.turn });
          return;
        }
        p.onMove?.(orig + dest);
        setTimeout(() => cg.current?.set(cgConfig(propsRef.current)), 0);
      },
    };
    cg.current = Chessground(el.current, config);
    // Redraw on resize, but never for a detached or hidden board: chessground would measure 0×0
    // and draw arrows with NaN coordinates.
    const ro = new ResizeObserver(() => {
      const e = el.current;
      if (cg.current && e?.isConnected && e.offsetWidth > 0 && e.offsetHeight > 0) {
        cg.current.redrawAll();
        resyncSoon();
      }
    });
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      // a redraw scheduled after the element leaves the page would draw arrows at 0×0 size
      cg.current?.setAutoShapes([]);
      cg.current?.setShapes([]);
      cg.current?.destroy();
      cg.current = null;
    };
  }, []);

  useEffect(() => {
    if (!cg.current) return;
    if (lastFen.current !== props.fen) {
      cg.current.setShapes([]);
      lastFen.current = props.fen;
    }
    cg.current.set(cgConfig(props));
    if (lastOrientation.current !== props.orientation) {
      lastOrientation.current = props.orientation;
      resyncSoon(); // a new orientation rebuilds the board (see resyncSoon)
    }
  }, [props.fen, props.orientation, props.lastMove?.join(), props.movable, props.viewOnly, JSON.stringify(props.shapes || []), JSON.stringify(props.highlights || {}), (props.hide || []).join()]);

  const choose = role => {
    const p = propsRef.current;
    const letter = { queen: 'q', rook: 'r', bishop: 'b', knight: 'n' }[role];
    const m = promo;
    setPromo(null);
    if (role) p.onMove?.(m.orig + m.dest + letter);
    setTimeout(() => cg.current?.set(cgConfig(propsRef.current)), 0);
  };
  const set = state.settings?.board?.pieces || 'cburnett';

  return html`
    <div class="board-wrap" onClick=${props.onClick}>
      <div ref=${el}></div>
      ${props.banner && html`<div class="board-banner">${props.banner}</div>`}
      ${promo &&
      html`<div class="promotion" onClick=${() => choose(null)}>
        <div class="choices" onClick=${e => e.stopPropagation()}>
          ${['queen', 'knight', 'rook', 'bishop'].map(
            role =>
              html`<button title=${role} style=${{ backgroundImage: `url(${pieceUrl(set, promo.color, role)})` }} onClick=${() => choose(role)}></button>`,
          )}
        </div>
      </div>`}
    </div>
  `;
}
