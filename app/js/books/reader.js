// A book opened in the Book reader, and reading it aloud.
// - The book's units — a PDF's pages, an EPUB's chapters — are read one after the other in the background (a PDF's
//   text once: it is kept for the next time), each with its moves, its sentences, its diagrams and what the voice says
//   for them (text.js); the moves are followed through the whole book as they come (moves.js). A scanned page has its
//   text read by OCR and its boards found in its picture (scan.js): slow, so the page being read goes first.
// - A reading goes through the parts of the sentences (voice.js says them: a part ends with a move, which the board
//   plays once it has been said), from any sentence, at a speed, until it is paused, the book ends or the coach talks.
import { findMoves, findSentences, spokenParts } from './text.js';
import { BookMoves } from './moves.js';
import { openEpub } from './epub.js';
import { openPdf, closePdf, readPageText, pageBoxes, pdfVersion } from './pdf.js';
import { Scanner } from './scan.js';
import { bookFile, loadCache, saveCache } from './library.js';
import { startReading, prepareReading, cancelReading, readAloud, stopSpeaking } from '../voice.js';

const TEXT_CACHE = 4; // the version of what is kept of a PDF's pages (pdf.js's version goes with it)
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

function makeUnit(index, title, text, more, { readings = !!more?.ocr } = {}) {
  const moves = findMoves(text, { ocr: readings });
  return { index, title, text, moves, sentences: findSentences(text, moves), diagrams: [], ...more };
}

/**
 * A PDF page (as kept: its text, items and diagrams) as a unit; its diagrams are copies: the reading follows them. Its
 * moves are read as a scan's may be written (text.js: ocrMoves) — the text of many PDFs is a scanner's OCR.
 */
function pageUnit(u, page) {
  const diagrams = (page.diagrams || []).map((d, k) => ({ at: d.at, placement: d.placement || null, side: d.side || null, font: !!d.font, sure: d.sure, alts: d.alts, box: d.box, kind: 'diagram', unit: u, index: k }));
  return makeUnit(u, `Page ${u + 1}`, page.text, { items: page.items, diagrams, ocr: !!(page.scan && page.scanned) }, { readings: true });
}

class Book {
  constructor(meta, count) {
    this.meta = meta;
    this.format = meta.format;
    this.lang = String(meta.language || 'en').slice(0, 2).toLowerCase();
    this.count = count;
    this.units = new Array(count);
    this.loaded = 0;
    this.last = -1; // the last unit added: the next one goes on with its moves (another starts a run of its own)
    this.focus = 0; // the unit the student is at (the scanned pages are read from there)
    this.scanning = null; // { done, total } while scanned pages are read
    this.moves = new BookMoves();
    this.closed = false;
    this.error = null;
    this.listeners = new Set();
  }

  add(unit) {
    if (unit.index !== this.last + 1) this.moves = new BookMoves();
    this.track(unit);
    this.last = unit.index;
    if (!this.units[unit.index]) this.loaded++;
    this.units[unit.index] = unit;
    this.emit();
  }

  track(unit) {
    this.moves.follow(unit);
    // what the voice says: a part ends with each move the board plays (not a move only said again), and with each
    // diagram it shows
    for (const s of unit.sentences) s.parts = spokenParts(unit.text, s, unit.moves, m => !!m.node && !m.restated, unit.diagrams);
  }

  /** Follows the moves of the whole book again (the reading of a diagram changed), a few units at a time. */
  async retrack() {
    let last = -2;
    let n = 0;
    for (const unit of this.units) {
      if (this.closed) return;
      if (!unit) continue;
      if (unit.index !== last + 1) this.moves = new BookMoves();
      this.track(unit);
      last = unit.index;
      if (++n % 25 === 0) await pause(); // (a big book takes seconds: the window goes on meanwhile)
    }
    this.last = last;
    this.emit();
  }

  emit() {
    for (const fn of [...this.listeners]) fn();
  }

  /** Resolves once unit `i` is there (or the book was closed). */
  unit(i) {
    if (this.units[i] || this.closed) return Promise.resolve(this.units[i]);
    return new Promise(resolve => {
      const fn = () => (this.units[i] || this.closed || this.error) && (this.listeners.delete(fn), resolve(this.units[i]));
      this.listeners.add(fn);
    });
  }

