// A board to set up a position on (the Book reader: a diagram read wrong, or not read, set right by the student). Pieces
// are dragged from square to square, off the board to take them away, or put on squares from the pieces around it: a
// piece chosen there goes on each square clicked (dragged from there, on the square it is dropped on); the ✕ takes away
// the piece of each square clicked. The side to move goes with the position. Save checks the position can be played.
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { Chessground } from '../../vendor/chessground.js';
import { posFromFen } from '../chess.js';
import { pieceUrl } from '../board-theme.js';
import { state } from '../store.js';
import { cls } from '../util.js';

const ROLES = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
const NAMES = { king: 'king', queen: 'queen', rook: 'rook', bishop: 'bishop', knight: 'knight', pawn: 'pawn' };

/** The castling a position may still have: each king and rook on its square. */
function castlingOf(placement) {
  const s = placement.split('/').map(r => r.replace(/\d/g, d => '.'.repeat(Number(d)))).join('');
  let c = '';
  if (s[60] === 'K') c += (s[63] === 'R' ? 'K' : '') + (s[56] === 'R' ? 'Q' : '');
  if (s[4] === 'k') c += (s[7] === 'r' ? 'k' : '') + (s[0] === 'r' ? 'q' : '');
  return c || '-';
}

/** Why a position cannot be played, in words (chessops' reasons), or null. */
export function positionProblem(placement, side) {
  try {
    posFromFen(`${placement} ${side} ${castlingOf(placement)} - 0 1`);
    return null;
  } catch (e) {
    const m = String(e.message || e).toUpperCase();
    if (m.includes('EMPTY')) return 'The board is empty.';
    if (m.includes('KINGS')) return 'Each side needs exactly one king.';
    if (m.includes('BACKRANK')) return 'A pawn cannot stand on the first or the last rank.';
    if (m.includes('CHECK')) return side === 'w' ? "Black's king is in check, but it is White's move." : "White's king is in check, but it is Black's move.";
    return 'This position cannot be played.';
  }
}

/**
 * props: placement (a FEN's piece placement), side ('w' | 'b'), orientation, title, onSave(placement, side), onCancel().
 */
export function BoardEditor({ placement, side: side0 = 'w', orientation = 'white', title = '', onSave, onCancel }) {
  const el = useRef();
  const cg = useRef();
  const [brush, setBrush] = useState(null); // { role, color } | 'erase' | null (pieces move)
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const [side, setSide] = useState(side0 === 'b' ? 'b' : 'w');
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    cg.current = Chessground(el.current, {
      fen: placement || '8/8/8/8/8/8/8/8',
      orientation,
      coordinates: state.settings?.board?.coords !== false,
      movable: { free: true, color: 'both', showDests: false },
      draggable: { enabled: true, deleteOnDropOff: true, showGhost: true },
      premovable: { enabled: false },
      selectable: { enabled: true },
      highlight: { lastMove: false, check: false },
      animation: { enabled: false },
      drawable: { enabled: false },
      events: {
        select: key => {
          // (✕: the piece on the square clicked goes)
          if (brushRef.current === 'erase') {
            cg.current.setPieces(new Map([[key, undefined]]));
            cg.current.selectSquare(null);
          }
          setProblem(null);
        },
        change: () => setProblem(null),
      },
    });
    const ro = new ResizeObserver(() => cg.current?.redrawAll());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      cg.current?.destroy();
      cg.current = null;
    };
  }, []);

  // a piece chosen around the board: dropped on each square clicked; the ✕ and moving pieces: no dropping
  useEffect(() => {
    const c = cg.current;
    if (!c) return;
    const piece = brush && brush !== 'erase' ? brush : null;
    c.set({ dropmode: { active: !!piece, piece: piece || undefined }, movable: { free: true, color: brush === 'erase' ? undefined : 'both' } });
    c.selectSquare(null);
  }, [brush]);

  const choose = (e, piece) => {
    const same = brush && brush !== 'erase' && brush.role === piece.role && brush.color === piece.color;
    setBrush(same ? null : piece);
    // (dragged from here: dropped on a square of the board)
    if (!same && e.button === 0) cg.current?.dragNewPiece({ ...piece }, e, true);
  };
  const set = state.settings?.board?.pieces || 'cburnett';
  const row = color =>
    html`<div class="be-pieces">
      ${ROLES.map(
        role =>
          html`<button
            type="button"
            class=${cls('be-piece', brush && brush !== 'erase' && brush.role === role && brush.color === color && 'active')}
            title=${`Put a ${color} ${NAMES[role]} on the squares you click (or drag it to a square)`}
            style=${{ backgroundImage: `url(${pieceUrl(set, color, role)})` }}
            onMouseDown=${e => choose(e, { role, color })}
          ></button>`,
      )}
    </div>`;
  const save = () => {
    const placed = cg.current.getFen();
    const why = positionProblem(placed, side);
    if (why) return setProblem(why);
    onSave(placed, side);
  };
  const top = orientation === 'white' ? 'black' : 'white';

  return html`<div class="board-editor">
    ${title && html`<div class="be-title">${title}</div>`}
    ${row(top)}
    <div class="board-wrap be-board"><div ref=${el}></div></div>
    ${row(top === 'white' ? 'black' : 'white')}
    <div class="be-tools">
      <button type="button" class=${cls('btn small', !brush && 'active')} title="Drag pieces from square to square; drag one off the board to take it away" onClick=${() => setBrush(null)}>✥ Move</button>
      <button type="button" class=${cls('btn small', brush === 'erase' && 'active')} title="Take away the piece of each square you click" onClick=${() => setBrush(brush === 'erase' ? null : 'erase')}>✕ Remove</button>
      <button type="button" class="btn small" title="Take every piece off the board" onClick=${() => (cg.current.set({ fen: '8/8/8/8/8/8/8/8' }), setProblem(null))}>Clear</button>
      <span class="spacer"></span>
      <div class="btn-group" title="The side to move in this position">
        <button type="button" class=${cls('btn small', side === 'w' && 'active')} onClick=${() => (setSide('w'), setProblem(null))}>White to move</button>
        <button type="button" class=${cls('btn small', side === 'b' && 'active')} onClick=${() => (setSide('b'), setProblem(null))}>Black to move</button>
      </div>
    </div>
    ${problem && html`<div class="be-problem">${problem}</div>`}
    <div class="be-actions">
      <button type="button" class="btn" onClick=${onCancel}>Cancel</button>
      <button type="button" class="btn primary" onClick=${save}>Save the position</button>
    </div>
  </div>`;
}
