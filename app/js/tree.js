// Move tree with variations (like lichess' analysis tree).
import { parsePgn, parseComment, startingPosition } from '../vendor/chessops.js';
import { posFromFen, fenOf, moveFromUci, uciOf, makeSan, parseSan, INITIAL_FEN, repKey } from './chess.js';

let ids = 0;

export class TreeNode {
  constructor({ parent = null, uci = null, san = null, fen, ply = 0, color = null, moveNumber = 0 }) {
    this.id = ++ids;
    this.parent = parent;
    this.uci = uci;
    this.san = san;
    this.fen = fen;
    this.ply = ply;
    this.color = color; // colour of the player who made this move
    this.moveNumber = moveNumber;
    this.children = [];
    this.comments = [];
    this.nags = [];
    this.clock = null;
    this.judge = null; // live move judgement (from /api/engine/move) or game analysis
    this.score = null; // evaluation after this move (White's view) from game analysis
  }
  get label() {
    return this.color === 'white' ? `${this.moveNumber}. ${this.san}` : `${this.moveNumber}... ${this.san}`;
  }
}

export class Tree {
  constructor(startFen = INITIAL_FEN) {
    const pos = posFromFen(startFen);
    this.root = new TreeNode({ fen: fenOf(pos), ply: 0 });
    this.version = 0;
  }

  get startFen() {
    return this.root.fen;
  }

  get isStandardStart() {
    return repKey(this.root.fen) === repKey(INITIAL_FEN);
  }

  /** Adds (or finds) the child reached by `uci`. Returns { node, created } or null if illegal. */
  addMove(parent, uci) {
    const pos = posFromFen(parent.fen);
    const move = moveFromUci(pos, uci);
    if (!move) return null;
    const std = uciOf(pos, move);
    const existing = parent.children.find(c => c.uci === std);
    if (existing) return { node: existing, created: false };
    const san = makeSan(pos, move);
    const color = pos.turn;
    const moveNumber = pos.fullmoves;
    pos.play(move);
    const node = new TreeNode({ parent, uci: std, san, fen: fenOf(pos), ply: parent.ply + 1, color, moveNumber });
    node.check = pos.isCheck();
    node.capture = san.includes('x');
    node.mate = pos.isCheckmate();
    parent.children.push(node);
    this.version++;
    return { node, created: true };
  }

  addLine(parent, ucis) {
    let node = parent;
    for (const u of ucis) {
      const r = this.addMove(node, u);
      if (!r) break;
      node = r.node;
    }
    return node;
  }

  path(node) {
    const p = [];
    for (let n = node; n; n = n.parent) p.unshift(n);
    return p;
  }

  ucis(node) {
    return this.path(node)
      .slice(1)
      .map(n => n.uci);
  }

  mainline() {
    const out = [this.root];
    let n = this.root;
    while (n.children.length) {
      n = n.children[0];
      out.push(n);
    }
    return out;
  }

  isMainline(node) {
    for (let n = node; n.parent; n = n.parent) if (n.parent.children[0] !== n) return false;
    return true;
  }

  find(pred, from = this.root) {
    if (pred(from)) return from;
    for (const c of from.children) {
      const r = this.find(pred, c);
      if (r) return r;
    }
    return null;
  }

  findByFen(fen) {
    const k = repKey(fen);
    return this.find(n => repKey(n.fen) === k);
  }

  promote(node) {
    const p = node.parent;
    if (!p) return;
    p.children = [node, ...p.children.filter(c => c !== node)];
    this.version++;
  }

  remove(node) {
    const p = node.parent;
    if (!p) return;
    p.children = p.children.filter(c => c !== node);
    this.version++;
  }

  static fromMoves(startFen, ucis) {
    const t = new Tree(startFen || INITIAL_FEN);
    t.addLine(t.root, ucis);
    return t;
  }

