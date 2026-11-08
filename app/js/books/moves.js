// Follows the moves of a chess book in reading order (Book reader): each move written in the text (text.js) is played
// in the position it belongs to and becomes a node of a game tree (tree.js), so the board can show it when the
// reading gets there. Books write a game's main line and its variations together, so the position of a move is found
// the way a reader finds it:
// - by its move number ("13...h6": Black's 13th move) — continuing the line just read, or the main line (back from a
//   variation), or else branching off where that move number is on the line being read or on the main line; when it
//   may be played in more than one of them (the text going back: "55.h7? The correct move is 55.Kg7. 55...Rg1+
//   56.Kh6"), in the one where the moves written after it can be played too; when they can be played in none, a
//   position read not long ago where they can (back from notes to the line they left, or to a game left);
// - without a number, right after a move ("13.Bg5 h6"): the reply to it;
// - after an opening bracket ("13.Bg5 (13.Nd5 …)" or "(Nd7 …)"): an alternative to the move before (numbered or not);
//   the closing bracket goes back to the line the variation left;
// - a move named on its own in a sentence ("Nf3 was possible", "...Nd7 is an idea"): shown from the position just
//   read, without changing the line being followed; a pawn "move" on its own is most often a square ("the d5
//   square"), so it is left alone (unless "...d5" says it is Black's move);
// - "1." of White's first move: a new game from the initial position (unless the moves after it say it is named in a
//   sentence);
// - a move of the side that is not to move, with the position's number ("Black to move loses: 7...Kg3"): what would
//   happen if that side were to move, a game of its own from the position with that side to move;
// - after a puzzle's number ("5194 1.Bb1"), or words naming its diagram by its number ("Exercise 4 (Diagram 61): …
//   1...Rd2+", "if White waits (see diagram 62), 1.Kd2"): from the position of the diagram with that number;
// - a diagram: the position it shows — one of the game being read, when it is there, else a new game from it (after
//   the move its caption says led to it: "Position after: 23. Bd3").
import { Tree } from '../tree.js';
import { posFromFen, uciOf, moveFromUci, fenOf, parseSan, makeSan, repKey, dests, isPromotion, squareIndex, INITIAL_FEN } from '../chess.js';
import { spokenMove, namedDiagram, diagramNumber, misreadings, wordDistance, closeSpellings, rowMoves } from './text.js';
import { descriptiveMoves, spokenDescriptive } from './descriptive.js';

// (a position's move number and side to move, read from its FEN's last field and its second: asked of hundreds of
// positions for each move a note may go back to, see pick)
const fullmove = node => Number(node.fen.slice(node.fen.lastIndexOf(' ') + 1)) || 1;
const turn = node => (node.fen[node.fen.indexOf(' ') + 1] === 'b' ? 'black' : 'white');

// The positions of the FENs looked at last (chessops positions, only read: played on a clone): a book's moves are
// tried in the same few positions over and over (each move, the moves written after it, the moves a scan lost).
const POSITIONS = new Map();
function positionOf(fen) {
  let pos = POSITIONS.get(fen);
  if (pos === undefined) {
    try {
      pos = posFromFen(fen);
    } catch {
      pos = null;
    }
    if (POSITIONS.size >= 512) POSITIONS.clear();
    POSITIONS.set(fen, pos);
  }
  return pos;
}

/** The position after the move `uci` in `pos` (a new one), or null. */
function played(pos, uci) {
  const m = pos && moveFromUci(pos, uci);
  if (!m) return null;
  const next = pos.clone();
  next.play(m);
  return next;
}

// How many of the positions the reading went through last a move may go back to (see pick).
const SEEN = 500;
// The words that make the move after them a side's plan, whatever the other side does first (see MoveTracker.plan) —
// only these: "threatening 4.Kd5" names a side's next move too, but taken so it cost Mastering Endgame Strategy moves.
const PLAN = /\bfollowed\s+by\s*:?\s*$/i;
// How many squares a picture's reading may have wrong and still be a position of the line read (see diagram).
const LOOSE = 14;
// (the text before a move that begins a sentence: a sentence's end, or a variation's)
const SENTENCE_END = /[.!?…)\]]["'”’]*\s+$/;
// (a list's marker closes no bracket: "a)", "2)" starting a line)
const LIST_MARKER = /(?:^|\n|[.:;]\s)\s*[A-Za-z0-9]{1,2}$/;
// (the text before a move that begins a paragraph: a sentence's end and a line break, or a blank line)
const PARA = /(?:[.!?…]["'”’)\]]*[ \t]*\n|\n[ \t]*\n)\s*$/;

/** The move number and side to move `plies` half-moves after a position: { num, side }. */
const afterPlies = (pos, plies) => ({ num: pos.fullmoves + Math.floor((plies + (pos.turn === 'black' ? 1 : 0)) / 2), side: (plies % 2 === 0) === (pos.turn === 'white') ? 'white' : 'black' });

/** The 64 squares of a FEN's piece placement, from a8 to h1: a piece's letter or '.'. */
const squares = placement => placement.split('/').map(r => r.replace(/\d/g, d => '.'.repeat(Number(d)))).join('');
const placementOf = sq => [0, 1, 2, 3, 4, 5, 6, 7].map(r => sq.slice(r * 8, r * 8 + 8).replace(/\.+/g, m => String(m.length))).join('/');
/** The name of square `i` of those (0: a8 … 63: h1). */
const squareName = i => `${'abcdefgh'[i & 7]}${8 - (i >> 3)}`;

/**
 * The squares the board leaves empty for a position of `tree`: the kings the reader put in where the book's diagram
 * has none (`tree.hidden`, see withKings), while each still stands where it was put.
 */
export function hiddenSquares(tree, fen) {
  if (!tree?.hidden || !fen) return [];
  const s = squares(String(fen).split(' ')[0]);
  return tree.hidden.filter(h => s['abcdefgh'.indexOf(h.square[0]) + (8 - Number(h.square[1])) * 8] === h.piece).map(h => h.square);
}
const differ = (a, b) => {
  let n = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) n++;
  return n;
};
/**
 * Whether a picture's reading (squares `a`) may be position `b` with squares misread: most of the pieces it shows
 * stand where the position has them (some of its pieces lost), or most of the position's pieces stand where it shows
 * them (marks drawn on the board, arrows and lines, read as pieces) — not another position with the same pieces
 * elsewhere.
 */
const squaresAlike = (a, b) => {
  let same = 0;
  let shown = 0; // (pieces it shows that the position does not have there)
  let lost = 0; // (pieces of the position it does not show there)
  for (let i = 0; i < 64; i++) {
    if (a[i] !== '.' && a[i] === b[i]) same++;
    else {
      if (a[i] !== '.') shown++;
      if (b[i] !== '.') lost++;
    }
  }
  return same > Math.min(shown, lost);
};

/**
 * Whether a piece placement may be a game's position: a king a side, no pawn on the first or last rank, no more of a
 * piece than a side has (two queens at most).
 */
function possible(placement) {
  const s = squares(placement);
  const count = c => s.split(c).length - 1;
  if (count('K') !== 1 || count('k') !== 1 || /[Pp]/.test(s.slice(0, 8) + s.slice(56))) return false;
  return Object.entries({ P: 8, N: 2, B: 2, R: 2, Q: 2 }).every(([c, most]) => count(c) <= most && count(c.toLowerCase()) <= most);
}

const ROOK_LINES = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const BISHOP_LINES = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const STEPS = { n: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]], k: [...ROOK_LINES, ...BISHOP_LINES] };

/**
 * The squares the pieces of a side (`white`) can go to — a piece's moves and captures, a pawn's steps too, as far as
 * the board lets it slide —, of a placement's squares (a8 … h1): how many reach each.
 */
function reachOf(s, white) {
  const out = new Uint8Array(64);
  const free = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  for (let i = 0; i < 64; i++) {
    const p = s[i];
    if (p === '.' || (p === p.toUpperCase()) !== white) continue;
    const [r, c] = [i >> 3, i & 7];
    const type = p.toLowerCase();
    const up = white ? -1 : 1;
    const steps = type === 'p' ? [[up, -1], [up, 1], [up, 0], ...(r === (white ? 6 : 1) ? [[2 * up, 0]] : [])] : STEPS[type];
    if (steps) for (const [dr, dc] of steps) free(r + dr, c + dc) && out[(r + dr) * 8 + c + dc]++;
    else
      for (const [dr, dc] of type === 'r' ? ROOK_LINES : type === 'b' ? BISHOP_LINES : [...ROOK_LINES, ...BISHOP_LINES])
        for (let k = 1; free(r + dr * k, c + dc * k); k++) {
          out[(r + dr * k) * 8 + c + dc * k]++;
          if (s[(r + dr * k) * 8 + c + dc * k] !== '.') break;
        }
  }
  return out;
}

/**
 * A diagram's piece placement with the kings it leaves out put in — a puzzle book may draw only the pieces that matter
 * (CT-Art's diagrams lack a side's king half the time), a beginner's book no king at all —: each where it changes
 * nothing, so that the book's moves can be played: on an empty square no piece can go to (else one the other side's
 * cannot), the farthest from the pieces, a corner first. The placement as it is when it has a king a side, or when no
 * square will do.
 */
function withKings(placement) {
  let s = squares(placement);
  for (const k of ['K', 'k']) {
    if (s.includes(k)) continue;
    const mine = reachOf(s, k === 'K');
    const theirs = reachOf(s, k !== 'K');
    const pieces = [...Array(64).keys()].filter(i => s[i] !== '.');
    const far = i => Math.min(8, ...pieces.map(j => Math.max(Math.abs((i >> 3) - (j >> 3)), Math.abs((i & 7) - (j & 7)))));
    const corner = i => Math.abs((i >> 3) - 3.5) + Math.abs((i & 7) - 3.5);
    const order = [...Array(64).keys()].filter(i => s[i] === '.' && !theirs[i]).sort((a, b) => !mine[b] - !mine[a] || far(b) - far(a) || corner(b) - corner(a));
    if (!order.length) return placement;
    s = s.slice(0, order[0]) + k + s.slice(order[0] + 1);
  }
  return placementOf(s);
}

/** The castling a diagram's position may still have: each king and rook on its square. */
function castlingOf(placement) {
  const s = squares(placement);
  let c = '';
  if (s[60] === 'K') c += (s[63] === 'R' ? 'K' : '') + (s[56] === 'R' ? 'Q' : '');
  if (s[4] === 'k') c += (s[7] === 'r' ? 'k' : '') + (s[0] === 'r' ? 'q' : '');
  return c || '-';
}

/**
 * A guess at the side to move in an opening's position (most pieces still on the board): the side that has moved fewer
 * of its pieces from their first squares ('w' or 'b'; null later in a game).
 */
function developmentSide(placement) {
  const s = squares(placement);
  const start = squares(INITIAL_FEN.split(' ')[0]);
  if ((s.match(/[a-z]/gi) || []).length < 24) return null;
  let white = 0;
  let black = 0;
  for (let i = 0; i < 64; i++) if (start[i] !== '.' && s[i] !== start[i]) start[i] === start[i].toUpperCase() ? white++ : black++;
  return white > black ? 'b' : 'w';
}

const SIDE_WORDS = /\b(white|black)\s+(?:to\s+(?:move|play)|moves|plays|is\s+to\s+(?:move|play))\b/gi;

/** "White to move", "Black to play" in the words after a diagram: 'w' or 'b' (or null). */
export function sideSaid(text) {
  const m = new RegExp(SIDE_WORDS.source, 'i').exec(text);
  return m ? (m[1].toLowerCase() === 'white' ? 'w' : 'b') : null;
}

/**
 * The side to move a book marks at a diagram (`before`: the text before it, `after`: the text after it): "W" or "B"
 * on a line of its own ("W?" for an exercise; under the diagram's number, "9-63⏎W"; a scan's "w"; or before the first
 * move: "B?8...h5?"), or a caption — "Diagram 14. White to play", "White to move wins" — on one of the first lines
 * after it, or on the line before it: 'w' or 'b' (or null).
 */
export function sideMarked(before, after) {
  const lines = text => text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of [...lines(after).slice(0, 3), ...lines(before).slice(-1)]) {
    // (also before the first move, on its line: "B?8...h5?")
    if (/^[WBwb][?!]{0,2}$/.test(line) || /^[WB]\??(?=\d{1,3}\.)/.test(line)) return line[0].toLowerCase();
    const said = [...line.matchAll(SIDE_WORDS)];
    // (two diagrams side by side have their two captions on one line: no telling which is whose)
    if (said.length === 1 && line.length <= 48) return said[0][1][0].toLowerCase();
  }
  return null;
}

const LABEL = '\\d{1,5}(?:[/-]\\d{1,4})?';

/**
 * The numbers a book gives a diagram (`before`: the text before it, `after`: the text after it) — "5194" on the line
 * over it, else "1-36" or "1/45" on one of the lines under it —, for a solution far after it to be followed from its
 * position (see BookMoves): its labels.
 */
function labelsOf(before, after) {
  const lines = text => text.split('\n').map(l => l.trim()).filter(Boolean);
  const label = line => new RegExp(`^(${LABEL})\\.?$`).exec(line)?.[1];
  const over = label(lines(before).at(-1) || '');
  return over ? [over] : lines(after).slice(0, 3).map(label).filter(Boolean);
}

/**
 * The number a diagram's caption gives it, on the line over it or on one of the lines under it, all of that line —
 * "Diagram 62" —, or null: for the words naming it (see BookMoves).
 */
function captionOf(before, after) {
  const lines = text => text.split('\n').map(l => l.trim()).filter(Boolean);
  return diagramNumber(lines(before).at(-1) || '', true) || lines(after).slice(0, 3).map(l => diagramNumber(l, true)).find(Boolean) || null;
}

/**
 * The label a puzzle's solution begins with, at the start of its line, before its first move (`between`: the text
 * before the move) — "5194 1.Bb1 …" (`direct`: the move right after it), "12. S. Loyd, 1869: 1.Rf1!" —, or null.
 */
function solutionOf(between) {
  const m = new RegExp(`(?:^|\\n)[ \\t]*(${LABEL})[.):]?[ \\t]([^\\n]{0,80}\\n?[^\\n]{0,40})$`).exec(between);
  return m ? { label: m[1], direct: !m[2].trim() } : null;
}

/**
 * A game's moves played again from another first position (`fen`): each position and move as they are then — or false,
 * the game left as it was, when one of its moves cannot be played there.
 */
function rebase(tree, fen) {
  const out = new Map();
  const walk = (node, pos) =>
    node.children.every(c => {
      const m = moveFromUci(pos, c.uci);
      if (!m || !pos.isLegal(m)) return false;
      const san = makeSan(pos, m);
      const next = pos.clone();
      next.play(m);
      out.set(c, { fen: fenOf(next), san, check: next.isCheck(), capture: san.includes('x'), mate: next.isCheckmate() });
      return walk(c, next);
    });
  const root = positionOf(fen);
  if (!root || !walk(tree.root, root)) return false;
  tree.root.fen = fenOf(root);
  for (const [n, v] of out) Object.assign(n, v);
  tree.version++;
  return true;
}

