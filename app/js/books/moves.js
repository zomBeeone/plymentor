// Follows the moves of a chess book in reading order (Book reader): each move written in the text (text.js) is played
// in the position it belongs to and becomes a node of a game tree (tree.js), so the board can show it when the
// reading gets there. Books write a game's main line and its variations together, so the position of a move is found
// the way a reader finds it:
// - by its move number ("13...h6": Black's 13th move) — continuing the line just read, or the main line (back from a
//   variation), or else branching off where that move number is on the line being read or on the main line; when it
//   may be played in more than one of them (the text going back: "55.h7? The correct move is 55.Kg7. 55...Rg1+
//   56.Kh6"), in the one where the moves written after it can be played too;
// - without a number, right after a move ("13.Bg5 h6"): the reply to it;
// - after an opening bracket ("13.Bg5 (13.Nd5 …)" or "(Nd7 …)"): an alternative to the move before (numbered or not);
//   the closing bracket goes back to the line the variation left;
// - a move named on its own in a sentence ("Nf3 was possible", "...Nd7 is an idea"): shown from the position just
//   read, without changing the line being followed; a pawn "move" on its own is most often a square ("the d5
//   square"), so it is left alone (unless "...d5" says it is Black's move);
// - "1." of a move that does not start the game being read: a new game from the initial position;
// - a diagram: the position it shows — one of the game being read, when it is there, else a new game from it.
import { Tree } from '../tree.js';
import { posFromFen, uciOf, parseSan, playUci, repKey, INITIAL_FEN } from '../chess.js';
import { spokenMove } from './text.js';
import { descriptiveMoves, spokenDescriptive } from './descriptive.js';

const fullmove = node => Number(node.fen.split(' ')[5]) || 1;
const turn = node => (node.fen.split(' ')[1] === 'b' ? 'black' : 'white');

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

/** "White to move", "Black to play" in the words after a diagram: 'w' or 'b' (or null). */
export function sideSaid(text) {
  const m = /\b(white|black)\s+(?:to\s+(?:move|play)|moves|plays|is\s+to\s+(?:move|play))\b/i.exec(text);
  return m ? (m[1].toLowerCase() === 'white' ? 'w' : 'b') : null;
}

/** The game's main line: its first moves, leaving out the moves the book only named (shown, never the main line). */
function mainLine(tree) {
  const out = [tree.root];
  for (let n = tree.root.children.find(c => !c.bookShown); n; n = n.children.find(c => !c.bookShown)) out.push(n);
  return out;
}

/** The move `san` in the position of `node`, as UCI (null when it is not a legal move there). */
function moveAt(node, san) {
  try {
    const pos = posFromFen(node.fen);
    const m = parseSan(pos, san);
    if (!m || !pos.isLegal(m)) return null;
    // (chessops plays "Rxg2" to an empty square too: a move that says it takes must take there)
    if (san.includes('x') && !pos.board.has(m.to) && m.to !== pos.epSquare) return null;
    return uciOf(pos, m);
  } catch {
    return null;
  }
}

/**
 * The move of the text `t` at `node` (a move read by OCR: the first of its readings that is legal there; one in
 * descriptive notation: the likeliest of the moves it may be), or null.
 */
function playable(node, t) {
  if (t.desc) return descriptiveMoves(node.fen, t.desc)[0] || null;
  for (const san of t.sans || [t.san]) {
    const uci = moveAt(node, san);
    if (uci) return uci;
  }
  return null;
}

/**
 * How many of the moves written after a move (`ahead`: [{ t, between: the text before it }]) can be played after it
 * (`uci` at `node`), one after the other (`limit` at most): the replies right after each move, the numbered ones with
 * the next number — up to a bracket, or a move that is not the next one.
 */
function followOn(node, uci, ahead, limit = ahead.length) {
  let at = { fen: playUci(node.fen, uci)?.fen };
  let n = 0;
  for (const { t, between } of ahead) {
    if (n >= limit || !at.fen || /[()[\]]/.test(between)) break;
    if (t.num ? fullmove(at) !== t.num || (t.side && turn(at) !== t.side) : !/^\s*$/.test(between) && !(t.desc && /^\s*[.,]\s*$/.test(between))) break;
    const next = playable(at, t);
    if (!next) break;
    at = { fen: playUci(at.fen, next)?.fen };
    n++;
  }
  return n;
}

