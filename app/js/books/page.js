// The page of the Book reader: a PDF page (its picture, with its text over it, transparent — a scanned page's words
// where the OCR found them) or an EPUB chapter laid out in pages (columns of the panel's size). Every sentence and move
// of the text is a span (data-s, data-m), and every diagram the reader found a box over it (data-d), so the sentence
// being read, the moves and the diagram on the board are marked, and a click says where.
import { drawPage } from './pdf.js';

/**
 * A move the page marks: one the board knows, or one with a move number or a piece (a lone "d5" may be a square; a word
 * read by OCR is a move only when the board knows it or it has a number).
 */
const marked = m => !!m.node || !!m.num || (!m.pawn && !m.ocr);

/** Fills `el` with the text of `unit` from `start` to `end`: a span per piece of a sentence (data-s) or a move (data-m). */
export function fillText(el, unit, start, end) {
  const cuts = new Set([start, end]);
  for (const s of unit.sentences) if (s.end > start && s.start < end) cuts.add(Math.max(s.start, start)).add(Math.min(s.end, end));
  for (const m of unit.moves) if (m.end > start && m.start < end && marked(m)) cuts.add(Math.max(m.start, start)).add(Math.min(m.end, end));
  const points = [...cuts].sort((a, b) => a - b);
  el.replaceChildren();
  let s = 0;
  let m = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const span = document.createElement('span');
    span.textContent = unit.text.slice(a, points[i + 1]);
    while (s < unit.sentences.length && unit.sentences[s].end <= a) s++;
    if (unit.sentences[s] && unit.sentences[s].start <= a) span.dataset.s = s;
    while (m < unit.moves.length && unit.moves[m].end <= a) m++;
    const move = unit.moves[m];
    if (move && move.start <= a && marked(move)) {
      span.dataset.m = m;
      span.className = move.node ? (move.shown ? 'bk-m shown' : 'bk-m') : 'bk-m unknown';
    }
    el.append(span);
  }
}

class Page {
  /** handlers: onSentence(unit, i), onMove(unit, i), onDiagram(unit, i), onTurn(dir), onPaged() (an EPUB page turned). */
  constructor(root, book, handlers) {
    this.root = root;
    this.book = book;
    this.handlers = handlers;
    this.unit = -1;
    this.mark = { at: null, now: null };
    this.onClick = e => {
      const diagram = e.target.closest?.('[data-d]');
      if (diagram && this.root.contains(diagram)) return this.handlers.onDiagram?.(this.unit, Number(diagram.dataset.d));
      const move = e.target.closest?.('[data-m]');
      const sentence = e.target.closest?.('[data-s]');
      if (move && this.root.contains(move)) return this.handlers.onMove(this.unit, Number(move.dataset.m));
      if (sentence && this.root.contains(sentence)) return this.handlers.onSentence(this.unit, Number(sentence.dataset.s));
      // a click in the page's left or right fifth turns the page
      const r = this.root.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      if (x < 0.2) this.handlers.onTurn(-1);
      else if (x > 0.8) this.handlers.onTurn(1);
    };
    root.addEventListener('click', this.onClick);
    this.resize = new ResizeObserver(() => this.resized());
    this.resize.observe(root);
  }

  destroy() {
    this.resize.disconnect();
    this.root.removeEventListener('click', this.onClick);
    this.root.replaceChildren();
  }

  /**
   * Marks the sentence being read (at.sentence), the move being said (now: its index in the unit's moves) and the
   * diagram the board shows (a diagram of a unit, or null); the page goes to the sentence when it is another one than
   * before (the student may look at other pages meanwhile).
   */
  highlight(at, now, diagram = null) {
    this.mark = { at, now, diagram };
    const unit = this.book.units[this.unit];
    for (const el of this.root.querySelectorAll('[data-d]')) {
      const d = unit?.diagrams[Number(el.dataset.d)];
      el.classList.toggle('unread', !d?.node);
      el.classList.toggle('bk-shown', !!d && d === diagram);
      el.title = d?.node ? 'Show this position on the board' : 'This diagram could not be read: click to set its position up';
    }
    if (at?.unit !== this.unit) return;
    for (const el of this.root.querySelectorAll('.bk-cur, .bk-now')) el.classList.remove('bk-cur', 'bk-now');
    const spans = this.root.querySelectorAll(`[data-s="${at.sentence}"]`);
    for (const el of spans) el.classList.add('bk-cur');
    if (now !== null && now !== undefined) for (const el of this.root.querySelectorAll(`[data-m="${now}"]`)) el.classList.add('bk-now');
    const key = `${at.unit}:${at.sentence}`;
    if (spans[0] && key !== this.revealed) this.reveal(spans[0]);
    this.revealed = key;
  }

  reveal() {}
  resized() {}

  /** Whether sentence `s` of the unit shown is on the page shown. */
  showsSentence() {
    return true;
  }
}

/** The zoom of a PDF page the student may choose: from 30% to 300% of the panel's width. */
export const ZOOM = { min: 30, max: 300 };