  /** First game of a PGN text (variations, comments, clocks, NAGs). Returns { tree, headers }. */
  static fromPgn(text) {
    const games = parsePgn(text);
    if (!games.length) throw new Error('No game found in the PGN');
    const game = games[0];
    const start = startingPosition(game.headers);
    if (start.isErr) throw new Error('Invalid starting position in the PGN');
    const tree = new Tree(fenOf(start.value));
    const walk = (pgnNode, treeNode) => {
      for (const child of pgnNode.children) {
        const pos = posFromFen(treeNode.fen);
        const move = parseSan(pos, child.data.san);
        if (!move || !pos.isLegal(move)) continue;
        const r = tree.addMove(treeNode, uciOf(pos, move));
        if (!r) continue;
        const n = r.node;
        for (const c of child.data.comments || []) {
          const pc = parseComment(c);
          if (pc.text?.trim()) n.comments.push(pc.text.trim());
          if (pc.clock !== undefined) n.clock = pc.clock;
        }
        if (child.data.nags?.length) n.nags = child.data.nags;
        walk(child, n);
      }
    };
    walk(game.moves, tree.root);
    return { tree, headers: Object.fromEntries(game.headers) };
  }

  /** PGN export with variations and comments. */
  toPgn(headers = {}) {
    const h = { Event: '?', Site: '?', Date: '????.??.??', White: '?', Black: '?', Result: '*', ...headers };
    if (!this.isStandardStart) {
      h.FEN = this.root.fen;
      h.SetUp = '1';
    }
    const head = Object.entries(h)
      .map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`)
      .join('\n');
    const moveText = (node, forceNumber) => {
      let s = '';
      if (node.color === 'white') s += `${node.moveNumber}. `;
      else if (forceNumber) s += `${node.moveNumber}... `;
      s += node.san;
      for (const nag of node.nags) s += ` $${nag}`;
      for (const c of node.comments) s += ` {${c.replace(/[{}]/g, '')}}`;
      return s;
    };
    const line = (node, forceNumber) => {
      const parts = [];
      let n = node;
      let force = forceNumber;
      for (;;) {
        parts.push(moveText(n, force));
        force = n.comments.length > 0;
        const p = n.parent;
        if (p && p.children[0] === n && p.children.length > 1) {
          for (const v of p.children.slice(1)) parts.push(`(${line(v, true)})`);
          force = true;
        }
        if (!n.children.length) break;
        n = n.children[0];
      }
      return parts.join(' ');
    };
    const body = this.root.children.length ? line(this.root.children[0], true) : '';
    return `${head}\n\n${body} ${h.Result}\n`;
  }
}

/**
 * Where a position the coach shows (set_board) goes: { tree, node }, `tree` being the given one when the position fits
 * in it. ev.path: the moves from the initial position that lead to it, when known (ev.pathFrom: 'moves' — the coach's
 * own, 'board' — after the line on the student's board, 'book' — from the opening book). merge: the coach's lines join
 * a tree that starts from the initial position (the Openings board); otherwise only a position a move or two after the
 * student's line does, and the others get a tree of their own — with the moves that lead to them, when known.
 */
export function placeCoachPosition(tree, ev, { merge = false } = {}) {
  const path = Array.isArray(ev.path) ? ev.path.map(m => m.uci) : null;
  const known = tree.findByFen(ev.fen);
  if (known && !(merge && path && ev.pathFrom === 'moves')) return { tree, node: known };
  if (path && tree.isStandardStart && (merge || ev.pathFrom === 'board')) {
    const node = tree.addLine(tree.root, path);
    if (repKey(node.fen) === repKey(ev.fen)) return { tree, node };
  }
  if (path) {
    const t = Tree.fromMoves(INITIAL_FEN, path);
    const node = t.mainline().at(-1);
    if (repKey(node.fen) === repKey(ev.fen)) return { tree: t, node };
  }
  const t = new Tree(ev.fen);
  return { tree: t, node: t.root };
}
