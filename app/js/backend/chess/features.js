// Static position features used to ground the coach's explanations: material, pawn structure, king safety,
// development, piece activity, hanging pieces (static exchange evaluation), pins, forks, checks and captures.
import {
  SquareSet,
  pawnAttacks,
  knightAttacks,
  kingAttacks,
  bishopAttacks,
  rookAttacks,
  attacks,
  between,
  opposite,
  makeSquare,
} from 'chessops';
import { makeSan } from 'chessops/san';
import { PIECE_VALUE, ROLE_LETTER, legalMoves, asciiBoard, pieceList, outcomeText } from './core.js';
import { phaseOf } from './divider.js';

const SEE_VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 };
const FILES = 'abcdefgh';
const cap = s => s[0].toUpperCase() + s.slice(1);
const pname = (role, sq) => `${ROLE_LETTER[role] || ''}${makeSquare(sq)}`;
const fileOf = sq => sq & 7;
const rankOf = sq => sq >> 3;

export function attackersOf(board, sq, color, occupied = board.occupied) {
  return board[color].intersect(occupied).intersect(
    rookAttacks(sq, occupied)
      .intersect(board.rook.union(board.queen))
      .union(bishopAttacks(sq, occupied).intersect(board.bishop.union(board.queen)))
      .union(knightAttacks(sq).intersect(board.knight))
      .union(kingAttacks(sq).intersect(board.king))
      .union(pawnAttacks(opposite(color), sq).intersect(board.pawn)),
  );
}

function leastValuable(board, set) {
  let best;
  let bestVal = Infinity;
  for (const sq of set) {
    const v = SEE_VALUE[board.getRole(sq)];
    if (v < bestVal) {
      bestVal = v;
      best = sq;
    }
  }
  return best;
}

/** Static exchange evaluation: material `side` expects to win by starting a capture sequence on `sq`. */
export function see(board, sq, side) {
  const target = board.get(sq);
  if (!target || target.color === side) return 0;
  let occupied = board.occupied;
  let color = side;
  let from = leastValuable(board, attackersOf(board, sq, color, occupied));
  if (from === undefined) return 0;
  const gain = [SEE_VALUE[target.role]];
  let d = 0;
  let onSquare = board.getRole(from);
  for (;;) {
    d++;
    gain[d] = SEE_VALUE[onSquare] - gain[d - 1];
    if (Math.max(-gain[d - 1], gain[d]) < 0) break;
    occupied = occupied.without(from);
    color = opposite(color);
    from = leastValuable(board, attackersOf(board, sq, color, occupied));
    if (from === undefined) break;
    onSquare = board.getRole(from);
  }
  while (--d) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
  return gain[0];
}

/** Pieces of `color` that the opponent can win material from (SEE > 0). */
export function hangingPieces(board, color) {
  const out = [];
  for (const sq of board[color].diff(board.king)) {
    const attackers = attackersOf(board, sq, opposite(color));
    if (attackers.isEmpty()) continue;
    const gain = see(board, sq, opposite(color));
    if (gain > 0) {
      const role = board.getRole(sq);
      out.push({
        square: makeSquare(sq),
        role,
        gain,
        defended: attackersOf(board, sq, color).nonEmpty(),
        attackers: [...attackers].map(a => pname(board.getRole(a), a)),
      });
    }
  }
  return out.sort((a, b) => b.gain - a.gain);
}