export class MoveTracker {
  constructor() {
    this.trees = [];
    this.tree = null;
    this.cur = null; // the position after the last move of the line being read
    this.returns = []; // per open bracket: the position to go back to when it closes
    this.opened = false; // a bracket opened since the last move
    this.lastReal = false; // the last move continued the line being read (not one shown on its own)
    this.restated = null; // the move a spelled-out move in a bracket said again last (see play)
  }

  /** The text between two moves: brackets open and close variations ("a)" or "2)" starting a line is a list marker). */
  between(text) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '[') {
        this.returns.push(this.cur);
        this.opened = true;
      } else if ((c === ')' || c === ']') && this.returns.length && !/(?:^|\n|[.:;]\s)\s*[A-Za-z0-9]{1,2}$/.test(text.slice(0, i))) {
        this.cur = this.returns.pop() || this.cur;
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
   * A diagram: its piece placement, the side to move when it shows it ('w' or 'b'), the moves written after it (next),
   * how many squares a picture read may have wrong (near), and the other readings of its unsure squares (alts:
   * [{ sq: 0 (a8) … 63 (h1), options: ['B', 'P', '.'] }], the reading first). The line goes on from the position: one of
   * the game being read when it is there (the line read so far, the main line, a move on), else a new game from it —
   * its side to move and move number from the first move after it, a misread square put right by that move. Returns
   * { tree, node }, or null when it shows no position.
   */
  diagram(placement, { side = null, next = [], near = 0, alts = [] } = {}) {
    const first = next[0];
    const want = squares(placement);
    if (this.tree) {
      let best = null;
      const main = mainLine(this.tree);
      for (const n of [...this.cur.children, ...this.tree.path(this.cur).reverse(), ...main.reverse()]) {
        if (side && turn(n)[0] !== side) continue;
        const d = differ(want, squares(n.fen.split(' ')[0]));
        if (d <= near && (!best || d < best.d)) best = { n, d };
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
    // its side to move: as the diagram says, else as its first move says (or, with no move after it, as an opening's
    // development says); its move number from its first numbered move
    const said = side || (first?.side === 'white' ? 'w' : first?.side === 'black' ? 'b' : !first ? developmentSide(placement) : null);
    const numbered = next.find(t => t.num);
    const number = s => (!numbered ? 1 : s === 'b' && numbered.side === 'white' ? Math.max(1, numbered.num - 1) : numbered.num);
    // (no numbered move after it — a diagram at the end of a page, its moves on the next —: its move number, and its
    // side to move when nothing says it, are guesses that the first numbered move puts right: settle)
    const guess = { number: !numbered, side: !side && !first?.side };
    const game = fen => {
      const r = this.newGame(fen);
      if (guess.number || guess.side) this.tree.guess = guess;
      return r;
    };
    let fallback = null;
    for (const p of tries)
      for (const s of said ? [said] : ['w', 'b']) {
        const fen = `${p} ${s} ${castlingOf(p)} - 0 ${number(s)}`;
        try {
          posFromFen(fen);
        } catch {
          continue;
        }
        if (!first || playable({ fen }, first)) return game(fen);
        if (p === placement) fallback ||= fen;
      }
    return fallback ? game(fallback) : null;
  }

  /** The first numbered move after a diagram whose move number or side to move was a guess: the diagram takes them from it. */
  settle(t) {
    const { root, guess } = this.tree;
    this.tree.guess = null;
    if (this.cur !== root || root.children.length || (t.num === 1 && t.side === 'white')) return;
    const f = root.fen.split(' ');
    if (guess.side) f[1] = t.side === 'black' ? 'b' : 'w';
    if (guess.number) f[5] = String(t.num);
    const fen = f.join(' ');
    try {
      posFromFen(fen);
    } catch {
      return;
    }
    if (playable({ fen }, t)) root.fen = fen;
  }

  /**
   * Plays the move `t` (from text.js); returns { tree, node, shown (only shown: the line is not followed), restated (a
   * move said again: nothing played) } or null. ahead: the moves written after it (see followOn), which tell where a
   * numbered move belongs when it may be played in more than one place; para: it begins a paragraph; between: the
   * text since the move before it.
   */
  play(t, { seq = false, ahead = [], para = false, between = '' } = {}) {
    const variation = this.opened;
    this.opened = false;
    const again = t.spelled && variation && this.restate(t, between);
    if (again) return again;
    this.restated = null;
    const sequence = seq && this.lastReal && !variation;
    const alone = !t.num && !sequence && !variation;
    if (alone && t.pawn && !t.side) return null; // a square, most often
    if (alone && !this.tree) return t.pawn ? null : this.startGame(t);
    if (t.num && this.tree?.guess) this.settle(t);
    const legal = [];
    for (const node of this.candidates(t, { variation, sequence })) {
      const uci = playable(node, t);
      if (uci) legal.push({ node, uci });
      if (legal.length && !t.num) break;
    }
    const chosen = t.num && ahead.length ? this.pick(t, legal, ahead, para) : legal[0];
    if (chosen) {
      const { node, uci } = chosen;
      const { node: child, created } = this.tree.addMove(node, uci);
      if (alone) {
        if (created) child.bookShown = true;
        return { tree: this.tree, node: child, shown: true };
      }
      child.bookShown = false;
      // a move of the line being read comes before the ones only named (the move list shows it first)
      if (node.children[0] !== child && node.children[0].bookShown) this.tree.promote(child);
      this.cur = child;
      this.lastReal = true;
      return { tree: this.tree, node: child, shown: false };
    }
    if (t.num === 1 && t.side === 'white') return this.startGame(t);
    if (!alone) this.lastReal = false;
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
   * position of another line of the game with its number where they can (a note going back to a line that is neither
   * the one being read nor the main line: two of them at least, or one when the move fits nowhere else).
   */
  pick(t, legal, ahead, para) {
    const scores = legal.length > 1 ? legal.map(c => followOn(c.node, c.uci, ahead)) : legal.map(c => followOn(c.node, c.uci, ahead, 1));
    let best = legal.length ? Math.max(...scores) : -1;
    let chosen = legal[scores.indexOf(best)];
    if (para && legal.length > 1) {
      const end = mainLine(this.tree).at(-1);
      chosen = legal.find((c, i) => c.node === end && scores[i] === best) || chosen;
    }
    // ("1." of a first move the game does not have: a new game)
    if (best > 0 || !this.tree || (t.num === 1 && t.side === 'white')) return chosen;
    const need = legal.length ? 2 : 1;
    const known = new Set(legal.map(c => c.node));
    const visit = node => {
      if (!known.has(node) && fullmove(node) === t.num && turn(node) === t.side) {
        const uci = playable(node, t);
        const score = uci ? followOn(node, uci, ahead) : -1;
        if (score >= need && score > best) (best = score), (chosen = { node, uci });
      }
      for (const c of node.children) visit(c);
    };
    visit(this.tree.root);
    return chosen;
  }

  startGame(t) {
    const tree = new Tree(INITIAL_FEN);
    const uci = playable(tree.root, t);
    if (!uci) return null;
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
      // (a game from the initial position: "1." is the same game only with a first move it has — an opening restated)
      const fresh = n => n === this.tree.root && this.tree.isStandardStart && !n.children.some(c => playable(n, t) === c.uci);
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
  }

  get trees() {
    return this.tracker.trees;
  }

  follow(unit) {
    let prevEnd = 0;
    const diagrams = unit.diagrams || [];
    let d = 0;
    const diagram = dg => {
      this.tracker.between(this.gap + unit.text.slice(prevEnd, Math.max(prevEnd, dg.at)));
      this.gap = '';
      prevEnd = Math.max(prevEnd, dg.at);
      // (the first moves after it — not squares named on their own, which may be pawn moves of either side)
      const next = unit.moves.filter(t => t.start >= dg.at && (t.num || t.side || !t.pawn)).slice(0, 3);
      const side = dg.side || sideSaid(unit.text.slice(dg.at, dg.at + 200));
      const r = dg.placement ? this.tracker.diagram(dg.placement, { side, next, near: dg.font ? 0 : 1, alts: dg.alts || [] }) : null;
      dg.tree = r?.tree || null;
      dg.node = r?.node || null;
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
      const r = this.tracker.play(t, { seq: reply, ahead, para, between });
      t.tree = r?.tree || null;
      t.node = r?.node || null;
      t.shown = !!r?.shown;
      t.restated = !!r?.restated;
      // (a move read by OCR or written in descriptive notation: said as the move that was played — or, in descriptive
      // notation, as written when none was: followed again, a move may lose its position; a move spelled out is said
      // as it is written)
      if ((t.ocr || t.desc || t.spelled) && t.node) {
        t.san = t.node.san.replace(/[+#]$/, '');
        t.check = /[+#]$/.exec(t.node.san)?.[0] || '';
        if (!t.spelled) t.words = spokenMove(t);
      } else if (t.desc && !t.spelled) t.words = spokenDescriptive(t);
      this.gap = '';
      this.prev = t;
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
