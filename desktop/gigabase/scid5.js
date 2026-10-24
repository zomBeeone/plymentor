// Reading Scid 5 databases: the .si5 index (56 bytes per game), the .sn5 names and the .sg5 games — the format of
// Scid 5 (scid.sourceforge.net; codec_scid5.h, bytebuf.h, game.cpp and position.cpp of its source), in which big
// game collections are published.
//
// A game's moves are one byte each (queen diagonals two): the high 4 bits are the index of the moving piece in the
// mover's piece list, the low 4 bits a code that depends on the piece type. The piece lists follow Scid exactly: the
// standard start is K R N B Q B N R and the pawns a–h; a captured piece's slot is taken by the side's last piece; a
// promoted pawn keeps its index; positions from a FEN get their pieces in FEN order with the king swapped to index 0.

export const ENTRY_SIZE = 56;
export const NAME_PLAYER = 0;
export const NAME_EVENT = 1;
export const NAME_SITE = 2;
export const NAME_ROUND = 3;
const NAME_TYPES = 5; // the four above and the database's own info

export const RESULT_NONE = 0;
export const RESULT_WHITE = 1;
export const RESULT_BLACK = 2;
export const RESULT_DRAW = 3;
export const RESULT_PGN = ['*', '1-0', '0-1', '1/2-1/2'];

export const FLAG_START = 1 << 0; // the game has its own start position (FEN)
export const FLAG_DELETE = 1 << 3; // marked for deletion

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;
const PIECE_CHARS = ' pnbrqk';

// Index entries --------------------------------------------------------------------------------------------------

/** Decodes the index entry at byte `o` of `u8` (a Uint8Array holding whole entries). */
export function decodeEntry(u8, o) {
  const u = i => (u8[o + i] | (u8[o + i + 1] << 8) | (u8[o + i + 2] << 16) | (u8[o + i + 3] << 24)) >>> 0;
  const w7 = u(28);
  const w8 = u(32);
  const w11 = u(44);
  return {
    white: u(0) & 0x0fffffff,
    black: u(4) & 0x0fffffff,
    event: u(8) & 0x0fffffff,
    site: u(12),
    chess960: u(16) >>> 31,
    round: u(16) & 0x7fffffff,
    whiteElo: u(20) >>> 20,
    date: u(20) & 0xfffff,
    blackElo: u(24) >>> 20,
    eventDate: u(24) & 0xfffff,
    plies: w7 >>> 22,
    flags: w7 & 0x3fffff,
    length: w8 >>> 15,
    offset: (w8 & 0x7fff) * 0x100000000 + u(36),
    result: (w11 >>> 16) & 3,
    eco: w11 & 0xffff,
  };
}

/** Scid dates: year << 9 | month << 5 | day; 0 means unknown. As PGN ("1999.01.??"). */
export function dateString(d) {
  const y = d >>> 9;
  const m = (d >>> 5) & 15;
  const day = d & 31;
  const two = n => (n ? String(n).padStart(2, '0') : '??');
  return `${y ? String(y).padStart(4, '0') : '????'}.${two(m)}.${two(day)}`;
}

/** Scid ECO codes: (letter * 100 + number) * 131 + 1 (+ extensions); 0 means none. "B90" or ''. */
export function ecoString(eco) {
  if (!eco) return '';
  const basic = Math.floor((eco - 1) / 131);
  if (basic >= 500) return '';
  return 'ABCDE'[Math.floor(basic / 100)] + String(basic % 100).padStart(2, '0');
}

// Names ------------------------------------------------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

/** The .sn5 file: each name is a varint (length * 8 + type) and its bytes; ids count up per type from 0. */
export class Names {
  constructor(buf) {
    this.buf = buf;
    const starts = Array.from({ length: NAME_TYPES }, () => []);
    let i = 0;
    while (i < buf.length) {
      let v = 0;
      let mul = 1;
      let b;
      do {
        if (i >= buf.length) throw new Error('The names file (.sn5) is cut short.');
        b = buf[i++];
        v += (b & 127) * mul;
        mul *= 128;
      } while (b >= 128);
      const type = v % 8;
      const len = Math.floor(v / 8);
      if (type >= NAME_TYPES || i + len > buf.length) throw new Error('The names file (.sn5) is damaged.');
      starts[type].push(i, len);
      i += len;
    }
    this.lists = starts.map(a => Uint32Array.from(a));
  }