/** Absolute pins (to the king) and relative pins (to a more valuable queen/rook) against `color`. */
export function pins(board, color) {
  const out = [];
  const opp = opposite(color);
  const targets = [...board.pieces(color, 'king'), ...board.pieces(color, 'queen'), ...board.pieces(color, 'rook')];
  for (const t of targets) {
    const targetRole = board.getRole(t);
    const snipers = rookAttacks(t, SquareSet.empty())
      .intersect(board.rook.union(board.queen))
      .union(bishopAttacks(t, SquareSet.empty()).intersect(board.bishop.union(board.queen)))
      .intersect(board[opp]);
    for (const s of snipers) {
      const sniperRole = board.getRole(s);
      if (targetRole !== 'king' && SEE_VALUE[sniperRole] >= SEE_VALUE[targetRole]) continue;
      const blockers = between(t, s).intersect(board.occupied);
      if (blockers.size() !== 1) continue;
      const p = blockers.first();
      if (!board[color].has(p)) continue;
      const pinnedRole = board.getRole(p);
      if (targetRole !== 'king' && SEE_VALUE[pinnedRole] >= SEE_VALUE[targetRole]) continue;
      out.push({ pinned: pname(pinnedRole, p), to: pname(targetRole, t), by: pname(sniperRole, s), absolute: targetRole === 'king' });
    }
  }
  return out;
}

/** Pieces of `color` attacking two or more valuable targets (king, higher-value or undefended pieces). */
export function forks(board, color) {
  const out = [];
  const opp = opposite(color);
  for (const sq of board[color]) {
    const piece = board.get(sq);
    const targets = [];
    for (const t of attacks(piece, sq, board.occupied).intersect(board[opp])) {
      const role = board.getRole(t);
      if (role === 'king' || SEE_VALUE[role] > SEE_VALUE[piece.role] || (role !== 'pawn' && attackersOf(board, t, opp).isEmpty()))
        targets.push(pname(role, t));
    }
    if (targets.length >= 2) out.push({ piece: pname(piece.role, sq), targets });
  }
  return out;
}

function material(board, color) {
  const counts = {};
  let points = 0;
  for (const role of ['queen', 'rook', 'bishop', 'knight', 'pawn']) {
    counts[role] = board.pieces(color, role).size();
    points += counts[role] * PIECE_VALUE[role];
  }
  return { counts, points };
}

function materialText(m) {
  const c = m.counts;
  const parts = [];
  if (c.queen) parts.push(c.queen > 1 ? `${c.queen}Q` : 'Q');
  if (c.rook) parts.push(c.rook > 1 ? `${c.rook}R` : 'R');
  if (c.bishop) parts.push(c.bishop > 1 ? `${c.bishop}B` : 'B');
  if (c.knight) parts.push(c.knight > 1 ? `${c.knight}N` : 'N');
  parts.push(`${c.pawn}P`);
  return parts.join(' ');
}

function pawnStructure(board, color) {
  const own = board.pieces(color, 'pawn');
  const opp = board.pieces(opposite(color), 'pawn');
  const byFile = Array.from({ length: 8 }, () => []);
  for (const sq of own) byFile[fileOf(sq)].push(sq);
  const oppByFile = Array.from({ length: 8 }, () => []);
  for (const sq of opp) oppByFile[fileOf(sq)].push(sq);
  const ahead = (sq, other) => (color === 'white' ? rankOf(other) > rankOf(sq) : rankOf(other) < rankOf(sq));
  const isolated = [];
  const doubled = [];
  const passed = [];
  const backward = [];
  for (let f = 0; f < 8; f++) {
    if (byFile[f].length > 1) doubled.push(FILES[f]);
    for (const sq of byFile[f]) {
      const left = f > 0 ? byFile[f - 1] : [];
      const right = f < 7 ? byFile[f + 1] : [];
      if (!left.length && !right.length) isolated.push(makeSquare(sq));
      const blockers = [f - 1, f, f + 1].filter(x => x >= 0 && x < 8).flatMap(x => oppByFile[x]).filter(o => ahead(sq, o));
      if (!blockers.length) passed.push(makeSquare(sq));
      else if (left.length + right.length > 0) {
        // backward: all neighbours are further advanced and the stop square is controlled by an enemy pawn
        const neighbours = [...left, ...right];
        const allAhead = neighbours.every(n => ahead(sq, n));
        const stop = color === 'white' ? sq + 8 : sq - 8;
        if (allAhead && stop >= 0 && stop < 64 && pawnAttacks(color, stop).intersect(opp).nonEmpty()) backward.push(makeSquare(sq));
      }
    }
  }
  let islands = 0;
  for (let f = 0; f < 8; f++) if (byFile[f].length && (f === 0 || !byFile[f - 1].length)) islands++;
  return { isolated, doubled, passed, backward, islands, byFile };
}

