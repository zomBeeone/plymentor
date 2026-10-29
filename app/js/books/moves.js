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
// - after a puzzle's number ("5194 1.Bb1"): from the position of the diagram with that number;
// - a diagram: the position it shows — one of the game being read, when it is there, else a new game from it (after
//   the move its caption says led to it: "Position after: 31. Nf3").
import { Tree } from '../tree.js';
import { posFromFen, uciOf, moveFromUci, fenOf, parseSan, repKey, dests, isPromotion, INITIAL_FEN } from '../chess.js';
import { spokenMove } from './text.js';
import { descriptiveMoves, spokenDescriptive } from './descriptive.js';

const fullmove = node => Number(node.fen.split(' ')[5]) || 1;
const turn = node => (node.fen.split(' ')[1] === 'b' ? 'black' : 'white');

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

/** The move number and side to move `plies` half-moves after a position: { num, side }. */
const afterPlies = (pos, plies) => ({ num: pos.fullmoves + Math.floor((plies + (pos.turn === 'black' ? 1 : 0)) / 2), side: (plies % 2 === 0) === (pos.turn === 'white') ? 'white' : 'black' });

/** The 64 squares of a FEN's piece placement, from a8 to h1: a piece's letter or '.'. */
const squares = placement => placement.split('/').map(r => r.replace(/\d/g, d => '.'.repeat(Number(d)))).join('');
const placementOf = sq => [0, 1, 2, 3, 4, 5, 6, 7].map(r => sq.slice(r * 8, r * 8 + 8).replace(/\.+/g, m => String(m.length))).join('/');
const differ = (a, b) => {
  let n = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) n++;
  return n;
};

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
 * The label a puzzle's solution begins with, at the start of its line, before its first move (`between`: the text
 * before the move) — "5194 1.Bb1 …" (`direct`: the move right after it), "12. S. Loyd, 1869: 1.Rf1!" —, or null.
 */
function solutionOf(between) {
  const m = new RegExp(`(?:^|\\n)[ \\t]*(${LABEL})[.):]?[ \\t]([^\\n]{0,80}\\n?[^\\n]{0,40})$`).exec(between);
  return m ? { label: m[1], direct: !m[2].trim() } : null;
}

