// The moves the coach says, played on the student's board as its voice says them — as the Book reader's board plays a
// book's moves once they have been said (books/reader.js Reading). What the coach says with its speak tool is read like
// a book (coachReading.js); its moves are followed as the Book reader follows a book's (books/moves.js BookMoves), from
// the board the student had when the coach said it: the line to the position on the board, and the game's main line,
// are the line read. So a numbered move goes where its number is — "15. f4" on from the position on the board,
// "12...Ne8" back in the game, "12...Nd5" the other move there (a variation) —, the moves written after it without a
// number are its line, and White's "1." begins a game from the initial position. A coach writes otherwise than a book
// in places (CoachTracker, followMoves):
// - a move named on its own — "Nd5 is strong", "the plan with ...c5", "White threatens Nd5" — is shown only from the
//   position the line read is at, and not when its sentence names the other side last: a coach names plans and threats
//   so, where a book's "Nf3 was possible" is the other move of the move before (a coach numbers that one);
// - moves one after the other without numbers ("Nbd2 Bb7 Bc2") are a line from there;
// - a numbered move that does not go on from the line read goes first where the student's game made it — back in the
//   game after a line that left it: "9. d4 Bg4 is annoying. Then 9...Nb8 …";
// - a position the coach set up, nothing played from it yet, takes its move number from the first numbered move (a
//   coach's FEN says move 1 whatever the game's number was).
import { BookMoves, MoveTracker } from './books/moves.js';
import { Tree } from './tree.js';
import { repKey, sanToUci, playUci } from './chess.js';

// (nothing but signs between two moves: the second is the reply to the first — as books/moves.js has it)
const ADJOINS = /^[\s!?+#]*$/;
const SIDE_WORDS = /\b(white|black)\b/gi;

/** Whether the moves (text.js) can be played one after the other from `fen`. */
function playsOn(fen, moves) {
  let at = fen;
  for (const t of moves) {
    const uci = sanToUci(at, t.san);
    const r = uci && playUci(at, uci);
    if (!r) return false;
    at = r.fen;
  }
  return true;
}

/** The book's tracker, for what a coach writes (see the top of this file). */
class CoachTracker extends MoveTracker {
  play(t, o = {}) {
    // (moves without numbers one after the other: a line from where the line read is, when each can be played after the
    // one before — a book's are a move shown and replies to it)
    const next = o.ahead?.[0];
    if (!t.num && !o.seq && !this.opened && this.cur && next && !next.t.num && ADJOINS.test(next.between) && playsOn(this.cur.fen, [t, next.t])) {
      this.lastReal = true;
      o = { ...o, seq: true };
    }
    return super.play(t, o);
  }

  candidates(t, o) {
    const out = super.candidates(t, o);
    // (a move named on its own: from the position the line read is at, nowhere else)
    if (!t.num) return o.variation || o.sequence ? out : out.filter(n => n === this.cur);
    if (o.variation || out.includes(this.cur)) return out;
    // (where the student's game made it, first)
    const own = out.filter(n => {
      const uci = sanToUci(n.fen, t.san);
      return !!uci && n.children.some(c => c.game && c.uci === uci);
    });
    return own.length ? [...own, ...out.filter(n => !own.includes(n))] : out;
  }
}

/** The side the sentence of move `t` names last before it ("White wants Nd5": white), or null. */
function sideNamed(block, t) {
  const s = block.sentences.find(x => t.start >= x.start && t.start < x.end);
  const named = [...block.text.slice(s ? s.start : 0, t.start).matchAll(SIDE_WORDS)].at(-1);
  return named ? named[1].toLowerCase() : null;
}

/**
 * Follows the moves of what the coach said — its blocks, { text, moves (text.js findMoves), sentences }, in order — from
 * the board the student had then (`board`: { tree, node }). Each move the board plays gets `line`: { start (its game's
 * first position, a FEN), ucis (its moves from there) }; the others get none. The board's own tree stays as it is.
 */
export function followMoves(blocks, board) {
  for (const b of blocks) for (const t of b.moves) t.line = null;
  if (!board?.tree || !board.node) return;
  // (the board's game, as the line read: its main line and the line to the position on the board, marked as the game's)
  const copy = new Tree(board.tree.root.fen);
  const lineOf = ucis => {
    let n = copy.root;
    for (const uci of ucis) {
      const r = copy.addMove(n, uci);
      if (!r) break;
      n = r.node;
      n.game = true;
    }
    return n;
  };
  lineOf(board.tree.mainline().slice(1).map(n => n.uci));
  const cur = lineOf(board.tree.ucis(board.node));
  const moves = new BookMoves();
  const tracker = (moves.tracker = new CoachTracker());
  tracker.tree = copy;
  tracker.trees.push(copy);
  for (const n of [...copy.mainline(), ...copy.path(cur)]) tracker.see(n);
  tracker.cur = cur;
  tracker.grow(cur);
  tracker.lastReal = true;
  if (!copy.isStandardStart && cur === copy.root && !cur.children.length) copy.guess = { number: true, side: false };
  blocks.forEach((b, index) => moves.follow({ index, text: b.text, moves: b.moves, diagrams: [] }));
  for (const b of blocks)
    for (const t of b.moves) {
      if (!t.node || t.restated) continue;
      // (a move named on its own whose sentence names the other side: "White wants Nd5", Black to move)
      const named = t.shown && !t.side ? sideNamed(b, t) : null;
      if (named && named !== t.node.color) continue;
      t.line = { start: t.tree.root.fen, ucis: t.tree.ucis(t.node) };
    }
}

/**
 * The position of `line` (followMoves) on the board's tree — its moves added as a variation where the tree has not got
 * them —, or null when it is not a line of that tree's game.
 */
export function nodeOn(tree, line) {
  if (!tree || !line || repKey(tree.root.fen) !== repKey(line.start)) return null;
  // (every move first: none is added when one cannot be played)
  let fen = tree.root.fen;
  for (const uci of line.ucis) {
    const r = playUci(fen, uci);
    if (!r) return null;
    fen = r.fen;
  }
  let n = tree.root;
  for (const uci of line.ucis) n = tree.addMove(n, uci).node;
  return n;
}