function kingSafety(pos, color) {
  const board = pos.board;
  const k = board.kingOf(color);
  if (k === undefined) return null;
  const f = fileOf(k);
  const r = rankOf(k);
  const dir = color === 'white' ? 1 : -1;
  const ownPawns = board.pieces(color, 'pawn');
  const shield = [];
  for (let df = -1; df <= 1; df++) {
    const ff = f + df;
    if (ff < 0 || ff > 7) continue;
    for (const dr of [1, 2]) {
      const rr = r + dr * dir;
      if (rr < 0 || rr > 7) continue;
      const sq = rr * 8 + ff;
      if (ownPawns.has(sq)) shield.push(makeSquare(sq));
    }
  }
  const openFiles = [];
  for (let df = -1; df <= 1; df++) {
    const ff = f + df;
    if (ff < 0 || ff > 7) continue;
    const fileSet = SquareSet.fromFile(ff);
    if (fileSet.intersect(ownPawns).isEmpty())
      openFiles.push(FILES[ff] + (fileSet.intersect(board.pawn).isEmpty() ? ' (open)' : ' (half-open)'));
  }
  const zone = kingAttacks(k).with(k);
  const opp = opposite(color);
  const zoneAttackers = new Set();
  for (const z of zone) for (const a of attackersOf(board, z, opp)) if (board.getRole(a) !== 'king') zoneAttackers.add(pname(board.getRole(a), a));
  const home = color === 'white' ? 0 : 7;
  let status;
  if (r === home && f >= 6) status = 'castled short (kingside)';
  else if (r === home && f <= 2) status = 'castled long (queenside)';
  else if (r === home && f === 4) {
    const rights = pos.castles.castlingRights.intersect(SquareSet.fromRank(home));
    status = rights.isEmpty() ? 'uncastled, castling rights lost' : 'uncastled, can still castle';
  } else status = 'king has left its home squares';
  return { square: makeSquare(k), status, shield, openFiles, zoneAttackers: [...zoneAttackers], inCheck: pos.turn === color && pos.isCheck() };
}

function development(board, color) {
  const home = color === 'white' ? { knight: ['b1', 'g1'], bishop: ['c1', 'f1'], queen: 'd1' } : { knight: ['b8', 'g8'], bishop: ['c8', 'f8'], queen: 'd8' };
  const sqIdx = n => FILES.indexOf(n[0]) + (Number(n[1]) - 1) * 8;
  const undeveloped = [];
  for (const role of ['knight', 'bishop'])
    for (const n of home[role]) if (board.getRole(sqIdx(n)) === role && board.getColor(sqIdx(n)) === color) undeveloped.push(ROLE_LETTER[role] + n);
  return undeveloped;
}

function rookActivity(board, color) {
  const notes = [];
  const seventh = color === 'white' ? 6 : 1;
  for (const sq of board.pieces(color, 'rook')) {
    const fileSet = SquareSet.fromFile(fileOf(sq));
    const ownPawns = fileSet.intersect(board.pieces(color, 'pawn'));
    const anyPawns = fileSet.intersect(board.pawn);
    if (anyPawns.isEmpty()) notes.push(`R${makeSquare(sq)} on the open ${FILES[fileOf(sq)]}-file`);
    else if (ownPawns.isEmpty()) notes.push(`R${makeSquare(sq)} on the half-open ${FILES[fileOf(sq)]}-file`);
    if (rankOf(sq) === seventh) notes.push(`R${makeSquare(sq)} on the ${color === 'white' ? '7th' : '2nd'} rank`);
  }
  return notes;
}