/**
 * The brackets of moves of the text one after the other (`steps`: [{ t, between: the text before it, since the move
 * before }]): "(" and "[" open a variation, ")" and "]" close it — a list's marker closes none, "a)", "2)" starting a
 * line —; for each move, how deep in them it is (`depth`) and the least depth the text before it reached (`low`).
 */
function bracketsOf(steps) {
  const depth = [];
  const low = [];
  let d = 0;
  for (const [k, { between }] of steps.entries()) {
    let least = d;
    if (k)
      for (const b of bracketsIn(between)) {
        if (b > 0) d++;
        else least = Math.min(least, --d);
      }
    depth.push(d);
    low.push(least);
  }
  return { depth, low };
}

/** The brackets of a text, in order: 1 for one that opens a variation, -1 for one that closes it (see bracketsOf). */
function bracketsIn(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') out.push(1);
    else if ((c === ')' || c === ']') && !LIST_MARKER.test(text.slice(0, i))) out.push(-1);
  }
  return out;
}

/**
 * For moves of the text one after the other (`steps`, see bracketsOf), the numbered moves of each one's line written
 * after it — past the variations in brackets after it, before its own bracket closes —: a function of its index (the
 * next of them first); with `end` (the next diagram's place), only those before it, up to the first that begins a
 * paragraph or a line after a variation closed — where a game's own moves go on after the notes on a move —, and before
 * a puzzle's solution ("495 1...Qd1+": another position's).
 */
function linesOf(steps) {
  const { depth, low } = bracketsOf(steps);
  const resumes = steps.map(({ between }, k) => !!k && (PARA.test(between) || (low[k] < depth[k - 1] && /\n[ \t]*$/.test(between))));
  const solves = steps.map(({ between }, k) => !!k && !!solutionOf(between)?.direct);
  return (i, end) => {
    const out = [];
    for (let j = i + 1; j < steps.length && low[j] >= depth[i] && steps[j].t.start < (end ?? Infinity); j++) {
      if (end !== undefined && solves[j]) break;
      if (depth[j] === depth[i] && steps[j].t.num) {
        out.push(steps[j].t);
        if (end !== undefined && resumes[j]) break;
      }
    }
    return out;
  };
}

/**
 * The game's main line: its first moves, leaving out the moves the book only named (shown, never the main line) and a
 * side line's a diagram put in before the game's own move (`bookAside`, see MoveTracker.onward).
 */
function mainLine(tree) {
  const out = [tree.root];
  const next = n => n.children.find(c => !c.bookShown && !c.bookAside);
  for (let n = next(tree.root); n; n = next(n)) out.push(n);
  return out;
}

/** The move `san` in the position `pos`, as UCI (null when it is not a legal move there). */
function moveIn(pos, san) {
  try {
    const m = parseSan(pos, san);
    if (!m || !pos.isLegal(m)) return null;
    // (chessops plays "Rxg2" to an empty square too: a move that says it takes must take there)
    if (san.includes('x') && !pos.board.has(m.to) && m.to !== pos.epSquare) return null;
    return uciOf(pos, m);
  } catch {
    return null;
  }
}

/** The kind of piece ('king', 'rook' …) the move `uci` moves in the position `fen`, or null. */
const roleOf = (fen, uci) => positionOf(fen)?.board.get(squareIndex(uci.slice(0, 2)))?.role || null;
// (a piece's letter → its kind, and back: a pawn's P)
const ROLES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
const LETTERS = { ...Object.fromEntries(Object.entries(ROLES).map(([letter, role]) => [role, letter])), pawn: 'P' };

/** The move `san` in the position of `node`, as UCI (null when it is not a legal move there). */
function moveAt(node, san) {
  const pos = positionOf(node.fen);
  return pos ? moveIn(pos, san) : null;
}

/** Whether the text's move `t` is the move that led to `node` (not a game's first position). */
const says = (node, t) => (t.desc ? descriptiveMoves(node.parent.fen, t.desc).includes(node.uci) : (t.sans || [t.san]).some(s => moveAt(node.parent, s) === node.uci));

/**
 * The move of the text `t` in the position `pos` (a move read by OCR: the first of its readings that is legal there;
 * one in descriptive notation: the likeliest of the moves it may be; a move whose piece the text lost — `glyph` —: the
 * one piece that can make it, or the piece the book's glyph has been learnt to be, `t.piece`; a scanned page's move —
 * BookMoves.follow —: its digits of like shape, or the move most like its word, when none of its readings is), or
 * null. `strict`: a scanned page's move only as written (true) — where a move is looked for far from the reading: other
 * games, positions read long ago —, or only as its readings ('read'); as written, a piece's move the text writes
 * without x (`untaken`, see BookMoves.follow) takes nothing.
 */
function playableIn(pos, t, strict = false) {
  if (!pos) return null;
  if (t.fuzzy) return strict === true ? null : nearest(pos, t.fuzzy)[0] || null;
  if (t.desc) return descriptiveMoves(fenOf(pos), t.desc)[0] || null;
  if (t.glyph) {
    const legal = t.sans.map(san => [san, moveIn(pos, san)]).filter(([, uci]) => uci);
    // (a glyph firmly learnt: its piece's move, or none — see BookMoves.learnt)
    if (!t.firm && new Set(legal.map(([san]) => san[0])).size === 1) return legal[0][1];
    return legal.find(([san]) => san[0] === t.piece)?.[1] || null;
  }
  for (const san of (strict === true && t.read) || t.sans || [t.san]) {
    const uci = moveIn(pos, san);
    if (uci && !(strict === true && t.untaken && pos.board.get(squareIndex(uci.slice(2, 4)))?.color === (pos.turn === 'white' ? 'black' : 'white'))) return uci;
  }
  // (`strict`: as written; 'read': its readings, not these)
  if (strict) return null;
  // (a scan's move none of whose readings is legal: a digit of like shape, else the legal move most like the word read)
  for (const san of t.like || []) {
    const uci = moveIn(pos, san);
    if (uci) return uci;
  }
  return t.word ? nearest(pos, t.word, CLOSE)[0] || null : null;
}

/** The move of the text `t` at `node` (see playableIn), or null. */
const playable = (node, t, strict = false) => (t.desc ? descriptiveMoves(node.fen, t.desc)[0] || null : playableIn(positionOf(node.fen), t, strict));

/** Whether `uci` at `node` is the text's move `t` as written (not a scan's other reading of it: see BookMoves.follow). */
function written(node, t, uci) {
  if (!t.misread && !t.fuzzy) return true;
  const pos = positionOf(node.fen);
  return !!pos && !t.fuzzy && t.read.some(san => moveIn(pos, san) === uci);
}

/**
 * The moves the text's move `t` may be at `node` (UCI): the one playable gives — or, for a lost figurine more than one
 * piece can be (and not the one learnt for it), or a promotion whose piece the text lost or wrote as a figurine (its
 * pieces in order — text.js's, the queen first; the one learnt for its figurine first, BookMoves.figure), each of
 * theirs: the moves written after it tell which (see pick) — a knight's promotion, "1.c8=N Ke8", lost no line to a
 * queen's that left the king no move.
 */
function choices(node, t, near = true) {
  // (a scan's move whose digits may have been misread: each of its readings legal there — the moves after it tell
  // which, as written on a tie —, else, where the reading is (`near`), each of its digits of like shape, else the moves
  // most like the word read: elsewhere they would find a move in a line it does not belong to, "Kc4" as Ke4)
  if (t.misread || t.fuzzy) {
    const p = positionOf(node.fen);
    if (!p) return [];
    if (t.fuzzy) return nearest(p, t.fuzzy);
    const legal = list => [...new Set(list.map(san => moveIn(p, san)).filter(Boolean))];
    const read = legal(t.sans);
    if (read.length || !near) return read;
    const like = legal(t.like || []);
    return like.length || !t.word ? like : nearest(p, t.word, CLOSE);
  }
  if (t.sans?.length > 1 && t.sans.every(san => /=[QRBN]$/.test(san))) {
    const p = positionOf(node.fen);
    return p ? [...new Set(t.sans.map(san => moveIn(p, san)).filter(Boolean))] : [];
  }
  const pos = !t.desc && t.glyph && positionOf(node.fen);
  if (!pos) {
    const uci = playable(node, t);
    return uci ? [uci] : [];
  }
  const legal = t.sans.map(san => [san, moveIn(pos, san)]).filter(([, uci]) => uci);
  const learnt = legal.find(([san]) => san[0] === t.piece);
  return learnt ? [learnt[1]] : t.firm ? [] : [...new Set(legal.map(([, uci]) => uci))];
}

// A word of a scan's moves the OCR made no move of (a table's: text.js rowMoves), or a move none of whose readings is
// legal: the legal moves as like it as one plain edit (text.js wordDistance) — those as like as the likest, within
// FUZZY_TIE, the likest first.
const FUZZY = 1;
const FUZZY_TIE = 0.3;
// (a word the OCR made a move of, that move not legal: the legal move that differs from it only by a character of like
// shape, or one more beside its like — "Ngd4+" Ng4+ —, a capture as it says)
const CLOSE = 0.5;

// (the legal moves of the positions looked at last — a scan's words are tried in the same few positions over and over —,
// each with whether it takes and how long its SAN may be: castling 3 or 5 letters, a pawn's square with its file and x
// when it takes and =Q, a piece's letter, x, its square and one or two letters telling it from its like; a check sign
// maybe. Its SAN is made only when a word may be like it.)
const SANS = new Map();
function movesOf(pos, key) {
  let list = SANS.get(key);
  if (!list) {
    list = [];
    for (const u of legalMoves(pos)) {
      const from = squareIndex(u.slice(0, 2));
      const to = squareIndex(u.slice(2, 4));
      const role = pos.board.get(from)?.role;
      const taken = pos.board.get(to);
      // (castling: the king two squares aside, or onto its own rook)
      const castles = role === 'king' && (taken?.color === pos.turn || Math.abs((from & 7) - (to & 7)) > 1);
      const takes = !castles && (!!taken || (role === 'pawn' && (from & 7) !== (to & 7)));
      const least = castles ? 3 : role === 'pawn' ? (takes ? 4 : 2) + (u.length > 4 ? 2 : 0) : takes ? 4 : 3;
      list.push({ u, castles, takes, least, most: castles ? 6 : role === 'pawn' ? least + 1 : least + 3, m: null, uci: null, san: null });
    }
    if (SANS.size >= 512) SANS.clear();
    SANS.set(key, list);
  }
  return list;
}

