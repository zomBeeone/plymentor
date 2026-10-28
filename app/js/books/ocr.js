// Reading scanned pages (Book reader): Tesseract (the OCR engine, Apache-2.0) through Tesseract.js, with its English
// model — all served by the app (scripts/build.mjs copies them to /ocr/), loaded the first time a book has a scanned
// page. The recognition runs in Tesseract.js's workers; this turns what they read into the page's text, a word per span.

// (the core named — no other is looked for —, its .wasm next to it)
const FILES = { workerPath: '/ocr/worker.min.js', corePath: '/ocr/tesseract-core-simd-lstm.js', langPath: '/ocr' };
let lib = null;

/** A Tesseract worker for English (`files`: where its parts are; `Tesseract`: the library, the app's by default). */
export async function ocrWorker({ files = FILES, Tesseract = null } = {}) {
  if (!Tesseract) {
    const url = '/ocr/tesseract.mjs'; // (not bundled: only scanned books need it)
    lib ||= (await import(url)).default;
    Tesseract = lib;
  }
  const worker = await Tesseract.createWorker('eng', 1, { ...files, gzip: true, cacheMethod: 'none', workerBlobURL: false });
  await worker.setParameters({ user_defined_dpi: '300' });
  return worker;
}

const share = v => Math.round(v * 10000) / 10000;

/**
 * A scanned page's text from what Tesseract read in its picture (width × height pixels; its blocks of paragraphs of
 * lines of words, in reading order): { text, items: [{ start, end, box }] — a word each, box: [x0, y0, x1, y1] as shares
 * of the page —, diagrams: [{ at, box, board }] for the `boards` found in the picture ({ x, y, width, height, board }:
 * each goes before the first line under it) }. Lines are joined by a line break, paragraphs by a blank line. Left out: specks
 * read as letters, the running head and the page number, a scanner's mark ("Digitized by Google") and a diagram's
 * labels ("WHITE", "BLACK").
 */
export function ocrText(data, { width, height, boards = [] }) {
  const lines = [];
  for (const block of data.blocks || [])
    for (const par of block.paragraphs || []) {
      let first = true;
      for (const line of par.lines || []) {
        // (without the page's edge or a fold read as a bar or a quote)
        const words = (line.words || []).filter(w => w.text?.trim() && !/^[|¦‘’'`]+$/.test(w.text.trim()));
        const s = words.map(w => w.text.trim()).join(' ');
        const signs = (s.match(/[\p{L}\p{N}]/gu) || []).length;
        // (specks read as a letter or two)
        if (!signs || (signs < 3 && !/\d/.test(s))) continue;
        const confidence = words.reduce((n, w) => n + (w.confidence || 0), 0) / words.length;
        if (signs < 4 && confidence < 50) continue;
        lines.push({ words, box: line.bbox, par: first, text: s });
        first = false;
      }
    }
  const heights = lines.flatMap(l => l.words.map(w => w.bbox.y1 - w.bbox.y0)).sort((a, b) => a - b);
  const lh = heights.length ? heights[heights.length >> 1] : height / 60;
  const byBoard = l => boards.some(b => l.box.x1 > b.x && l.box.x0 < b.x + b.width && l.box.y1 > b.y - lh * 3 && l.box.y0 < b.y + b.height + lh * 3);
  const top = Math.min(...lines.map(l => l.box.y0));
  const bottom = Math.max(...lines.map(l => l.box.y1));
  const kept = lines.filter(l => {
    const s = l.text;
    if (/\bdigiti[sz]ed\s+by\b/i.test(s)) return false;
    // the running head: the page's top line, its number and a title in capitals ("12 THE CHESS PRIMER.")
    const letters = s.match(/\p{L}/gu) || [];
    const capitals = letters.filter(c => c !== c.toLowerCase()).length;
    const head = l.box.y0 <= top + lh * 0.5 && l.box.y1 < height * 0.25 && s.length < 70;
    if (head && /^\W*\d{1,4}\b|\b\d{1,4}\W*$/.test(s) && /\p{Lu}{3}/u.test(s) && capitals >= letters.length * 0.8) return false;
    // the page number at the foot
    if (l.box.y1 >= bottom - lh * 0.5 && l.box.y0 > height * 0.85 && /^[\divxlc\s.\-–—]{1,8}$/i.test(s)) return false;
    if (byBoard(l) && /^(?:white|black)[.:,]?$/i.test(s)) return false;
    return true;
  });
  let text = '';
  const items = [];
  for (const l of kept) {
    if (text) text += l.par ? '\n\n' : '\n';
    l.start = text.length;
    l.words.forEach((w, k) => {
      if (k) text += ' ';
      const start = text.length;
      text += w.text.trim();
      items.push({ start, end: text.length, box: [share(w.bbox.x0 / width), share(w.bbox.y0 / height), share(w.bbox.x1 / width), share(w.bbox.y1 / height)] });
    });
  }
  const diagrams = boards
    .map(b => {
      const under = kept.find(l => l.box.y0 >= b.y + b.height - lh && l.box.x1 > b.x && l.box.x0 < b.x + b.width);
      return { at: under ? under.start : text.length, box: [share(b.x / width), share(b.y / height), share((b.x + b.width) / width), share((b.y + b.height) / height)], board: b.board };
    })
    .sort((a, b) => a.at - b.at);
  return { text, items, diagrams };
}