function mobility(pos, color) {
  // squares attacked by pieces (not pawns/king) that are not occupied by own pieces
  const board = pos.board;
  let n = 0;
  for (const sq of board[color].diff(board.pawn).diff(board.king)) n += attacks(board.get(sq), sq, board.occupied).diff(board[color]).size();
  return n;
}

function bishopNotes(board, color) {
  const notes = [];
  const bishops = [...board.pieces(color, 'bishop')];
  const ownPawns = board.pieces(color, 'pawn');
  for (const b of bishops) {
    const light = SquareSet.lightSquares().has(b);
    const complex = light ? SquareSet.lightSquares() : SquareSet.darkSquares();
    const blocked = complex.intersect(ownPawns).size();
    if (ownPawns.size() >= 4 && blocked >= Math.ceil(ownPawns.size() * 0.6))
      notes.push(`B${makeSquare(b)} is hemmed in by own pawns on its colour (${blocked} of ${ownPawns.size()})`);
  }
  return notes;
}

function centreControl(board, color) {
  const centre = ['d4', 'e4', 'd5', 'e5'].map(n => FILES.indexOf(n[0]) + (Number(n[1]) - 1) * 8);
  const pawns = centre.filter(sq => board.getRole(sq) === 'pawn' && board.getColor(sq) === color).map(makeSquare);
  const control = centre.reduce((s, sq) => s + attackersOf(board, sq, color).size(), 0);
  return { pawns, control };
}

/** Structured features of a position. */
export function positionFeatures(pos) {
  const board = pos.board;
  const sides = {};
  for (const color of ['white', 'black']) {
    sides[color] = {
      material: material(board, color),
      pawns: pawnStructure(board, color),
      king: kingSafety(pos, color),
      undeveloped: development(board, color),
      rooks: rookActivity(board, color),
      mobility: mobility(pos, color),
      bishops: bishopNotes(board, color),
      bishopPair: board.pieces(color, 'bishop').size() >= 2,
      centre: centreControl(board, color),
      hanging: hangingPieces(board, color),
      pinned: pins(board, color),
      forks: forks(board, color),
    };
  }
  const moves = legalMoves(pos);
  const checks = [];
  const captures = [];
  for (const m of moves) {
    const san = makeSan(pos, m);
    if (san.includes('+') || san.includes('#')) checks.push(san);
    if (san.includes('x')) {
      const gain = board.has(m.to) ? see(applyMoveBoard(board, m), m.to, opposite(pos.turn)) : 0;
      const captured = board.getRole(m.to);
      const net = captured ? SEE_VALUE[captured] - gain : 0;
      captures.push({ san, net });
    }
  }
  const openFiles = [];
  for (let f = 0; f < 8; f++) if (SquareSet.fromFile(f).intersect(board.pawn).isEmpty()) openFiles.push(FILES[f]);
  return { turn: pos.turn, moveNumber: pos.fullmoves, phase: phaseOf(board), sides, checks, captures, openFiles, legalMoveCount: moves.length, outcome: outcomeText(pos) };
}

function applyMoveBoard(board, m) {
  const b = board.clone();
  const piece = b.take(m.from);
  b.set(m.to, m.promotion ? { role: m.promotion, color: piece.color } : piece);
  return b;
}