/**
 * A PDF page: the whole page as large as fits (zoom 'page'), as wide as the panel ('width'), or a share of the panel's
 * width (a number, in %: ZOOM) — the last two scrolled with the reading. `percent`: the page's width as drawn, in % of the
 * panel's.
 */
export class PdfPage extends Page {
  constructor(root, book, handlers, { zoom = 'page' } = {}) {
    super(root, book, handlers);
    root.classList.add('bk-pdf');
    this.zoom = zoom;
    this.percent = null;
    this.classes();
    this.sheet = document.createElement('div');
    this.sheet.className = 'bk-sheet';
    this.canvas = document.createElement('canvas');
    this.layer = document.createElement('div');
    this.layer.className = 'textLayer';
    this.sheet.append(this.canvas, this.layer);
    root.append(this.sheet);
    this.drawn = 0;
    this.wanted = null; // the page and size drawn (or being drawn)
    this.drawing = null;
  }

  /** Shows unit `u` (page u + 1): its picture, and its text once it is there (a scanned page's after its OCR). */
  async show(u) {
    const unit = this.book.units[u];
    const want = `${u}@${this.root.clientWidth}x${this.root.clientHeight}/${this.zoom}/${unit ? 'text' : 'picture'}`;
    if (want === this.wanted) return; // (drawn, or being drawn)
    this.wanted = want;
    const n = ++this.drawn;
    // one drawing at a time on the canvas (pdf.js refuses two); a newer page asked for meanwhile is drawn instead
    await this.drawing;
    if (n !== this.drawn) return;
    this.drawing = this.draw(u, unit, n).catch(e => {
      this.wanted = null;
      console.warn('the page could not be drawn:', e);
    });
    await this.drawing;
  }

  async draw(u, unit, n) {
    const panel = Math.max(1, this.root.clientWidth - 24);
    const fit = typeof this.zoom === 'number' ? { width: (panel * this.zoom) / 100, height: Infinity } : { width: panel, height: this.zoom === 'width' ? Infinity : this.root.clientHeight - 16 };
    const layer = unit && !unit.ocr ? this.layer : null;
    const r = await drawPage(this.book.doc, u + 1, { canvas: this.canvas, layer, fit, cancelled: () => n !== this.drawn });
    if (!r) return;
    if (u !== this.unit) this.root.scrollTop = 0;
    this.revealed = null;
    this.unit = u;
    this.sheet.style.width = `${Math.floor(r.width)}px`;
    this.sheet.style.height = `${Math.floor(r.height)}px`;
    this.percent = Math.round((r.width / panel) * 100);
    // (a new zoom keeps the middle of what was in view in the middle)
    const a = this.anchor;
    this.anchor = null;
    if (a) {
      this.root.scrollLeft = a.x * r.width - this.root.clientWidth / 2;
      this.root.scrollTop = a.y * r.height - this.root.clientHeight / 2;
    }
    if (!layer) this.layer.replaceChildren();
    this.layer.classList.toggle('bk-ocr', !!unit?.ocr);
    if (unit?.ocr) ocrLayer(this.layer, unit, r.width, r.height);
    else if (unit)
      unit.items.forEach((item, i) => {
        const span = r.spans[i];
        if (!span) return;
        if (item.skip) span.textContent = ''; // (a row of a diagram set in a chess font)
        else if (item.end > item.start) fillText(span, unit, item.start, item.end);
      });
    this.drawDiagrams(unit);
    this.highlight(this.mark.at, this.mark.now, this.mark.diagram);
    this.handlers.onPaged?.(); // (the zoom shown: percent)
  }