  count(type) {
    return this.lists[type].length / 2;
  }

  get(type, id) {
    const l = this.lists[type];
    if (!(id >= 0 && id * 2 < l.length)) return '';
    const s = this.buf.subarray(l[id * 2], l[id * 2] + l[id * 2 + 1]);
    try {
      return utf8.decode(s);
    } catch {
      return latin1.decode(s);
    }
  }

  /** The database's own info ("type…", "description…"), as Scid writes it. */
  info() {
    const out = {};
    for (let id = 0; id < this.count(4); id++) {
      const s = this.get(4, id);
      const m = /^(type|description|autoload|flag\d)(.*)$/s.exec(s);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }
}

// Zobrist keys -----------------------------------------------------------------------------------------------------
// Positions are keyed by two 32-bit halves of a Zobrist hash (pieces, side to move, castling rights and an
// en-passant file when a pawn can take there). The same numbers are used for the index and for looking positions up.

const Z = (() => {
  let s = 0x9e3779b9;
  const next = () => {
    // splitmix32
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) | 0;
  };
  const n = 16 * 64 + 1 + 16 + 8;
  const hi = new Int32Array(n);
  const lo = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    hi[i] = next();
    lo[i] = next();
  }
  return { hi, lo };
})();
const Z_TURN = 16 * 64;
const Z_CASTLE = Z_TURN + 1;
const Z_EP = Z_CASTLE + 16;

// Castling rights: 1 white king side, 2 white queen side, 4 black king side, 8 black queen side.
const CASTLE_LOSS = new Uint8Array(64).fill(0);
CASTLE_LOSS[0] = 2;
CASTLE_LOSS[7] = 1;
CASTLE_LOSS[4] = 3;
CASTLE_LOSS[56] = 8;
CASTLE_LOSS[63] = 4;
CASTLE_LOSS[60] = 12;

const PAWN_DIFF = [7, 8, 9, 7, 8, 9, 7, 8, 9, 7, 8, 9, 7, 8, 9, 16];
const PAWN_PROMO = [0, 0, 0, QUEEN, QUEEN, QUEEN, ROOK, ROOK, ROOK, BISHOP, BISHOP, BISHOP, KNIGHT, KNIGHT, KNIGHT, 0];
const KNIGHT_DIFF = [0, -17, -15, -10, -6, 6, 10, 15, 17, 0, 0, 0, 0, 0, 0, 0];
const KING_DIFF = [0, -9, -8, -7, -1, 1, 7, 8, 9];

export const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * A position with Scid's piece lists, able to play the bytes of a Scid game. Pieces are type | color << 3
 * (white 0, black 1). After `play`, `from`, `to`, `promo` and `castle` describe the move.
 */
export class ScidPosition {
  board = new Uint8Array(64);
  list = new Uint8Array(32); // color * 16 + index → square
  listPos = new Uint8Array(64);
  count = new Uint8Array(2);
  turn = 0;
  castling = 0;
  ep = -1; // the square a pawn could take on en passant, or -1
  hi = 0;
  lo = 0;
  from = 0;
  to = 0;
  promo = 0;
  castle = 0; // 1 king side, 2 queen side
  nullMove = false;

