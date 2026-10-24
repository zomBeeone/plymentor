// Chess helpers on top of chessops (lichess' chess library).
import { Chess, parseUci, makeSquare, parseSquare } from 'chessops';
import { parseFen, makeFen, INITIAL_FEN } from 'chessops/fen';
import { parseSan, makeSan } from 'chessops/san';
import { castlingSide, normalizeMove } from 'chessops/chess';
import { kingCastlesTo } from 'chessops/util';

export { INITIAL_FEN };

export const ROLE_LETTER = { pawn: '', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' };
export const ROLE_NAME = { pawn: 'pawn', knight: 'knight', bishop: 'bishop', rook: 'rook', queen: 'queen', king: 'king' };
export const PIECE_VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

export class ChessError extends Error {}

/** Parses a FEN into a legal standard-chess position, throwing ChessError with a readable reason. */
export function posFromFen(fen) {
  const setup = parseFen(String(fen || '').trim());
  if (setup.isErr) throw new ChessError(`Invalid FEN (${setup.error.message}): ${fen}`);
  const pos = Chess.fromSetup(setup.value);
  if (pos.isErr) throw new ChessError(`Illegal position (${pos.error.message}): ${fen}`);
  return pos.value;
}

export const initialPos = () => Chess.default();
export const fenOf = pos => makeFen(pos.toSetup());
/** Transposition key: board, turn, castling rights, and en passant square only when a capture is legal. */
export const keyOf = pos => makeFen(pos.toSetup(), { epd: true });
export const keyFromFen = fen => keyOf(posFromFen(fen));
export const turnOf = fen => (String(fen).split(' ')[1] === 'b' ? 'black' : 'white');

/** UCI in standard notation (castling as king two squares: e1g1), as engines expect. */
export function uciOf(pos, move) {
  const side = castlingSide(pos, move);
  if (side) return makeSquare(move.from) + makeSquare(kingCastlesTo(pos.turn, side));
  return makeSquare(move.from) + makeSquare(move.to) + (move.promotion ? ROLE_LETTER[move.promotion].toLowerCase() : '');
}

/** Legal move from UCI (accepts e1g1 or e1h1 castling); undefined if illegal or malformed. */
export function moveFromUci(pos, uci) {
  const raw = parseUci(String(uci || '').trim());
  if (!raw || raw.role) return undefined;
  const move = normalizeMove(pos, raw);
  return pos.isLegal(move) ? move : undefined;
}

/** Accepts SAN ("Nf3", "O-O", "exd8=Q+") or UCI ("g1f3"); returns { move, san, uci } or undefined. */
export function parseMove(pos, text) {
  const s = String(text || '').trim().replace(/[!?]+$/, '').replace(/^\d+\.(\.\.)?\s*/, '');
  if (!s) return undefined;
  let move = /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(s) ? moveFromUci(pos, s.toLowerCase()) : undefined;
  if (!move) {
    move = parseSan(pos, s.replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O'));
    if (move && !pos.isLegal(move)) move = undefined;
  }
  if (!move) return undefined;
  return { move, san: makeSan(pos, move), uci: uciOf(pos, move) };
}

/** All legal moves (castling is represented king-takes-rook, as chessops does). */
export function legalMoves(pos) {
  const out = [];
  for (const [from, dests] of pos.allDests()) {
    for (const to of dests) {
      const isPromo = pos.board.getRole(from) === 'pawn' && (to >> 3 === 7 || to >> 3 === 0);
      for (const promotion of isPromo ? ['queen', 'rook', 'bishop', 'knight'] : [undefined])
        out.push(promotion ? { from, to, promotion } : { from, to });
    }
  }
  return out;
}

export const legalSans = pos => legalMoves(pos).map(m => makeSan(pos, m));

/** Plays SAN/UCI moves from a FEN. Stops at the first illegal move and reports it. */
export function playLine(fen, moves) {
  const pos = fen ? posFromFen(fen) : initialPos();
  const steps = [];
  for (const text of moves) {
    const parsed = parseMove(pos, text);
    if (!parsed) {
      return {
        steps,
        fen: fenOf(pos),
        error: `Illegal or unreadable move "${text}" in position ${fenOf(pos)} (${pos.turn} to move). Legal moves: ${legalSans(pos).join(', ')}`,
      };
    }
    const moverNumber = pos.fullmoves;
    const mover = pos.turn;
    pos.play(parsed.move);
    steps.push({ ...parsed, moveNumber: moverNumber, color: mover, fen: fenOf(pos), check: pos.isCheck(), mate: pos.isCheckmate() });
  }
  return { steps, fen: fenOf(pos), pos };
}

/** Converts a UCI line into SAN from pos (does not mutate pos). Stops at the first illegal move. */
export function ucisToSans(pos, ucis) {
  const p = pos.clone();
  const out = [];
  for (const uci of ucis) {
    const move = moveFromUci(p, uci);
    if (!move) break;
    out.push(makeSan(p, move));
    p.play(move);
  }
  return out;
}

/** "14...Nf6 15. e5 Nd5" — SAN with move numbers, starting from pos. */
export function formatLine(pos, sans) {
  let n = pos.fullmoves;
  let white = pos.turn === 'white';
  const parts = [];
  sans.forEach((san, i) => {
    if (white) parts.push(`${n}. ${san}`);
    else parts.push(i === 0 ? `${n}... ${san}` : san);
    if (!white) n++;
    white = !white;
  });
  return parts.join(' ');
}

export const formatUciLine = (pos, ucis) => formatLine(pos, ucisToSans(pos, ucis));

export function moveLabel(moveNumber, color, san) {
  return color === 'white' ? `${moveNumber}. ${san}` : `${moveNumber}... ${san}`;
}

export function asciiBoard(pos) {
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = `${rank + 1} `;
    for (let file = 0; file < 8; file++) {
      const p = pos.board.get(rank * 8 + file);
      const ch = p ? (p.role === 'knight' ? 'n' : p.role[0]) : '.';
      row += ' ' + (p && p.color === 'white' ? ch.toUpperCase() : ch);
    }
    rows.push(row);
  }
  rows.push('   a b c d e f g h');
  return rows.join('\n');
}

export function pieceList(pos, color) {
  const order = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
  const parts = [];
  for (const role of order) {
    const sqs = [...pos.board.pieces(color, role)].sort((a, b) => (a & 7) - (b & 7) || a - b).map(makeSquare);
    if (!sqs.length) continue;
    parts.push(role === 'pawn' ? `pawns ${sqs.join(' ')}` : sqs.map(s => ROLE_LETTER[role] + s).join(' '));
  }
  return parts.join(', ');
}

export const square = name => parseSquare(name);
export const squareName = sq => makeSquare(sq);

export function outcomeText(pos) {
  if (pos.isCheckmate()) return `checkmate — ${pos.turn === 'white' ? 'Black' : 'White'} wins`;
  if (pos.isStalemate()) return 'stalemate — draw';
  if (pos.isInsufficientMaterial()) return 'insufficient material — draw';
  return null;
}
