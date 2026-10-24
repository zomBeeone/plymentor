// The opening index ("book") of a Scid database, built once when the database is added and read by the explorer.
//
// For every position that at least MIN_GAMES games reached within their first MAX_PLY half-moves it keeps: the
// results of those games, the moves played from it (results, average rating, last year played), its best games by
// rating, and — for moves into rarer positions — the games themselves (at most EDGE_GAMES), so the explorer can follow
// a line beyond the index by reading those games.
//
// Building it reads the games twice:
//  A. Every position's 32-bit fingerprint (the high half of its key) goes to one of 64 temporary files; sorting each
//     file finds the fingerprints seen at least MIN_GAMES times. (The first plies are counted in memory.)
//  B. With those fingerprints known, each game is played again and its moves are counted under the exact 64-bit keys.
//     Moves into positions outside the index are written to a temporary file and grouped at the end.
// For 12 million games it needs about 700 MB of memory and 1.6 GB of temporary files (removed at the end).

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import * as S from './scid5.js';

export const BOOK_VERSION = 1;
export const MAX_PLY = 40;
export const MIN_GAMES = 10;
export const TOP_GAMES = 5;
export const EDGE_GAMES = 32;
const MAGIC = 'PLYBOOK1';
const HEADER_SIZE = 64;
const EARLY_PLIES = 8; // counted in memory in pass A
const PARTS = 64;

// Game info: result (2 bits) | average rating (12) << 2 | both ratings known (1) << 14 | year (11) << 15 | skip << 26.
// Top games are ranked by the lower of the two ratings (both must be known), then by year; games of chess engines
// (names like "Gull x64 4CPU") and against unrated players do not count as top games.
const SKIP = 1 << 26;
const infoResult = x => x & 3;
const infoElo = x => (x >>> 2) & 0xfff;
const infoBoth = x => (x >>> 14) & 1;
const infoYear = x => (x >>> 15) & 0x7ff;
const ENGINE_NAME = /\bx(?:64|86)\b|\b\d+\s?cpus?\b/i;
const UNKNOWN_NAME = /^\s*(?:n\.?\s?n\.?|\?+|-|unknown|anonymous|unbekannt|player|white|black)?\s*$/i;

class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.cancelled = true;
  }
}

/** The database files: index entries are read in chunks, game data in large blocks. */
export class ScidFiles {
  constructor(base) {
    this.base = base;
    this.fi = openSync(base + '.si5', 'r');
    this.fg = openSync(base + '.sg5', 'r');
    const size = fstatSync(this.fi).size;
    if (size % S.ENTRY_SIZE) throw new Error('The index file (.si5) is damaged.');
    this.count = size / S.ENTRY_SIZE;
    this.gameFileSize = fstatSync(this.fg).size;
  }
  close() {
    closeSync(this.fi);
    closeSync(this.fg);
  }
  entry(g) {
    const b = Buffer.alloc(S.ENTRY_SIZE);
    readSync(this.fi, b, 0, S.ENTRY_SIZE, g * S.ENTRY_SIZE);
    return S.decodeEntry(b, 0);
  }
  gameData(e) {
    const b = Buffer.alloc(e.length);
    if (readSync(this.fg, b, 0, e.length, e.offset) !== e.length) throw new Error('The games file (.sg5) is cut short.');
    return b;
  }
  /**
   * Calls onGame(g, entryBytes, entryOffset, data) for games [from, to) in order; data is valid during the call only.
   * onChunk(g) runs every 64k games (progress, cancelling).
   */
  scan(onGame, { from = 0, to = this.count, onChunk = () => {}, withData = true } = {}) {
    const CH = 65536;
    const ib = Buffer.alloc(S.ENTRY_SIZE * CH);
    const BLOCK = 16 << 20;
    let gbuf = Buffer.alloc(BLOCK);
    let gstart = -1;
    let gend = -1;
    for (let b0 = from; b0 < to; b0 += CH) {
      onChunk(b0);
      const n = Math.min(CH, to - b0);
      readSync(this.fi, ib, 0, n * S.ENTRY_SIZE, b0 * S.ENTRY_SIZE);
      for (let k = 0; k < n; k++) {
        const o = k * S.ENTRY_SIZE;
        if (!withData) {
          onGame(b0 + k, ib, o, null);
          continue;
        }
        const w8 = ib.readUInt32LE(o + 32);
        const len = w8 >>> 15;
        const off = (w8 & 0x7fff) * 0x100000000 + ib.readUInt32LE(o + 36);
        if (len === 0 || off + len > this.gameFileSize) {
          onGame(b0 + k, ib, o, null);
          continue;
        }
        if (off < gstart || off + len > gend) {
          if (len > gbuf.length) gbuf = Buffer.alloc(len);
          gstart = off;
          gend = off + readSync(this.fg, gbuf, 0, gbuf.length, off);
        }
        onGame(b0 + k, ib, o, gbuf.subarray(off - gstart, off - gstart + len));
      }
    }
  }
}