  standard() {
    this.board.fill(0);
    this.count[0] = this.count[1] = 16;
    const back = [KING, ROOK, KNIGHT, BISHOP, QUEEN, BISHOP, KNIGHT, ROOK];
    const files = [4, 0, 1, 2, 3, 5, 6, 7];
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < 8; i++) {
        this.#put(c, i, back[i], c ? 56 + files[i] : files[i]);
        this.#put(c, 8 + i, PAWN, c ? 48 + i : 8 + i);
      }
    }
    this.turn = 0;
    this.castling = 15;
    this.ep = -1;
    this.#rehash();
    return this;
  }

  #put(c, idx, type, sq) {
    this.board[sq] = type | (c << 3);
    this.list[c * 16 + idx] = sq;
    this.listPos[sq] = idx;
  }

  /** Sets up a FEN the way Scid does (pieces in FEN order, the king swapped to index 0). Throws on bad input. */
  setFen(fen) {
    const [placement, turn = 'w', castling = '-', ep = '-'] = String(fen).trim().split(/\s+/);
    this.board.fill(0);
    this.count[0] = this.count[1] = 0;
    const ranks = placement.split('/');
    if (ranks.length !== 8) throw new Error('bad FEN');
    const kings = [0, 0];
    for (let r = 0; r < 8; r++) {
      let file = 0;
      for (const ch of ranks[r]) {
        if (ch >= '1' && ch <= '8') {
          file += Number(ch);
          continue;
        }
        const type = PIECE_CHARS.indexOf(ch.toLowerCase());
        if (type < 1 || file > 7) throw new Error('bad FEN');
        const c = ch === ch.toLowerCase() ? 1 : 0;
        const sq = (7 - r) * 8 + file++;
        if (this.count[c] >= 16) throw new Error('bad FEN');
        const n = this.count[c]++;
        if (type === KING) {
          if (kings[c]++) throw new Error('bad FEN');
          if (n > 0) {
            const old = this.list[c * 16];
            this.list[c * 16 + n] = old;
            this.listPos[old] = n;
          }
          this.#put(c, 0, KING, sq);
        } else this.#put(c, n, type, sq);
      }
      if (file !== 8) throw new Error('bad FEN');
    }
    if (kings[0] !== 1 || kings[1] !== 1) throw new Error('bad FEN');
    this.turn = turn === 'b' ? 1 : 0;
    this.castling = 0;
    if (castling.includes('K') && this.board[4] === KING && this.board[7] === ROOK) this.castling |= 1;
    if (castling.includes('Q') && this.board[4] === KING && this.board[0] === ROOK) this.castling |= 2;
    if (castling.includes('k') && this.board[60] === (KING | 8) && this.board[63] === (ROOK | 8)) this.castling |= 4;
    if (castling.includes('q') && this.board[60] === (KING | 8) && this.board[56] === (ROOK | 8)) this.castling |= 8;
    this.ep = -1;
    if (/^[a-h][36]$/.test(ep)) {
      const sq = (ep.charCodeAt(0) - 97) + (Number(ep[1]) - 1) * 8;
      if (this.#epCapturable(sq)) this.ep = sq;
    }
    this.#rehash();
    return this;
  }

  /** True when a pawn of the side to move stands next to the pawn that just passed `sq`. */
  #epCapturable(sq) {
    const pawnSq = this.turn ? sq + 8 : sq - 8; // the pawn that moved two squares
    const mine = PAWN | (this.turn << 3);
    const file = sq & 7;
    return (file > 0 && this.board[pawnSq - 1] === mine) || (file < 7 && this.board[pawnSq + 1] === mine);
  }

  #rehash() {
    let hi = 0;
    let lo = 0;
    for (let sq = 0; sq < 64; sq++) {
      const p = this.board[sq];
      if (p) {
        hi ^= Z.hi[p * 64 + sq];
        lo ^= Z.lo[p * 64 + sq];
      }
    }
    if (this.turn) {
      hi ^= Z.hi[Z_TURN];
      lo ^= Z.lo[Z_TURN];
    }
    hi ^= Z.hi[Z_CASTLE + this.castling];
    lo ^= Z.lo[Z_CASTLE + this.castling];
    if (this.ep >= 0) {
      hi ^= Z.hi[Z_EP + (this.ep & 7)];
      lo ^= Z.lo[Z_EP + (this.ep & 7)];
    }
    this.hi = hi;
    this.lo = lo;
  }

  #toggle(p, sq) {
    this.hi ^= Z.hi[p * 64 + sq];
    this.lo ^= Z.lo[p * 64 + sq];
  }

  /**
   * Plays the Scid move byte `val`; queen diagonals read their second byte at `data[at]`. Returns the number of
   * bytes used (1 or 2), or 0 when the byte is not a legal-looking move here (damaged data).
   */
  play(val, data, at) {
    const c = this.turn;
    const idx = val >> 4;
    const code = val & 15;
    if (idx >= this.count[c]) return 0;
    const from = this.list[c * 16 + idx];
    const piece = this.board[from];
    let to = -1;
    let promo = 0;
    let used = 1;
    this.castle = 0;
    this.nullMove = false;
    switch (piece & 7) {
      case PAWN:
        to = c ? from - PAWN_DIFF[code] : from + PAWN_DIFF[code];
        promo = PAWN_PROMO[code];
        if (to < 0 || to > 63 || Math.abs((to & 7) - (from & 7)) > 1) return 0;
        if (!promo && (to >> 3) === (c ? 0 : 7)) promo = QUEEN;
        if ((to & 7) === (from & 7)) {
          if (this.board[to] || (code === 15 && this.board[(from + to) >> 1])) return 0;
        } else if (!this.board[to] && this.board[c ? to + 8 : to - 8] !== (PAWN | ((c ^ 1) << 3))) return 0;
        break;
      case KNIGHT:
        to = from + KNIGHT_DIFF[code];
        if (to === from || to < 0 || to > 63 || Math.abs((to & 7) - (from & 7)) > 2) return 0;
        break;
      case BISHOP: {
        const fd = (code & 7) - (from & 7);
        to = code >= 8 ? from - 7 * fd : from + 9 * fd;
        if (to === from || to < 0 || to > 63) return 0;
        break;
      }
      case QUEEN:
        if (code === (from & 7)) {
          if (at >= data.length) return 0;
          to = data[at] - 64;
          used = 2;
          if (to < 0 || to > 63 || to === from) return 0;
          break;
        }
      // falls through: rook-like queen moves are encoded like rook moves
      case ROOK:
        to = code >= 8 ? ((code - 8) << 3) | (from & 7) : (from & 56) | code;
        if (to === from) return 0;
        break;
      case KING:
        if (code === 0) {
          this.nullMove = true;
          to = from;
        } else if (code <= 8) {
          to = from + KING_DIFF[code];
          if (to < 0 || to > 63 || Math.abs((to & 7) - (from & 7)) > 1) return 0;
        } else if (code === 9 || code === 10) {
          this.castle = code === 10 ? 1 : 2;
          if (!(this.castling & (this.castle << (2 * c)))) return 0;
        } else return 0;
        break;
      default:
        return 0;
    }
    const target = this.board[to];
    if (!this.castle && !this.nullMove && target && ((target >> 3) === c || (target & 7) === KING)) return 0;
    this.#apply(c, idx, from, to, promo);
    return used;
  }

  /**
   * Plays a move given in UCI (castling as the king's two-square move or as king takes rook). Only checks that the
   * side to move has a piece there and does not take its own; returns false otherwise.
   */
  playUci(uci) {
    const sq = s => (/^[a-h][1-8]$/.test(s) ? s.charCodeAt(0) - 97 + (Number(s[1]) - 1) * 8 : -1);
    const from = sq(String(uci).slice(0, 2));
    let to = sq(String(uci).slice(2, 4));
    if (from < 0 || to < 0 || from === to) return false;
    const c = this.turn;
    const piece = this.board[from];
    if (!piece || piece >> 3 !== c) return false;
    this.castle = 0;
    this.nullMove = false;
    const target = this.board[to];
    if ((piece & 7) === KING && (Math.abs(to - from) === 2 || target === (ROOK | (c << 3)))) {
      this.castle = to > from ? 1 : 2;
      if (!(this.castling & (this.castle << (2 * c)))) return false;
    } else if (target && (target >> 3 === c || (target & 7) === KING)) return false;
    const promo = uci.length > 4 ? PIECE_CHARS.indexOf(uci[4].toLowerCase()) : 0;
    if (promo && (promo < KNIGHT || promo > QUEEN || (piece & 7) !== PAWN)) return false;
    let p = promo;
    if (!p && (piece & 7) === PAWN && (to >> 3) === (c ? 0 : 7)) p = QUEEN;
    this.#apply(c, this.listPos[from], from, to, p);
    return true;
  }

  #apply(c, idx, from, to, promo) {
    const enemy = c ^ 1;
    const piece = this.board[from];
    // castling rights and en passant leave the hash first and come back below
    this.hi ^= Z.hi[Z_CASTLE + this.castling];
    this.lo ^= Z.lo[Z_CASTLE + this.castling];
    if (this.ep >= 0) {
      this.hi ^= Z.hi[Z_EP + (this.ep & 7)];
      this.lo ^= Z.lo[Z_EP + (this.ep & 7)];
    }
    this.ep = -1;
    this.from = from;
    this.promo = 0;
    if (this.nullMove) {
      this.to = from;
    } else if (this.castle) {
      const base = c ? 56 : 0;
      const kTo = base + (this.castle === 1 ? 6 : 2);
      const rFrom = base + (this.castle === 1 ? 7 : 0);
      const rTo = base + (this.castle === 1 ? 5 : 3);
      const rook = ROOK | (c << 3);
      const rIdx = this.listPos[rFrom];
      this.board[from] = 0;
      this.board[rFrom] = 0;
      this.#toggle(piece, from);
      this.#toggle(rook, rFrom);
      this.#put(c, 0, KING, kTo);
      this.#put(c, rIdx, ROOK, rTo);
      this.#toggle(piece, kTo);
      this.#toggle(rook, rTo);
      this.castling &= c ? 3 : 12;
      this.to = kTo;
    } else {
      let capSq = to;
      let captured = this.board[to];
      if ((piece & 7) === PAWN && !captured && (to & 7) !== (from & 7)) {
        // en passant (as in Scid: a pawn moving diagonally to an empty square takes the pawn behind it)
        capSq = c ? to + 8 : to - 8;
        captured = this.board[capSq];
      }
      if (captured) {
        const capIdx = this.listPos[capSq];
        const last = --this.count[enemy];
        const lastSq = this.list[enemy * 16 + last];
        this.list[enemy * 16 + capIdx] = lastSq;
        this.listPos[lastSq] = capIdx;
        this.board[capSq] = 0;
        this.#toggle(captured, capSq);
      }
      this.board[from] = 0;
      this.#toggle(piece, from);
      const placed = promo ? promo | (c << 3) : piece;
      this.board[to] = placed;
      this.list[c * 16 + idx] = to;
      this.listPos[to] = idx;
      this.#toggle(placed, to);
      this.promo = promo;
      this.castling &= ~(CASTLE_LOSS[from] | CASTLE_LOSS[to]);
      if ((piece & 7) === PAWN && Math.abs(to - from) === 16) {
        const passed = (from + to) >> 1;
        this.turn = enemy; // ep is seen from the side that may take
        if (this.#epCapturable(passed)) this.ep = passed;
        this.turn = c;
      }
      this.to = to;
    }
    this.turn = enemy;
    this.hi ^= Z.hi[Z_TURN];
    this.lo ^= Z.lo[Z_TURN];
    this.hi ^= Z.hi[Z_CASTLE + this.castling];
    this.lo ^= Z.lo[Z_CASTLE + this.castling];
    if (this.ep >= 0) {
      this.hi ^= Z.hi[Z_EP + (this.ep & 7)];
      this.lo ^= Z.lo[Z_EP + (this.ep & 7)];
    }
  }

  /** The last move in UCI (castling as the king's two-square move, a null move as "0000"). */
  uci() {
    if (this.nullMove) return '0000';
    const sq = s => String.fromCharCode(97 + (s & 7)) + ((s >> 3) + 1);
    return sq(this.from) + sq(this.to) + (this.promo ? PIECE_CHARS[this.promo] : '');
  }

  /** The last move as 16 bits: from | to << 6 | promotion type << 12 (castling: the king's two squares). */
  move16() {
    return this.from | (this.to << 6) | (this.promo << 12);
  }

  fen() {
    let s = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 8 + f];
        if (!p) {
          empty++;
          continue;
        }
        if (empty) s += empty;
        empty = 0;
        const ch = PIECE_CHARS[p & 7];
        s += p >> 3 ? ch : ch.toUpperCase();
      }
      if (empty) s += empty;
      if (r) s += '/';
    }
    const cs = (this.castling & 1 ? 'K' : '') + (this.castling & 2 ? 'Q' : '') + (this.castling & 4 ? 'k' : '') + (this.castling & 8 ? 'q' : '');
    const ep = this.ep >= 0 ? String.fromCharCode(97 + (this.ep & 7)) + ((this.ep >> 3) + 1) : '-';
    return `${s} ${this.turn ? 'b' : 'w'} ${cs || '-'} ${ep}`;
  }
}

