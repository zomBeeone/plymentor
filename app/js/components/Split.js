// Panels resized by pulling on their sides: a handle in the gap between two of them. What grows takes its room from its
// neighbour, within limits (nothing gets too small to use, the board no taller than the window lets it). The sizes are
// kept only while the app runs — CSS variables on the screen's root, on no disk —: every start is the default layout.
import { html, useLayoutEffect, useRef } from '../../vendor/preact.js';
import { cls } from '../util.js';

const sizes = new Map(); // a screen's name → { '--board-size': '612px', … }, what the student pulled its panels to

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const px = n => `${Math.round(n)}px`;

/**
 * The sizes of a screen: { root (its element's ref), set(vars) }. fit(root, set): puts them right when the window changes
 * — only once the student has resized something: until then the screen is as its style sheet says.
 */
export function useSplit(screen, fit) {
  const root = useRef(null);
  const set = vars => {
    sizes.set(screen, { ...sizes.get(screen), ...vars });
    for (const [k, v] of Object.entries(vars)) root.current?.style.setProperty(k, v);
  };
  useLayoutEffect(() => {
    for (const [k, v] of Object.entries(sizes.get(screen) || {})) root.current?.style.setProperty(k, v);
    if (!fit) return;
    const refit = () => sizes.has(screen) && root.current && fit(root.current, set);
    refit();
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, [screen]);
  return { root, set };
}

/**
 * A handle in the gap beside its parent (axis 'x': pulled sideways; 'y': up and down). begin(): what the drag starts from
 * (nothing: no drag); onDrag(how far from where it started, that).
 */
export function Splitter({ axis = 'x', left = false, begin, onDrag, title, style }) {
  const down = e => {
    if (e.button !== 0) return;
    const from = begin();
    if (!from) return;
    e.preventDefault();
    const el = e.currentTarget;
    const at = axis === 'x' ? e.clientX : e.clientY;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    document.body.classList.add('resizing', `resizing-${axis}`);
    const move = ev => onDrag((axis === 'x' ? ev.clientX : ev.clientY) - at, from);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing', `resizing-${axis}`);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return html`<div class=${cls('split', `split-${axis}`, left && 'at-left')} style=${style} title=${title || 'Drag to resize'} onPointerDown=${down}></div>`;
}

// ---------------------------------------------------------------------------------------------
// The board screens (.workspace): the board's column, the middle column (above 1280 px), the side column

const BOARD_MIN = 260;
const MIDDLE_MIN = 220;
const BAR = 22; // (the board's column is this much wider than the board: its evaluation bar)
const number = (root, name, or) => parseFloat(getComputedStyle(root).getPropertyValue(name)) || or;

function workspace(root) {
  const wrap = root.querySelector('.board-col .board-wrap');
  if (!wrap) return null;
  const middle = root.querySelector('.side-col.middle');
  const side = root.querySelector('.side-col:not(.middle)');
  const mid = middle?.offsetWidth || 0;
  return {
    board: wrap.offsetWidth,
    mid,
    side: side?.offsetWidth || 0,
    sideMin: root.classList.contains('two') ? 360 : mid ? 340 : 330,
    maxBoard: window.innerHeight - number(root, '--topbar', 50) - number(root, '--board-reserve', 118),
  };
}

function fitWorkspace(root, set) {
  const s = workspace(root);
  if (!s) return;
  let board = Math.max(BOARD_MIN, Math.min(s.board, s.maxBoard));
  let mid = s.mid;
  // (padding 24, a gap of 12 between the columns: first the middle column gives way, then the board)
  let over = board + BAR + mid + s.sideMin + 24 + (mid ? 24 : 12) - root.clientWidth;
  if (over > 0 && mid) {
    const give = Math.min(over, mid - MIDDLE_MIN);
    mid -= give;
    over -= give;
  }
  if (over > 0) board = Math.max(BOARD_MIN, board - over);
  const vars = {};
  if (board !== s.board) vars['--board-size'] = px(board);
  if (mid !== s.mid) vars['--mid-w'] = px(mid);
  if (Object.keys(vars).length) set(vars);
}

/**
 * The handles of a board screen: { root, set, board (the handle beside the board), middle (beside the middle column) }.
 * The board takes its room from the column next to it, and gives it back.
 */
export function useBoardSplits(screen) {
  const { root, set } = useSplit(screen, fitWorkspace);
  const begin = () => workspace(root.current);
  const moveBoard = (dx, s) => {
    const room = s.mid ? s.mid - MIDDLE_MIN : s.side - s.sideMin;
    const board = clamp(s.board + dx, BOARD_MIN, Math.max(BOARD_MIN, Math.min(s.maxBoard, s.board + room)));
    set({ '--board-size': px(board), ...(s.mid ? { '--mid-w': px(s.mid - (board - s.board)) } : {}) });
  };
  const moveMiddle = (dx, s) => set({ '--mid-w': px(clamp(s.mid + dx, MIDDLE_MIN, Math.max(MIDDLE_MIN, s.mid + s.side - s.sideMin))) });
  return {
    root,
    set,
    board: html`<${Splitter} title="Drag to resize the board" begin=${begin} onDrag=${moveBoard} />`,
    middle: html`<${Splitter} title="Drag to resize these panels" begin=${begin} onDrag=${moveMiddle} />`,
  };
}

// ---------------------------------------------------------------------------------------------
// The Book reader: the page, and the column of the board and the panel under it

const READER = { side: 320, main: 320, board: 200, panel: 190, gap: 8 };

function reader(root) {
  const side = root.querySelector('.book-side');
  const main = root.querySelector('.book-main');
  const wrap = side?.querySelector('.board-wrap, .be-board');
  if (!wrap || !main) return null;
  // (what else the column holds: the room left for the board, the panel under it at its smallest)
  const rest = [...side.children].filter(c => !c.matches('.board-area, .board-editor, .panel.grow, .book-coach, .split, .split-slot'));
  const taken = rest.reduce((n, c) => n + c.offsetHeight, 0) + READER.gap * (rest.length + 1);
  return { side: side.offsetWidth, main: main.offsetWidth, board: wrap.offsetWidth, maxBoard: side.clientHeight - taken - READER.panel };
}

function fitReader(root, set) {
  const s = reader(root);
  if (!s) return;
  const side = clamp(s.side, READER.side, Math.max(READER.side, root.clientWidth - 24 - 12 - READER.main));
  const board = clamp(s.board, READER.board, Math.max(READER.board, Math.min(side - 26, s.maxBoard)));
  const vars = {};
  if (side !== s.side) vars['--side-w'] = px(side);
  if (board !== s.board) vars['--board-size'] = px(board);
  if (Object.keys(vars).length) set(vars);
}

/** The handles of the Book reader: { root, page (between the page and the board's column), board (under the board) }. */
export function useReaderSplits() {
  const { root, set } = useSplit('books', fitReader);
  const begin = () => reader(root.current);
  const moveSide = (dx, s) => {
    const side = clamp(s.side - dx, READER.side, Math.max(READER.side, s.side + s.main - READER.main));
    const board = clamp(s.board + (side - s.side), READER.board, Math.max(READER.board, Math.min(side - 26, s.maxBoard)));
    set({ '--side-w': px(side), '--board-size': px(board) });
  };
  const moveBoard = (dy, s) => set({ '--board-size': px(clamp(s.board + dy, READER.board, Math.max(READER.board, Math.min(s.side - 26, s.maxBoard)))) });
  return {
    root,
    page: html`<${Splitter} left title="Drag to resize the page and the board" begin=${begin} onDrag=${moveSide} />`,
    board: html`<div class="split-slot"><${Splitter} axis="y" title="Drag to resize the board and the panel under it" begin=${begin} onDrag=${moveBoard} /></div>`,
  };
}