  /** A box over each diagram of the page, to click. */
  drawDiagrams(unit) {
    this.boxes?.remove();
    this.boxes = null;
    if (!unit?.diagrams.some(d => d.box)) return;
    this.boxes = document.createElement('div');
    this.boxes.className = 'bk-diagrams';
    unit.diagrams.forEach((d, i) => {
      if (!d.box) return;
      const [x0, y0, x1, y1] = d.box;
      const el = document.createElement('div');
      el.className = 'bk-diagram';
      el.dataset.d = i;
      Object.assign(el.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
      this.boxes.append(el);
    });
    this.sheet.append(this.boxes);
  }

  resized() {
    if (this.unit >= 0) this.show(this.unit);
  }

  classes() {
    this.root.classList.toggle('bk-wide', this.zoom === 'width');
    this.root.classList.toggle('bk-zoom', typeof this.zoom === 'number');
  }

  setZoom(zoom) {
    if (zoom === this.zoom) return;
    const w = this.sheet.offsetWidth;
    const h = this.sheet.offsetHeight;
    // (the point in the middle of the panel, as a share of the page)
    if (w && h) this.anchor = { x: Math.min(1, (this.root.scrollLeft + this.root.clientWidth / 2 - this.sheet.offsetLeft) / w), y: Math.min(1, (this.root.scrollTop + this.root.clientHeight / 2 - this.sheet.offsetTop) / h) };
    this.zoom = zoom;
    this.classes();
    this.resized();
  }

  /** (zoomed in) The page scrolls so that the sentence being read is in view. */
  reveal(el) {
    const r = el.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    if (r.top < box.top + 30 || r.bottom > box.bottom - 30) this.root.scrollTop += r.top - box.top - box.height / 3;
    if (r.left < box.left + 8 || r.left > box.right - 40) this.root.scrollLeft += r.left - box.left - 24;
  }
}

let measure = null;

/**
 * A scanned page's words over its picture (width × height pixels), where its OCR found them: transparent text of the
 * word's height, stretched to its width.
 */
function ocrLayer(layer, unit, width, height) {
  measure ||= document.createElement('canvas').getContext('2d');
  layer.replaceChildren();
  layer.style.setProperty('--total-scale-factor', '1');
  for (const it of unit.items) {
    if (!it.box || it.end <= it.start) continue;
    const [x0, y0, x1, y1] = it.box;
    const h = Math.max(4, (y1 - y0) * height);
    const span = document.createElement('span');
    measure.font = `${h}px sans-serif`;
    const w = measure.measureText(unit.text.slice(it.start, it.end)).width;
    span.style.cssText = `left:${x0 * width}px;top:${y0 * height}px;--font-height:${h}px;--scale-x:${w ? ((x1 - x0) * width) / w : 1};font-family:sans-serif`;
    fillText(span, unit, it.start, it.end);
    layer.append(span);
  }
}

const GAP = 48; // between the columns (the pages) of an EPUB chapter
const TAGS = { h1: 'h2', h2: 'h3', h3: 'h4', h4: 'h5', quote: 'blockquote', pre: 'pre', caption: 'figcaption' };

/** An EPUB chapter, laid out in pages of the panel's size (within its margins); page: the one shown. */
export class EpubPage extends Page {
  constructor(root, book, handlers) {
    super(root, book, handlers);
    root.classList.add('bk-epub');
    this.box = document.createElement('div');
    this.box.className = 'bk-box';
    this.flow = document.createElement('div');
    this.flow.className = 'bk-flow';
    this.box.append(this.flow);
    root.append(this.box);
    this.page = 0;
    this.pages = 1;
  }

  async show(u, { page = null } = {}) {
    const unit = this.book.units[u];
    if (!unit) return;
    if (u !== this.unit) {
      this.unit = u;
      this.flow.replaceChildren(...unit.blocks.map(b => this.block(b, unit)));
      this.page = 0;
      this.layout();
      this.revealed = null;
      this.highlight(this.mark.at, this.mark.now, this.mark.diagram);
    }
    if (page !== null) this.turnTo(page === -1 ? this.pages - 1 : page);
  }

  block(b, unit) {
    if (b.kind === 'img') {
      const fig = document.createElement('figure');
      fig.className = 'bk-figure';
      const box = document.createElement('span');
      box.className = 'bk-figbox';
      const img = document.createElement('img');
      img.alt = b.alt || '';
      img.onload = () => this.layout();
      this.book.epub.image(b.path).then(url => (img.src = url), () => fig.remove());
      box.append(img);
      fig.append(box);
      // (a diagram: to click, and marked when the board shows it)
      if (b.diagram !== undefined) fig.dataset.d = b.diagram;
      return fig;
    }
    const el = document.createElement(TAGS[b.kind] || 'p');
    if (b.kind === 'li') el.className = 'bk-li';
    for (const r of b.runs) {
      let host = el;
      for (const k of ['b', 'i', 'sup', 'sub'])
        if (r[k]) {
          const m = document.createElement(k);
          host.append(m);
          host = m;
        }
      const span = document.createElement('span');
      host.append(span);
      fillText(span, unit, r.start, r.start + r.text.length);
    }
    return el;
  }

  get stride() {
    return this.box.clientWidth + GAP;
  }

  layout() {
    const w = this.box.clientWidth;
    const h = this.box.clientHeight;
    if (!w || !h) return;
    Object.assign(this.flow.style, { width: `${w}px`, height: `${h}px`, columnWidth: `${w}px`, columnGap: `${GAP}px` });
    this.pages = Math.max(1, Math.round((this.flow.scrollWidth + GAP) / this.stride));
    this.turnTo(Math.min(this.page, this.pages - 1));
  }

  resized() {
    this.layout();
    this.revealed = null; // (the pages changed: the sentence being read is on the page shown again)
    if (this.mark.at) this.highlight(this.mark.at, this.mark.now, this.mark.diagram);
  }

  turnTo(p) {
    this.page = Math.max(0, Math.min(p, this.pages - 1));
    this.flow.style.transform = `translateX(${-this.page * this.stride}px)`;
    this.handlers.onPaged?.();
  }

  pageOf(el) {
    return Math.floor((el.offsetLeft + 1) / this.stride);
  }

  reveal(el) {
    const p = this.pageOf(el);
    if (p !== this.page) this.turnTo(p);
  }

  /** The first sentence on the page shown (or null). */
  firstSentence() {
    for (const el of this.flow.querySelectorAll('[data-s]')) if (this.pageOf(el) >= this.page) return Number(el.dataset.s);
    return null;
  }

  showsSentence(s) {
    const el = this.flow.querySelector(`[data-s="${s}"]`);
    return !el || this.pageOf(el) === this.page;
  }
}