export class ScidDataError extends Error {}

export function moveToUci(m) {
  const sq = s => String.fromCharCode(97 + (s & 7)) + ((s >> 3) + 1);
  return sq(m & 63) + sq((m >> 6) & 63) + ((m >> 12) & 7 ? PIECE_CHARS[(m >> 12) & 7] : '');
}

/** The key of a position given as FEN, as two 32-bit numbers. */
export function keyOfFen(fen) {
  const p = new ScidPosition().setFen(fen);
  return [p.hi, p.lo];
}

// Game data ----------------------------------------------------------------------------------------------------------

const COMMON_TAGS = ['WhiteCountry', 'BlackCountry', 'Annotator', 'PlyCount', 'EventDate', 'Opening', 'Variation', 'Setup', 'Source', 'SetUp'];
const ENCODE_NAG = 11;
const ENCODE_COMMENT = 12;
const ENCODE_START_MARKER = 13;
const ENCODE_END_MARKER = 14;
const ENCODE_END_GAME = 15;

/** Skips the extra tags; returns the offset of the start-board byte, or -1. */
export function skipTags(data, i = 0) {
  for (;;) {
    if (i >= data.length) return -1;
    const tagLen = data[i++];
    if (tagLen === 0) return i;
    if (tagLen <= 240) i += tagLen;
    i += tagLen !== 255 ? data[i] + 1 : 3;
  }
}

