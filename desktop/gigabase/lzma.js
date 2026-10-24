// LZMA and LZMA2 decoders (the compression of .7z archives), after Igor Pavlov's public-domain LZMA SDK
// (LzmaSpec.cpp, Lzma2Dec.c). Output goes through a sliding dictionary to a sink: sink(bytes) receives views that
// are only valid during the call.

const PROB_INIT = 1024;
const NUM_STATES = 12;
const POS_BITS_MAX = 4;
const LEN_TO_POS_STATES = 4;
const END_POS_MODEL_INDEX = 14;
const NUM_FULL_DISTANCES = 128;
const MATCH_MIN_LEN = 2;

// Offsets of the probability groups in one Uint16Array (the literal coders follow at LITERAL).
const IS_MATCH = 0;
const IS_REP = IS_MATCH + (NUM_STATES << POS_BITS_MAX);
const IS_REP_G0 = IS_REP + NUM_STATES;
const IS_REP_G1 = IS_REP_G0 + NUM_STATES;
const IS_REP_G2 = IS_REP_G1 + NUM_STATES;
const IS_REP0_LONG = IS_REP_G2 + NUM_STATES;
const POS_SLOT = IS_REP0_LONG + (NUM_STATES << POS_BITS_MAX);
const SPEC_POS = POS_SLOT + (LEN_TO_POS_STATES << 6);
const ALIGN = SPEC_POS + 1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX;
const LEN_CODER = ALIGN + 16;
const REP_LEN_CODER = LEN_CODER + 514;
const LITERAL = REP_LEN_CODER + 514;
// a length coder: choice, choice2, low[16][8], mid[16][8], high[256]
const L_CHOICE = 0;
const L_CHOICE2 = 1;
const L_LOW = 2;
const L_MID = 2 + 128;
const L_HIGH = 2 + 256;

export class LzmaError extends Error {}

/** The sliding dictionary: a ring buffer that hands every new byte to the sink. */
class Window {
  constructor(size, sink) {
    this.buf = new Uint8Array(Math.max(size, 4096));
    this.size = this.buf.length;
    this.pos = 0;
    this.flushed = 0;
    this.full = false;
    this.total = 0; // bytes written since the last dictionary reset
    this.sink = sink;
  }
  reset() {
    this.flush();
    this.pos = this.flushed = 0;
    this.full = false;
    this.total = 0;
  }
  flush() {
    if (this.pos > this.flushed) this.sink(this.buf.subarray(this.flushed, this.pos));
    if (this.pos === this.size) {
      this.pos = 0;
      this.full = true;
    }
    this.flushed = this.pos;
  }
}

/**
 * Decodes LZMA data. One instance keeps the state between LZMA2 chunks; decode() runs the coder over `src` from
 * `at` until `outSize` bytes are produced (or, when outSize is -1, until the end marker).
 */
export class LzmaDecoder {
  constructor(win) {
    this.win = win;
    this.probs = null;
    this.lc = 3;
    this.lp = 0;
    this.pb = 2;
    this.resetState();
  }

  setProps(lc, lp, pb) {
    if (lc > 8 || lp > 4 || pb > 4) throw new LzmaError('bad LZMA properties');
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.probs = new Uint16Array(LITERAL + (0x300 << (lc + lp)));
  }