/** Open-addressing table of 32-bit keys with counts (fingerprint → count). */
class CountTable {
  constructor(bits = 16) {
    this.alloc(bits);
  }
  alloc(bits) {
    this.bits = bits;
    this.mask = (1 << bits) - 1;
    this.keys = new Uint32Array(1 << bits);
    this.counts = new Uint32Array(1 << bits); // 0 = empty slot
    this.size = 0;
  }
  add(key, n = 1) {
    let i = Math.imul(key, 0x9e3779b1) >>> (32 - this.bits);
    for (;;) {
      if (this.counts[i] === 0) {
        this.keys[i] = key;
        this.counts[i] = n;
        if (++this.size * 4 > this.mask * 3) this.grow();
        return;
      }
      if (this.keys[i] === key) {
        this.counts[i] += n;
        return;
      }
      i = (i + 1) & this.mask;
    }
  }
  get(key) {
    let i = Math.imul(key, 0x9e3779b1) >>> (32 - this.bits);
    for (;;) {
      if (this.counts[i] === 0) return 0;
      if (this.keys[i] === key) return this.counts[i];
      i = (i + 1) & this.mask;
    }
  }
  grow() {
    const { keys, counts } = this;
    this.alloc(this.bits + 1);
    for (let i = 0; i < keys.length; i++) if (counts[i]) this.add(keys[i], counts[i]);
  }
  *entries() {
    for (let i = 0; i < this.keys.length; i++) if (this.counts[i]) yield [this.keys[i], this.counts[i]];
  }
}

/** A set of 32-bit fingerprints (fixed size). */
class FpSet {
  constructor(list) {
    let bits = 10;
    while (1 << bits < list.length * 2) bits++;
    this.bits = bits;
    this.mask = (1 << bits) - 1;
    this.keys = new Uint32Array(1 << bits);
    this.used = new Uint8Array(1 << bits);
    for (const k of list) this.add(k);
  }
  add(key) {
    let i = Math.imul(key, 0x9e3779b1) >>> (32 - this.bits);
    while (this.used[i]) {
      if (this.keys[i] === key) return;
      i = (i + 1) & this.mask;
    }
    this.used[i] = 1;
    this.keys[i] = key;
  }
  has(key) {
    let i = Math.imul(key, 0x9e3779b1) >>> (32 - this.bits);
    while (this.used[i]) {
      if (this.keys[i] === key) return true;
      i = (i + 1) & this.mask;
    }
    return false;
  }
}

/** Growable typed array. */
function grown(arr, need) {
  if (need <= arr.length) return arr;
  let n = arr.length || 1024;
  while (n < need) n *= 2;
  const out = new arr.constructor(n);
  out.set(arr);
  return out;
}