/** The extra tags (not in the index) as [name, value] pairs and the offset after them. */
export function readTags(data) {
  const tags = [];
  let i = 0;
  for (;;) {
    if (i >= data.length) throw new ScidDataError('tags cut short');
    const tagLen = data[i++];
    if (tagLen === 0) return { tags, at: i };
    let name = null;
    if (tagLen > 240) name = COMMON_TAGS[tagLen - 241] ?? null;
    else {
      name = latin1.decode(data.subarray(i, i + tagLen));
      i += tagLen;
    }
    const valueLen = tagLen !== 255 ? data[i++] : 3;
    const raw = data.subarray(i, i + valueLen);
    i += valueLen;
    if (name && tagLen !== 255) {
      let value;
      try {
        value = utf8.decode(raw);
      } catch {
        value = latin1.decode(raw);
      }
      tags.push([name, value]);
    }
  }
}

/**
 * Reads the start-board byte at `i`: { fen (null for the standard start), at } — `at` is where the moves begin.
 */
export function readStart(data, i) {
  if (i < 0 || i >= data.length) throw new ScidDataError('no start position');
  const flags = data[i++];
  if (!(flags & 1)) return { fen: null, at: i };
  const end = data.indexOf(0, i);
  if (end < 0) throw new ScidDataError('FEN cut short');
  return { fen: latin1.decode(data.subarray(i, end)), at: end + 1 };
}