  /**
   * The position on the board at `offset` of unit `u`: after the last move of the line read before it, or the last
   * diagram before it (or null).
   */
  nodeAt(u, offset = Infinity) {
    for (let i = u; i >= 0; i--) {
      const unit = this.units[i];
      if (!unit) continue;
      let best = null;
      let at = -1;
      for (const m of unit.moves) if ((i < u || m.end <= offset) && m.node && !m.shown && !m.restated && m.end > at) (best = m), (at = m.end);
      for (const d of unit.diagrams) if ((i < u || d.at <= offset) && d.node && d.at >= at) (best = d), (at = d.at);
      if (best) return best;
    }
    return null;
  }

  close() {
    this.closed = true;
    this.emit();
    this.scanner?.close();
    this.flush?.();
    closePdf(this.doc);
    this.epub?.close();
  }
}

const PICTURES = 1; // the version of what is kept of an EPUB's pictures

/** A FEN in a picture's description (its alt text): { placement, side ('w', 'b' or null) } or null. */
function fenIn(alt) {
  const m = /(?:^|[\s:])((?:[pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8})(?:\s+([wb])\b)?/.exec(alt || '');
  const eight = rank => [...rank].reduce((n, c) => n + (/\d/.test(c) ? Number(c) : 1), 0) === 8;
  return m && m[1].split('/').every(eight) ? { placement: m[1], side: m[2] || null } : null;
}

/**
 * The diagrams in an EPUB's pictures: a picture that shows a board (found by the reader's worker: diagrams.js
 * findPictureBoard) — or that a FEN describes — is a diagram at its place in its chapter's text. The book's boards are
 * read together, as a scanned book's are; what each picture shows and how it was read are kept (`<id>.text.json`), not
 * to look at it nor read the boards again the next time.
 */
class EpubDiagrams {
  constructor(book) {
    this.book = book;
    this.scanner = book.scanner = new Scanner(null);
    this.kept = {}; // path → the board in the picture (packed), or 0: none
    this.readings = {}; // path → the last reading of its board ({ placement, sure, alts })
    this.boards = new Map(); // path → { board, diagrams (its diagrams in the chapters: a picture may come twice), reading }
    this.unread = 0; // boards found since the boards were last read (none read before)
    this.dirty = false;
    book.flush = () => this.save();
  }

  async load() {
    const cache = await loadCache(this.book.meta.id).catch(() => null);
    if (cache?.version !== `epub/${PICTURES}`) return;
    this.kept = cache.pictures || {};
    this.readings = cache.readings || {};
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    return saveCache(this.book.meta.id, { version: `epub/${PICTURES}`, pictures: this.kept, readings: this.readings }).catch(() => {});
  }

  /** The diagrams of chapter `u` among its blocks (a picture that is one gets .diagram: the diagram's index). */
  async find(u, blocks) {
    const out = [];
    for (const b of blocks) {
      if (b.kind !== 'img' || this.book.closed) continue;
      const fen = fenIn(b.alt);
      let board = null;
      if (!fen) {
        board = this.kept[b.path];
        if (board === undefined) {
          board = this.kept[b.path] = (await this.look(b.path)) || 0;
          this.dirty = true;
        }
        if (!board) continue;
      }
      const d = { at: b.at, placement: fen?.placement || null, side: fen?.side || null, font: !!fen, sure: fen ? 1 : 0, alts: [], kind: 'diagram', unit: u, index: out.length };
      b.diagram = out.length;
      out.push(d);
      if (!board) continue;
      const known = this.boards.get(b.path);
      if (known) known.diagrams.push(d);
      else {
        // (read before, with the book's other boards: that reading until new boards come)
        const reading = this.readings[b.path] || null;
        this.boards.set(b.path, { board, diagrams: [d], reading });
        if (!reading) this.unread++;
      }
      const reading = this.boards.get(b.path).reading;
      if (reading) Object.assign(d, reading);
    }
    return out;
  }

  async look(path) {
    try {
      const image = new Image();
      image.src = await this.book.epub.image(path);
      await image.decode();
      return await this.scanner.picture(image);
    } catch (e) {
      console.warn(`the picture ${path} could not be looked at:`, e);
      return null;
    }
  }

  /**
   * Reads the book's boards again when new ones came — at the chapter the student is at, at the last one, or when a
   * good many came —; true when a diagram of another chapter than `u` (the one being added) shows another position.
   */
  async read(u, last) {
    const all = [...this.boards];
    if (!this.unread || this.book.closed || (!last && u !== this.book.focus && this.unread < Math.max(4, all.length * 0.25))) return false;
    this.unread = 0;
    const readings = await this.scanner.read(all.map(([, x]) => x.board));
    let changed = false;
    readings.forEach((r, i) => {
      const [path, x] = all[i];
      for (const d of x.diagrams) {
        if (d.unit !== u && d.placement !== r.placement) changed = true;
        Object.assign(d, r);
      }
      x.reading = this.readings[path] = r;
    });
    this.dirty = true;
    return changed;
  }

  async done() {
    this.scanner.close();
    if (this.book.scanner === this.scanner) this.book.scanner = null;
    if (!this.book.closed) await this.save();
  }
}

/** Opens a book of the library: its units come in the background (book.loaded of book.count; listen with book.listeners). */
export async function openBook(meta) {
  const file = await bookFile(meta);
  if (!file) throw new Error('The file of this book is missing: add the book again.');
  if (meta.format === 'epub') {
    const epub = await openEpub(file);
    const book = new Book(meta, epub.chapters.length);
    book.epub = epub;
    book.titles = epub.chapters.map(c => c.title);
    (async () => {
      const pictures = new EpubDiagrams(book);
      await pictures.load();
      for (let i = 0; i < epub.chapters.length && !book.closed; i++) {
        const { blocks } = await epub.chapter(i);
        // the chapter's text: its blocks one after the other, a blank line between them
        let text = '';
        for (const b of blocks) {
          if (b.kind === 'img') {
            b.at = text.length;
            continue;
          }
          if (text) text += '\n\n';
          b.start = text.length;
          for (const r of b.runs) {
            r.start = text.length;
            text += r.text;
          }
          b.end = text.length;
        }
        const diagrams = await pictures.find(i, blocks);
        const changed = await pictures.read(i, i === epub.chapters.length - 1);
        if (book.closed) break;
        book.add(makeUnit(i, epub.chapters[i].title, text, { blocks, diagrams }));
        if (changed) await book.retrack();
      }
      await pictures.done();
    })().catch(e => ((book.error = e), book.emit()));
    return book;
  }
  const doc = await openPdf(await file.arrayBuffer());
  const book = new Book(meta, doc.numPages);
  book.doc = doc;
  (async () => {
    const version = `${TEXT_CACHE}/${pdfVersion()}`;
    const cache = await loadCache(meta.id);
    const pages = cache?.version === version && cache.pages?.length === doc.numPages ? cache.pages : new Array(doc.numPages).fill(null);
    // what is read of the pages is kept as it comes (a scanned book takes long), and when the book is closed
    let dirty = false;
    let savedAt = Date.now();
    const save = (now = false) => {
      dirty = true;
      if (!now && Date.now() - savedAt < 20000) return;
      dirty = false;
      savedAt = Date.now();
      return saveCache(meta.id, { version, pages }).catch(() => {});
    };
    book.flush = () => dirty && save(true);
    const scans = [];
    for (let n = 1; n <= doc.numPages && !book.closed; n++) {
      let page = pages[n - 1];
      if (!page) {
        page = pages[n - 1] = await readPageText(doc, n);
        dirty = true;
      }
      if ((page.scan || page.picture || page.figures) && !page.scanned) scans.push(n - 1);
      else book.add(pageUnit(n - 1, page));
      if (n % 25 === 0) await pause(); // (pages kept from before come all at once: the window goes on meanwhile)
    }
    if (dirty && !book.closed) await save(true);
    if (scans.length && !book.closed) await scanPages(book, pages, scans, save);
  })().catch(e => ((book.error = e), book.emit()));
  return book;
}

/**
 * Reads the scanned pages of a PDF (and the pictures of pages that have text: they may be scans with their text, or
 * diagrams): the page being read first, then the ones after it, then the rest. The boards found in them are read with
 * the book's other boards each time new ones come — a better reading of a board already passed follows the book's
 * moves again.
 */
async function scanPages(book, pages, todo, save) {
  const scanner = (book.scanner = new Scanner(book.doc));
  const pending = new Set(todo);
  book.scanning = { done: 0, total: todo.length };
  const boards = []; // the boards found in pictures: { u, k (the page's diagram), board }
  pages.forEach((p, u) => p?.diagrams?.forEach((d, k) => d.board && boards.push({ u, k, board: d.board })));
  const take = () => {
    let best = null;
    for (const u of pending) if (u >= book.focus && (best === null || u < best)) best = u;
    if (best === null) for (const u of pending) if (best === null || u < best) best = u;
    pending.delete(best);
    return best;
  };
  let read = 0;
  try {
    while (pending.size && !book.closed) {
      const batch = [];
      while (batch.length < scanner.lanes && pending.size) batch.push(take());
      const results = await Promise.all(
        batch.map((u, lane) =>
          scanner.page(u + 1, lane, { ocr: !!pages[u].scan, figures: pages[u].figures, whole: !!(pages[u].scan || pages[u].picture) }).catch(e => {
            console.warn(`page ${u + 1} could not be scanned:`, e);
            return null;
          }),
        ),
      );
      if (book.closed) break;
      if (!read && results.every(r => !r) && book.scanning.done + batch.length >= 3) throw new Error('The scanned pages cannot be read on this computer.');
      let found = false;
      for (const [i, u] of batch.entries()) {
        const r = results[i];
        const page = pages[u];
        if (!r) continue; // (read without its scan this time: it is tried again the next time the book is opened)
        read++;
        if (page.scan) Object.assign(page, { text: r.text, items: r.items, diagrams: r.diagrams });
        else if (r.diagrams.length) {
          // a page with text: its boards go before the first line of text under them
          const items = await pageBoxes(book.doc, u + 1);
          for (const d of r.diagrams) d.at = items.find(it => it.box && it.box[1] >= d.box[3] - 0.01 && it.box[0] < d.box[2] && it.box[2] > d.box[0])?.start ?? page.text.length;
          page.diagrams = [...(page.diagrams || []), ...r.diagrams].sort((a, b) => a.at - b.at);
        }
        page.scanned = true;
        page.diagrams?.forEach((d, k) => d.board && !boards.some(b => b.u === u && b.k === k) && (boards.push({ u, k, board: d.board }), (found = true)));
      }
      // the book's boards, read again with the new ones
      let changed = false;
      if (found) {
        const readings = await scanner.read(boards.map(b => b.board));
        readings.forEach((r, i) => {
          const { u, k } = boards[i];
          const d = pages[u].diagrams[k];
          const moved = d.placement !== r.placement;
          Object.assign(d, r);
          const ud = book.units[u]?.diagrams[k];
          if (ud && !batch.includes(u)) {
            Object.assign(ud, r);
            if (moved) changed = true; // (another position: the moves after it are followed again)
          }
        });
      }
      for (const [i, u] of batch.entries()) book.add(pageUnit(u, results[i] ? pages[u] : { ...pages[u], scanned: false }));
      if (changed) await book.retrack();
      book.scanning.done += batch.length;
      save();
      book.emit();
    }
  } finally {
    scanner.close();
    book.scanner = null;
    book.scanning = null;
    if (!book.closed) save(true);
    book.emit();
  }
}

// ---------------------------------------------------------------------------------------------
// Reading aloud

const AHEAD = 4; // parts the natural voice makes ahead of the one being read (and 600 characters at most)
const key = at => `${at.unit}/${at.sentence}/${at.part}`;

/**
 * The reading of a book: where it is (at: { unit, sentence, part }), whether it plays, its speed. onChange() after every
 * step; onMove(move) when the board should play a move (a move of the text, with .node). The natural voice makes the
 * parts ahead of the one being read, in the reading's order (audio): the next one is there when one ends — and, made
 * where the reading waits, the first one when ▶ is pressed.
 */
export class Reading {
  constructor(book, { at, onChange, onMove }) {
    this.book = book;
    this.at = at || { unit: 0, sentence: 0, part: 0 };
    this.playing = false;
    this.speed = 1;
    this.run = 0;
    this.onChange = onChange;
    this.onMove = onMove;
    this.audio = new Map(); // key(at) → { speed, text, prepared (prepareReading's) }
  }

  /** The places of the parts with something to say from `at` on (at included), `n` at most, in the units there. */
  coming(at, n) {
    const out = [];
    for (let p = at, steps = 0; p && out.length < n && steps < 200 && this.book.units[p.unit]; p = this.after(p), steps++) if (this.partAt(p)?.text) out.push(p);
    return out;
  }

  /**
   * Has the natural voice make the parts from `at` on in advance (AHEAD of them, `n`), in the reading's order: a part
   * missing before others makes them again after it; the parts made for other places, or at another speed, go.
   */
  prefetch(at, n = AHEAD) {
    const want = new Set();
    let chars = 0;
    let missing = false;
    for (const p of this.coming(at, n)) {
      const k = key(p);
      const text = this.partAt(p).text;
      const have = this.audio.get(k);
      // (the book followed again may have changed what a part says)
      if (have && (have.speed !== this.speed || have.text !== text || (missing && !have.prepared.done))) {
        cancelReading(have.prepared);
        this.audio.delete(k);
      }
      if (!this.audio.has(k)) {
        const prepared = prepareReading(text, { speed: this.speed, lang: this.book.lang });
        if (!prepared) return; // (the system voice: nothing is made in advance)
        this.audio.set(k, { speed: this.speed, text, prepared });
        missing = true;
      }
      want.add(k);
      if ((chars += text.length) > 600) break;
    }
    for (const [k, a] of this.audio)
      if (!want.has(k)) {
        cancelReading(a.prepared);
        this.audio.delete(k);
      }
  }

  /** The parts being made but not made yet are not made (the reading stops: the voice is free for the coach). */
  release() {
    for (const [k, a] of this.audio)
      if (!a.prepared.done) {
        cancelReading(a.prepared);
        this.audio.delete(k);
      }
  }

  /** Waiting at a place: the natural voice makes its first part, for ▶. */
  warm() {
    if (this.playing) return;
    const at = this.at;
    this.book.unit(at.unit).then(() => !this.playing && this.at === at && this.prefetch(at, 1));
  }

  /** The book closes. */
  dispose() {
    this.pause();
    for (const a of this.audio.values()) cancelReading(a.prepared);
    this.audio.clear();
  }

  partAt(at) {
    return this.book.units[at.unit]?.sentences[at.sentence]?.parts[at.part] || null;
  }

  /** The place after `at` (the next part, sentence or unit), or null at the end of the book. */
  after({ unit, sentence, part }) {
    const u = this.book.units[unit];
    const s = u?.sentences[sentence];
    if (s && part + 1 < s.parts.length) return { unit, sentence, part: part + 1 };
    if (u && sentence + 1 < u.sentences.length) return { unit, sentence: sentence + 1, part: 0 };
    if (unit + 1 < this.book.count) return { unit: unit + 1, sentence: 0, part: 0 };
    return null;
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.loop(++this.run);
    this.onChange();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.run++;
    stopSpeaking();
    this.release();
    this.onChange();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Goes to a place (and goes on reading from there if it was reading). */
  seek(at) {
    const playing = this.playing;
    if (playing) this.pause();
    this.at = { unit: at.unit, sentence: at.sentence || 0, part: at.part || 0 };
    this.onChange();
    if (playing) this.play();
    else this.warm();
  }

  /** The next or previous sentence (dir 1 or -1). */
  step(dir) {
    const { unit, sentence } = this.at;
    const u = this.book.units[unit];
    if (dir > 0) {
      if (u && sentence + 1 < u.sentences.length) this.seek({ unit, sentence: sentence + 1 });
      else if (unit + 1 < this.book.count) this.seek({ unit: unit + 1, sentence: 0 });
    } else if (sentence > 0) this.seek({ unit, sentence: sentence - 1 });
    else if (unit > 0) this.seek({ unit: unit - 1, sentence: Math.max(0, (this.book.units[unit - 1]?.sentences.length || 1) - 1) });
  }

  setSpeed(speed) {
    this.speed = speed;
    this.onChange();
  }

  async loop(run) {
    const reading = startReading();
    let first = true; // (the first part read starts at once; then a pause before each part — longer for a sentence)
    while (this.playing && run === this.run) {
      const unit = this.book.units[this.at.unit] || (await this.book.unit(this.at.unit));
      if (run !== this.run || !this.playing) break;
      if (!unit) {
        this.playing = false;
        this.onChange();
        break;
      }
      const part = this.partAt(this.at);
      if (!part) {
        const on = this.after(this.at);
        if (!on) {
          this.playing = false; // the end of the book
          this.onChange();
          break;
        }
        this.at = on;
        continue;
      }
      this.onChange();
      // the part's audio (taken: it is said now), the ones after it being made meanwhile
      this.prefetch(this.at);
      const made = this.audio.get(key(this.at));
      this.audio.delete(key(this.at));
      const next = this.after(this.at);
      if (next) this.prefetch(next);
      try {
        // (a part with nothing to say: a diagram at the start of a sentence)
        const pause = first ? 0 : this.at.part === 0 ? 0.35 : 0.2;
        if (part.text) await readAloud(part.text, { reading, speed: this.speed, lang: this.book.lang, prepared: made?.text === part.text ? made.prepared : null, pause });
        if (part.text) first = false;
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('reading aloud failed:', e);
        if (run === this.run && this.playing) {
          // stopped from outside (the coach talks), or no voice: paused
          this.playing = false;
          this.release();
          this.onChange();
        }
        break;
      }
      if (run !== this.run || !this.playing) break;
      if (part.move !== null) this.onMove(unit.moves[part.move]);
      else if (part.diagram !== undefined) this.onMove(unit.diagrams[part.diagram]);
      const on = this.after(this.at);
      if (!on) {
        this.playing = false;
        this.onChange();
        break;
      }
      this.at = on;
    }
  }
}