/** Positions by their full 64-bit key → dense slot numbers. */
class PositionMap {
  constructor() {
    this.bits = 16;
    this.table = new Int32Array(1 << this.bits); // slot + 1, 0 = empty
    this.hi = new Int32Array(1 << 15);
    this.lo = new Int32Array(1 << 15);
    this.size = 0;
  }
  slot(hi, lo, add) {
    const mask = (1 << this.bits) - 1;
    let i = Math.imul(lo ^ hi, 0x9e3779b1) >>> (32 - this.bits);
    for (;;) {
      const s = this.table[i];
      if (s === 0) break;
      if (this.hi[s - 1] === hi && this.lo[s - 1] === lo) return s - 1;
      i = (i + 1) & mask;
    }
    if (!add) return -1;
    const s = this.size++;
    this.hi = grown(this.hi, this.size);
    this.lo = grown(this.lo, this.size);
    this.hi[s] = hi;
    this.lo[s] = lo;
    this.table[i] = s + 1;
    if (this.size * 2 > mask) this.rehash();
    return s;
  }
  rehash() {
    this.bits++;
    const mask = (1 << this.bits) - 1;
    this.table = new Int32Array(1 << this.bits);
    for (let s = 0; s < this.size; s++) {
      let i = Math.imul(this.lo[s] ^ this.hi[s], 0x9e3779b1) >>> (32 - this.bits);
      while (this.table[i] !== 0) i = (i + 1) & mask;
      this.table[i] = s + 1;
    }
  }
}

/** Moves from indexed positions into indexed positions, with their statistics. */
class EdgeMap {
  constructor(expect = 1 << 15) {
    this.bits = 16;
    while (1 << this.bits < expect * 1.4) this.bits++;
    this.table = new Int32Array(1 << this.bits);
    this.size = 0;
    this.parent = new Int32Array(expect);
    this.move = new Uint16Array(expect);
    this.w = new Uint32Array(expect);
    this.d = new Uint32Array(expect);
    this.b = new Uint32Array(expect);
    this.eloSum = new Float32Array(expect);
    this.eloN = new Uint32Array(expect);
    this.year = new Uint16Array(expect);
  }
  add(slot, move, info) {
    const mask = (1 << this.bits) - 1;
    let i = Math.imul(slot * 65536 + move, 0x9e3779b1) >>> (32 - this.bits);
    let e = -1;
    for (;;) {
      const t = this.table[i];
      if (t === 0) break;
      if (this.parent[t - 1] === slot && this.move[t - 1] === move) {
        e = t - 1;
        break;
      }
      i = (i + 1) & mask;
    }
    if (e < 0) {
      e = this.size++;
      if (this.size > this.parent.length) {
        const cap = Math.ceil(this.parent.length * 1.25) + 1024;
        for (const k of ['parent', 'move', 'w', 'd', 'b', 'eloSum', 'eloN', 'year']) {
          const a = new this[k].constructor(cap);
          a.set(this[k]);
          this[k] = a;
        }
      }
      this.parent[e] = slot;
      this.move[e] = move;
      this.table[i] = e + 1;
      if (this.size * 4 > mask * 3) this.rehash();
    }
    const r = infoResult(info);
    if (r === S.RESULT_WHITE) this.w[e]++;
    else if (r === S.RESULT_BLACK) this.b[e]++;
    else if (r === S.RESULT_DRAW) this.d[e]++;
    if (infoBoth(info)) {
      this.eloSum[e] += infoElo(info);
      this.eloN[e]++;
    }
    const y = infoYear(info);
    if (y > this.year[e]) this.year[e] = y;
  }
  rehash() {
    this.bits++;
    const mask = (1 << this.bits) - 1;
    this.table = new Int32Array(1 << this.bits);
    for (let e = 0; e < this.size; e++) {
      let i = Math.imul(this.parent[e] * 65536 + this.move[e], 0x9e3779b1) >>> (32 - this.bits);
      while (this.table[i] !== 0) i = (i + 1) & mask;
      this.table[i] = e + 1;
    }
  }
}

/** Sorts a Uint32Array in place (LSD radix sort, two 16-bit digits). */
export function radixSort32(a) {
  const n = a.length;
  const tmp = new Uint32Array(n);
  const count = new Uint32Array(65536);
  let src = a;
  let dst = tmp;
  for (const shift of [0, 16]) {
    count.fill(0);
    for (let i = 0; i < n; i++) count[(src[i] >>> shift) & 0xffff]++;
    let sum = 0;
    for (let k = 0; k < 65536; k++) {
      const c = count[k];
      count[k] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const v = src[i];
      dst[count[(v >>> shift) & 0xffff]++] = v;
    }
    [src, dst] = [dst, src];
  }
  return a; // after two passes the result is back in `a`
}