/**
 * Plays the main line from `at` (variations, comments and NAGs skipped) for at most `maxPly` moves. After each move
 * `onMove(pos, ply)` is called with the new position (`pos.from`, `pos.to`, `pos.promo` describe the move); it may
 * return false to stop. Returns the number of moves played, or -1 when the data is damaged.
 */
export function playMainline(pos, data, at, maxPly, onMove) {
  let ply = 0;
  let depth = 0;
  let i = at;
  while (i < data.length && ply < maxPly) {
    const b = data[i];
    if (b === ENCODE_NAG) {
      i += 2;
      continue;
    }
    if (b === ENCODE_COMMENT) {
      i++;
      continue;
    }
    if (b === ENCODE_START_MARKER) {
      depth++;
      i++;
      continue;
    }
    if (b === ENCODE_END_MARKER) {
      if (!depth) return -1;
      depth--;
      i++;
      continue;
    }
    if (b === ENCODE_END_GAME) return depth ? -1 : ply;
    if (depth) {
      i++; // inside a variation: queen second bytes are >= 64, so they never look like markers
      continue;
    }
    const used = pos.play(b, data, i + 1);
    if (!used) return -1;
    i += used;
    ply++;
    if (onMove && onMove(pos, ply) === false) return ply;
  }
  return ply;
}

/**
 * Decodes a whole game: the move tree (main line with variations), NAGs and comments.
 * Returns { fen, root } where nodes are { uci, san?, nags: [], comment, children: [] } and root.children[0] is the
 * main line. The SAN is added by the caller (it needs a move generator).
 */
