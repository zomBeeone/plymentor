// Scanned pages (Book reader): a page without text is drawn at 300 dpi; its boards are found in the picture (by the
// reader's worker, books/worker.js: away from the window) and blanked out, then Tesseract reads its words (ocr.js).
// An EPUB's pictures are looked at for a board too. The boards of a book are read together: its pieces look the same
// throughout, so each board helps read the others (diagrams.js).
import { renderPage } from './pdf.js';
import { ocrWorker, ocrText } from './ocr.js';
import { grayFrom } from './diagrams.js';

let glyphs = null;

/**
 * The app's own pieces (the Merida and cburnett sets) each drawn alone on a light square: the pieces to read a book's
 * boards by until the book's own teach better (see readBoards).
 */
function pieceGlyphs() {
  glyphs ||= (async () => {
    const S = 64;
    const out = [];
    for (const set of ['merida', 'cburnett'])
      for (const t of ['P', 'N', 'B', 'R', 'Q', 'K']) {
        const img = new Image();
        img.src = `/assets/piece/${set}/w${t}.svg`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = S;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, S, S);
        ctx.drawImage(img, 0, 0, S, S);
        out.push({ type: t.toLowerCase(), ...grayFrom(ctx.getImageData(0, 0, S, S).data, S, S) });
      }
    return out;
  })().catch(e => {
    console.warn('the pieces to read diagrams by could not be drawn:', e);
    return [];
  });
  return glyphs;
}

export class Scanner {
  constructor(doc) {
    this.doc = doc;
    this.worker = null;
    this.calls = new Map();
    this.ids = 0;
    this.ocr = []; // per lane: a Tesseract worker (a promise)
    // two pages at a time on a computer with cores to spare
    this.lanes = (navigator.hardwareConcurrency || 4) >= 8 ? 2 : 1;
  }

  call(msg, transfer = []) {
    if (!this.worker) {
      this.worker = new Worker('/js/bookscan.js', { type: 'module', name: 'plymentor-books' });
      this.worker.onmessage = e => {
        const c = this.calls.get(e.data.id);
        this.calls.delete(e.data.id);
        if (e.data.error) c?.reject(new Error(e.data.error));
        else c?.resolve(e.data);
      };
      this.worker.onerror = e => {
        for (const c of this.calls.values()) c.reject(new Error(e.message || 'the diagram reader stopped'));
        this.calls.clear();
      };
    }
    const id = ++this.ids;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /**
   * Scans page `n` (from 1) on `lane`: its boards, and its words when `ocr` (not for a page with its own text) — the
   * boards in its pictures shaped like diagrams (`figures`, boxes as shares of the page: pdf.js readPageText), and
   * hatched ones anywhere on it when `whole` (a scan, a large picture). A page with only figures is drawn at 200 dpi.
   * Returns { text, items, diagrams: [{ at, box, board (what is on its squares, to read with the book's others) }] }.
   */
  async page(n, lane = 0, { ocr = true, figures = null, whole = true } = {}) {
    const canvas = await renderPage(this.doc, n, { dpi: whole || ocr ? 300 : 200 });
    try {
      const { width, height } = canvas;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const { boards } = await this.call({ op: 'find', rgba: rgba.buffer, width, height, figures: figures || [], whole }, [rgba.buffer]);
      // (the boards blanked out: their pieces are read as letters otherwise)
      ctx.fillStyle = '#fff';
      for (const b of boards) {
        const m = b.width * 0.06;
        ctx.fillRect(b.x - m, b.y - m, b.width + 2 * m, b.height + 2 * m);
      }
      if (!ocr) return ocrText({ blocks: [] }, { width, height, boards });
      const worker = await (this.ocr[lane] ||= ocrWorker());
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      return ocrText(data, { width, height, boards });
    } finally {
      canvas.width = canvas.height = 0; // (a page at 300 dpi is big)
    }
  }

  /**
   * The board in a picture of its own (an EPUB's: a decoded image), kept as page() keeps a page's — or null when it
   * shows none. (A big picture is looked at 1200 pixels at most: a diagram's squares are large enough then.)
   */
  async picture(image) {
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (Math.min(w, h) < 96 || Math.max(w, h) > Math.min(w, h) * 1.6) return null;
    const scale = Math.min(1, 1200 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return (await this.call({ op: 'picture', rgba: rgba.buffer, width: canvas.width, height: canvas.height }, [rgba.buffer])).board;
  }

  /** Reads the boards of a book (all of them found so far, as page() gave them): [{ placement, sure, alts }]. */
  async read(boards) {
    return (await this.call({ op: 'read', boards, glyphs: await pieceGlyphs() })).readings;
  }

  close() {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.ocr) w?.then(x => x.terminate()).catch(() => {});
    this.ocr = [];
  }
}