/** Appends Uint32 values to a file through a buffer. */
class U32Writer {
  constructor(path, size = 1 << 16) {
    this.fd = openSync(path, 'w');
    this.buf = new Uint32Array(size);
    this.n = 0;
    this.total = 0;
  }
  push(v) {
    this.buf[this.n++] = v;
    if (this.n === this.buf.length) this.flush();
  }
  flush() {
    if (this.n) {
      const bytes = new Uint8Array(this.buf.buffer, 0, this.n * 4);
      let w = 0;
      while (w < bytes.length) w += writeSync(this.fd, bytes, w, bytes.length - w);
      this.total += this.n;
    }
    this.n = 0;
  }
  close() {
    this.flush();
    closeSync(this.fd);
  }
}

function readU32File(path, count) {
  const out = new Uint32Array(count);
  const fd = openSync(path, 'r');
  try {
    const bytes = new Uint8Array(out.buffer);
    let done = 0;
    while (done < bytes.length) {
      const n = readSync(fd, bytes, done, Math.min(bytes.length - done, 1 << 26), done);
      if (n <= 0) throw new Error('A temporary file is cut short.');
      done += n;
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

/** Varint writer into a growing buffer. */
class Out {
  constructor() {
    this.buf = new Uint8Array(1 << 20);
    this.n = 0;
  }
  ensure(k) {
    if (this.n + k > this.buf.length) this.buf = grown(this.buf, this.n + k);
  }
  uint(v) {
    this.ensure(10);
    while (v >= 128) {
      this.buf[this.n++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.buf[this.n++] = v;
  }
}

/** Reads varints from a Uint8Array. */
class In {
  constructor(buf) {
    this.buf = buf;
    this.i = 0;
  }
  uint() {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = this.buf[this.i++];
      if (b === undefined) throw new Error('The opening index is damaged.');
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  }
}

/**
 * Builds the opening index of the database at `base` (path without extension) into `outFile`.
 * onProgress(fraction, label); isCancelled() stops the build (it throws an error with .cancelled).
 */
export function buildBook(base, outFile, { tmpDir, onProgress = () => {}, isCancelled = () => false, maxPly = MAX_PLY, minGames = MIN_GAMES } = {}) {
  const db = new ScidFiles(base);
  const n = db.count;
  mkdirSync(tmpDir, { recursive: true });
  const tmp = name => join(tmpDir, name);
  const check = () => {
    if (isCancelled()) throw new Cancelled();
  };
  // progress weights of the steps
  const steps = { info: 0.03, a: 0.37, count: 0.08, b: 0.42, write: 0.1 };
  let base0 = 0;
  const report = (step, frac, label) => onProgress(Math.min(1, base0 + steps[step] * frac), label);
  const done = step => (base0 += steps[step]);
  try {
    // 0. Game info from the index
    const names = new S.Names(readFileSync(base + '.sn5'));
    const players = names.count(S.NAME_PLAYER);
    const notTop = new Uint8Array(players); // engines and unknown players: their games are no top games
    for (let id = 0; id < players; id++) {
      const name = names.get(S.NAME_PLAYER, id);
      if (ENGINE_NAME.test(name) || UNKNOWN_NAME.test(name)) notTop[id] = 1;
    }
    const info = new Uint32Array(n);
    const topRating = new Uint16Array(n); // the lower rating of the two, 0 when the game cannot be a top game
    db.scan(
      (g, ib, o) => {
        const w4 = ib.readUInt32LE(o + 16);
        const w5 = ib.readUInt32LE(o + 20);
        const w6 = ib.readUInt32LE(o + 24);
        const w7 = ib.readUInt32LE(o + 28);
        const w11 = ib.readUInt32LE(o + 44);
        const flags = w7 & 0x3fffff;
        const we = w5 >>> 20;
        const be = w6 >>> 20;
        const both = we > 0 && be > 0;
        const elo = both ? Math.round((we + be) / 2) : Math.max(we, be);
        const year = Math.min((w5 & 0xfffff) >>> 9, 2047);
        const skip = flags & (S.FLAG_START | S.FLAG_DELETE) || w4 >>> 31 ? SKIP : 0;
        info[g] = ((w11 >>> 16) & 3) | (Math.min(elo, 4095) << 2) | ((both ? 1 : 0) << 14) | (year << 15) | skip;
        const white = ib.readUInt32LE(o) & 0x0fffffff;
        const black = ib.readUInt32LE(o + 4) & 0x0fffffff;
        if (both && white !== black && !notTop[white] && !notTop[black]) topRating[g] = Math.min(we, be);
      },
      { withData: false, onChunk: g => (check(), report('info', g / n, 'Reading the games list')) },
    );
    const topScore = g => (topRating[g] ? topRating[g] * 2048 + infoYear(info[g]) : 0);
    done('info');

    const pos = new S.ScidPosition();
    const startOf = data => {
      const at = S.skipTags(data, 0);
      return at < 0 || data[at] & 1 ? -1 : at + 1; // games with their own start position are not indexed
    };

    // A. Fingerprints of the positions after each of the first maxPly - 1 moves
    let early = new CountTable(18);
    const parts = Array.from({ length: PARTS }, (_, k) => new U32Writer(tmp(`a${k}.bin`)));
    db.scan(
      (g, ib, o, data) => {
        if (!data || info[g] & SKIP) return;
        const at = startOf(data);
        if (at < 0) return;
        pos.standard();
        S.playMainline(pos, data, at, maxPly - 1, (p, ply) => {
          const fp = p.hi >>> 0;
          if (ply <= EARLY_PLIES) early.add(fp);
          else parts[fp >>> 26].push(fp);
        });
      },
      { onChunk: g => (check(), report('a', g / n, 'Finding the common positions')) },
    );
    for (const w of parts) w.close();
    done('a');

    const frequent = [];
    const rootFp = new S.ScidPosition().standard().hi >>> 0;
    frequent.push(rootFp);
    let handled = new Set();
    for (let k = 0; k < PARTS; k++) {
      check();
      report('count', k / PARTS, 'Counting the common positions');
      const arr = radixSort32(readU32File(tmp(`a${k}.bin`), parts[k].total));
      rmSync(tmp(`a${k}.bin`), { force: true });
      for (let i = 0; i < arr.length; ) {
        const v = arr[i];
        let j = i + 1;
        while (j < arr.length && arr[j] === v) j++;
        const e = early.get(v);
        if (e) handled.add(v);
        if (j - i + e >= minGames) frequent.push(v);
        i = j;
      }
    }
    for (const [fp, c] of early.entries()) if (!handled.has(fp) && c >= minGames) frequent.push(fp);
    done('count');
    const fset = new FpSet(frequent);
    const expectEdges = Math.ceil(frequent.length * 1.35);
    frequent.length = 0;
    early = handled = null;

    // B. Moves under exact keys
    const positions = new PositionMap();
    const edges = new EdgeMap(expectEdges);
    let totW = new Uint32Array(1 << 16);
    let totD = new Uint32Array(1 << 16);
    let totB = new Uint32Array(1 << 16);
    let top = new Uint32Array(TOP_GAMES << 16); // game + 1, best first is not kept: sorted when written
    let topMin = new Uint32Array(1 << 16); // the lowest score among a full top list
    let rareCount = new Uint32Array(1 << 16);
    const rare = new U32Writer(tmp('rare.bin'), 3 << 16);
    const root = positions.slot(pos.standard().hi, pos.lo, true);
    const fit = need => {
      if (need > totW.length) {
        totW = grown(totW, need);
        totD = grown(totD, need);
        totB = grown(totB, need);
        topMin = grown(topMin, need);
        rareCount = grown(rareCount, need);
        top = grown(top, need * TOP_GAMES);
      }
    };
    fit(1);
    const reach = (slot, g) => {
      const x = info[g];
      const r = infoResult(x);
      if (r === S.RESULT_WHITE) totW[slot]++;
      else if (r === S.RESULT_BLACK) totB[slot]++;
      else if (r === S.RESULT_DRAW) totD[slot]++;
      const score = topScore(g);
      if (!score) return;
      if (score <= topMin[slot] && top[slot * TOP_GAMES + TOP_GAMES - 1] !== 0) return;
      // put the game in an empty place or over the lowest score
      let worst = -1;
      let worstScore = Infinity;
      for (let k = 0; k < TOP_GAMES; k++) {
        const t = top[slot * TOP_GAMES + k];
        if (t === 0) {
          worst = k;
          worstScore = -1;
          break;
        }
        const sc = topScore(t - 1);
        if (sc < worstScore) {
          worstScore = sc;
          worst = k;
        }
      }
      if (worstScore >= 0 && score <= worstScore) return;
      top[slot * TOP_GAMES + worst] = g + 1;
      let min = Infinity;
      for (let k = 0; k < TOP_GAMES; k++) {
        const t = top[slot * TOP_GAMES + k];
        min = Math.min(min, t ? topScore(t - 1) : 0);
      }
      topMin[slot] = min;
    };
    let game = 0;
    let slot = -1;
    const onMove = (p, ply) => {
      let child = -1;
      if (ply < maxPly && fset.has(p.hi >>> 0)) {
        child = positions.slot(p.hi, p.lo, true);
        if (child >= totW.length) fit(child + 1);
      }
      if (slot >= 0) {
        const m = p.move16();
        if (child >= 0) edges.add(slot, m, info[game]);
        else {
          rare.push(slot);
          rare.push(m);
          rare.push(game);
          rareCount[slot]++;
        }
      }
      if (child >= 0) reach(child, game);
      slot = child;
    };
    db.scan(
      (g, ib, o, data) => {
        if (!data || info[g] & SKIP) return;
        const at = startOf(data);
        if (at < 0) return;
        game = g;
        slot = root;
        reach(root, g);
        pos.standard();
        S.playMainline(pos, data, at, maxPly, onMove);
      },
      { onChunk: g => (check(), report('b', g / n, 'Counting the moves')) },
    );
    rare.close();
    done('b');

    // Write: positions sorted by key, each with its moves (common ones with their counts, rare ones with their games)
    const count = positions.size;
    const order = new Int32Array(count);
    for (let s = 0; s < count; s++) order[s] = s;
    const H = positions.hi;
    const L = positions.lo;
    order.sort((a, b) => (H[a] >>> 0) - (H[b] >>> 0) || (L[a] >>> 0) - (L[b] >>> 0));
    const rank = new Int32Array(count);
    for (let r = 0; r < count; r++) rank[order[r]] = r;
    // the common moves of each position, as lists
    const edgeHead = new Int32Array(count).fill(-1);
    const edgeNext = new Int32Array(edges.size);
    for (let e = edges.size - 1; e >= 0; e--) {
      edgeNext[e] = edgeHead[edges.parent[e]];
      edgeHead[edges.parent[e]] = e;
    }
    const outTmp = outFile + '.part';
    const fd = openSync(outTmp, 'w');
    const keys = new Uint32Array(count * 2);
    const offsets = new Uint32Array(count + 1);
    const dataStart = HEADER_SIZE + count * 8 + (count + 1) * 4;
    let dataPos = 0;
    const write = (bytes, at) => {
      let w = 0;
      while (w < bytes.length) w += writeSync(fd, bytes, w, bytes.length - w, at + w);
    };
    // rare records are grouped by rank in a few passes over their file
    const BUDGET = 4 << 20;
    const totalRare = rare.total / 3;
    let r0 = 0;
    const out = new Out();
    while (r0 < count) {
      check();
      report('write', r0 / count, 'Writing the opening index');
      let r1 = r0;
      let sum = 0;
      while (r1 < count && (r1 === r0 || sum + rareCount[order[r1]] <= BUDGET)) sum += rareCount[order[r1++]];
      // place the records of ranks [r0, r1)
      const start = new Uint32Array(r1 - r0 + 1);
      for (let r = r0; r < r1; r++) start[r - r0 + 1] = start[r - r0] + rareCount[order[r]];
      const fill = start.slice(0, r1 - r0);
      const gMove = new Uint16Array(sum);
      const gGame = new Uint32Array(sum);
      if (sum) {
        const rfd = openSync(tmp('rare.bin'), 'r');
        const chunk = new Uint32Array(3 << 18);
        const bytes = new Uint8Array(chunk.buffer);
        let filePos = 0;
        for (let left = totalRare * 12; left > 0; ) {
          const want = Math.min(left, bytes.length);
          let got = 0;
          while (got < want) got += readSync(rfd, bytes, got, want - got, filePos + got);
          filePos += want;
          left -= want;
          for (let i = 0; i < want / 4; i += 3) {
            const r = rank[chunk[i]];
            if (r < r0 || r >= r1) continue;
            const at = fill[r - r0]++;
            gMove[at] = chunk[i + 1];
            gGame[at] = chunk[i + 2];
          }
        }
        closeSync(rfd);
      }
      for (let r = r0; r < r1; r++) {
        const s = order[r];
        keys[r * 2] = H[s];
        keys[r * 2 + 1] = L[s];
        offsets[r] = dataPos + out.n;
        encodePosition(out, s, edges, edgeHead, edgeNext, gMove, gGame, start[r - r0], start[r - r0 + 1], info, topScore, { totW, totD, totB, top });
        if (out.n > 8 << 20) {
          write(out.buf.subarray(0, out.n), dataStart + dataPos);
          dataPos += out.n;
          out.n = 0;
        }
      }
      r0 = r1;
    }
    write(out.buf.subarray(0, out.n), dataStart + dataPos);
    dataPos += out.n;
    if (dataPos > 0xffffffff) throw new Error('The opening index is too large.');
    offsets[count] = dataPos;
    const header = Buffer.alloc(HEADER_SIZE);
    header.write(MAGIC, 0, 'latin1');
    header.writeUInt32LE(BOOK_VERSION, 8);
    header.writeUInt32LE(count, 12);
    header.writeUInt32LE(maxPly, 16);
    header.writeUInt32LE(minGames, 20);
    header.writeUInt32LE(n, 24);
    header.writeUInt32LE(dataPos, 28);
    header.writeUInt32LE(edges.size, 32);
    header.writeUInt32LE(totalRare, 36);
    write(header, 0);
    write(new Uint8Array(keys.buffer), HEADER_SIZE);
    write(new Uint8Array(offsets.buffer), HEADER_SIZE + count * 8);
    closeSync(fd);
    rmSync(tmp('rare.bin'), { force: true });
    renameSync(outTmp, outFile);
    onProgress(1, 'Done');
    return { positions: count, edges: edges.size, rare: totalRare, games: n, bytes: dataStart + dataPos };
  } finally {
    db.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

function encodePosition(out, s, edges, edgeHead, edgeNext, gMove, gGame, from, to, info, topScore, { totW, totD, totB, top }) {
  out.uint(totW[s]);
  out.uint(totD[s]);
  out.uint(totB[s]);
  // rare moves: group this position's records by move
  const groups = new Map();
  for (let i = from; i < to; i++) {
    const m = gMove[i];
    let list = groups.get(m);
    if (!list) groups.set(m, (list = []));
    list.push(gGame[i]);
  }
  const list = [];
  for (let e = edgeHead[s]; e >= 0; e = edgeNext[e]) {
    const n = edges.eloN[e];
    list.push({ move: edges.move[e], w: edges.w[e], d: edges.d[e], b: edges.b[e], elo: n ? Math.round(edges.eloSum[e] / n) : 0, year: edges.year[e], games: null, total: edges.w[e] + edges.d[e] + edges.b[e] });
  }
  for (const [move, games] of groups) {
    let w = 0;
    let d = 0;
    let b = 0;
    let eloSum = 0;
    let eloN = 0;
    let year = 0;
    for (const g of games) {
      const x = info[g];
      const r = infoResult(x);
      if (r === S.RESULT_WHITE) w++;
      else if (r === S.RESULT_BLACK) b++;
      else if (r === S.RESULT_DRAW) d++;
      if (infoBoth(x)) {
        eloSum += infoElo(x);
        eloN++;
      }
      year = Math.max(year, infoYear(x));
    }
    let keep = games;
    if (games.length > EDGE_GAMES) keep = [...games].sort((a, c) => topScore(c) - topScore(a) || infoElo(info[c]) - infoElo(info[a])).slice(0, EDGE_GAMES);
    keep = [...keep].sort((a, c) => a - c);
    list.push({ move, w, d, b, elo: eloN ? Math.round(eloSum / eloN) : 0, year, games: keep, total: games.length });
  }
  list.sort((a, c) => c.total - a.total || a.move - c.move);
  out.uint(list.length);
  for (const e of list) {
    out.uint(e.move);
    out.uint(e.w);
    out.uint(e.d);
    out.uint(e.b);
    out.uint(e.elo);
    out.uint(e.year);
    const g = e.games || [];
    out.uint(g.length);
    let prev = 0;
    for (const x of g) {
      out.uint(x - prev);
      prev = x;
    }
  }
  const best = [];
  for (let k = 0; k < TOP_GAMES; k++) {
    const t = top[s * TOP_GAMES + k];
    if (t) best.push(t - 1);
  }
  best.sort((a, c) => topScore(c) - topScore(a) || a - c);
  out.uint(best.length);
  for (const g of best) out.uint(g);
}

/** A built opening index, opened for reading. */
export class Book {
  constructor(file) {
    this.fd = openSync(file, 'r');
    const header = Buffer.alloc(HEADER_SIZE);
    readSync(this.fd, header, 0, HEADER_SIZE, 0);
    if (header.toString('latin1', 0, 8) !== MAGIC || header.readUInt32LE(8) !== BOOK_VERSION) {
      closeSync(this.fd);
      throw new Error('The opening index is from another version.');
    }
    this.count = header.readUInt32LE(12);
    this.maxPly = header.readUInt32LE(16);
    this.minGames = header.readUInt32LE(20);
    this.games = header.readUInt32LE(24);
    this.keys = new Uint32Array(this.count * 2);
    readSync(this.fd, new Uint8Array(this.keys.buffer), 0, this.count * 8, HEADER_SIZE);
    this.offsets = new Uint32Array(this.count + 1);
    readSync(this.fd, new Uint8Array(this.offsets.buffer), 0, (this.count + 1) * 4, HEADER_SIZE + this.count * 8);
    this.dataStart = HEADER_SIZE + this.count * 8 + (this.count + 1) * 4;
  }
  close() {
    closeSync(this.fd);
  }
  /** The rank of a position (its two key halves), or -1. */
  find(hi, lo) {
    hi >>>= 0;
    lo >>>= 0;
    let a = 0;
    let b = this.count - 1;
    const k = this.keys;
    while (a <= b) {
      const m = (a + b) >>> 1;
      const h = k[m * 2];
      const l = k[m * 2 + 1];
      if (h < hi || (h === hi && l < lo)) a = m + 1;
      else if (h > hi || l > lo) b = m - 1;
      else return m;
    }
    return -1;
  }
  /** { white, draws, black, moves: [{ move, white, draws, black, averageRating, lastYear, games: [ids] | null, total }], top: [ids] } */
  record(rank) {
    const from = this.offsets[rank];
    const to = this.offsets[rank + 1];
    const buf = Buffer.alloc(to - from);
    readSync(this.fd, buf, 0, buf.length, this.dataStart + from);
    const r = new In(buf);
    const rec = { white: r.uint(), draws: r.uint(), black: r.uint(), moves: [], top: [] };
    const nMoves = r.uint();
    for (let k = 0; k < nMoves; k++) {
      const m = { move: r.uint(), white: r.uint(), draws: r.uint(), black: r.uint(), averageRating: r.uint(), lastYear: r.uint(), games: null };
      const ng = r.uint();
      if (ng) {
        m.games = [];
        let prev = 0;
        for (let j = 0; j < ng; j++) m.games.push((prev += r.uint()));
      }
      rec.moves.push(m);
    }
    const nTop = r.uint();
    for (let k = 0; k < nTop; k++) rec.top.push(r.uint());
    return rec;
  }
}