export function decodeGameTree(data) {
  const { tags, at: tagEnd } = readTags(data);
  const { fen, at } = readStart(data, tagEnd);
  const pos = new ScidPosition();
  if (fen) pos.setFen(fen);
  else pos.standard();
  const root = { children: [], nags: [], comment: '', fen: pos.fen() };
  const marks = []; // nodes waiting for a comment, in order
  // the stack holds, for each open variation, the node the variation hangs from and the position to restore
  const stack = [];
  let parent = root; // where the next move goes
  let last = root; // the last move played (for NAGs and comments)
  let cur = clonePos(pos);
  let i = at;
  let ended = false;
  if (data[i] === ENCODE_COMMENT) {
    marks.push(root);
    i++;
  }
  while (i < data.length) {
    const b = data[i];
    if (b === ENCODE_NAG) {
      if (i + 1 >= data.length) throw new ScidDataError('NAG cut short');
      last.nags.push(data[i + 1]);
      i += 2;
      continue;
    }
    if (b === ENCODE_COMMENT) {
      marks.push(last);
      i++;
      continue;
    }
    if (b === ENCODE_START_MARKER) {
      // a variation replaces the last move: it starts from the position before it
      if (last === root || !last.parent) throw new ScidDataError('variation without a move');
      stack.push({ parent, last, cur });
      parent = last.parent;
      cur = clonePos(last.before);
      last = { parent, before: null, nags: [], comment: '', children: [], variationStart: true };
      i++;
      if (data[i] === ENCODE_COMMENT) {
        marks.push(last); // a comment before the variation's first move
        i++;
      }
      continue;
    }
    if (b === ENCODE_END_MARKER) {
      const s = stack.pop();
      if (!s) throw new ScidDataError('end of a variation in the main line');
      ({ parent, last, cur } = s);
      i++;
      continue;
    }
    if (b === ENCODE_END_GAME) {
      if (stack.length) throw new ScidDataError('game ends inside a variation');
      ended = true;
      i++;
      break;
    }
    const before = clonePos(cur);
    const used = cur.play(b, data, i + 1);
    if (!used) throw new ScidDataError('impossible move');
    i += used;
    const pending = last.variationStart ? last : null;
    const node = { parent, before, uci: cur.uci(), fen: cur.fen(), nags: [], comment: '', children: [] };
    if (pending) {
      node.preComment = pending; // its comment, if any, goes before this move
    }
    parent.children.push(node);
    parent = node;
    last = node;
  }
  if (!ended) throw new ScidDataError('game cut short');
  // comments: one string per mark, then any further strings go to the following moves in PGN order
  const strings = [];
  while (i < data.length) {
    const end = data.indexOf(0, i);
    if (end < 0) break;
    const raw = data.subarray(i, end);
    let s;
    try {
      s = utf8.decode(raw);
    } catch {
      s = latin1.decode(raw);
    }
    strings.push(s);
    i = end + 1;
  }
  marks.forEach((m, k) => {
    if (k < strings.length) m.comment = strings[k];
  });
  if (strings.length > marks.length) {
    // "If the number of comments is greater than the number of marked moves, they are added sequentially after the
    // last move that has a comment."
    const order = pgnOrder(root);
    let k = marks.length ? order.indexOf(marks.at(-1)) + 1 : 0;
    for (let j = marks.length; j < strings.length && k < order.length; j++, k++) order[k].comment = strings[j];
  }
  // variation-start placeholders hold the comments written before a variation's first move
  const fix = n => {
    for (const ch of n.children) {
      if (ch.preComment) {
        ch.startComment = ch.preComment.comment || '';
        delete ch.preComment;
      }
      delete ch.before;
      fix(ch);
    }
  };
  fix(root);
  return { tags, fen, root };
}

function pgnOrder(root) {
  // the order in which Scid stores comments: the moves as they appear in the PGN text
  const out = [root];
  const walk = node => {
    // node's main continuation, then its alternatives (variations), as PGN prints them
    let n = node;
    while (n.children.length) {
      const [main, ...alts] = n.children;
      out.push(main);
      for (const a of alts) {
        out.push(a);
        walk(a);
      }
      n = main;
    }
  };
  walk(root);
  return out;
}

function clonePos(p) {
  const q = new ScidPosition();
  q.board.set(p.board);
  q.list.set(p.list);
  q.listPos.set(p.listPos);
  q.count.set(p.count);
  q.turn = p.turn;
  q.castling = p.castling;
  q.ep = p.ep;
  q.hi = p.hi;
  q.lo = p.lo;
  return q;
}