/** Compact text description for the coach. */
export function describePosition(pos, { board: includeBoard = true } = {}) {
  const f = positionFeatures(pos);
  const W = f.sides.white;
  const B = f.sides.black;
  const lines = [];
  if (includeBoard) lines.push('Board (uppercase = White):', asciiBoard(pos));
  lines.push(`White: ${pieceList(pos, 'white')}`);
  lines.push(`Black: ${pieceList(pos, 'black')}`);
  lines.push(`Side to move: ${cap(f.turn)} (move ${f.moveNumber}); phase: ${f.phase}; legal moves: ${f.legalMoveCount}`);
  if (f.outcome) lines.push(`Game over: ${f.outcome}`);
  const diff = W.material.points - B.material.points;
  lines.push(
    `Material: White ${W.material.points} (${materialText(W.material)}) vs Black ${B.material.points} (${materialText(B.material)})` +
      (diff === 0 ? ' — equal' : ` — ${diff > 0 ? 'White' : 'Black'} is up ${Math.abs(diff)} point${Math.abs(diff) > 1 ? 's' : ''}`) +
      (W.bishopPair && !B.bishopPair ? '; White has the bishop pair' : '') +
      (B.bishopPair && !W.bishopPair ? '; Black has the bishop pair' : ''),
  );
  for (const [name, s] of [['White', W], ['Black', B]]) {
    const p = s.pawns;
    const bits = [];
    if (p.isolated.length) bits.push(`isolated ${p.isolated.join(' ')}`);
    if (p.doubled.length) bits.push(`doubled on ${p.doubled.join(', ')}-file`);
    if (p.backward.length) bits.push(`backward ${p.backward.join(' ')}`);
    if (p.passed.length) bits.push(`passed ${p.passed.join(' ')}`);
    bits.push(`${p.islands} pawn island${p.islands === 1 ? '' : 's'}`);
    lines.push(`${name} pawns: ${bits.join('; ')}`);
  }
  if (f.openFiles.length) lines.push(`Open files: ${f.openFiles.join(', ')}`);
  for (const [name, s] of [['White', W], ['Black', B]]) {
    const k = s.king;
    if (!k) continue;
    lines.push(
      `${name} king ${k.square}: ${k.status}; pawn shield ${k.shield.length ? k.shield.join(' ') : 'none'}` +
        (k.openFiles.length ? `; files near king without own pawns: ${k.openFiles.join(', ')}` : '') +
        (k.zoneAttackers.length ? `; enemy pieces hitting the king zone: ${k.zoneAttackers.join(' ')}` : '') +
        (k.inCheck ? '; IN CHECK' : ''),
    );
  }
  if (f.phase === 'opening')
    for (const [name, s] of [['White', W], ['Black', B]]) if (s.undeveloped.length) lines.push(`${name} undeveloped minor pieces: ${s.undeveloped.join(' ')}`);
  for (const [name, s] of [['White', W], ['Black', B]]) {
    const notes = [...s.rooks, ...s.bishops];
    if (notes.length) lines.push(`${name} pieces: ${notes.join('; ')}`);
  }
  lines.push(`Piece mobility (squares attacked by pieces): White ${W.mobility}, Black ${B.mobility}`);
  lines.push(
    `Centre: White pawns ${W.centre.pawns.join(' ') || 'none'} (control ${W.centre.control}), Black pawns ${B.centre.pawns.join(' ') || 'none'} (control ${B.centre.control})`,
  );
  for (const [name, s] of [['White', W], ['Black', B]]) {
    if (s.hanging.length)
      lines.push(
        `${name} pieces en prise: ${s.hanging.map(h => `${ROLE_LETTER[h.role] || 'pawn '}${h.square} (attacked by ${h.attackers.join(', ')}${h.defended ? ', defended but loses material' : ', undefended'}; exchange wins ${h.gain} for the opponent)`).join('; ')}`,
      );
    if (s.pinned.length)
      lines.push(`${name} pinned pieces: ${s.pinned.map(p => `${p.pinned} pinned to ${p.to} by ${p.by}${p.absolute ? ' (absolute)' : ''}`).join('; ')}`);
    if (s.forks.length) lines.push(`${name} pieces attacking several targets: ${s.forks.map(x => `${x.piece} → ${x.targets.join(', ')}`).join('; ')}`);
  }
  if (f.checks.length) lines.push(`Checks available to ${f.turn}: ${f.checks.join(', ')}`);
  if (f.captures.length)
    lines.push(
      `Captures available to ${f.turn}: ${f.captures.map(c => `${c.san} (${c.net > 0 ? `wins ~${c.net}` : c.net < 0 ? `loses ~${-c.net}` : 'even'})`).join(', ')}`,
    );
  lines.push('(Static features only; tactics deeper than one exchange need the engine.)');
  return lines.join('\n');
}
