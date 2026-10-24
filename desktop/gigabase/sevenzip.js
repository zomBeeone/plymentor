// Reading .7z archives (7zFormat.txt of the 7-Zip documentation): the archive's file list and the extraction of
// chosen files. Supports what 7-Zip writes by default — LZMA2 or LZMA data, an LZMA-compressed header, solid
// blocks — and stored (copy) data. Each extracted file is checked against the CRC-32 the archive keeps for it.

import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import * as zlib from 'node:zlib';
import { lzma2Decoder, lzmaDecode } from './lzma.js';

const SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const K = {
  End: 0x00,
  Header: 0x01,
  ArchiveProperties: 0x02,
  AdditionalStreamsInfo: 0x03,
  MainStreamsInfo: 0x04,
  FilesInfo: 0x05,
  PackInfo: 0x06,
  UnpackInfo: 0x07,
  SubStreamsInfo: 0x08,
  Size: 0x09,
  CRC: 0x0a,
  Folder: 0x0b,
  CodersUnpackSize: 0x0c,
  NumUnpackStream: 0x0d,
  EmptyStream: 0x0e,
  EmptyFile: 0x0f,
  Name: 0x11,
  WinAttributes: 0x15,
  EncodedHeader: 0x17,
  Dummy: 0x19,
};
const METHOD = { '00': 'copy', 21: 'lzma2', '030101': 'lzma', '06f10701': 'aes' };

export class SevenZipError extends Error {}

const crc32 =
  typeof zlib.crc32 === 'function'
    ? (data, value = 0) => zlib.crc32(data, value)
    : (() => {
        const table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          table[n] = c;
        }
        return (data, value = 0) => {
          let c = ~value;
          for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
          return ~c >>> 0;
        };
      })();

