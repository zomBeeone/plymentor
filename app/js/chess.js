// Client-side chess helpers on top of chessops (vendored).
import {
  Chess,
  parseFen,
  makeFen,
  parseUci,
  makeSan,
  makeSquare,
  chessgroundDests,
  normalizeMove,
  castlingSide,
  kingCastlesTo,
  parseSan,
  INITIAL_FEN,
} from '../vendor/chessops.js';

export { INITIAL_FEN, makeSan, parseSan };

export function posFromFen(fen) {
  const setup = parseFen(String(fen || '').trim());
  if (setup.isErr) throw new Error(`Invalid FEN: ${setup.error.message}`);
  const pos = Chess.fromSetup(setup.value);
  if (pos.isErr) throw new Error(`Illegal position: ${pos.error.message}`);
  return pos.value;
}

export function tryPos(fen) {
  try {
    return posFromFen(fen);
  } catch {
    return null;
  }
}

export const fenOf = pos => makeFen(pos.toSetup());

export function uciOf(pos, move) {
  const side = castlingSide(pos, move);
  if (side) return makeSquare(move.from) + makeSquare(kingCastlesTo(pos.turn, side));
  return makeSquare(move.from) + makeSquare(move.to) + (move.promotion ? { queen: 'q', rook: 'r', bishop: 'b', knight: 'n' }[move.promotion] : '');
}

export function moveFromUci(pos, uci) {
  const raw = parseUci(String(uci || ''));
  if (!raw) return undefined;
  const move = normalizeMove(pos, raw);
  return pos.isLegal(move) ? move : undefined;
}

export function sanOf(fen, uci) {
  const pos = tryPos(fen);
  const m = pos && moveFromUci(pos, uci);
  return m ? makeSan(pos, m) : uci;
}

/** Plays a UCI move on a FEN; returns { fen, san, uci, capture, check } or null if illegal. */
export function playUci(fen, uci) {
  const pos = posFromFen(fen);
  const move = moveFromUci(pos, uci);
  if (!move) return null;
  const san = makeSan(pos, move);
  const capture = pos.board.has(move.to) && !castlingSide(pos, move) ? true : san.includes('x');
  const std = uciOf(pos, move);
  pos.play(move);
  return { fen: fenOf(pos), san, uci: std, capture, check: pos.isCheck(), mate: pos.isCheckmate() };
}

export function sanToUci(fen, san) {
  const pos = tryPos(fen);
  if (!pos) return null;
  const m = parseSan(pos, san);
  return m && pos.isLegal(m) ? uciOf(pos, m) : null;
}

export const dests = pos => chessgroundDests(pos);
export const turnOf = fen => (String(fen).split(' ')[1] === 'b' ? 'black' : 'white');

export function isPromotion(pos, orig, dest) {
  const from = squareIndex(orig);
  const to = squareIndex(dest);
  return pos.board.getRole(from) === 'pawn' && (to >> 3 === 7 || to >> 3 === 0);
}

export const squareIndex = name => 'abcdefgh'.indexOf(name[0]) + (Number(name[1]) - 1) * 8;

export function gameOver(pos) {
  if (pos.isCheckmate()) return { result: pos.turn === 'white' ? '0-1' : '1-0', reason: 'checkmate' };
  if (pos.isStalemate()) return { result: '1/2-1/2', reason: 'stalemate' };
  if (pos.isInsufficientMaterial()) return { result: '1/2-1/2', reason: 'insufficient material' };
  if (pos.halfmoves >= 100) return { result: '1/2-1/2', reason: 'fifty-move rule' };
  return null;
}

/** Repetition key (board + turn + castling + ep). */
export const repKey = fen => String(fen).split(' ').slice(0, 4).join(' ');

/** "12. Nf3" / "12... Nf6" for a node-like { ply, san } where ply is the number of half-moves after the move. */
export function moveLabel(ply, san, startPly = 0) {
  const p = ply + startPly;
  const n = Math.ceil(p / 2);
  return p % 2 === 1 ? `${n}. ${san}` : `${n}... ${san}`;
}

/** Formats a SAN list starting from a FEN: "14...Nf6 15. e5 Nd5". */
export function formatSanLine(fen, sans) {
  const parts = String(fen).split(' ');
  let n = Number(parts[5]) || 1;
  let white = parts[1] !== 'b';
  return sans
    .map((san, i) => {
      const s = white ? `${n}. ${san}` : i === 0 ? `${n}... ${san}` : san;
      if (!white) n++;
      white = !white;
      return s;
    })
    .join(' ');
}