/** The game's main line: its first moves, leaving out the moves the book only named (shown, never the main line). */
function mainLine(tree) {
  const out = [tree.root];
  for (let n = tree.root.children.find(c => !c.bookShown); n; n = n.children.find(c => !c.bookShown)) out.push(n);
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

/** The move `san` in the position of `node`, as UCI (null when it is not a legal move there). */
function moveAt(node, san) {
  const pos = positionOf(node.fen);
  return pos ? moveIn(pos, san) : null;
}

/**
 * The move of the text `t` in the position `pos` (a move read by OCR: the first of its readings that is legal there;
 * one in descriptive notation: the likeliest of the moves it may be; a move whose piece the text lost — `glyph` —: the
 * one piece that can make it, or the piece the book's glyph has been learnt to be, `t.piece`), or null.
 */
function playableIn(pos, t) {
  if (!pos) return null;
  if (t.desc) return descriptiveMoves(fenOf(pos), t.desc)[0] || null;
  if (t.glyph) {
    const legal = t.sans.map(san => [san, moveIn(pos, san)]).filter(([, uci]) => uci);
    if (new Set(legal.map(([san]) => san[0])).size === 1) return legal[0][1];
    return legal.find(([san]) => san[0] === t.piece)?.[1] || null;
  }
  for (const san of t.sans || [t.san]) {
    const uci = moveIn(pos, san);
    if (uci) return uci;
  }
  return null;
}

/** The move of the text `t` at `node` (see playableIn), or null. */
const playable = (node, t) => (t.desc ? descriptiveMoves(node.fen, t.desc)[0] || null : playableIn(positionOf(node.fen), t));

/**
 * The moves the text's move `t` may be at `node` (UCI): the one playable gives — or, for a lost figurine more than one
 * piece can be (and not the one learnt for it), each of theirs: the moves written after it tell which (see pick).
 */
function readings(node, t) {
  const pos = !t.desc && t.glyph && positionOf(node.fen);
  if (!pos) {
    const uci = playable(node, t);
    return uci ? [uci] : [];
  }
  const legal = t.sans.map(san => [san, moveIn(pos, san)]).filter(([, uci]) => uci);
  const learnt = legal.find(([san]) => san[0] === t.piece);
  return learnt ? [learnt[1]] : [...new Set(legal.map(([, uci]) => uci))];
}

/** The legal moves of a position as UCI (a pawn reaching the last rank: a queen). */
function legalMoves(pos) {
  const out = [];
  for (const [from, tos] of dests(pos)) for (const to of tos) out.push(`${from}${to}${isPromotion(pos, from, to) ? 'q' : ''}`);
  return out;
}

/** Whether a move `t` with a number or a side to move (as written) may be played in the position `pos`. */
const fitsAt = (pos, t) => (!t.num || pos.fullmoves === t.num) && (!t.side || pos.turn === t.side);

/**
 * How many of the moves written after a move (`ahead`: [{ t, between: the text before it }]) can be played after it
 * (`uci` at `node`, or in the position `pos`), one after the other (`limit` at most): the replies right after each
 * move, the numbered ones with the next number — up to a bracket, or a move that is not the next one.
 */
function followOn(node, uci, ahead, limit = ahead.length, pos = positionOf(node.fen)) {
  let at = played(pos, uci);
  let n = 0;
  for (const { t, between } of ahead) {
    if (n >= limit || !at || /[()[\]]/.test(between)) break;
    if (t.num ? !fitsAt(at, t) : !/^\s*$/.test(between) && !(t.desc && /^\s*[.,]\s*$/.test(between))) break;
    const next = playableIn(at, t);
    if (!next) break;
    at = played(at, next);
    n++;
  }
  return n;
}

/** How many of the moves `next` (moves of the text) can be played one after the other from the position `pos`. */
function runFrom(pos, next) {
  let n = 0;
  for (const t of next) {
    if (!pos || !fitsAt(pos, t)) break;
    const uci = playableIn(pos, t);
    if (!uci) break;
    pos = played(pos, uci);
    n++;
  }
  return n;
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
    this.returns = []; // per open bracket: the position to go back to when it closes
    this.opened = false; // a bracket opened since the last move
    this.lastReal = false; // the last move continued the line being read (not one shown on its own)
    this.restated = null; // the move a spelled-out move in a bracket said again last (see play)
  }

  get cur() {
    return this._cur;
  }

  set cur(node) {
    this._cur = node;
    if (node) this.see(node);
  }

  /** A position the reading went through (the board showed it): a move may go back to it (see pick). */
  see(node) {
    this.seen.delete(node);
    this.seen.set(node, this.tree);
    if (this.seen.size > SEEN) this.seen.delete(this.seen.keys().next().value);
  }

  /** The text between two moves: brackets open and close variations ("a)" or "2)" starting a line is a list marker). */
  between(text) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '[') {
        this.returns.push(this.cur);
        this.opened = true;
      } else if ((c === ')' || c === ']') && this.returns.length && !/(?:^|\n|[.:;]\s)\s*[A-Za-z0-9]{1,2}$/.test(text.slice(0, i))) {
        const back = this.returns.pop();
        // (back to the game the bracket left, when a game began in it)
        if (back) (this.tree = this.seen.get(back) || this.tree), (this.cur = back);
        this.opened = false;
      }
    }
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
    this.tree = new Tree(fen);
    this.trees.push(this.tree);
    this.cur = this.tree.root;
    this.returns = [];
    this.lastReal = true;
    return { tree: this.tree, node: this.cur };
  }

  /**
   * A diagram: its piece placement, the side to move as the book marks it ('w' or 'b': only that side), or as the words
   * after it say it (said: that side rather than the other), the moves written after it (next), how many squares a
   * picture read may have wrong (near), and the other readings of its unsure squares (alts: [{ sq: 0 (a8) … 63 (h1),
   * options: ['B', 'P', '.'] }], the reading first). The line goes on from the position: one of the game being read
   * when it is there (the line read so far, the main line, a move on), else a new game from it — its side to move and
   * move number from the first move after it, a misread square put right by that move; or, when the first move after
   * it is the one that led to it (its caption: "Position after: 31. Nf3"), the other side to move. Returns { tree,
   * node }, or null when it shows no position.
   */
  diagram(placement, { side = null, said = null, next = [], near = 0, alts = [] } = {}) {
    const first = next[0];
    const want = squares(placement);
    this.caption = null;
    if (this.tree) {
      let best = null;
      const main = mainLine(this.tree);
      for (const n of [...this.cur.children, ...this.tree.path(this.cur).reverse(), ...main.reverse()]) {
        if (side && turn(n)[0] !== side) continue;
        const d = differ(want, squares(n.fen.split(' ')[0]));
        // (the words after a diagram may talk of the other side's moves — "Black to move loses" —: the position the
        // reading is at comes first, a square read wrong before the side the words say)
        const score = d + (said && turn(n)[0] !== said ? 0.5 : 0);
        if (d <= near && (!best || score < best.score)) best = { n, score };
      }
      if (best) {
        this.cur = best.n;
        this.returns = [];
        this.lastReal = true;
        return { tree: this.tree, node: best.n };
      }
    }
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
    const toMove = marked || (first?.side === 'white' ? 'w' : first?.side === 'black' ? 'b' : !first ? developmentSide(placement) : null);
    const numbered = next.find(t => t.num);
    const number = s => (!numbered ? 1 : s === 'b' && numbered.side === 'white' ? Math.max(1, numbered.num - 1) : numbered.num);
    // (no numbered move after it — a diagram at the end of a page, its moves on the next —: its move number, and its
    // side to move when nothing says it, are guesses that the first numbered move puts right: settle)
    const guess = { number: !numbered, side: !marked && !first?.side };
    const game = (fen, g = guess) => {
      const r = this.newGame(fen);
      if (g.number || g.side) this.tree.guess = g;
      return r;
    };
    let fallback = null;
    let before = null; // (the position before its first move)
    for (const p of tries) {
      for (const s of toMove ? [toMove] : ['w', 'b']) {
        const fen = `${p} ${s} ${castlingOf(p)} - 0 ${number(s)}`;
        const pos = positionOf(fen);
        if (!pos) continue;
        if (!first || playableIn(pos, first)) {
          before = { fen, run: runFrom(pos, next) };
          break;
        }
        if (p === placement) fallback ||= fen;
      }
      if (before) break;
    }
    // (its caption: the first move after it led to it — its piece stands where it went — and the moves after it are
    // played from it with the other side to move, more of them than from it as the position before that move)
    if (first?.num && first.side && (!side || side !== first.side[0]) && ledTo(placement, first)) {
      const s = first.side === 'white' ? 'b' : 'w';
      const fen = `${placement} ${s} ${castlingOf(placement)} - 0 ${first.num + (s === 'w' ? 1 : 0)}`;
      const pos = positionOf(fen);
      if (pos && 1 + runFrom(pos, next.slice(1)) > (before?.run || 0)) {
        const r = game(fen, {});
        this.caption = { moves: [first], node: r.node };
        return r;
      }
    }
    if (before) return game(before.fen);
    return fallback ? game(fallback) : null;
  }

  /**
   * The first move of a puzzle's solution, far after the puzzle ("5194 1.Bb1 …": the diagram the book numbered 5194,
   * `node` of `tree`): the line goes on from there when the move can be played there, and the reply right after it
   * too (a game the puzzle comes from, written from its first move, is no solution from the puzzle) — and, unless it
   * comes right after the number (`direct`), not where the reading is. Returns whether it does.
   */
  solve(tree, node, t, direct, ahead = []) {
    if (!direct && this.candidates(t, { variation: false, sequence: false }).some(n => playable(n, t))) return false;
    const back = { tree: this.tree, cur: this.cur, guess: tree.guess };
    this.tree = tree;
    this.cur = node;
    if (tree.guess) this.settle(t, true);
    const uci = fullmove(node) === t.num && turn(node) === t.side && playable(node, t);
    const reply = ahead[0] && !ahead[0].t.num && /^\s*$/.test(ahead[0].between);
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
   * The first numbered move after a diagram whose move number or side to move was a guess: the diagram takes them from
   * it — not from White's "1." (a game's start, most often), unless it is the diagram's own solution (`solution`).
   * When it is the move that led to the diagram (its piece where it went, the move after it played from the diagram
   * with the other side to move: "My last move was 1...Qc7. After 2.g3 …", the diagram at the end of the page before),
   * the diagram is the position after it: returns 'caption' (see diagram).
   */
  settle(t, solution = false, ahead = []) {
    const { root, guess } = this.tree;
    this.tree.guess = null;
    if (this.cur !== root || root.children.length || (!solution && t.num === 1 && t.side === 'white')) return null;
    const f = root.fen.split(' ');
    if (guess.side) f[1] = t.side === 'black' ? 'b' : 'w';
    if (guess.number) f[5] = String(t.num);
    const fen = f.join(' ');
    if (positionOf(fen) && playable({ fen }, t)) {
      root.fen = fen;
      return null;
    }
    const s = t.side === 'white' ? 'b' : 'w';
    if (!t.side || (!guess.side && root.fen.split(' ')[1] !== s) || !ledTo(f[0], t)) return null;
    f[1] = s;
    if (guess.number) f[5] = String(t.num + (s === 'w' ? 1 : 0));
    const after = f.join(' ');
    const pos = positionOf(after);
    if (!pos || (ahead.length && !runFrom(pos, [ahead[0].t]))) return null;
    root.fen = after;
    this.caption = { moves: [t], node: root };
    return 'caption';
  }

  /**
   * Plays the move `t` (from text.js); returns { tree, node, shown (only shown: the line is not followed), restated (a
   * move said again: nothing played) } or null. ahead: the moves written after it (see followOn), which tell where a
   * numbered move belongs when it may be played in more than one place; para: it begins a paragraph; between: the
   * text since the move before it.
   */
  play(t, { seq = false, ahead = [], para = false, between = '' } = {}) {
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
    const sequence = seq && this.lastReal && !variation;
    const alone = !t.num && !sequence && !variation;
    if (alone && t.pawn && !t.side) return null; // a square, most often
    if (alone && !this.tree) return t.pawn ? null : this.startGame(t);
    if (t.num && this.tree?.guess && this.settle(t, false, ahead) === 'caption') return { tree: this.tree, node: this.cur, shown: false, restated: true };
    const legal = [];
    for (const node of this.candidates(t, { variation, sequence })) {
      for (const uci of readings(node, t)) legal.push({ node, uci });
      if (legal.length && !t.num) break;
    }
    let chosen = (t.num || legal.length > 1) && ahead.length ? this.pick(t, legal, ahead, para) : legal[0];
    // (a lost figurine more than one piece can be, the moves after it no help to tell which: none)
    if (t.glyph && (chosen?.tied || legal.length) > 1) chosen = null;
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
      const { node: child, created } = this.tree.addMove(node, uci);
      if (alone) {
        if (created) child.bookShown = true;
        this.see(child);
        return { tree: this.tree, node: child, shown: true };
      }
      child.bookShown = false;
      // a move of the line being read comes before the ones only named (the move list shows it first)
      if (node.children[0] !== child && node.children[0].bookShown) this.tree.promote(child);
      this.cur = child;
      this.lastReal = true;
      return { tree: this.tree, node: child, shown: false };
    }
    if (t.num === 1 && t.side === 'white') {
      const started = this.startGame(t, ahead);
      if (started) return started;
    }
    const bridged = !alone && !variation ? this.bridge(t, ahead) : null;
    if (bridged) return bridged;
    const other = t.num ? this.otherSide(t, ahead) : null;
    if (other) return other;
    if (!alone) this.lastReal = false;
    return null;
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
    const uci = playableIn(pos, t);
    if (!uci || !followOn(null, uci, ahead, 1, pos)) return null;
    // (a game like a diagram's — but the brackets open stay open: their end goes back to the game it left)
    this.tree = new Tree(fen);
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
   * move number, the side, the replies) — at least the next one, and more than after any other. Returns what play
   * returns, or null.
   */
  bridge(t, ahead) {
    const cur = this.cur;
    const pos = cur && positionOf(cur.fen);
    if (!this.tree || !pos || t.desc) return null;
    const fits = plies => {
      const at = afterPlies(pos, plies);
      return (!t.num || at.num === t.num) && (!t.side || at.side === t.side);
    };
    const found = [];
    const try1 = (p, path) => {
      const uci = playableIn(p, t);
      if (uci) found.push({ path, uci, score: followOn(null, uci, ahead, ahead.length, p) });
    };
    if (fits(1)) for (const m of legalMoves(pos)) try1(played(pos, m), [m]);
    // (two missing: only when one cannot do, and the move's number says so)
    if (!found.length && t.num && fits(2))
      for (const m of legalMoves(pos)) {
        const mid = played(pos, m);
        if (mid) for (const n of legalMoves(mid)) try1(played(mid, n), [m, n]);
      }
    if (!found.length) return null;
    const best = Math.max(...found.map(f => f.score));
    const top = found.filter(f => f.score === best);
    if (best < 1 || top.length !== 1) return null;
    let node = cur;
    for (const m of top[0].path) {
      node = this.tree.addMove(node, m).node;
      node.bookInferred = true;
      node.bookShown = false;
    }
    const child = this.tree.addMove(node, top[0].uci).node;
    child.bookShown = false;
    this.cur = child;
    this.lastReal = true;
    return { tree: this.tree, node: child, shown: false };
  }

  /**
   * A move spelled out in a bracket right after the moves of a number (nothing else between them), saying one of them
   * again — "3 P to Q 4  3 P takes P (Pawn to Queen's fourth.) (Pawn takes Pawn.)", as Cook's primer writes each move
   * once more —: that move ({ tree, node, restated }), in their order; else null.
   */
  restate(t, between) {
    const cur = this.cur;
    if (!this.tree || !cur?.parent || !/^[\s()[\].,;:]*$/.test(between)) return null;
    const says = n => (t.desc ? descriptiveMoves(n.parent.fen, t.desc).includes(n.uci) : (t.sans || [t.san]).some(s => moveAt(n.parent, s) === n.uci));
    // (Black's move with White's of the same number before it: both may be said again, White's first)
    const pair = cur.color === 'black' && cur.parent.parent && cur.parent.moveNumber === cur.moveNumber ? [cur.parent, cur] : [cur];
    for (const n of pair.slice(pair.indexOf(this.restated) + 1))
      if (says(n)) {
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
      chosen = legal.find((c, i) => c.node === end && scores[i] === best) || chosen;
    }
    const tied = new Set(legal.filter((c, i) => scores[i] === best).map(c => c.uci.slice(0, 2))).size;
    if (best > 0 || !this.tree) return chosen && { ...chosen, score: best, tied };
    const known = new Set(legal.map(c => c.node));
    // (one of the game being read where the reply right after it can be played: when it can be played after none of
    // the places it may be — "6.Kf4 Kh6", back to the main line from a note)
    const need = tree => (tree === this.tree && (!legal.length || /^\s*$/.test(ahead[0].between)) ? 1 : 2);
    for (const [node, tree] of [...this.seen].reverse()) {
      if (known.has(node) || fullmove(node) !== t.num || turn(node) !== t.side || (node === tree.root && tree.isStandardStart)) continue;
      const uci = playable(node, t);
      const score = uci ? followOn(node, uci, ahead) : -1;
      if (score >= need(tree) && score > best) (best = score), (chosen = { node, uci, tree });
    }
    return chosen && { ...chosen, score: best, tied: chosen.tree ? 1 : tied };
  }

  /** How many of the moves written after `t` (White's "1.") can be played after it from the initial position (-1: not it). */
  fromStart(t, ahead) {
    const root = { fen: INITIAL_FEN };
    const uci = playable(root, t);
    return uci ? followOn(root, uci, ahead) : -1;
  }

  /**
   * A game from the initial position, with `t` ("1." of White's move) — unless the moves written after it say it is a
   * move named in a sentence ("the analysis of 1.h4 …"): the reply right after it cannot be played, or the next
   * numbered move is a later one than the game's second; `sure`: only when the move after it can be played.
   */
  startGame(t, ahead = [], sure = false) {
    const tree = new Tree(INITIAL_FEN);
    const uci = playable(tree.root, t);
    if (!uci) return null;
    const reply = ahead[0] && /^\s*$/.test(ahead[0].between) && !ahead[0].t.num ? ahead[0] : null;
    const numbered = ahead.find(a => a.t.num);
    if ((reply && !followOn(tree.root, uci, [reply])) || numbered?.t.num > 2 || (sure && !followOn(tree.root, uci, ahead, 1))) return null;
    this.trees.push(tree);
    this.tree = tree;
    this.returns = [];
    this.cur = tree.addMove(tree.root, uci).node;
    this.lastReal = true;
    return { tree, node: this.cur, shown: false };
  }

  /** Where `t` may be played, the likeliest first. */
  candidates(t, { variation, sequence }) {
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
      if (at(main.at(-1))) add(main.at(-1));
      // (a game from the initial position: "1." begins another game — a book's games, or an opening restated with
      // other moves after it —, unless the reading is at its start: a diagram of the initial position)
      const fresh = n => n === this.tree.root && this.tree.isStandardStart && n !== cur;
      for (const line of [this.tree.path(cur), main]) add(line.find(n => at(n) && !fresh(n)));
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

/**
 * Follows the moves of a book, unit by unit — its pages or chapters, in reading order, { text, moves, diagrams }
 * (text.js; diagrams: [{ at (its place in the text), placement (FEN, or null when it was not read), side, font (set in a
 * chess font: exact), alts }]): each move gets .tree, .node and .shown (null and false when no position was found),
 * each diagram .tree and .node.
 */
export class BookMoves {
  constructor() {
    this.tracker = new MoveTracker();
    this.gap = ''; // the text after the last move, up to the next unit
    this.prev = null; // the last move followed
    this.glyphs = new Map(); // a lost figurine's glyph → { piece letter: moves where only that piece could go }
    this.labels = new Map(); // a diagram's number (see labelsOf) → the diagram (null: more than one has it)
    this.lastNum = null; // the number of the last numbered move of the text
  }

  /**
   * The piece a lost figurine's glyph is, once the book's moves have shown it clearly (twice, and twice as often as
   * any other, and seven times in ten) — never "�", the character for any glyph a font or an OCR could not tell.
   */
  pieceOf(glyph) {
    const seen = [...(this.glyphs.get(glyph) || new Map())].sort((a, b) => b[1] - a[1]);
    const all = seen.reduce((n, [, k]) => n + k, 0);
    return glyph !== '\uFFFD' && seen[0] && seen[0][1] >= 2 && seen[0][1] >= 2 * (seen[1]?.[1] || 0) && seen[0][1] >= all * 0.7 ? seen[0][0] : null;
  }

  /** A lost figurine's move was played where only one piece could make it: that piece is what the glyph stands for. */
  learn(t) {
    const legal = new Set(t.sans.filter(san => moveAt(t.node.parent, san)).map(san => san[0]));
    if (legal.size !== 1) return;
    const seen = this.glyphs.get(t.glyph) || new Map();
    const [piece] = legal;
    seen.set(piece, (seen.get(piece) || 0) + 1);
    this.glyphs.set(t.glyph, seen);
  }

  get trees() {
    return this.tracker.trees;
  }

  follow(unit) {
    let prevEnd = 0;
    const diagrams = unit.diagrams || [];
    let d = 0;
    const diagram = dg => {
      const before = (this.gap + unit.text.slice(0, dg.at)).slice(-80);
      this.tracker.between(this.gap + unit.text.slice(prevEnd, Math.max(prevEnd, dg.at)));
      this.gap = '';
      prevEnd = Math.max(prevEnd, dg.at);
      // (the first moves after it — not squares named on their own, which may be pawn moves of either side)
      const next = unit.moves.filter(t => t.start >= dg.at && (t.num || t.side || !t.pawn)).slice(0, 3);
      // (its side to move: as the book marks it — under it, in its caption —, else as the words after it say)
      const side = dg.side || sideMarked(before, unit.text.slice(dg.at, dg.at + 120));
      const said = sideSaid(unit.text.slice(dg.at, dg.at + 200));
      const r = dg.placement ? this.tracker.diagram(dg.placement, { side, said, next, near: dg.font ? 0 : 1, alts: dg.alts || [] }) : null;
      dg.tree = r?.tree || null;
      dg.node = r?.node || null;
      if (dg.node) for (const label of labelsOf(before, unit.text.slice(dg.at, dg.at + 60))) this.labels.set(label, this.labels.has(label) ? null : dg);
    };
    for (const [i, t] of unit.moves.entries()) {
      while (d < diagrams.length && diagrams[d].at <= t.start) diagram(diagrams[d++]);
      const between = this.gap + unit.text.slice(prevEnd, t.start);
      this.tracker.between(between);
      // (the reply: right after a move — in descriptive notation also after a comma or a full stop: "5 R - B 4 ch,
      // K - Kt 6;", "1. P. to K. 4th. P. to K. 4th.")
      const prev = this.prev;
      const reply = /^\s*$/.test(between) || (t.desc && prev?.desc && prev.num && prev.side === 'white' && /^\s*[.,]\s*$/.test(between));
      const ahead = [];
      for (let j = i + 1, end = t.end; j < unit.moves.length && ahead.length < 8; end = unit.moves[j++].end) ahead.push({ t: unit.moves[j], between: unit.text.slice(end, unit.moves[j].start) });
      // (a paragraph begins: after a sentence's end and a line break, or a blank line)
      const para = /(?:[.!?…]["'”’)\]]*[ \t]*\n|\n[ \t]*\n)\s*$/.test(between);
      for (const a of [t, ...ahead.map(x => x.t)]) if (a.glyph) a.piece = this.pieceOf(a.glyph);
      // (a move number cut in two by a scan's OCR — "1 4.Nxe4" — is the one the line being read, or the moves written
      // before it, go on with; else the first part is a puzzle's number and the second the move's: "1 1.Qxg7#")
      if (t.cut) {
        const at = this.tracker.cur;
        const near = n => !!n && Math.abs(n - t.cut.whole) <= 1;
        t.num = near(at && fullmove(at)) || near(this.lastNum) ? t.cut.whole : t.cut.num;
        t.words = spokenMove(t);
      }
      // (a puzzle's solution, after the number of its diagram: from that diagram's position)
      const solution = t.cut?.num === t.num ? { label: t.cut.label, direct: true } : t.num ? solutionOf(between) : null;
      const puzzle = solution && this.labels.get(solution.label);
      const solved = !!puzzle && this.tracker.solve(puzzle.tree, puzzle.node, t, solution.direct, ahead);
      const r = this.tracker.play(t, { seq: reply && !solved, ahead, para, between });
      t.tree = r?.tree || null;
      t.node = r?.node || null;
      if (t.glyph && t.node?.parent) this.learn(t);
      t.shown = !!r?.shown;
      t.restated = !!r?.restated;
      // (a move read by OCR or written in descriptive notation: said as the move that was played — or, in descriptive
      // notation, as written when none was: followed again, a move may lose its position; a move spelled out is said
      // as it is written)
      if ((t.ocr || t.desc || t.spelled) && t.node?.san) {
        t.san = t.node.san.replace(/[+#]$/, '');
        t.check = /[+#]$/.exec(t.node.san)?.[0] || '';
        if (!t.spelled) t.words = spokenMove(t);
      } else if (t.desc && !t.spelled) t.words = spokenDescriptive(t);
      this.gap = '';
      this.prev = t;
      if (t.num) this.lastNum = t.num;
      prevEnd = t.end;
    }
    while (d < diagrams.length) diagram(diagrams[d++]);
    this.gap += `${unit.text.slice(prevEnd)}\n`;
  }
}

/** Follows every move of a book's units (see BookMoves); returns the games. */
export function trackMoves(units) {
  const book = new BookMoves();
  for (const unit of units) book.follow(unit);
  return book.trees;
}