// (the SANs a word may be as like it as half an edit — text.js closeSpellings: a capture only for a capture written, in
// the shape makeSan writes —, each with how like: kept by word)
const SAN_LIKE = /^(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?$/;
const SPELLINGS = new Map();
function spellingsOf(word) {
  let list = SPELLINGS.get(word);
  if (!list) {
    const takes = /[x×:]/.test(word);
    list = [...closeSpellings(word)].filter(san => san.includes('x') === takes && SAN_LIKE.test(san)).map(san => ({ san, d: wordDistance(word, san) }));
    if (SPELLINGS.size >= 4096) SPELLINGS.clear();
    SPELLINGS.set(word, list);
  }
  return list;
}

// (the moves most like a word in a position, as found last: a scan's words are tried in the same positions again —
// each start of retrace's, each lost move a bridge looks for)
const NEAREST = new Map();
function nearest(pos, word, limit = FUZZY) {
  if (!pos || !word) return [];
  const key = `${fenOf(pos)} ${limit} ${word}`;
  let found = NEAREST.get(key);
  if (!found) {
    found = nearestOf(pos, word, limit);
    if (NEAREST.size >= 8192) NEAREST.clear();
    NEAREST.set(key, found);
  }
  return found;
}

function nearestOf(pos, word, limit) {
  const scored = [];
  if (limit <= 0.5) {
    // (as like as half an edit: those of the word's close spellings that are a legal move's SAN — a queen's promotion, as
    // legalMoves has them —, in the order of the position's moves)
    for (const { san, d } of spellingsOf(word)) {
      const m = d <= limit && parseSan(pos, san);
      if (!m || !pos.isLegal(m) || (m.promotion && m.promotion !== 'queen') || makeSan(pos, m) !== san) continue;
      scored.push({ uci: uciOf(pos, m), d });
    }
    if (scored.length > 1) {
      const list = movesOf(pos, fenOf(pos));
      const at = uci => list.findIndex(e => (e.castles ? uciOf(pos, moveFromUci(pos, e.u)) : e.u) === uci);
      for (const x of scored) x.at = at(x.uci);
      scored.sort((a, b) => a.at - b.at);
    }
  } else {
    const takes = /[x×:]/.test(word);
    for (const e of movesOf(pos, fenOf(pos))) {
      // (a move read as a move: a capture only for a capture written)
      if (limit < FUZZY && e.takes !== takes) continue;
      // (a SAN longer than the word by more than `limit` letters, or shorter by more than twice that, is less like it:
      // each letter the word lacks costs 1, each one too many half at least — wordDistance)
      if (e.least - word.length > limit || word.length - e.most > 2 * limit) continue;
      if (!e.m) {
        e.m = moveFromUci(pos, e.u);
        if (!e.m) continue;
        e.uci = uciOf(pos, e.m);
        e.san = makeSan(pos, e.m);
      }
      const d = wordDistance(word, e.san, limit);
      if (d <= limit) scored.push({ uci: e.uci, d });
    }
  }
  const best = Math.min(...scored.map(x => x.d));
  return [...new Set(scored.filter(x => x.d <= best + FUZZY_TIE).sort((a, b) => a.d - b.d).map(x => x.uci))];
}

/** The legal moves of a position as UCI (a pawn reaching the last rank: a queen). */
function legalMoves(pos) {
  const out = [];
  for (const [from, tos] of dests(pos)) for (const to of tos) out.push(`${from}${to}${isPromotion(pos, from, to) ? 'q' : ''}`);
  return out;
}

/**
 * A move the text lost before its first numbered move, of the side to move at `pos` (a table's first row a scan's OCR
 * dropped: "1 ... a5", "Rfd8" before "2 Rad1"): the one legal move after which more of the moves written after that
 * numbered one go on (`after`: how many, from the position it gets to, -1 when that move cannot be played there) than
 * after any other — two at least, and two more than without it (`without`) —, or null.
 */
function lostMoveOf(pos, after, without) {
  const found = legalMoves(pos).map(m => ({ m, n: after(played(pos, m)) }));
  const best = Math.max(-1, ...found.map(x => x.n));
  const top = found.filter(x => x.n === best);
  return top.length === 1 && best >= 2 && best >= without + 2 ? top[0].m : null;
}

/** Whether a move `t` with a number or a side to move (as written) may be played in the position `pos`. */
const fitsAt = (pos, t) => (!t.num || pos.fullmoves === t.num) && (!t.side || pos.turn === t.side);

/**
 * Whether the text wrote the move `t` whole: not a pawn's move whose file a scan lost (text.js NO_FILE), nor a word of a
 * table of moves the OCR made no move of (text.js rowMoves) — such a move is played where it fits, but says nothing of a
 * diagram: not its side to move, nor its number, nor that it led to it.
 */
const whole = t => !t.fileless && !t.fuzzy;

/**
 * Whether the text between two moves joins them (the second is the reply to the first): nothing but spaces — and the
 * signs of the first that a scan's text set apart from it, "5.g5 ! Kg6", "4.Kg6 + Kf8", or a number in square brackets
 * after it, a computer's count of the moves to mate: "1.Kd3 [27] Rc6 [26]".
 */
const adjoins = between => /^[\s!?+#]*(?:\[[\d\s]+\][\s!?+#]*)?$/.test(between);

/**
 * How many of the moves written after a move (`ahead`: [{ t, between: the text before it }]) can be played after it
 * (`uci` at `node`, or in the position `pos`), one after the other (`limit` at most): the replies right after each
 * move, the numbered ones with the next number — up to a bracket, or a move that is not the next one.
 */
function followOn(node, uci, ahead, limit = ahead.length, pos = positionOf(node.fen), strict = false) {
  let at = played(pos, uci);
  let n = 0;
  for (const { t, between } of ahead) {
    if (n >= limit || !at || /[()[\]]/.test(between)) break;
    if (t.num ? !fitsAt(at, t) : !adjoins(between) && !(t.desc && /^\s*[.,]\s*$/.test(between))) break;
    const next = playableIn(at, t, strict);
    if (!next) break;
    at = played(at, next);
    n++;
  }
  return n;
}

/**
 * How well the check signs written agree with the board along a move (`t`, played as `uci` at `node`) and the moves
 * written after it, as followOn plays them: one for each check written and given, less one for each written and not
 * given or given and not written — what tells two readings of a scan's move apart when as many moves go on after each
 * ("6 Kel": Ke3, as "9...Nxg4+" says, not Ke1). The sign as the book wrote it (text.js `written`): a move placed has
 * the sign of the move played (see voiced), and is followed again when a board is read again. From the position `pos`
 * (the one at `node`, else); `written`: a check given and not written costs nothing (a line's own position is told by
 * the checks it writes: see bridge).
 */
function checksAgree(node, uci, t, ahead, pos = positionOf(node.fen), written = false) {
  const said = m => /[+#]/.test((m.written || m).check || '');
  const score = (p, m) => (p.isCheck() === said(m) ? (said(m) ? 1 : 0) : written && !said(m) ? 0 : -1);
  let at = played(pos, uci);
  let n = at ? score(at, t) : 0;
  for (const { t: m, between } of ahead) {
    if (!at || /[()[\]]/.test(between)) break;
    if (m.num ? !fitsAt(at, m) : !adjoins(between)) break;
    const next = playableIn(at, m);
    if (!next) break;
    at = played(at, next);
    if (at) n += score(at, m);
  }
  return n;
}

/**
 * How many of the moves `next` (moves of the text) can be played one after the other from the position `pos` (`strict`:
 * a scan's moves as written, see playableIn).
 */
function runFrom(pos, next, strict = false) {
  let n = 0;
  for (const t of next) {
    if (!pos || !fitsAt(pos, t)) break;
    const uci = playableIn(pos, t, strict);
    if (!uci) break;
    pos = played(pos, uci);
    n++;
  }
  return n;
}

/**
 * The move number of a diagram's position with side `s` ('w' or 'b') to move, as the first numbered move written whole
 * after it (`next`) gives it: its own, or one less for Black to move before White's; 1 with none.
 */
function numberAfter(next, s) {
  const numbered = next.find(t => t.num && whole(t));
  return !numbered ? 1 : s === 'b' && numbered.side === 'white' ? Math.max(1, numbered.num - 1) : numbered.num;
}

/**
 * How many of the moves `next` (moves of the text) can be played one after the other from a diagram's piece placement,
 * with the side to move the first of them gives (either side when it gives none) and its number (numberAfter).
 */
function runFromPicture(placement, next) {
  let best = 0;
  for (const s of next[0]?.side ? [next[0].side[0]] : ['w', 'b']) best = Math.max(best, runFrom(positionOf(`${placement} ${s} ${castlingOf(placement)} - 0 ${numberAfter(next, s)}`), next));
  return best;
}

/**
 * Whether the move `t` (of the text: one of its readings) may be the move that led to the position `placement` (a
 * FEN's piece placement): its piece stands on the square it went to (a king and rook castled, a pawn promoted as it
 * says), the side's that made it.
 */
function ledTo(placement, t) {
  const sq = squares(placement);
  const white = t.side === 'white';
  const at = (s, piece) => sq[(8 - Number(s[1])) * 8 + s.charCodeAt(0) - 97] === (white ? piece : piece.toLowerCase());
  return (t.sans || [t.san]).some(san => {
    if (/^O-O-O/.test(san)) return at(white ? 'c1' : 'c8', 'K') && at(white ? 'd1' : 'd8', 'R');
    if (/^O-O/.test(san)) return at(white ? 'g1' : 'g8', 'K') && at(white ? 'f1' : 'f8', 'R');
    const m = /^([KQRBN])?[a-h]?[1-8]?x?([a-h][1-8])(?:=?([QRBN]))?/.exec(san);
    return !!m && at(m[2], m[3] || m[1] || 'P');
  });
}

export class MoveTracker {
  constructor() {
    this.trees = [];
    this.seen = new Map(); // the positions the reading went through last (the latest last) → their game
    this.tree = null;
    this.cur = null; // the position after the last move of the line being read
    this.returns = []; // per open bracket: the position to go back to when it closes, and whether the line was there
    this.opened = false; // a bracket opened since the last move
    this.lastReal = false; // the last move continued the line being read (not one shown on its own)
    this.restated = null; // the move a spelled-out move in a bracket said again last (see play)
    this.recent = []; // whether each of the last numbered moves of the game being read found its position
    // The game's own line, as a reader keeps it — not the first move a book named at each turn (a note's, often): where
    // its last numbered move at a paragraph's start, and the moves written right after it, got to (see play).
    this.spine = null;
    this.spineTree = null;
    this.left = null; // the game a plan left, and where (see plan)
    this.misread = null; // a picture's other readings, the line read played from each (see repair)
    this.quick = false; // (retrace's own trackers: a scan's or a lost figurine's move bridged over one lost move, see bridge)
    this.answered = []; // the moves shown before that a later numbered move made the line's reply (see replied)
    this.last = null; // the move of the text played last, whether it found a place or not (see replied)
  }

  /** The game's own line got to `node` (of the game being read). */
  grow(node) {
    this.spine = node;
    this.spineTree = this.tree;
  }

  /** A diagram of the game being read at `node`: the game's own line goes on to it when it is further along that line. */
  reach(node) {
    if (this.spineTree !== this.tree) return this.grow(node);
    for (let n = node; n; n = n.parent) if (n === this.spine) return this.grow(node);
  }

  /**
   * A move of the line being read (`node`) comes before the moves only named there (the move list shows it first), and
   * before a side line a diagram put in ahead of it (see onward), which becomes a variation of it.
   */
  lead(node) {
    const first = node.parent.children[0];
    if (first === node || !(first.bookShown || first.bookAside)) return;
    this.tree.promote(node);
    if (first.bookAside) first.bookAside = false;
  }

  /** A numbered move of the text found its position, or not (the last 8 are kept: see diagram). */
  placed(ok) {
    this.recent.push(ok);
    if (this.recent.length > 8) this.recent.shift();
  }

  get cur() {
    return this._cur;
  }

  set cur(node) {
    this._cur = node;
    // (the moves written since the line read got here and only shown — a reply after a note may be one: see replied)
    this.since = [];
    if (node) this.see(node);
  }

  /** A position the reading went through (the board showed it): a move may go back to it (see pick). */
  see(node) {
    this.seen.delete(node);
    this.seen.set(node, this.tree);
    if (this.seen.size > SEEN) this.seen.delete(this.seen.keys().next().value);
  }

  /**
   * The text between two moves: brackets open and close variations ("a)" or "2)" starting a line is a list marker).
   * Returns whether a variation closed there, back to the line it left.
   */
  between(text) {
    let closed = false;
    for (const b of bracketsIn(text)) {
      if (b > 0) {
        this.returns.push({ node: this.cur, real: this.lastReal });
        this.opened = true;
        closed = false;
      } else if (this.returns.length) {
        const { node: back, real } = this.returns.pop();
        // (back to the game the bracket left, when a game began in it — and to the line as it was: a move after the
        // bracket is the reply to the move before it when that one was the line's)
        if (back) (this.tree = this.seen.get(back) || this.tree), (this.cur = back), (this.lastReal = real);
        this.opened = false;
        closed = !!back;
      }
    }
    return closed;
  }

  /** A position (a diagram): the line goes on from there. */
  setPosition(fen) {
    const known = this.tree && (this.tree.path(this.cur).find(n => repKey(n.fen) === repKey(fen)) || this.tree.findByFen(fen));
    if (known) this.cur = known;
    else this.newGame(fen);
    this.returns = [];
    this.lastReal = true;
  }

  newGame(fen) {
    this.left = null;
    this.tree = new Tree(fen);
    this.trees.push(this.tree);
    this.cur = this.tree.root;
    this.returns = [];
    this.lastReal = true;
    this.recent = [];
    this.grow(this.cur);
    return { tree: this.tree, node: this.cur };
  }

  /**
   * A diagram: its piece placement, the side to move as the book marks it ('w' or 'b': only that side), or as the words
   * after it say it (said: that side rather than the other), the moves written after it (next; and later, those up to
   * the page's next diagram), how many squares a picture read may have wrong (near), and the other readings of its
   * unsure squares (alts: [{ sq: 0 (a8) … 63 (h1), options: ['B', 'P', '.'] }], the reading first). The line goes on
   * from the position: one of the game being read when it is there (the line read so far, the main line, a move on, or
   * a few moves on: see onward), else a new game from it — its side to move and move number from the first move after
   * it, a misread square put right by that move; or, when the first move after it is the one that led to it (its
   * caption: "Position after: 23. Bd3"), the other side to move. A picture read with more squares wrong (a white piece
   * on a hatched square lost, a rook read as a bishop: up to LOOSE of them, most of the pieces it shows where they
   * stand there) is the position of the line read it is most like when the moves written after it — their numbers too
   * — go on from there, and further than from the picture as read: a book's diagram in a game is the game's position.
   * A font's diagram that leaves out a king is that king's position of the line read, or a game with the king put in
   * (withKings). `line`: the numbered moves written after it on its line (see onward). Returns { tree, node }, or null
   * when it shows no position.
   */
  diagram(placement, { side = null, said = null, next = [], later = next, near = 0, alts = [], line = [] } = {}) {
    const first = next[0];
    // (the first move after it as the text wrote it whole, which may say its side, its number, what led to it: whole)
    const told = first && whole(first) ? first : null;
    const want = squares(placement);
    // (a font's diagram may leave out a king: it is compared without that king, and played with it put in)
    const lacks = near ? '' : ['K', 'k'].filter(k => !want.includes(k)).join('');
    const kingless = sq => (lacks ? sq.replace(new RegExp(`[${lacks}]`, 'g'), '.') : sq);
    this.caption = null;
    let loose = null;
    if (this.tree) {
      let best = null;
      const main = mainLine(this.tree);
      const known = [...new Set([...this.cur.children, ...this.tree.path(this.cur).reverse(), ...main.reverse()])];
      for (const n of known) {
        if (side && turn(n)[0] !== side) continue;
        const d = differ(want, kingless(squares(n.fen.split(' ')[0])));
        // (the words after a diagram may talk of the other side's moves — "Black to move loses" —: the position the
        // reading is at comes first, a square read wrong before the side the words say)
        const score = d + (said && turn(n)[0] !== said ? 0.5 : 0);
        if (d <= near && (!best || score < best.score)) best = { n, score };
      }
      if (best) {
        this.cur = best.n;
        this.returns = [];
        this.lastReal = true;
        this.reach(best.n);
        return { tree: this.tree, node: best.n, known: true };
      }
      const ahead = this.onward(want, later, near, kingless, side, line);
      if (ahead) {
        this.returns = [];
        this.lastReal = true;
        return { tree: this.tree, node: ahead, known: true };
      }
      // (not the position the first move after it gets to from the picture as read: that move is played from it — "the
      // rook goes to g1" from a picture with the rook on c1 is no picture of the rook on g1)
      const step = told?.side && positionOf(`${placement} ${told.side[0]} ${castlingOf(placement)} - 0 ${told.num || 1}`);
      const uci = step && playableIn(step, told);
      const moved = uci ? squares(fenOf(played(step, uci)).split(' ')[0]) : null;
      if (near)
        for (const n of known) {
          const have = squares(n.fen.split(' ')[0]);
          const d = differ(want, have);
          if (d > LOOSE || (side && turn(n)[0] !== side) || !squaresAlike(want, have) || have === moved) continue;
          // (the first move after it may be its caption's, the move that led to it)
          const led = !!told?.num && !!n.parent && playable(n.parent, told) === n.uci;
          // (a scan's moves as written: its other readings go on from too many positions)
          const run = led ? 1 + runFrom(positionOf(n.fen), next.slice(1), true) : runFrom(positionOf(n.fen), next, true);
          if (next.length ? run < Math.min(2, next.length) || !next.slice(0, run).some(t => t.num) : d > 3) continue;
          if (!loose || run > loose.run || (run === loose.run && d < loose.d)) loose = { n, run, d, led };
        }
    }
    // (the kings put in are the game's `hidden`: the board does not show them while they stand there — the book's
    // diagram has none)
    if (lacks) placement = withKings(placement);
    const kinged = squares(placement);
    const hidden = lacks ? [...lacks].filter(k => kinged.includes(k)).map(k => ({ piece: k, square: squareName(kinged.indexOf(k)) })) : null;
    const tries = [placement];
    for (const a of alts)
      for (const o of a.options.slice(1)) {
        const sq = [...want];
        sq[a.sq] = o;
        tries.push(placementOf(sq.join('')));
      }
    // its side to move: as the book marks it or the words say it, else as its first move says (or, with no move after
    // it, as an opening's development says); its move number from its first numbered move
    const marked = side || said;
    const toMove = marked || (told?.side === 'white' ? 'w' : told?.side === 'black' ? 'b' : !first ? developmentSide(placement) : null);
    const numbered = next.find(t => t.num && whole(t));
    const number = s => numberAfter(next, s);
    // (no numbered move after it — a diagram at the end of a page, its moves on the next —: its move number, and its
    // side to move when nothing says it, are guesses that the first numbered move puts right: settle)
    const guess = { number: !numbered, side: !marked && !told?.side };
    const game = (fen, g = guess) => {
      const r = this.newGame(fen);
      if (g.number || g.side) this.tree.guess = g;
      if (hidden?.length) this.tree.hidden = hidden;
      // (a picture's unsure squares: a move further on may tell how one of them reads, see repair)
      if (near && alts.length) this.tree.alts = alts;
      return r;
    };
    let fallback = null;
    let before = null; // (the position before its first move)
    // (the words after it are no mark of the book's: when its first move cannot be played with the side they say —
    // "White to play wins, but first: 1...Kd7 2.Kf6" —, with the other one)
    const sides = !toMove ? ['w', 'b'] : side || !said ? [toMove] : [toMove, toMove === 'w' ? 'b' : 'w'];
    for (const p of tries) {
      for (const s of sides) {
        const fen = `${p} ${s} ${castlingOf(p)} - 0 ${number(s)}`;
        const pos = positionOf(fen);
        if (!pos) continue;
        if (!first || playableIn(pos, first)) {
          // (the picture as read, or with one of its unsure squares read otherwise when more of the moves written after
          // it can be played then: a white rook read as a knight shows at White's third move)
          const run = runFrom(pos, next);
          if (!before || run > before.run) before = { fen, run };
          break;
        }
        if (p === placement && (!toMove || s === toMove)) fallback ||= fen;
      }
      if (before && before.run >= next.length) break;
    }
    // (its caption: the first move after it led to it — its piece stands where it went — and the moves after it are
    // played from it with the other side to move, more of them than from it as the position before that move)
    let caption = null;
    if (told?.num && told.side && (!side || side !== told.side[0]) && ledTo(placement, told)) {
      const s = told.side === 'white' ? 'b' : 'w';
      const fen = `${placement} ${s} ${castlingOf(placement)} - 0 ${told.num + (s === 'w' ? 1 : 0)}`;
      const pos = positionOf(fen);
      if (pos) caption = { fen, run: 1 + runFrom(pos, next.slice(1)) };
    }
    // (the line read's position, when the moves after it go on from there further than from the picture as read — or as
    // far, when no numbered move was lost on the way to it — two moves at least, or the picture within three squares of
    // it: one king's move fits many positions, a new game's diagram after the last one's moves too —, or when the
    // picture as read is no game's position)
    const read = Math.max(before ? before.run : -1, caption ? caption.run : -1);
    const trusted = this.recent.length >= 2 && this.recent.every(Boolean) && (loose?.run >= 2 || loose?.d <= 3);
    if (loose && (!next.length || loose.run > read || (loose.run === read && (trusted || !possible(placement))))) {
      this.cur = loose.n;
      this.returns = [];
      this.lastReal = true;
      if (loose.led) this.caption = { moves: [told], node: loose.n };
      this.reach(loose.n);
      return { tree: this.tree, node: loose.n, known: true };
    }
    if (caption && caption.run > (before?.run || 0)) {
      const r = game(caption.fen, {});
      this.caption = { moves: [told], node: r.node };
      return r;
    }
    // (its first numbered move White's second or a later one, the side to move not marked: Black's move before it may
    // have been lost — a table's first row a scan's OCR dropped, "1 ... a5" —, when after one move of Black's, and no
    // other, more of the moves written after it on its page, `later`, go on: that move put in, as a bridge's)
    if (before && !marked && toMove === 'w' && numbered && numbered === first && numbered.misread && numbered.num >= 2 && later.length > next.length) {
      const f = before.fen.split(' ');
      f[1] = 'b';
      f[5] = String(numbered.num - 1);
      const fen = f.join(' ');
      const pos = positionOf(fen);
      // (the moves after the first numbered one, `later`'s first)
      const lost = pos && lostMoveOf(pos, p => runFrom(p, later) - 1, runFrom(positionOf(before.fen), later) - 1);
      if (lost) {
        const r = game(fen, {});
        const n = this.tree.addMove(r.node, lost).node;
        n.bookInferred = true;
        n.bookShown = false;
        this.cur = n;
        return r;
      }
    }
    if (before) return game(before.fen);
    // (no move with its first numbered move's number and side can be played from it — a move misread, or the moves that
    // led to it written after it, the picture set over them —: the first later numbered move that can be played from
    // it, with its number and side (the side the book marks, when it marks one), gives its side to move and its number
    // when two moves after it go on from there — the moves that led to it cannot be played from it, and when that first
    // one goes on no further, the moves further on that can are a note's on another position; only moves the text wrote
    // whole say a diagram's number and side —; but not when the moves before it, two or more, are one line with it,
    // "1.Kc6 Kd7 2.Kb6", and did not lead to the picture — its piece where the last of them went —: those are the
    // game's own first moves from a picture misread, and the moves after them would be played as if they had not been)
    const fenAt = (p, m) => `${p} ${m.side[0]} ${castlingOf(p)} - 0 ${m.num}`;
    const n0 = later.find(m => m.num && m.side && whole(m));
    const same = later.filter(m => m.num === n0?.num && m.side === n0.side);
    const ply = m => m.num * 2 + (m.side === 'black' ? 1 : 0);
    // (whether moves of the text are one line: each numbered one a ply after the move before, the others its replies)
    const oneLine = list => {
      let at = ply(list[0]);
      for (const m of list.slice(1)) {
        if (m.num && ply(m) !== at + 1) return false;
        at += 1;
      }
      return true;
    };
    if (n0 && !tries.some(p => same.some(m => positionOf(fenAt(p, m)) && choices({ fen: fenAt(p, m) }, m).length)))
      for (const [k, m] of later.entries()) {
        if (!m.num || !m.side || !whole(m) || same.includes(m) || (side && side !== m.side[0])) continue;
        const pos = positionOf(fenAt(placement, m));
        const run = pos ? runFrom(pos, later.slice(k)) : 0;
        const skipped = later.slice(later.indexOf(n0), k);
        const skips = skipped.length >= 2 && oneLine([...skipped, m]) && !ledTo(placement, skipped.at(-1));
        if (run >= 3 && !skips) return game(fenAt(placement, m), {});
        if (run) break;
      }
    return fallback ? game(fallback) : null;
  }

  /**
   * A diagram of the position the line read gets to a few moves on — the moves that lead to it written after it (the
   * picture set over them, at the top of a column) —: of the moves written after it (`later`), those that go on from
   * the position the line read is at, one after the other (a numbered move with the number and side there, a move
   * without a number right after one played; the others are a note's), until the position is the diagram's (its
   * squares `want`, `near` of them may differ; its side to move `side`, when the book marks it). Those moves are put
   * in the game (the text plays them when it gets there: the line read stays where it is); returns the diagram's node,
   * or null. When the text writes another move there further on its line (`line`: the numbered moves after the diagram
   * not in a variation's bracket) — "After 3.Bc4 Bc5 the bishops face each other; but here 3.Bb5" —, the diagram shows
   * a side line's position: its moves stay aside (`bookAside`) until that move comes, the main line's.
   */
  onward(want, later, near, kingless, side, line = []) {
    let at = this.cur;
    let on = false; // (the move before was one of them)
    const path = [];
    const used = new Set();
    for (const t of later) {
      const pos = positionOf(at.fen);
      const uci = (t.num ? fitsAt(pos, t) : on) && playableIn(pos, t);
      on = !!uci;
      if (!uci) continue;
      at = { fen: fenOf(played(pos, uci)) };
      path.push(uci);
      used.add(t);
      if (differ(want, kingless(squares(at.fen.split(' ')[0]))) <= near) break;
    }
    if (!path.length || differ(want, kingless(squares(at.fen.split(' ')[0]))) > near || (side && turn(at)[0] !== side)) return null;
    const here = positionOf(this.cur.fen);
    const aside = line.some(t => !used.has(t) && fitsAt(here, t) && (playableIn(here, t) || path[0]) !== path[0]);
    let node = this.cur;
    for (const uci of path) {
      const { node: child, created } = this.tree.addMove(node, uci);
      if (created) child.bookShown = false;
      if (created && aside && node === this.cur) child.bookAside = true;
      node = child;
    }
    return node;
  }

  /**
   * The first move of a puzzle's solution, far after the puzzle ("5194 1.Bb1 …": the diagram the book numbered 5194,
   * `node` of `tree`): the line goes on from there when the move can be played there, and the reply right after it
   * too (a game the puzzle comes from, written from its first move, is no solution from the puzzle) — and, unless it
   * comes right after the number (`direct`), not where the reading is. Returns whether it does.
   */
  solve(tree, node, t, direct, ahead = []) {
    if (!direct && this.candidates(t, { variation: false, sequence: false }).some(n => playable(n, t, true))) return false;
    const back = { tree: this.tree, cur: this.cur, guess: tree.guess };
    this.tree = tree;
    this.cur = node;
    if (tree.guess) this.settle(t, true);
    const uci = fullmove(node) === t.num && turn(node) === t.side && playable(node, t, true);
    const reply = ahead[0] && !ahead[0].t.num && adjoins(ahead[0].between);
    if (uci && (!reply || followOn(node, uci, ahead, 1))) {
      this.returns = [];
      this.lastReal = true;
      return true;
    }
    tree.guess = back.guess;
    this.tree = back.tree;
    this.cur = back.cur;
    return false;
  }

  /**
   * A numbered move right after the text names a diagram in its sentence (`node` of `tree`: its position) — "if White
   * waits instead (see diagram 62), 1.Kd2 …", "back at diagram (46): 1...a5" —: the line goes on from there, with the
   * other side to move when the move is that side's at the diagram's number (as otherSide), when the move can be played
   * there and the moves written after it go on from there as far as from where the reading may be — the book said
   * where; on a tie the move is the game's being read when it is that game's next move, a game naming a diagram it is
   * like or unlike: "As in diagram 5, 12...Rb8 …", not when it would go back in that game to another move's alternative
   * — a scan's moves as written, as for a puzzle's solution (solve) —, nor when the diagram is at the other side's move
   * and the words before the move (`between`) do not say its side moves: "Unlike in diagram 5, here 12...Rb8". Returns
   * whether it does.
   */
  refer(tree, node, t, ahead, between = '') {
    if (!node || !t.side || fullmove(node) !== t.num) return false;
    let fen = null;
    if (turn(node) !== t.side) {
      const f = node.fen.split(' ');
      f[1] = t.side[0];
      f[3] = '-';
      fen = f.join(' ');
    }
    const pos = positionOf(fen || node.fen);
    const uci = pos && playableIn(pos, t, true);
    if (!uci) return false;
    const there = followOn(null, uci, ahead, ahead.length, pos, true);
    const runs = this.candidates(t, { variation: false, sequence: false }).map(n => {
      const u = playable(n, t, true);
      return { n, run: u ? followOn(n, u, ahead, ahead.length, positionOf(n.fen), true) : -1 };
    });
    const here = Math.max(-1, ...runs.map(r => r.run));
    const said = [...between.matchAll(SIDE_WORDS)].at(-1)?.[1].toLowerCase();
    if (there < here || (there === here && (runs.some(r => r.n === this.cur && r.run === here) || (fen && said !== t.side)))) return false;
    if (fen) {
      // (a game like a what-if's: its kings put in hidden as the diagram's)
      const { hidden } = tree;
      this.tree = new Tree(fen);
      if (hidden) this.tree.hidden = hidden;
      this.trees.push(this.tree);
      this.cur = this.tree.root;
    } else {
      this.tree = tree;
      this.cur = node;
    }
    this.returns = [];
    this.lastReal = true;
    return true;
  }

  /**
   * The first numbered move after a diagram whose move number or side to move was a guess, that fits there: the diagram
   * takes them from it — not from White's "1." (a game's start, most often: the guesses stay, for a puzzle's solution
   * or an exercise's answer far after it),
   * unless it is the diagram's own solution (`solution`). When it is the move that led to the diagram (its piece where
   * it went, the move after it played from the diagram with the other side to move: "My last move was 1...Qc7. After
   * 2.g3 …", the diagram at the end of the page before), the diagram is the position after it: returns 'caption' (see
   * diagram).
   */
  settle(t, solution = false, ahead = []) {
    const { root, guess } = this.tree;
    if (!solution && t.num === 1 && t.side === 'white') return null;
    // (a square named in the words after it, taken for a move only shown, is no move of its game: then a move that goes
    // on from it as it is, two of the moves written after it too, puts the guesses right — not as the move that led to
    // it, a caption's; a move named in a note that only fits there leaves them —, the moves shown made again: refit)
    const shown = root.children.length > 0 && root.children.every(c => c.bookShown);
    if (this.cur !== root || (root.children.length && !shown)) {
      this.tree.guess = null;
      return null;
    }
    // (a move that fits neither way leaves the guesses: an exercise's answer, pages later, may tell)
    const f = root.fen.split(' ');
    if (guess.side) f[1] = t.side === 'black' ? 'b' : 'w';
    if (guess.number) f[5] = String(t.num);
    const fen = f.join(' ');
    const direct = positionOf(fen) && playable({ fen }, t, true);
    const run = direct ? followOn({ fen }, direct, ahead) : -1;
    if (guess.side && guess.number && t.side && t.misread && ahead.length && this.lostFirst(t, f, ahead, run)) return null;
    if (shown && run < 2) {
      this.tree.guess = null;
      return null;
    }
    if (direct) {
      this.refit(fen);
      this.tree.guess = null;
      return null;
    }
    const s = t.side === 'white' ? 'b' : 'w';
    if (!t.side || (!guess.side && root.fen.split(' ')[1] !== s) || !ledTo(f[0], t)) return null;
    f[1] = s;
    if (guess.number) f[5] = String(t.num + (s === 'w' ? 1 : 0));
    const after = f.join(' ');
    const pos = positionOf(after);
    if (!pos || (ahead.length && !runFrom(pos, [ahead[0].t]))) return null;
    this.refit(after);
    this.tree.guess = null;
    this.caption = { moves: [t], node: root };
    return 'caption';
  }

  /**
   * The game's first position put right (`fen`: its number, its side to move — guesses —, see settle): the moves only
   * shown from it so far are made again from there (a side's move no longer legal goes).
   */
  refit(fen) {
    const { root } = this.tree;
    root.fen = fen;
    const again = node => {
      node.children = node.children.filter(c => {
        const pos = positionOf(node.fen);
        const m = pos && moveFromUci(pos, c.uci);
        if (!m) return false;
        c.color = pos.turn;
        c.moveNumber = pos.fullmoves;
        c.fen = fenOf(played(pos, c.uci));
        again(c);
        return true;
      });
    };
    again(root);
  }

  /**
   * A diagram whose side to move and number are guesses, its first numbered move `t` (`f`: its FEN's fields as that
   * move would have them): the other side's first move may have been lost before it — a table's first row whose number
   * and dots a scan's OCR misread ("Rfd8" before "2 Rad1") —, when after one move of the other side, and no other, it
   * and the moves written after it go on further than from the diagram with `t` its first move (`direct`: how far
   * they go so, -1 when `t` cannot be played there): that move is put in (`bookInferred`, as a bridge's), the game's
   * first position the other side's. Returns whether it was.
   */
  lostFirst(t, f, ahead, direct) {
    const g = [...f];
    g[1] = t.side === 'white' ? 'b' : 'w';
    g[5] = String(t.side === 'white' ? t.num - 1 : t.num);
    const fen = g.join(' ');
    const pos = Number(g[5]) >= 1 && positionOf(fen);
    const lost = pos && lostMoveOf(pos, p => {
      const uci = playableIn(p, t);
      return uci ? followOn(null, uci, ahead, ahead.length, p) : -1;
    }, direct);
    if (!lost) return false;
    const { root } = this.tree;
    this.refit(fen);
    this.tree.guess = null;
    const n = this.tree.addMove(root, lost).node;
    n.bookInferred = true;
    n.bookShown = false;
    this.cur = n;
    return true;
  }

  /**
   * Plays the move `t` (from text.js); returns { tree, node, shown (only shown: the line is not followed), restated (a
   * move said again: nothing played) } or null. ahead: the moves written after it (see followOn), which tell where a
   * numbered move belongs when it may be played in more than one place; para: it begins a paragraph; between: the
   * text since the move before it; garbled: the moves before it, since the last one placed, that found no place, with
   * their words ([{ t, word }], see bridge); upcoming: for a move with no number, the next numbered move of its line
   * (past the variations in brackets after it, before its own bracket closes); further: the numbered moves of its line
   * written after it, up to the next diagram (see retold).
   */
  play(t, { seq = false, ahead = [], para = false, between = '', garbled = [], upcoming = null, further = [] } = {}) {
    const prior = this.last;
    this.last = t;
    // (the caption under a diagram: the move that led to it, said again)
    if (this.caption) {
      const { moves, node } = this.caption;
      if (moves.includes(t) && this.cur === node) return { tree: this.tree, node, shown: false, restated: true };
      this.caption = null;
    }
    const variation = this.opened;
    this.opened = false;
    const again = t.spelled && variation && this.restate(t, between);
    if (again) return again;
    this.restated = null;
    // (a reply written after the comments on the move before — "14.Rd1 The rook is active. Kf8", as a database's
    // export writes a game —: a move beginning a sentence, that the side to move can play, after which the line's next
    // numbered move can be played; its piece a letter or a font's figurine — an OCR's spelling of one may be any piece,
    // and fits too many lines —; not when the text writes the reply further on with its number — "Na5 is met by 10.Bc2.
    // The game went 9...Bb7": the sentence's move was a note's, see retold. When it is not taken so, the numbered move
    // that fits nowhere may still take it: replied)
    const answers = !seq && !variation && !t.num && !!upcoming && this.lastReal && (!t.glyph || FIGURINE.test(t.glyph)) && SENTENCE_END.test(between) && !this.retold(further) && this.continues(t, upcoming);
    const sequence = (seq || answers) && this.lastReal && !variation;
    // (back from a plan — "1.Qd7 followed by 2.Re8 mate", see plan —: the moves after it go on in the game it left,
    // unless they answer it right after it; nothing else took the reading elsewhere since: a bracket's end, a diagram)
    if (this.left && !sequence) {
      if (this.tree === this.left.plan) (this.tree = this.left.tree), (this.cur = this.left.cur);
      this.left = null;
    }
    const alone = !t.num && !sequence && !variation;
    if (alone && t.pawn && !t.side) {
      // (a square, most often — or a reply written after a note: see replied)
      this.since.push({ t });
      return null;
    }
    if (alone && t.fuzzy) return null; // (a table's word read as no move: only where the table's moves are followed)
    if (alone && !this.tree) return t.pawn ? null : this.startGame(t);
    if (t.num && whole(t) && this.tree?.guess && this.settle(t, false, ahead) === 'caption') return { tree: this.tree, node: this.cur, shown: false, restated: true };
    // (the next move of the side that made the move before it, joined to it by "and", the other side's move left out —
    // "as in 10.Re1 and 11.Nbd2" —, in a note's line: that side's plan there, not the game's own line where it would fit
    // too; on the game's line it may be a threat after the game's reply: "23.Qg4, threatening 24.Bxh6")
    const twice = !!t.num && prior?.num === t.num - 1 && prior.side === t.side && !!prior.node && prior.node === this.cur && /^\s*and\s*$/i.test(between) && !mainLine(this.tree).includes(this.cur);
    const legal = [];
    for (const node of this.candidates(t, { variation, sequence, twice })) {
      for (const uci of choices(node, t, node === this.cur || node === this.spine)) legal.push({ node, uci });
      if (legal.length && !t.num) break;
    }
    let chosen = (t.num || legal.length > 1) && ahead.length ? this.pick(t, legal, ahead, para) : legal[0];
    // (a lost figurine more than one piece can be, the moves after it no help to tell which: none — not one that moves
    // the same kind of piece in each place it may be, the line read and a variation of it, unless its glyph has been
    // learnt to be another piece: that doubt is the line's, settled as any move's is — Mastering Endgame Strategy's
    // king walks, "2.Ke3 Ke7 3.Ke4", were lost where a variation's king could reach e4 too, Amateur to IM's "3...*e7"
    // where the main line's king could, and an OCR's rook moves where another line's rook could go there too)
    const roles = t.glyph ? new Set(legal.map(c => roleOf(c.node.fen, c.uci))) : null;
    const same = roles?.size === 1 && (t.firm || !t.piece || roles.has(ROLES[t.piece]));
    if (t.glyph && (chosen?.tied || legal.length) > 1 && !same) chosen = null;
    // (a scan's move played otherwise than written — a digit of like shape, the legal move most like a word the OCR made
    // no move of —: only where a move written after it goes on from there too)
    if (chosen && !written(chosen.node, t, chosen.uci) && !(chosen.score ?? followOn(chosen.node, chosen.uci, ahead, 1))) chosen = null;
    // ("1." of White's first move where the moves after it cannot be played — the first position of a diagram's game,
    // with the number and side a guess —, or fewer of them than from the initial position — as many, in a game the
    // reading has left —: a game of its own from the initial position — "After 1.c4 c5 2.b3 …")
    const left = chosen?.tree && chosen.tree !== this.tree;
    const here = chosen && t.num === 1 && t.side === 'white' && ahead.length ? followOn(chosen.node, chosen.uci, ahead) : -1;
    if (here >= 0 && (!here || this.fromStart(t, ahead) > here - (left ? 1 : 0))) {
      const started = this.startGame(t, ahead, true);
      if (started) return started;
    }
    if (chosen) {
      const { node, uci } = chosen;
      if (chosen.tree && chosen.tree !== this.tree) (this.tree = chosen.tree), (this.returns = []);
      // (an exercise's diagram: its number and side as its answer gives them)
      if (chosen.fen) (node.fen = chosen.fen), (this.tree.guess = null);
      const { node: child, created } = this.tree.addMove(node, uci);
      if (alone) {
        if (created) child.bookShown = true;
        this.see(child);
        if (node === this.cur) this.since.push({ t, node: child });
        return { tree: this.tree, node: child, shown: true };
      }
      child.bookShown = false;
      this.lead(child);
      // (the game's own line: a numbered move beginning a paragraph, and the moves written right after it — "12...Nd4"
      // after the notes on 12.b4, "14. … Be6⏎15. Ne3 Rad8" — or on a line of their own after a page's running head;
      // not the moves of a note: "In the event of 12...cxb4")
      const onLine = this.spine === node && this.spineTree === this.tree && (!/\p{L}{2,}/u.test(between) || (t.num && /\n[ \t]*$/.test(between)));
      if (!variation && ((t.num && para) || onLine)) this.grow(child);
      this.cur = child;
      this.lastReal = true;
      return { tree: this.tree, node: child, shown: false };
    }
    if (t.num === 1 && t.side === 'white') {
      const started = this.startGame(t, ahead);
      if (started) return started;
    }
    // ("1.Qd7 followed by 2.Re8 mate": a plan, whatever the other side does)
    const planned = t.num && PLAN.test(between) ? this.plan(t) : null;
    if (planned) return planned;
    const answered = t.num && !variation && !this.retold(further) ? this.replied(t, prior, between) : null;
    if (answered) return answered;
    const bridged = !alone && !variation ? this.bridge(t, ahead, between, garbled) : null;
    if (bridged) return bridged;
    const repaired = t.num ? this.repair(t, ahead) : null;
    if (repaired) return repaired;
    const other = t.num ? this.otherSide(t, ahead) : null;
    if (other) return other;
    if (!alone) this.lastReal = false;
    return null;
  }

  /**
   * A numbered move of the line read, with its number and side there, that cannot be played, in a game begun from a
   * picture whose squares were read unsure (`tree.alts`): when one of those squares read otherwise lets every move of
   * the game be played still and this one too, with the move written right after it — one such reading only —, the
   * game's first position is that one (a misread square the moves show further on: a white bishop read as Black's
   * blocks a king's walk at move 5). The picture is not taken as known for that: a square the moves read otherwise is
   * their guess, not a position of the line read, and taught as one it made the book's other boards read worse. A
   * scan's moves count only as written. Returns what play returns, or null.
   */
  repair(t, ahead) {
    const tree = this.tree;
    const cur = this.cur;
    if (!tree?.alts || !cur || fullmove(cur) !== t.num || (t.side && turn(cur) !== t.side)) return null;
    // (the line read played from each other reading, once per position it is at: `misread`)
    if (this.misread?.cur !== cur) {
      const f = tree.root.fen.split(' ');
      const base = squares(f[0]);
      const path = tree.path(cur).slice(1).map(n => n.uci);
      const list = [];
      for (const a of tree.alts)
        for (const o of a.options) {
          if (o === base[a.sq]) continue;
          const sq = [...base];
          sq[a.sq] = o;
          const p = placementOf(sq.join(''));
          // (a reading no game can have — a third queen — is a picture misread all over, not one square)
          if (!possible(p)) continue;
          const fen = [p, f[1], castlingOf(p), '-', f[4], f[5]].join(' ');
          let pos = positionOf(fen);
          for (const uci of path) pos = played(pos, uci);
          if (pos) list.push({ fen, pos });
        }
      this.misread = { cur, list };
    }
    const fits = [];
    for (const { fen, pos } of this.misread.list) {
      const uci = playableIn(pos, t, true);
      if (uci && (!ahead.length || followOn(null, uci, ahead, 1, pos, true))) fits.push({ fen, uci });
    }
    if (fits.length !== 1 || !rebase(tree, fits[0].fen)) return null;
    tree.alts = null;
    const child = tree.addMove(cur, fits[0].uci).node;
    child.bookShown = false;
    this.cur = child;
    this.lastReal = true;
    return { tree, node: child, shown: false };
  }

  /**
   * A numbered move written after "followed by" (PLAN) that is the next move of the side that made the move before it —
   * "1.Qd7 followed by 2.Re8 mate", "2.Nb5+ followed by 3.Nxa7" —: what that side means to play, whatever the other does
   * in between. It is played from the position the reading is at with that side to move again, a game of its own (as
   * otherSide's what-if); the moves after it go on in the game it left (`left`) unless they answer it right after it
   * (see play). Returns what play returns (`planned`: its glyph teaches nothing, see BookMoves.follow), or null.
   */
  plan(t) {
    const cur = this.cur;
    if (!cur || !t.side || turn(cur) === t.side || t.num !== fullmove(cur) + (t.side === 'white' ? 1 : 0)) return null;
    const f = cur.fen.split(' ');
    f[1] = t.side[0];
    f[3] = '-';
    f[5] = String(t.num);
    const fen = f.join(' ');
    const pos = positionOf(fen);
    const uci = pos && playableIn(pos, t);
    if (!uci) return null;
    const from = this.tree;
    const { hidden } = from;
    this.tree = new Tree(fen);
    if (hidden) this.tree.hidden = hidden;
    this.trees.push(this.tree);
    const child = this.tree.addMove(this.tree.root, uci).node;
    child.bookShown = false;
    this.cur = child;
    // (the game it left, where, and the plan's own: see play)
    this.left = { tree: from, cur, plan: this.tree };
    this.lastReal = true;
    return { tree: this.tree, node: child, shown: false, planned: true };
  }

  /**
   * A numbered move of the side that is not to move, with the number of the position the reading is at, or of the
   * game's first one: what would happen there if that side were to move — "Black to move loses (7...Kg3 8.Ke2)", "on
   * 1...Kg6, 2.e7 …", "But Black to move draws: 1...Kd8!" after White's moves from a diagram —, a game of its own from
   * that position with that side to move, when the move and the one after it can be played there. The reading goes
   * back to the game it left at the bracket's end, or with the next move of that game (see pick). Returns what play
   * returns, or null.
   */
  otherSide(t, ahead) {
    if (!this.cur || !t.side) return null;
    const at = [this.cur, this.tree.root].find(n => fullmove(n) === t.num && turn(n) !== t.side);
    if (!at) return null;
    const f = at.fen.split(' ');
    f[1] = t.side[0];
    f[3] = '-';
    const fen = f.join(' ');
    const pos = positionOf(fen);
    const uci = playableIn(pos, t, true);
    if (!uci || !followOn(null, uci, ahead, 1, pos, true)) return null;
    // (a game like a diagram's — but the brackets open stay open: their end goes back to the game it left; its kings
    // put in hidden as there)
    const { hidden } = this.tree;
    this.tree = new Tree(fen);
    if (hidden) this.tree.hidden = hidden;
    this.trees.push(this.tree);
    this.cur = this.tree.root;
    const child = this.tree.addMove(this.tree.root, uci).node;
    child.bookShown = false;
    this.cur = child;
    this.lastReal = true;
    return { tree: this.tree, node: child, shown: false };
  }

  /**
   * A move of the line being read that fits only after a move the text does not show — one it lost (a scan's OCR read
   * it as something else) or left out —, or after two (both sides' moves of a number): those moves (`bookInferred`),
   * when they are the only ones after which this move and the moves written after it can be played as written (the
   * move number, the side, the replies) — at least the next one, and more than after any other (`between`: the text
   * before it; `garbled`: the moves since the last one placed that found no place, see play). Returns what play
   * returns, or null.
   */
  bridge(t, ahead, between = '', garbled = []) {
    const cur = this.cur;
    const pos = cur && positionOf(cur.fen);
    // (not a word of a table the OCR made no move of: the moves most like it fit after too many moves)
    if (!this.tree || !pos || t.desc || t.fuzzy) return null;
    const fits = plies => {
      const at = afterPlies(pos, plies);
      return (!t.num || at.num === t.num) && (!t.side || at.side === t.side);
    };
    const found = [];
    // (a scan's move as one of its readings, not its other digits of like shape nor the moves most like its word: those
    // fit in too many of the positions a lost move leads to)
    const try1 = (p, path) => {
      const uci = playableIn(p, t, 'read');
      if (uci) found.push({ path, uci, p, score: followOn(null, uci, ahead, ahead.length, p) });
    };
    if (fits(1)) for (const m of legalMoves(pos)) try1(played(pos, m), [m]);
    // (two missing: only when one cannot do, and the move's number says so — not for a scan's or a lost figurine's move
    // in a tracker of retrace's, which follows a window's moves again from each of its starts: tried there for each, in
    // every position two moves on, those made a scan's follow three times slower; a move the text wrote whole is tried
    // there too)
    if (!found.length && t.num && fits(2) && !(this.quick && (t.misread || t.glyph)))
      for (const m of legalMoves(pos)) {
        const mid = played(pos, m);
        if (mid) for (const n of legalMoves(mid)) try1(played(mid, n), [m, n]);
      }
    if (!found.length) return null;
    // (the one after which the most moves written after it go on — or, for a scan's moves, when two do as well so, the
    // one after which the most go on as read, as their readings, not their other digits of like shape nor the moves
    // most like their words — a table's word, read as no move, still as its likest —: those fit after too many; of
    // several that do as well, the one whose squares a short word between the two moves names — the move an OCR
    // garbled, read as no move or as one that found no place: "2.Nf3 2.7g6 3.Bc4" —, when only one does. A move written
    // well that found no place names its square where its number and side are a lost move's — "31.Rxh5+" on a board
    // whose h-pawn was read away —, else only its own piece's move there: with another number it is most often another
    // position's move, a threat a note names, "13.Nb6" — not Black's b6)
    const lost = m => found[0].path.some((_, plies) => {
      const at = afterPlies(pos, plies);
      return (!m.num || at.num === m.num) && (!m.side || at.side === m.side);
    });
    const squaresOf = g => g.t.ocr || g.t.misread || lost(g.t);
    const words = [...garbled.filter(squaresOf).map(g => g.word), between].join(' ').split(/\s+/).filter(w => w.length <= 10 && !/[a-z]{3}/.test(w));
    const named = new Set(words.flatMap(w => [...w.matchAll(/([a-h])([1-8]|[lI](?![a-z]))/g)].map(m => `${m[1]}${m[2].replace(/[lI]/, '1')}`)));
    for (const { t: m } of garbled.filter(g => !squaresOf(g)))
      for (const san of m.sans || [m.san]) {
        const to = /([a-h][1-8])(?:=[QRBN])?$/.exec(san);
        if (to) named.add(`${/^[KQRBN]/.exec(san)?.[0] || 'P'}${to[1]}`);
      }
    // (the moves of a path named: each its square, or its piece's move there)
    const says = path => {
      let at = pos;
      return path.every(m => {
        const role = at.board.get(squareIndex(m.slice(0, 2)))?.role;
        at = played(at, m);
        return named.has(m.slice(2, 4)) || named.has(`${LETTERS[role]}${m.slice(2, 4)}`);
      });
    };
    const one = key => {
      const best = Math.max(...found.map(f => f[key]));
      let top = found.filter(f => f[key] === best);
      if (top.length > 1) {
        const hinted = top.filter(f => says(f.path));
        if (hinted.length === 1) top = hinted;
      }
      return best >= 1 && top.length === 1 ? top[0] : null;
    };
    // (the scores as read only when the others choose none)
    const read = () => {
      for (const f of found) f.read = followOn(null, f.uci, ahead, ahead.length, f.p, 'read');
      return one('read');
    };
    const chosen = one('score') || (t.misread && read());
    // (not where the checks written along it fail more than they hold: the position is another one — a picture's piece
    // misread —, whatever the lost moves made up)
    if (!chosen || checksAgree(null, chosen.uci, t, ahead, chosen.p, true) < 0) return null;
    let node = cur;
    for (const m of chosen.path) {
      node = this.tree.addMove(node, m).node;
      node.bookInferred = true;
      node.bookShown = false;
    }
    const child = this.tree.addMove(node, chosen.uci).node;
    child.bookShown = false;
    this.cur = child;
    this.lastReal = true;
    return { tree: this.tree, node: child, shown: false };
  }

  /**
   * Whether the move `t` (no number: `uci` there, by default as the text has it) can be played where the line is, by
   * the side to move, and the numbered move `upcoming` after it — a scan's moves as written: that move's, or null.
   */
  continues(t, upcoming, uci = this.cur && playable(this.cur, t, true)) {
    const cur = this.cur;
    if (!cur || !uci || (t.side && turn(cur) !== t.side)) return null;
    const pos = played(positionOf(cur.fen), uci);
    return (pos && fitsAt(pos, upcoming) && playableIn(pos, upcoming, true)) || null;
  }

  /**
   * Whether one of the numbered moves the text writes further on the line (`further`, see play: not in a variation's
   * bracket, before the next diagram) has the number and side of the position the line is at — before any of an earlier
   * move, another game's or a puzzle's: the move there is written again with its number, the game's own after a note
   * on another, so a move without one before it is not it —, or is the move that got the line there, written again:
   * "The usual line is 4.Ba4 Nf6", the game's own reply after it.
   */
  retold(further) {
    const cur = this.cur;
    if (!cur) return false;
    const ply = (num, side) => num * 2 + (side === 'black' ? 1 : 0);
    const here = ply(fullmove(cur), turn(cur));
    for (const m of further) {
      const at = ply(m.num, m.side);
      if (at === here - 1 && cur.parent && says(cur, m)) return true;
      if (at < here) return false;
      if (at === here) return true;
    }
    return false;
  }

  /**
   * A numbered move that fits nowhere, after a move written since the line read got where it is and only shown — a
   * reply written after a note without its number that play did not take as the line's (its next numbered move on the
   * next page, or not at a sentence's start: "6.f5, when Kd8 7.Kf7"), or a pawn's taken for a square, "6.f5 [note] g6
   * 7.Kf7" —: when it can be played, with its number and side, after one of those moves (the latest first) from the
   * position the line read is at, that move is the line's reply (the text's move gets its node), and this one is played
   * after it (see continues) — unless the text writes the reply further on with its number (play: retold), a note's
   * moves before it: "Black has Na5, Bb7 and h6; after 10.d4 … 9...Bb7 10.d4". On the game's main line, only the move
   * written last before it (`prior`), nothing between them but signs or the comments on that move ending a sentence
   * ("Kf8 The only move. 15.Qe2"): a move a note names there, the words going on to this one — "Black may play b5
   * later; after 5.d4 …", "Nc7 runs into 21.Nb6" —, is the note's, and taken for the reply it put the game's own moves
   * after it in a variation. Returns what play returns, or null.
   */
  replied(t, prior, between) {
    const cur = this.cur;
    // (not at a game's first position for a move of its number and the other side — "the threat is Bb1 followed by Qc2
    // … 1...d5" —: its side to move may be a guess, and that move what the other side would do, see otherSide)
    if (!this.tree || !cur || (!cur.parent && t.num === fullmove(cur) && t.side !== turn(cur))) return null;
    const last = this.since.at(-1);
    const main = mainLine(this.tree).includes(cur);
    if (main && (last?.t !== prior || (/\p{L}/u.test(between) && !SENTENCE_END.test(between) && !PARA.test(between)))) return null;
    for (const s of main ? [last] : [...this.since].reverse()) {
      const uci = s.node ? s.node.uci : playable(cur, s.t, true);
      const next = this.continues(s.t, t, uci);
      if (!next) continue;
      const { node } = this.tree.addMove(cur, uci);
      node.bookShown = false;
      this.lead(node);
      Object.assign(s.t, { tree: this.tree, node, shown: false });
      this.answered.push(s.t);
      const child = this.tree.addMove(node, next).node;
      child.bookShown = false;
      const spine = this.spine === cur && this.spineTree === this.tree;
      this.cur = child;
      if (spine) this.grow(child);
      this.lastReal = true;
      return { tree: this.tree, node: child, shown: false };
    }
    return null;
  }

  /**
   * A move spelled out in a bracket right after the moves of a number (nothing else between them), saying one of them
   * again — "3 P to Q 4  3 P takes P (Pawn to Queen's fourth.) (Pawn takes Pawn.)", as Cook's primer writes each move
   * once more —: that move ({ tree, node, restated }), in their order; else null.
   */
  restate(t, between) {
    const cur = this.cur;
    if (!this.tree || !cur?.parent || !/^[\s()[\].,;:]*$/.test(between)) return null;
    // (Black's move with White's of the same number before it: both may be said again, White's first)
    const pair = cur.color === 'black' && cur.parent.parent && cur.parent.moveNumber === cur.moveNumber ? [cur.parent, cur] : [cur];
    for (const n of pair.slice(pair.indexOf(this.restated) + 1))
      if (says(n, t)) {
        this.restated = n;
        return { tree: this.tree, node: n, shown: false, restated: true };
      }
    return null;
  }

  /**
   * Where a numbered move goes, of the places it may be played (`legal`: [{ node, uci }], the likeliest first): the
   * one where the most moves written after it (`ahead`) can be played too — of equals, the main line's end when the
   * move begins a paragraph (`para`: the game goes on after a note). When they can be played in none of them, a
   * position the reading went through not long ago, with the move's number, where they can — the latest first —: a
   * note going back to a line that is neither the one being read nor the main line (two of them at least, or one when
   * the move fits nowhere else), or the text going back to a game it left (two at least: "Let's try 1.Na3" after a
   * position the book showed on its own); never the start of a game from the initial position ("1." there begins a
   * game of its own). Returns { node, uci, tree (another game's), score, tied (how many different moves — pieces —
   * the moves after it fit as well) } or undefined.
   */
  pick(t, legal, ahead, para) {
    const scores = legal.length > 1 ? legal.map(c => followOn(c.node, c.uci, ahead)) : legal.map(c => followOn(c.node, c.uci, ahead, 1));
    let best = legal.length ? Math.max(...scores) : -1;
    let chosen = legal[scores.indexOf(best)];
    if (para && legal.length > 1) {
      const end = mainLine(this.tree).at(-1);
      const spine = this.spineTree === this.tree ? this.spine : null;
      chosen = legal.find((c, i) => c.node === spine && scores[i] === best) || legal.find((c, i) => c.node === end && scores[i] === best) || chosen;
      // (a scan's: the game's own line wherever a move after it goes on there too — its OCR's other readings make the
      // moves after it a poorer guide to tell a note's line from the game's)
      if (t.misread || t.fuzzy) chosen = legal.find((c, i) => c.node === spine && scores[i] > 0) || chosen;
    }
    // (a scan's move read more than one way there, as many moves going on after each: the reading the check signs agree
    // with)
    const even = chosen ? legal.filter((c, i) => c.node === chosen.node && scores[i] === best) : [];
    if ((t.misread || t.fuzzy) && new Set(even.map(c => c.uci)).size > 1) {
      const agree = even.map(c => checksAgree(c.node, c.uci, t, ahead));
      chosen = even[agree.indexOf(Math.max(...agree))];
    }
    const tied = new Set(legal.filter((c, i) => scores[i] === best).map(c => c.uci.slice(0, 2))).size;
    if (best > 0 || !this.tree) return chosen && { ...chosen, score: best, tied };
    const known = new Set(legal.map(c => c.node));
    // (one of the game being read where the reply right after it can be played: when it can be played after none of
    // the places it may be — "6.Kf4 Kh6", back to the main line from a note)
    const need = tree => (tree === this.tree && (!legal.length || adjoins(ahead[0].between)) ? 1 : 2);
    for (const [node, tree] of [...this.seen].reverse()) {
      // (a diagram not played from yet whose move number — and side — are guesses: an exercise, its answer pages later,
      // "6. d5 Ne5 7. c4", gives them — not a numbered puzzle: its solution names it)
      const open = !!t.num && node === tree.root && !!tree.guess?.number && !tree.labelled && !node.children.length;
      if (known.has(node) || (fullmove(node) !== t.num && !open) || (turn(node) !== t.side && !(open && tree.guess.side && t.side)) || (node === tree.root && tree.isStandardStart)) continue;
      let at = node;
      if (open) {
        const f = node.fen.split(' ');
        f[5] = String(t.num);
        if (t.side) f[1] = t.side[0];
        at = { fen: f.join(' ') };
      }
      // (a scan's moves as written: their other readings fit too many positions read long ago)
      const uci = positionOf(at.fen) && playable(at, t, true);
      const score = uci ? followOn(at, uci, ahead, undefined, undefined, true) : -1;
      if (score >= need(tree) && score > best) (best = score), (chosen = { node, uci, tree, fen: open ? at.fen : null });
    }
    return chosen && { ...chosen, score: best, tied: chosen.tree ? 1 : tied };
  }

  /** How many of the moves written after `t` (White's "1.") can be played after it from the initial position (-1: not it). */
  fromStart(t, ahead) {
    const root = { fen: INITIAL_FEN };
    const uci = playable(root, t, true);
    return uci ? followOn(root, uci, ahead, undefined, undefined, true) : -1;
  }

  /**
   * A game from the initial position, with `t` ("1." of White's move) — unless the moves written after it say it is a
   * move named in a sentence ("the analysis of 1.h4 …"): the reply right after it cannot be played, or the next
   * numbered move is a later one than the game's second; `sure`: only when the move after it can be played.
   */
  startGame(t, ahead = [], sure = false) {
    const tree = new Tree(INITIAL_FEN);
    const uci = playable(tree.root, t, true);
    if (!uci) return null;
    const reply = ahead[0] && adjoins(ahead[0].between) && !ahead[0].t.num ? ahead[0] : null;
    const numbered = ahead.find(a => a.t.num);
    if ((reply && !followOn(tree.root, uci, [reply], 1, undefined, true)) || numbered?.t.num > 2 || (sure && !followOn(tree.root, uci, ahead, 1, undefined, true))) return null;
    this.trees.push(tree);
    this.tree = tree;
    this.returns = [];
    this.recent = [];
    this.cur = tree.addMove(tree.root, uci).node;
    this.lastReal = true;
    this.grow(this.cur);
    return { tree, node: this.cur, shown: false };
  }

  /** Where `t` may be played, the likeliest first (`twice`: in the line read only, see play). */
  candidates(t, { variation, sequence, twice = false }) {
    if (!this.tree) return [];
    const out = [];
    const add = n => n && !out.includes(n) && (!t.side || turn(n) === t.side) && out.push(n);
    const cur = this.cur;
    const main = mainLine(this.tree);
    if (t.num) {
      const at = n => n && fullmove(n) === t.num && turn(n) === t.side;
      // (in a bracket: the alternative to the move before — "13.Bg5 (13.Nd5 …)" —, or its reply)
      if (variation && at(cur.parent)) add(cur.parent);
      if (at(cur)) add(cur);
      // (the game's own line)
      if (!twice && this.spineTree === this.tree && at(this.spine)) add(this.spine);
      if (!twice && at(main.at(-1))) add(main.at(-1));
      // (a game from the initial position: "1." begins another game — a book's games, or an opening restated with
      // other moves after it —, unless the reading is at its start: a diagram of the initial position)
      const fresh = n => n === this.tree.root && this.tree.isStandardStart && n !== cur;
      for (const line of twice ? [this.tree.path(cur)] : [this.tree.path(cur), main]) add(line.find(n => at(n) && !fresh(n)));
      return out;
    }
    if (variation) {
      add(cur.parent);
      add(cur);
    } else if (sequence) add(cur);
    else {
      add(cur);
      add(cur.parent);
      add(main.at(-1));
    }
    return out;
  }
}

// The usual figurines as OCRs read them, most often (see BookMoves.pieceOf): the commercial OCR behind many scanned
// books' text — each spelling the same piece wherever a book's own moves taught it (Inside the Chess Mind, Pump Up
// Your Rating, Kotov, The Soviet Chess Primer) — and Tesseract's W and &.
const OCR_FIGURINES = {
  W: 'Q', "'ii'": 'Q', "'ii": 'Q', "'iW": 'Q', "'i": 'Q',
  '&': 'K', "'it>": 'K', '<it>': 'K', "'it": 'K', "'itt": 'K', "'iit": 'K', '<t>': 'K', '<lt': 'K',
  'l:t': 'R', 'l:.': 'R', "':": 'R', "':'": 'R', ":'": 'R', ':t': 'R', 'l:': 'R',
  'i.': 'B', iL: 'B', 'i..': 'B', 'il.': 'B', 'ii.': 'B', 'J.': 'B', 'j.': 'B',
  ttJ: 'N', liJ: 'N', ltJ: 'N', lLl: 'N', lD: 'N', tD: 'N', tiJ: 'N', tLl: 'N',
};
// (a font's own figurine, without Unicode for it: one character of its own — of the private use area, as Mastering
// Endgame Strategy's, or a symbol such as "¢", as The Woodpecker Method's —, no ASCII an OCR reads, no letter or digit,
// not "�")
const FIGURINE = /^[^\x00-\x7F\p{L}\p{N}�]$/u;
// (the moves only one piece could make that make a glyph that piece's alone: see BookMoves.learnt)
const FIRM = 12;

/** A glyph's moves where only one piece could go, as [[piece, count]], most first. */
const sorted = seen => [...(seen || new Map())].sort((a, b) => b[1] - a[1]);

/**
 * The piece such moves show clearly — twice, and twice as often as any other, and seven times in ten; or, from eight
 * moves on, three times as often as any other and half the times (see BookMoves.pieceOf) — or null.
 */
function clearOf(seen) {
  const all = seen.reduce((n, [, k]) => n + k, 0);
  const top = seen[0]?.[1] || 0;
  const next = seen[1]?.[1] || 0;
  return (top >= 2 && top >= 2 * next && top >= all * 0.7) || (top >= 8 && top >= 3 * next && top >= all * 0.5) ? seen[0][0] : null;
}

/**
 * How a move of the text `t` stands (see BookMoves.follow; `between`: the text since the move before, `closed`: a
 * variation in brackets closed there, `prev`: the move before): whether it is the reply to the move before it, and
 * whether it begins a paragraph.
 */
function standing(t, between, closed, prev) {
  // (the reply: right after a move — or after a variation in brackets, to the move it went back to: "1.Qh7+ (1.Rxf5?
  // Qh1#) Kf8" —; in descriptive notation also after a comma or a full stop: "5 R - B 4 ch, K - Kt 6;", "1. P. to K.
  // 4th. P. to K. 4th.")
  const reply = adjoins(between) || (closed && /^[\s)\]]*$/.test(between)) || (t.desc && prev?.desc && prev.num && prev.side === 'white' && /^\s*[.,]\s*$/.test(between));
  return { reply, para: PARA.test(between) };
}

// How many of the moves followed before a diagram, since the diagram before it, may be its game's first ones (see
// BookMoves.retrace).
const HISTORY = 60;

/**
 * A move of the text once placed: one read by OCR, one with readings of its own — "Bxc3" played as bxc3 — or one
 * written in descriptive notation is said as the move that was played — or, in descriptive notation, as written when
 * none was: followed again, a move may lose its position —; a move spelled out is said as it is written.
 */
function voiced(t) {
  if ((t.ocr || t.sans || t.desc || t.spelled) && t.node?.san) {
    t.san = t.node.san.replace(/[+#]$/, '');
    t.check = /[+#]$/.exec(t.node.san)?.[0] || '';
    if (!t.spelled) t.words = spokenMove(t);
  } else if (t.desc && !t.spelled) t.words = spokenDescriptive(t);
}

/**
 * Follows the moves of a book, unit by unit — its pages or chapters, in reading order, { text, moves, diagrams }
 * (text.js; diagrams: [{ at (its place in the text), placement (FEN, or null when it was not read), side, font (set in a
 * chess font: exact), alts, label (its number by its corner, a puzzle's), number (its caption's) }]): each move gets
 * .tree, .node and .shown (null and false when no position was found), each diagram .tree and .node.
 */
export class BookMoves {
  /** `before`: the moves followed so far of the same book, when these go on from another place: what its glyphs are carries over. */
  constructor(before = null) {
    this.tracker = new MoveTracker();
    this.gap = ''; // the text after the last move, up to the next unit
    this.prev = null; // the last move followed
    this.glyphs = before?.glyphs || new Map(); // a lost figurine's glyph → { piece letter: moves where only that piece could go }
    this.known = new Map(); // (learnt's answers since the last move learnt from)
    this.labels = new Map(); // a diagram's number (see labelsOf) → the diagram (null: more than one has it)
    this.lastNum = null; // the number of the last numbered move of the text
    // the moves followed since the last diagram, { t, between, unread } (see retrace; `unread`: the line written after
    // a diagram that shows no position, its moves numbered on from its first one — that diagram's own moves)
    this.history = [];
    this.unread = null; // (the number of the last move of such a line, while it goes on)
    this.foot = null; // a diagram at the foot of a page, its own moves maybe on the next one (see follow)
    this.unitOf = new WeakMap(); // each move followed → its unit
    this.unit = null; // the unit being followed
    this.changed = new Set(); // the units before the one followed whose moves got a place (see replaced)
    this.takes = { played: 0, written: 0 }; // the moves placed that took, and of those the ones the text wrote with x
  }

  /**
   * A move given its place after it was followed (a reply a later move showed, a move written before its diagram: see
   * MoveTracker.replied, retrace): said as it is played, and its unit, when it is one followed before, made again by
   * the reader (follow returns it).
   */
  replaced(t) {
    voiced(t);
    const unit = this.unitOf.get(t);
    if (unit && unit !== this.unit) this.changed.add(unit);
  }

  /**
   * The piece a lost figurine's glyph is, once the book's moves have shown it clearly (twice, and twice as often as
   * any other, and seven times in ten; or, from eight moves or more, three times as often as any other and half the
   * times — a scan's moves placed in wrong positions add noise: the 158-page Inside the Chess Mind's "l:t" was a
   * rook 165 times in 179) — never "�", the character for any glyph a font or an OCR could not tell —; until then,
   * what an OCR reads the usual figurines as (OCR_FIGURINES). With both, the 158-page Inside the Chess Mind +221 moves
   * placed, Pump Up +150, The Soviet Chess Primer +83, Kotov +51, no book fewer.
   */
  pieceOf(glyph) {
    return this.learnt(glyph)?.piece || OCR_FIGURINES[glyph] || null;
  }

  /**
   * What the book's moves have shown a lost figurine's glyph to be (see pieceOf): { piece, firm } or null. A font's own
   * figurine — one character of its own (FIGURINE), one per piece — is firm once FIRM of its moves could only be that
   * piece's: its moves are then that piece's alone — another piece that can go there means a position the move does not
   * belong to (Mastering Endgame Strategy's king's figurine was played as a queen or a rook 1,265 times). It is also
   * the piece most of its moves showed when that is no piece another of the book's figurines has been learnt to be (its
   * other readings are counted out): the moves of a piece the book moves rarely teach slowly, and moves placed in wrong
   * positions add the other pieces (Mastering Endgame Strategy's knight: N 277, Q 123, K 122, R 77).
   */
  learnt(glyph) {
    if (glyph === '\uFFFD') return null;
    if (this.known.has(glyph)) return this.known.get(glyph);
    const seen = sorted(this.glyphs.get(glyph));
    let piece = clearOf(seen);
    // (a font's figurines come together — characters near each other, two others at least shown clearly to be other
    // pieces —; an OCR's stray symbol stands alone: The Soviet Chess Primer's "®", Kotov's "•")
    const kin = new Set();
    if (FIGURINE.test(glyph))
      for (const [g, s] of this.glyphs) if (g !== glyph && FIGURINE.test(g) && Math.abs(g.codePointAt(0) - glyph.codePointAt(0)) <= 32) kin.add(clearOf(sorted(s)));
    kin.delete(null);
    const font = kin.size >= 2;
    if (!piece && font && seen.length && !kin.has(seen[0][0])) piece = clearOf(seen.filter(([p]) => !kin.has(p)));
    // (only a font's figurine is firm: an OCR may spell two pieces alike — the 158-page Inside the Chess Mind, Pump Up
    // Your Rating, The Soviet Chess Primer and Amateur to IM lost moves when their spellings were)
    const out = piece ? { piece, firm: font && this.glyphs.get(glyph).get(piece) >= FIRM } : null;
    this.known.set(glyph, out);
    return out;
  }

  /**
   * A move's lost figurine as the piece the book's moves have taught it to be (see pieceOf), and a promotion's figurine
   * (text.js `promoted`): its piece's promotion first, then the others as text.js has them, the queen first — whatever
   * a run before had put first.
   */
  figure(t) {
    if (t.glyph) (t.piece = this.pieceOf(t.glyph)), (t.firm = !!this.learnt(t.glyph)?.firm);
    if (!t.promoted) return;
    const p = this.pieceOf(t.promoted);
    const order = san => (p && san.endsWith(p) ? -1 : 'QNRB'.indexOf(san.at(-1)));
    t.sans = [...t.sans].sort((a, b) => order(a) - order(b));
  }

  /** A lost figurine's move was played where only one piece could make it: that piece is what the glyph stands for. */
  learn(t) {
    const legal = new Set(t.sans.filter(san => moveAt(t.node.parent, san)).map(san => san[0]));
    if (legal.size !== 1) return;
    const seen = this.glyphs.get(t.glyph) || new Map();
    const [piece] = legal;
    seen.set(piece, (seen.get(piece) || 0) + 1);
    this.glyphs.set(t.glyph, seen);
    this.known.clear();
  }

  get trees() {
    return this.tracker.trees;
  }

  /**
   * A diagram that began a game of its own (`tree`, nothing played from it yet): the moves written before it may be its
   * own — the picture set under them, at the foot of a column or a page ("1.Ke2 Kf7 2.Ke3 Ke7 3.Ke4" over the diagram
   * they are played from), or over the rest of them at the top of the next one, as a database's export lays out an
   * example ("41.Kf2 Kd7 42.Ke3 Ke7 [diagram] 43.Kd4"). `prior`: the moves followed since the diagram before it, on its
   * page or the pages before ({ t, between, unread }: `unread`, the line written after a diagram that shows no position
   * — its own); `rest`: the text after the last of them, up to the diagram; `side`: the side to move the book marks;
   * `was`: the number the line read was at; `fresh`: no move written after the diagram goes on from it as read;
   * `later`: the moves written after it on its page — or, at the foot of a page, on the next one, up to its first
   * diagram (see follow). From each of those numbered moves, written whole, that found no place — not in a variation's
   * brackets that close before the diagram — and can be played from it, with its number and side (the side the book
   * marks, when it marks one), the moves from there on are followed again in a game of its own from it (a tracker of
   * their own, as the book's are followed — a scan's or a lost figurine's move bridged over one lost move: quick); the
   * one that places the most of the moves that had no place — in three positions at least (two, when the moves after
   * the diagram go on from where they got to further than from it as read, or as far when the last move before it that
   * had no place, not in such brackets, is one of them), twice as many as it places of the moves placed elsewhere, and
   * more than it leaves of those — becomes the diagram's game: those moves get their place in it (the others keep
   * theirs), and the reading goes on from where they got to. Unless they are an example begun again — from its first
   * move, or numbered below the line read, and no move after the diagram goes on from it as read —, the moves after the
   * diagram, from its first numbered one (the text wrote whole), must go on from where they got to (or from before the
   * last of them: another move for it), and as far as from the diagram as read: the moves of a note on the game read
   * may be played from its later diagram too, with the game's next move after them, and a king's from many a position.
   * Returns the game's first position, or null.
   */
  retrace(tree, prior, { side, was, fresh, later, rest = '' }) {
    const lost = t => !t.node || t.shown;
    // (how far the moves after the diagram go on from a position: from its first numbered one, its number and side)
    const after = later.find(t => t.num && whole(t));
    const tail = after ? later.slice(later.indexOf(after)) : [];
    const runAt = fen => (after && positionOf(fen) ? runFrom(positionOf(fen), tail) : 0);
    const g = tree.root.fen.split(' ');
    if (after) [g[1], g[3], g[5]] = [after.side?.[0] || g[1], '-', String(after.num)];
    const asRead = runAt(g.join(' '));
    // (a variation's move in brackets that close before the diagram — a note on the game's moves that led to it —
    // begins no game of the diagram's: "21.Kf3 Rd6 (21...Ke5 22.g4) 22.h5 [diagram]")
    const { depth, low } = bracketsOf([...prior, { between: rest }]);
    const closes = [];
    for (let k = prior.length - 1, least = low[prior.length]; k >= 0; k--) (closes[k] = least < depth[k]), (least = Math.min(least, low[k]));
    // (how many moves that found no place there are from each one on: no start can gain more positions than that)
    const left = [];
    for (let k = prior.length - 1, n = 0; k >= 0; k--) left[k] = n += lost(prior[k].t) ? 1 : 0;
    // (the last move before the diagram that had no place, not one of a variation's in brackets closed before it)
    const last = prior.findLastIndex((p, k) => !closes[k] && p.t.num && whole(p.t) && lost(p.t));
    let best = null;
    for (const [k, { t: m, unread }] of prior.entries()) {
      if (unread || closes[k] || !m.num || !m.side || !whole(m) || !lost(m) || (side && side !== m.side[0]) || left[k] < Math.max(2, (best?.gained ?? 0) + 1)) continue;
      const f = tree.root.fen.split(' ');
      [f[1], f[3], f[5]] = [m.side[0], '-', String(m.num)];
      const fen = f.join(' ');
      if (!positionOf(fen) || !choices({ fen }, m).length) continue;
      const sub = new MoveTracker();
      sub.quick = true;
      const game = sub.newGame(fen).tree;
      if (tree.hidden) game.hidden = tree.hidden;
      const copies = prior.slice(k).map(s => ({ t: { ...s.t, node: null, tree: null, shown: false, restated: false }, between: s.between }));
      const lines = linesOf(copies);
      let prev = null;
      for (const [i, { t, between }] of copies.entries()) {
        const closed = i ? sub.between(between) : false;
        const { reply, para } = standing(t, i ? between : '', closed, prev);
        const joined = !!i && reply;
        const r = sub.play(t, { seq: joined, ahead: copies.slice(i + 1, i + 9), para, between: i ? between : '', upcoming: joined || t.num ? null : lines(i)[0] || null, further: lines(i, Infinity) });
        if (r) Object.assign(t, { tree: r.tree, node: r.node, shown: !!r.shown, restated: !!r.restated });
        prev = t;
      }
      const placed = copies.filter(c => c.t.node && !c.t.shown && c.t.tree === game);
      const found = placed.filter(c => lost(prior[k + copies.indexOf(c)].t));
      // (the positions they get to: a move written again — "1...Nxe4" in each of three notes — gets to one)
      const gained = new Set(found.map(c => c.t.node)).size;
      // (the moves after them that have a place elsewhere and not in it: another game's line, written between them and
      // the diagram — those moves are not the diagram's)
      const apart = copies.filter((c, i) => !lost(prior[k + i].t) && !placed.includes(c)).length;
      // (where they got to, and whether the moves after the diagram go on from there — or from before the last of them
      // — and as far as from the diagram as read)
      const end = sub.tree === game ? sub.cur : placed.at(-1)?.t.node;
      const there = end ? runAt(end.fen) : 0;
      const on = Math.max(there, end?.parent ? runAt(end.parent.fen) : 0);
      const goesOn = on >= 1 && on >= asRead;
      // (two positions are enough when the moves after the diagram go on from where they got to — further than from the
      // diagram as read, or as far when the last move that had no place before it is one of them: else that move, which
      // they leave out, led to the diagram, "9...Qb6?! 10.Na4 … 10.Be3 [diagram] 10...Nxe5", and theirs were a note's)
      const ends = last < k || found.includes(copies[last - k]);
      const enough = (gained >= 3 || (gained === 2 && there >= 1 && (there > asRead || (there === asRead && ends)))) && found.length >= 2 * (placed.length - found.length) && apart < found.length;
      // (an example begun again: from its first move, or numbered below the line read)
      const begun = !was || m.num === 1 || m.num < was;
      if (!enough || (best && gained <= best.gained) || (!(fresh && begun) && !goesOn)) continue;
      best = { k, sub, game, copies, gained, end };
    }
    if (!best) return null;
    const { k, sub, game, copies, end } = best;
    // (the diagram's game is the one followed again: its first position and its moves — under the diagram's own root,
    // which the reading has seen and the diagram shows)
    const { root } = tree;
    const own = n => (n === game.root ? root : n);
    root.fen = game.root.fen;
    root.children = game.root.children;
    for (const c of root.children) c.parent = root;
    tree.guess = null;
    tree.version++;
    copies.forEach(({ t: c }, i) => {
      const { t } = prior[k + i];
      if (!lost(t) || !c.node || c.shown || c.tree !== game) return;
      Object.assign(t, { tree, node: own(c.node), shown: false, restated: c.restated });
      if (t.glyph && t.node.parent) this.learn(t);
      this.replaced(t);
    });
    const tracker = this.tracker;
    tracker.tree = tree;
    for (const [n, g] of sub.seen) if (g === game) tracker.see(own(n));
    tracker.cur = own(end);
    tracker.grow(sub.spineTree === game ? own(sub.spine) : root);
    tracker.returns = [];
    tracker.lastReal = true;
    return root;
  }

  /**
   * Follows a unit's moves and diagrams (see the class); returns the units followed before it whose moves got a place
   * only now (see replaced): the reader makes their spoken parts again.
   */
  follow(unit) {
    let prevEnd = 0;
    const diagrams = unit.diagrams || [];
    let d = 0;
    this.unit = unit;
    this.changed = new Set();
    // (a scanned page the app read by OCR: its moves' digits may be misread — text.js misreadings: the board and the
    // moves after it tell which reading —, and a word of a table of moves it made no move of is one too: text.js
    // rowMoves)
    if (unit.ocr && !unit.moves.some(t => t.fuzzy)) {
      const rows = rowMoves(unit.text, unit.moves);
      if (rows.length) unit.moves = [...unit.moves, ...rows].sort((a, b) => a.start - b.start);
    }
    if (unit.ocr)
      for (const t of unit.moves) {
        if (t.misread || t.fuzzy || t.desc || t.spelled || t.glyph) continue;
        t.read = t.sans || [t.san];
        const other = misreadings(t);
        t.sans = other?.sans || t.read;
        t.like = other?.like || [];
        t.misread = true;
        // (the word as read, from where the move itself begins: without its number — cut in two, "1 0.Qb3", or a letter
        // for a digit, "S.Kd4" — or dots)
        t.word = unit.text.slice(t.written?.at ?? t.start, t.end);
      }
    const { moves } = unit;
    // (a book that writes its captures with x — nine in ten of the moves placed that took, twenty at least —: a piece's
    // move written without one takes nothing, where a move is looked for as written — a scan's text may lose its x)
    const writes = this.takes.played >= 20 && this.takes.written >= 0.9 * this.takes.played;
    for (const t of moves) {
      this.unitOf.set(t, unit);
      t.untaken = writes && !t.pawn && !t.misread && !/^O-O/.test(t.san) && !/[x×:X]/.test(unit.text.slice(t.written?.at ?? t.start, t.end));
    }
    // (the moves written from `from` on, the first ones — not squares named on their own, which may be pawn moves of
    // either side, unless they answer the move before: "17. Ng5 c4!" —, and the ones before `stop`, the page's next
    // diagram, a dozen at most: see MoveTracker.diagram's `next` and `later`; `named`: those of the first ones with no
    // number named in a sentence before the first numbered one — "Black hopes for ...Ke6 and ...f5. 1.Nd4!" —, their
    // pieces letters or a font's figurines: an OCR's spelling of one may be the game's first move misread)
    const after = (from, stop) => {
      const next = [];
      const later = [];
      const named = [];
      const joins = (list, t) => list.length && adjoins(unit.text.slice(list.at(-1).end, t.start));
      const kept = (list, t) => t.num || t.side || !t.pawn || joins(list, t);
      for (const t of moves) {
        if (t.start < from) continue;
        if (next.length < 4 && kept(next, t)) {
          if (!t.num && !joins(next, t) && !next.some(x => x.num) && (!t.glyph || FIGURINE.test(t.glyph))) named.push(t);
          next.push(t);
        }
        if (t.start < stop && later.length < 12 && kept(later, t)) later.push(t);
        if (next.length === 4 && (later.length === 12 || t.start >= stop)) break;
      }
      return { next, later, named };
    };
    // (no move written after a diagram that began a game of its own goes on from it — the first one, or one with a
    // number —: the moves written before it are most surely its own, see retrace)
    const fresh = (node, later) => !later.some((t, i) => (t.num || !i) && fitsAt(positionOf(node.fen), t) && choices(node, t).length);
    // (a diagram at the last page's foot, no move after it there: its moves after it are this page's first ones,
    // up to its first diagram)
    if (this.foot) {
      const { tree, prior, side, was, rest } = this.foot;
      const { later } = after(0, diagrams[0]?.at ?? Infinity);
      if (!tree.root.children.length) this.retrace(tree, prior, { side, was, fresh: fresh(tree.root, later), later, rest });
      this.foot = null;
    }
    const diagram = dg => {
      const before = (this.gap + unit.text.slice(0, dg.at)).slice(-80);
      const rest = this.gap + unit.text.slice(prevEnd, Math.max(prevEnd, dg.at));
      this.tracker.between(rest);
      this.gap = '';
      prevEnd = Math.max(prevEnd, dg.at);
      const stop = diagrams[d]?.at ?? Infinity;
      const { later, named, next: first } = after(dg.at, stop);
      // (a font's own figurine among them, firmly learnt, is its piece, as for the moves themselves — taken for no
      // piece, a rook's "3.Re1" stopped where a bishop could go too, and went on where a square misread as a second
      // bishop made "Be1" no move: the misreading was chosen —; an OCR's spelling, learnt loosely, keeps the piece it
      // was given as one of the moves after the move before, if it was: kept from the diagram, its moves lost lines)
      for (const t of first) if (!t.glyph || this.learnt(t.glyph)?.firm) this.figure(t);
      // (its first move the first numbered one, the moves named before it left out, when more of them can be played
      // from the picture as read then: they tell its side to move — a move named with Black's dots is no reply)
      const numbered = first.filter(t => !named.includes(t));
      const next = dg.placement && named.length && numbered[0]?.num && runFromPicture(dg.placement, numbered) > runFromPicture(dg.placement, first) ? numbered : first;
      // (its side to move: as the book marks it — under it, in its caption —, else as the words after it say)
      const side = dg.side || sideMarked(before, unit.text.slice(dg.at, dg.at + 120));
      const said = sideSaid(unit.text.slice(dg.at, dg.at + 200));
      const was = this.tracker.cur && fullmove(this.tracker.cur);
      // (the numbered moves after it on its line, up to the page's next diagram, when the first of them is in a
      // sentence — a note's, "After 3.Bc4 …" —, not on a line of its own after it, the game's: see MoveTracker.onward)
      const k = moves.findIndex(t => t.start >= dg.at);
      const starts = k < 0 || /^\s*$|\n[ \t]*$/.test(unit.text.slice(dg.at, moves[k].start));
      const line = starts ? [] : [moves[k], ...lines(k, stop)].filter(t => t.num && t.start < stop);
      const r = dg.placement ? this.tracker.diagram(dg.placement, { side, said, next, later, near: dg.font ? 0 : 1, alts: dg.alts || [], line }) : null;
      // (a game of its own: the moves written before it may be its own, see retrace — at a page's foot, no move
      // after it there, once the next page shows whether its own moves come there)
      const own = r && !r.known && !this.tracker.caption && r.node === r.tree.root && !r.node.children.length;
      if (own && !later.length && d >= diagrams.length) this.foot = { tree: r.tree, prior: this.history, side, was, rest };
      else if (own) this.retrace(r.tree, this.history, { side, was, fresh: fresh(r.node, later), later, rest });
      this.history = [];
      this.unread = r ? null : 0;
      dg.tree = r?.tree || null;
      dg.node = r?.node || null;
      // (a picture's board that is a position of the line read: the position it shows is known — it teaches the
      // reading of the book's pieces, see diagrams.js readBoards)
      dg.known = r?.known && !dg.font ? r.node.fen.split(' ')[0] : null;
      if (!dg.node) return;
      // (its number: by its corner, as the page has it, else in the text around it — a puzzle's, which its solution
      // names: no exercise answered by its moves alone, see pick)
      for (const label of dg.label ? [dg.label] : labelsOf(before, unit.text.slice(dg.at, dg.at + 60))) {
        this.labels.set(label, this.labels.has(label) ? null : dg);
        dg.tree.labelled = true;
      }
      // (and the number its caption gives it — "DIAGRAM 10.", as pdf.js found it beside a picture, or a line over or
      // under it —, for the words that name it: see refer and solve)
      const caption = dg.number || captionOf(before, unit.text.slice(dg.at, dg.at + 60));
      if (caption && this.labels.get(caption) !== dg) this.labels.set(caption, this.labels.has(caption) ? null : dg);
    };
    let text = false; // (the move before was taken for text: see below)
    let garbled = []; // (the moves since the last one placed that found no place, with their words: see MoveTracker.bridge)
    // (each move with the text before it; the numbered moves of each one's line after it: see MoveTracker.play's
    // upcoming and further)
    const steps = moves.map((t, i) => ({ t, between: unit.text.slice(i ? moves[i - 1].end : 0, t.start) }));
    const lines = linesOf(steps);
    for (const [i, t] of moves.entries()) {
      while (d < diagrams.length && diagrams[d].at <= t.start) diagram(diagrams[d++]);
      const between = this.gap + unit.text.slice(prevEnd, t.start);
      // (after a diagram that shows no position, its own line: until a move numbered below the one before it begins
      // another — "1...Kd7" after "9.Rf1")
      if (this.unread !== null && t.num) this.unread = t.num < this.unread ? null : t.num;
      this.history.push({ t, between, unread: this.unread !== null });
      if (this.history.length > HISTORY) this.history.shift();
      const closed = this.tracker.between(between);
      const { reply: joined, para } = standing(t, between, closed, this.prev);
      const ahead = steps.slice(i + 1, i + 9);
      // (not the reply to a move taken for text)
      const reply = joined && !text;
      text = false;
      const then = reply || t.num ? null : lines(i)[0] || null;
      const further = lines(i, diagrams[d]?.at ?? Infinity);
      for (const a of [t, ...ahead.map(x => x.t), ...(then ? [then] : [])]) this.figure(a);
      // (a move number cut in two by a scan's OCR — "1 4.Nxe4" — is the one the line being read, or the moves written
      // before it, go on with; else the first part is a puzzle's number and the second the move's: "1 1.Qxg7#")
      if (t.cut) {
        const at = this.tracker.cur;
        const near = x => !!x && [at && fullmove(at), this.lastNum].some(n => !!n && Math.abs(n - x) <= 1);
        // (or the text goes back to a move of the game being read — after a note: "12.Qd3+? Kxe5 13.Qe3+ Kf5 14.Qf3+
        // Kg5 … 1 2 ... Rh8" — where the second part alone would be before the game's start; of three digits, the last
        // two after a stray one, as the line goes on: "11.Nbd2 Bf8 3 1 2.a4")
        const root = at && this.tracker.tree?.root;
        const inGame = n => !!root && n >= fullmove(root) && n <= fullmove(at) + 1;
        t.num = near(t.cut.whole) || (inGame(t.cut.whole) && !inGame(t.cut.num)) ? t.cut.whole : near(t.cut.pair) ? t.cut.pair : t.cut.num;
        t.words = spokenMove(t);
      }
      // (a scan's S for a 5 or an 8 — "S.Kd4", "lS.Rb8" —: the number the line being read, or the moves written before
      // it, go on with; else as a 5, the likelier)
      if (t.nums) {
        const at = this.tracker.cur;
        const nearTo = x => n => !!x && Math.abs(n - x) <= 1;
        t.num = t.nums.find(nearTo(at && fullmove(at))) ?? t.nums.find(nearTo(this.lastNum)) ?? t.nums[0];
        t.words = spokenMove(t);
      }
      // (a puzzle's solution, after the number of its diagram, or a move after words naming a diagram by its number: from
      // that diagram's position — named in the move's own sentence, "if White waits (see diagram 62), 1.Kd2", as the
      // words say, MoveTracker.refer; named before it, "Exercise 4 (Diagram 61): a famous study. 1...Rd2+", only where
      // the move fits nowhere the reading may be, solve)
      const inSentence = t.num ? namedDiagram(between, true) : null;
      const before = t.num && !inSentence ? namedDiagram(between) : null;
      const solution = t.cut?.num === t.num ? { label: t.cut.label, direct: true } : t.num ? solutionOf(between) || (before && { label: before, direct: false }) : null;
      const puzzle = solution && this.labels.get(solution.label);
      const solved = !!puzzle && this.tracker.solve(puzzle.tree, puzzle.node, t, solution.direct, ahead);
      const sent = !solved && inSentence ? this.labels.get(inSentence) : null;
      const referred = !!sent && this.tracker.refer(sent.tree, sent.node, t, ahead, between);
      const kept = { opened: this.tracker.opened, lastReal: this.tracker.lastReal, restated: this.tracker.restated, caption: this.tracker.caption };
      const r = this.tracker.play(t, { seq: reply && !solved && !referred, ahead, para, between, garbled, upcoming: then, further });
      garbled = r?.node ? [] : [...garbled, { t, word: unit.text.slice(t.start, t.end) }];
      // (the reply a numbered move showed, written before it: see MoveTracker.replied)
      for (const m of this.tracker.answered.splice(0)) this.replaced(m);
      // (a pawn's move whose file the scan lost that found no place is taken for the text it may be — a game's heading,
      // "(rapid 2.5)", a figurine and its square garbled —: the reading as it was before it, the move after it no reply)
      if (t.fileless && !r) {
        Object.assign(this.tracker, kept);
        t.tree = t.node = null;
        t.shown = t.restated = false;
        this.gap = '';
        prevEnd = t.end;
        text = true;
        continue;
      }
      if (t.num && (!t.fuzzy || r?.node)) this.tracker.placed(!!r?.node && !r.shown);
      t.tree = r?.tree || null;
      t.node = r?.node || null;
      // (a plan's move teaches no glyph: it is played where the other side's move is left out)
      if (t.glyph && t.node?.parent && !r.planned) this.learn(t);
      t.shown = !!r?.shown;
      t.restated = !!r?.restated;
      voiced(t);
      this.gap = '';
      this.prev = t;
      if (t.num && (!t.fuzzy || t.node)) this.lastNum = t.num;
      if (t.node?.san?.includes('x') && !t.shown) {
        this.takes.played++;
        if (/[x×:X]/.test(unit.text.slice(t.written?.at ?? t.start, t.end))) this.takes.written++;
      }
      prevEnd = t.end;
    }
    while (d < diagrams.length) diagram(diagrams[d++]);
    this.gap += `${unit.text.slice(prevEnd)}\n`;
    return [...this.changed];
  }
}

/** Follows every move of a book's units (see BookMoves); returns the games. */
export function trackMoves(units) {
  const book = new BookMoves();
  for (const unit of units) book.follow(unit);
  return book.trees;
}