  resetState() {
    if (this.probs) this.probs.fill(PROB_INIT);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  /**
   * Returns the offset in `src` after the data used. When the input runs out, `more()` (if given) supplies the next
   * piece of the stream as a Uint8Array (null at its end).
   */
  decode(src, at, end, outSize, more = null) {
    const probs = this.probs;
    const win = this.win;
    const buf = win.buf;
    const size = win.size;
    const lc = this.lc;
    const lpMask = (1 << this.lp) - 1;
    const pbMask = (1 << this.pb) - 1;
    let { state, rep0, rep1, rep2, rep3 } = this;
    let pos = win.pos;
    let full = win.full;
    let total = win.total;
    let i = at;
    const next = () => {
      if (i >= end) {
        const piece = more ? more() : null;
        if (!piece || !piece.length) throw new LzmaError('LZMA data cut short');
        src = piece;
        i = 0;
        end = piece.length;
      }
      return src[i++];
    };
    if (next() !== 0) throw new LzmaError('bad LZMA stream');
    let range = 0xffffffff | 0;
    let code = 0;
    for (let k = 0; k < 4; k++) code = (code << 8) | next();
    let remaining = outSize;
    const unbounded = outSize < 0;

    // The range coder works on unsigned 32-bit values kept in signed ints: comparisons go through >>> 0.
    const bit = p => {
      const prob = probs[p];
      const bound = Math.imul(range >>> 11, prob);
      let b;
      if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
        range = bound;
        probs[p] = prob + ((2048 - prob) >>> 5);
        b = 0;
      } else {
        range = (range - bound) | 0;
        code = (code - bound) | 0;
        probs[p] = prob - (prob >>> 5);
        b = 1;
      }
      if ((range >>> 0) < 0x1000000) {
        range <<= 8;
        code = (code << 8) | (i < end ? src[i++] : next());
      }
      return b;
    };
    const tree = (base, numBits) => {
      let m = 1;
      for (let k = 0; k < numBits; k++) m = (m << 1) | bit(base + m);
      return m - (1 << numBits);
    };
    const reverse = (base, numBits) => {
      let m = 1;
      let sym = 0;
      for (let k = 0; k < numBits; k++) {
        const b = bit(base + m);
        m = (m << 1) | b;
        sym |= b << k;
      }
      return sym;
    };
    const direct = numBits => {
      let res = 0;
      for (let k = 0; k < numBits; k++) {
        range = (range >>> 1) | 0;
        code = (code - range) | 0;
        const t = code >> 31; // -1 when code went "negative" (it was below range)
        code = (code + (range & t)) | 0;
        res = (res << 1) + (t + 1);
        if ((range >>> 0) < 0x1000000) {
          range <<= 8;
          code = (code << 8) | (i < end ? src[i++] : next());
        }
      }
      return res >>> 0;
    };
    const len = (base, posState) => {
      if (bit(base + L_CHOICE) === 0) return tree(base + L_LOW + (posState << 3), 3);
      if (bit(base + L_CHOICE2) === 0) return 8 + tree(base + L_MID + (posState << 3), 3);
      return 16 + tree(base + L_HIGH, 8);
    };
    const flushIfFull = () => {
      if (pos === size) {
        win.pos = pos;
        win.flush();
        pos = 0;
        full = true;
      }
    };

    while (unbounded || remaining > 0) {
      const posState = total & pbMask;
      if (bit(IS_MATCH + (state << POS_BITS_MAX) + posState) === 0) {
        // literal
        const prev = total > 0 ? buf[(pos === 0 ? size : pos) - 1] : 0;
        const base = LITERAL + 0x300 * (((total & lpMask) << lc) + (prev >>> (8 - lc)));
        let sym = 1;
        if (state >= 7) {
          let back = pos - rep0 - 1;
          if (back < 0) back += size;
          let matchByte = buf[back];
          do {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte <<= 1;
            const b = bit(base + ((1 + matchBit) << 8) + sym);
            sym = (sym << 1) | b;
            if (matchBit !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | bit(base + sym);
        buf[pos++] = sym - 0x100;
        total++;
        remaining--;
        flushIfFull();
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let n;
      if (bit(IS_REP + state) !== 0) {
        if (total === 0 && !full) throw new LzmaError('LZMA data starts with a repeat');
        if (bit(IS_REP_G0 + state) === 0) {
          if (bit(IS_REP0_LONG + (state << POS_BITS_MAX) + posState) === 0) {
            // a single byte from rep0
            state = state < 7 ? 9 : 11;
            let back = pos - rep0 - 1;
            if (back < 0) back += size;
            buf[pos++] = buf[back];
            total++;
            remaining--;
            flushIfFull();
            continue;
          }
        } else {
          let dist;
          if (bit(IS_REP_G1 + state) === 0) dist = rep1;
          else {
            if (bit(IS_REP_G2 + state) === 0) dist = rep2;
            else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        n = len(REP_LEN_CODER, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        n = len(LEN_CODER, posState);
        state = state < 7 ? 7 : 10;
        // the distance
        const lenState = n < LEN_TO_POS_STATES - 1 ? n : LEN_TO_POS_STATES - 1;
        const slot = tree(POS_SLOT + (lenState << 6), 6);
        if (slot < 4) rep0 = slot;
        else {
          const numDirect = (slot >>> 1) - 1;
          let dist = ((2 | (slot & 1)) << numDirect) >>> 0;
          if (slot < END_POS_MODEL_INDEX) dist += reverse(SPEC_POS + dist - slot, numDirect);
          else {
            dist += direct(numDirect - 4) * 16;
            dist += reverse(ALIGN, 4);
          }
          rep0 = dist >>> 0;
          if (rep0 === 0xffffffff) {
            // end marker
            if (!unbounded && remaining !== 0) throw new LzmaError('LZMA end marker too early');
            break;
          }
        }
        if (!full && rep0 >= total) throw new LzmaError('LZMA distance beyond the data');
        if (rep0 >= size) throw new LzmaError('LZMA distance beyond the dictionary');
      }
      n += MATCH_MIN_LEN;
      if (!unbounded && n > remaining) throw new LzmaError('LZMA match beyond the end');
      remaining -= n;
      total += n;
      let back = pos - rep0 - 1;
      if (back < 0) back += size;
      if (n > 32 && rep0 >= n && pos + n <= size && back + n <= size) {
        // a long match that neither overlaps itself nor wraps around the ring
        buf.copyWithin(pos, back, back + n);
        pos += n;
        flushIfFull();
      } else {
        // byte by byte: a match closer than its length repeats itself, as LZ77 means it to
        for (; n > 0; n--) {
          buf[pos++] = buf[back++];
          if (back === size) back = 0;
          if (pos === size) flushIfFull();
        }
      }
    }
    Object.assign(this, { state, rep0, rep1, rep2, rep3 });
    win.pos = pos;
    win.full = full;
    win.total = total;
    // the coder must have consumed its data up to here (range coder: the last bytes are already in `code`)
    return i;
  }
}

/** LZMA2: a series of LZMA or stored chunks. `dictSize` from the coder property. */
export function lzma2Decoder(dictSize, sink) {
  const win = new Window(dictSize, sink);
  const lz = new LzmaDecoder(win);
  let needDictReset = true;
  let needProps = true;
  let done = false;
  let pending = null; // bytes of an incomplete chunk from the previous call
  return {
    /** Feeds compressed bytes; returns true when the end of the stream was seen. */
    write(chunk) {
      let src = pending ? concat(pending, chunk) : chunk;
      pending = null;
      let i = 0;
      while (i < src.length && !done) {
        const c = src[i];
        if (c === 0) {
          done = true;
          i++;
          break;
        }
        if (c === 1 || c === 2) {
          if (i + 3 > src.length) break;
          const n = ((src[i + 1] << 8) | src[i + 2]) + 1;
          if (i + 3 + n > src.length) break;
          if (c === 1) {
            win.reset();
            needDictReset = false;
          } else if (needDictReset) throw new LzmaError('LZMA2 stream without a dictionary reset');
          storeBytes(win, src.subarray(i + 3, i + 3 + n));
          i += 3 + n;
          continue;
        }
        if (c < 0x80) throw new LzmaError('bad LZMA2 chunk');
        const mode = (c >>> 5) & 3;
        const hasProps = mode >= 2;
        const head = hasProps ? 6 : 5;
        if (i + head > src.length) break;
        const unpacked = ((c & 0x1f) << 16) + (src[i + 1] << 8) + src[i + 2] + 1;
        const packed = (src[i + 3] << 8) + src[i + 4] + 1;
        if (i + head + packed > src.length) break;
        if (mode === 3) {
          win.reset();
          needDictReset = false;
        } else if (needDictReset) throw new LzmaError('LZMA2 stream without a dictionary reset');
        if (hasProps) {
          let p = src[i + 5];
          if (p >= 9 * 5 * 5) throw new LzmaError('bad LZMA2 properties');
          const lc = p % 9;
          p = (p / 9) | 0;
          const lp = p % 5;
          const pb = (p / 5) | 0;
          if (lc + lp > 4) throw new LzmaError('bad LZMA2 properties');
          lz.setProps(lc, lp, pb);
          needProps = false;
        } else if (needProps) throw new LzmaError('LZMA2 stream without properties');
        if (mode >= 1) lz.resetState();
        const from = i + head;
        const used = lz.decode(src, from, from + packed, unpacked);
        if (used > from + packed) throw new LzmaError('LZMA2 chunk overrun');
        win.flush();
        i = from + packed;
      }
      if (!done && i < src.length) pending = src.slice(i);
      return done;
    },
    end() {
      win.flush();
      if (!done) throw new LzmaError('LZMA2 stream cut short');
    },
  };
}

function storeBytes(win, bytes) {
  let k = 0;
  while (k < bytes.length) {
    const n = Math.min(bytes.length - k, win.size - win.pos);
    win.buf.set(bytes.subarray(k, k + n), win.pos);
    win.pos += n;
    win.total += n;
    k += n;
    win.flush();
  }
}

/**
 * Plain LZMA (5 property bytes) of a known output size (or -1: up to the end marker). `src` is the first piece of
 * the packed stream; `more()` gives the next ones.
 */
export function lzmaDecode(props, src, outSize, sink, more = null) {
  let p = props[0];
  const dictSize = (props[1] | (props[2] << 8) | (props[3] << 16) | (props[4] << 24)) >>> 0;
  if (p >= 9 * 5 * 5) throw new LzmaError('bad LZMA properties');
  const lc = p % 9;
  p = (p / 9) | 0;
  const lp = p % 5;
  const pb = (p / 5) | 0;
  const winSize = outSize >= 0 ? Math.min(Math.max(dictSize, 4096), Math.max(outSize, 4096)) : Math.max(dictSize, 4096);
  const win = new Window(winSize, sink);
  const lz = new LzmaDecoder(win);
  lz.setProps(lc, lp, pb);
  lz.resetState();
  lz.decode(src, 0, src.length, outSize, more);
  win.flush();
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