/** A reader over the bytes of a header. */
class Bytes {
  constructor(buf) {
    this.buf = buf;
    this.i = 0;
  }
  byte() {
    if (this.i >= this.buf.length) throw new SevenZipError('The archive header is cut short.');
    return this.buf[this.i++];
  }
  bytes(n) {
    if (this.i + n > this.buf.length) throw new SevenZipError('The archive header is cut short.');
    const out = this.buf.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
  uint32() {
    const b = this.bytes(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  /** 7z's variable-length number: the leading 1 bits of the first byte count the bytes that follow. */
  number() {
    const first = this.byte();
    let mask = 0x80;
    let value = 0;
    for (let k = 0; k < 8; k++) {
      if ((first & mask) === 0) return value + (first & (mask - 1)) * 2 ** (8 * k);
      value += this.byte() * 2 ** (8 * k);
      mask >>>= 1;
    }
    return value;
  }
  bits(n) {
    const out = new Array(n);
    let b = 0;
    let mask = 0;
    for (let k = 0; k < n; k++) {
      if (mask === 0) {
        b = this.byte();
        mask = 0x80;
      }
      out[k] = (b & mask) !== 0;
      mask >>>= 1;
    }
    return out;
  }
  /** "AllAreDefined" byte, then a bit vector when not all are. */
  defined(n) {
    return this.byte() ? new Array(n).fill(true) : this.bits(n);
  }
  digests(n) {
    const defined = this.defined(n);
    return defined.map(d => (d ? this.uint32() : null));
  }
  expect(id) {
    const got = this.number();
    if (got !== id) throw new SevenZipError(`Unexpected data in the archive header (${got}, wanted ${id}).`);
  }
}

function readPackInfo(r) {
  const info = { packPos: r.number(), sizes: [], crcs: [] };
  const n = r.number();
  for (;;) {
    const id = r.number();
    if (id === K.End) break;
    if (id === K.Size) for (let k = 0; k < n; k++) info.sizes.push(r.number());
    else if (id === K.CRC) info.crcs = r.digests(n);
    else throw new SevenZipError('Unsupported pack information in the archive.');
  }
  return info;
}

function readFolder(r) {
  const coders = [];
  const numCoders = r.number();
  let totalIn = 0;
  let totalOut = 0;
  for (let c = 0; c < numCoders; c++) {
    const flags = r.byte();
    if (flags & 0x80) throw new SevenZipError('The archive uses alternative coders (not supported).');
    const id = Buffer.from(r.bytes(flags & 0x0f)).toString('hex');
    const complex = (flags & 0x10) !== 0;
    const numIn = complex ? r.number() : 1;
    const numOut = complex ? r.number() : 1;
    const props = flags & 0x20 ? r.bytes(r.number()) : new Uint8Array(0);
    coders.push({ id, method: METHOD[id] || `method ${id}`, numIn, numOut, props });
    totalIn += numIn;
    totalOut += numOut;
  }
  const bindPairs = [];
  for (let k = 0; k < totalOut - 1; k++) bindPairs.push({ in: r.number(), out: r.number() });
  const numPacked = totalIn - bindPairs.length;
  const packed = [];
  if (numPacked === 1) {
    for (let k = 0; k < totalIn; k++) if (!bindPairs.some(b => b.in === k)) packed.push(k);
  } else for (let k = 0; k < numPacked; k++) packed.push(r.number());
  return { coders, bindPairs, packed, totalOut, unpackSizes: [], crc: null };
}

function readUnpackInfo(r) {
  r.expect(K.Folder);
  const n = r.number();
  if (r.byte() !== 0) throw new SevenZipError('External folder data in the archive (not supported).');
  const folders = [];
  for (let k = 0; k < n; k++) folders.push(readFolder(r));
  r.expect(K.CodersUnpackSize);
  for (const f of folders) for (let k = 0; k < f.totalOut; k++) f.unpackSizes.push(r.number());
  for (;;) {
    const id = r.number();
    if (id === K.End) break;
    if (id === K.CRC) r.digests(n).forEach((crc, k) => (folders[k].crc = crc));
    else throw new SevenZipError('Unsupported folder information in the archive.');
  }
  return folders;
}

/** The final output of a folder: the coder output that no bind pair consumes. */
function folderSize(f) {
  for (let k = 0; k < f.totalOut; k++) if (!f.bindPairs.some(b => b.out === k)) return f.unpackSizes[k];
  return 0;
}

function readSubStreamsInfo(r, folders) {
  const counts = folders.map(() => 1);
  let id = r.number();
  if (id === K.NumUnpackStream) {
    for (let k = 0; k < folders.length; k++) counts[k] = r.number();
    id = r.number();
  }
  const sizes = [];
  const hasSizes = id === K.Size;
  folders.forEach((f, k) => {
    if (!counts[k]) return;
    let sum = 0;
    for (let s = 0; s < counts[k] - 1; s++) {
      const size = hasSizes ? r.number() : 0;
      sizes.push(size);
      sum += size;
    }
    sizes.push(folderSize(f) - sum);
  });
  if (hasSizes) id = r.number();
  // CRCs: for streams whose CRC is not already known from the folder (a folder holding one stream)
  const crcs = [];
  const unknown = [];
  folders.forEach((f, k) => {
    for (let s = 0; s < counts[k]; s++) {
      const known = counts[k] === 1 && f.crc != null;
      crcs.push(known ? f.crc : null);
      if (!known) unknown.push(crcs.length - 1);
    }
  });
  while (id !== K.End) {
    if (id === K.CRC) {
      const d = r.digests(unknown.length);
      unknown.forEach((idx, k) => (crcs[idx] = d[k]));
    } else throw new SevenZipError('Unsupported stream information in the archive.');
    id = r.number();
  }
  return { counts, sizes, crcs };
}

function readStreamsInfo(r) {
  const out = { pack: null, folders: [], sub: null };
  for (;;) {
    const id = r.number();
    if (id === K.End) break;
    if (id === K.PackInfo) out.pack = readPackInfo(r);
    else if (id === K.UnpackInfo) out.folders = readUnpackInfo(r);
    else if (id === K.SubStreamsInfo) out.sub = readSubStreamsInfo(r, out.folders);
    else throw new SevenZipError('Unsupported stream information in the archive.');
  }
  if (!out.sub) {
    out.sub = { counts: out.folders.map(() => 1), sizes: out.folders.map(folderSize), crcs: out.folders.map(f => f.crc) };
  }
  return out;
}

function readFilesInfo(r) {
  const n = r.number();
  const files = Array.from({ length: n }, () => ({ name: '', emptyStream: false, emptyFile: false, attributes: null }));
  let emptyStreams = 0;
  for (;;) {
    const id = r.number();
    if (id === K.End) break;
    const size = r.number();
    const end = r.i + size;
    if (id === K.EmptyStream) {
      r.bits(n).forEach((b, k) => (files[k].emptyStream = b));
      emptyStreams = files.filter(f => f.emptyStream).length;
    } else if (id === K.EmptyFile) {
      const bits = r.bits(emptyStreams);
      let e = 0;
      for (const f of files) if (f.emptyStream) f.emptyFile = bits[e++];
    } else if (id === K.Name) {
      if (r.byte() !== 0) throw new SevenZipError('External file names in the archive (not supported).');
      const raw = r.bytes(end - r.i);
      const text = Buffer.from(raw.buffer, raw.byteOffset, raw.length).toString('utf16le');
      text.split('\0').slice(0, n).forEach((name, k) => (files[k].name = name));
    } else if (id === K.WinAttributes) {
      const defined = r.defined(n);
      if (r.byte() !== 0) throw new SevenZipError('External attributes in the archive (not supported).');
      defined.forEach((d, k) => d && (files[k].attributes = r.uint32()));
    }
    r.i = end; // times and anything else are skipped
  }
  return files;
}

function readHeader(r) {
  const header = { main: null, files: [] };
  for (;;) {
    const id = r.number();
    if (id === K.End) break;
    if (id === K.ArchiveProperties) {
      for (;;) {
        const pid = r.number();
        if (pid === K.End) break;
        r.bytes(r.number());
      }
    } else if (id === K.AdditionalStreamsInfo) readStreamsInfo(r);
    else if (id === K.MainStreamsInfo) header.main = readStreamsInfo(r);
    else if (id === K.FilesInfo) header.files = readFilesInfo(r);
    else throw new SevenZipError('Unsupported data in the archive header.');
  }
  return header;
}

function readAt(fd, pos, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, pos + done);
    if (n <= 0) throw new SevenZipError('The archive is cut short.');
    done += n;
  }
  return buf;
}

/** Decodes one folder: `sink(bytes)` gets the output in order. `onPacked(n)` counts the packed bytes read. */
function decodeFolder(fd, folder, packStart, packSize, sink, onPacked = () => {}) {
  if (folder.coders.length !== 1 || folder.packed.length !== 1) {
    const names = folder.coders.map(c => c.method).join(' + ');
    throw new SevenZipError(`The archive uses ${names}, which this app cannot unpack.`);
  }
  const coder = folder.coders[0];
  const outSize = folder.unpackSizes[0];
  const BLOCK = 1 << 20;
  let at = packStart;
  const endPos = packStart + packSize;
  const more = () => {
    if (at >= endPos) return null;
    const n = Math.min(BLOCK, endPos - at);
    const piece = readAt(fd, at, n);
    at += n;
    onPacked(n);
    return piece;
  };
  if (coder.method === 'copy') {
    for (let piece = more(); piece; piece = more()) sink(piece);
  } else if (coder.method === 'lzma2') {
    const p = coder.props[0];
    if (p > 40) throw new SevenZipError('Bad LZMA2 properties in the archive.');
    const dict = p === 40 ? 0xffffffff : (2 | (p & 1)) * 2 ** (Math.floor(p / 2) + 11);
    const dec = lzma2Decoder(Math.min(dict, Math.max(outSize, 4096)), sink);
    let ended = false;
    for (let piece = more(); piece && !ended; piece = more()) ended = dec.write(piece);
    dec.end();
  } else if (coder.method === 'lzma') {
    lzmaDecode(coder.props, more() || new Uint8Array(0), outSize, sink, more);
  } else if (coder.method === 'aes') {
    throw new SevenZipError('The archive is encrypted.');
  } else throw new SevenZipError(`The archive uses ${coder.method}, which this app cannot unpack.`);
}

/** Opens an archive and reads its file list: { files: [{ name, size, crc, dir }], ... }. Close it with close(). */
export function open7z(path) {
  const fd = openSync(path, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    const head = readAt(fd, 0, Math.min(32, fileSize));
    if (head.length < SIGNATURE.length || !SIGNATURE.every((b, k) => head[k] === b)) throw new SevenZipError('This is not a 7z archive.');
    if (head.length < 32) throw new SevenZipError('The archive is incomplete (the download may have stopped early).');
    const start = head;
    if (crc32(start.subarray(12, 32)) !== start.readUInt32LE(8)) throw new SevenZipError('The archive is damaged (start header).');
    const nextOffset = Number(start.readBigUInt64LE(12));
    const nextSize = Number(start.readBigUInt64LE(20));
    const nextCrc = start.readUInt32LE(28);
    if (32 + nextOffset + nextSize > fileSize) throw new SevenZipError('The archive is incomplete (the download may have stopped early).');
    let headerBuf = readAt(fd, 32 + nextOffset, nextSize);
    if (crc32(headerBuf) !== nextCrc) throw new SevenZipError('The archive is damaged (header).');
    let r = new Bytes(headerBuf);
    let id = r.number();
    while (id === K.EncodedHeader) {
      const info = readStreamsInfo(r);
      const folder = info.folders[0];
      const parts = [];
      decodeFolder(fd, folder, 32 + info.pack.packPos, info.pack.sizes[0], b => parts.push(Buffer.from(b)));
      headerBuf = Buffer.concat(parts);
      if (folder.crc != null && crc32(headerBuf) !== folder.crc) throw new SevenZipError('The archive is damaged (packed header).');
      r = new Bytes(headerBuf);
      id = r.number();
    }
    if (id !== K.Header) throw new SevenZipError('The archive header is not readable.');
    const header = readHeader(r);
    // assign the streams to the files: files without a stream are folders or empty files
    const main = header.main || { pack: { packPos: 0, sizes: [] }, folders: [], sub: { counts: [], sizes: [], crcs: [] } };
    const streams = [];
    let packPos = 32 + (main.pack?.packPos || 0);
    main.folders.forEach((folder, k) => {
      const packSize = main.pack.sizes[k] ?? 0;
      folder.packStart = packPos;
      folder.packSize = packSize;
      packPos += packSize;
    });
    let s = 0;
    main.folders.forEach((folder, k) => {
      for (let j = 0; j < main.sub.counts[k]; j++, s++) streams.push({ folder: k, size: main.sub.sizes[s], crc: main.sub.crcs[s] });
    });
    let next = 0;
    const files = header.files.map(f => {
      const dir = f.emptyStream && !f.emptyFile ? true : f.attributes != null && (f.attributes & 0x10) !== 0;
      if (f.emptyStream) return { name: f.name, size: 0, crc: null, dir, stream: -1 };
      const st = streams[next];
      if (!st) throw new SevenZipError('The archive lists more files than it holds.');
      return { name: f.name, size: st.size, crc: st.crc, dir: false, stream: next++ };
    });
    return { fd, files, folders: main.folders, streams, close: () => closeSync(fd) };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/**
 * Extracts the files for which `target(file)` returns an output path (others are skipped but still decoded when they
 * share a solid block). `onProgress(doneBytes, totalBytes)` reports the unpacked bytes. Checks each file's CRC.
 * `isCancelled()` may stop the work (it throws).
 */
export function extract7z(path, target, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const archive = open7z(path);
  const outputs = [];
  try {
    const byStream = new Map(archive.files.filter(f => f.stream >= 0).map(f => [f.stream, f]));
    const wanted = new Map();
    for (const f of archive.files) {
      if (f.stream < 0) continue;
      const out = target(f);
      if (out) wanted.set(f.stream, out);
    }
    // empty files have no stream: they are just created
    for (const f of archive.files) {
      if (f.dir || f.stream >= 0) continue;
      const out = target(f);
      if (out) {
        closeSync(openSync(out, 'w'));
        outputs.push(out);
      }
    }
    const folders = new Set([...wanted.keys()].map(s => archive.streams[s].folder));
    const total = [...folders].reduce((n, k) => n + folderSize(archive.folders[k]), 0);
    let done = 0;
    let lastReport = 0;
    for (const k of [...folders].sort((a, b) => a - b)) {
      const folder = archive.folders[k];
      const own = [];
      archive.streams.forEach((st, idx) => st.folder === k && own.push(idx));
      let si = 0;
      let s = own[0];
      let left = archive.streams[s].size;
      let crc = 0;
      let fd = -1;
      const open = () => {
        const out = wanted.get(s);
        fd = out ? openSync(out, 'w') : -1;
        if (out) outputs.push(out);
        crc = 0;
      };
      const close = () => {
        if (fd >= 0) closeSync(fd);
        fd = -1;
        const st = archive.streams[s];
        if (wanted.has(s) && st.crc != null && crc >>> 0 !== st.crc) throw new SevenZipError(`${byStream.get(s)?.name} is damaged in the archive (CRC).`);
      };
      const advance = () => {
        close();
        if (++si >= own.length) throw new SevenZipError('The archive holds more data than it lists.');
        s = own[si];
        left = archive.streams[s].size;
        open();
      };
      open();
      decodeFolder(archive.fd, folder, folder.packStart, folder.packSize, bytes => {
        let off = 0;
        while (off < bytes.length) {
          if (left === 0) {
            advance();
            continue;
          }
          const n = Math.min(left, bytes.length - off);
          const part = bytes.subarray(off, off + n);
          if (wanted.has(s)) {
            crc = crc32(part, crc);
            let w = 0;
            while (w < part.length) w += writeSync(fd, part, w, part.length - w);
          }
          left -= n;
          off += n;
        }
        done += bytes.length;
        if (done - lastReport >= 8 << 20) {
          lastReport = done;
          if (isCancelled()) throw new SevenZipError('cancelled');
          onProgress(done, total);
        }
      });
      if (left !== 0) throw new SevenZipError('The archive is cut short.');
      close();
      while (++si < own.length) {
        s = own[si];
        if (archive.streams[s].size !== 0) throw new SevenZipError('The archive is cut short.');
        open();
        close();
      }
    }
    onProgress(total, total);
    return [...wanted.values()];
  } catch (e) {
    e.outputs = outputs;
    throw e;
  } finally {
    archive.close();
  }
}
