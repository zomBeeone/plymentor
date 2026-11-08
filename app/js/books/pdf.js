// PDF books (Book reader), with pdf.js (Mozilla, Apache-2.0): it is loaded the first time a PDF is opened, renders the
// pages in its own worker, and gives each page's text. Never with eval (the window's security policy forbids it).
import { fontBoards } from './diagrams.js';
import { diagramNumber, namedAt } from './text.js';

let lib = null;

async function pdfjs() {
  if (!lib) {
    const url = '/js/pdf.mjs'; // (copied next to the bundles by scripts/build.mjs; not bundled: only the reader needs it)
    lib = await import(url);
    lib.GlobalWorkerOptions.workerSrc = '/js/pdf.worker.mjs';
  }
  return lib;
}

/** pdf.js's version (once a PDF was opened): the text the reader keeps of a PDF goes with it. */
export const pdfVersion = () => lib?.version || '';

/** Opens a PDF from its bytes (an ArrayBuffer, handed over to pdf.js). */
export async function openPdf(data) {
  const { getDocument } = await pdfjs();
  return getDocument({ data, isEvalSupported: false, enableXfa: false, useSystemFonts: true, wasmUrl: '/pdf/wasm/', iccUrl: '/pdf/iccs/' }).promise;
}

/** Closes a PDF (its pages, and the worker's copy). */
export function closePdf(doc) {
  doc?.loadingTask?.destroy().catch(() => {});
}

/** The title and author a PDF says it has. */
export async function pdfInfo(doc) {
  const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
  return { title: String(info?.Title || '').trim(), author: String(info?.Author || '').trim(), pages: doc.numPages };
}

/** The page (from 1) a bookmark of a PDF goes to, or null. */
async function destinationPage(doc, dest) {
  try {
    const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(d)) return null;
    return (typeof d[0] === 'number' ? d[0] : await doc.getPageIndex(d[0])) + 1;
  } catch {
    return null;
  }
}

/** A PDF's own table of contents, its bookmarks in order (three levels, `most` at most): [{ title, page, depth }]. */
export async function pdfOutline(doc, most = 200) {
  const out = [];
  const walk = async (items, depth) => {
    for (const it of items || []) {
      if (out.length >= most) return;
      out.push({ title: String(it.title || ''), page: await destinationPage(doc, it.dest), depth });
      if (depth < 2) await walk(it.items, depth + 1);
    }
  };
  await walk(await doc.getOutline().catch(() => null), 0);
  return out;
}

/**
 * A page's text as the reader reads it: the text items in their order, a line break after an item that ends a line:
 * { text, items: [{ start, end }], diagrams } — items[i] is the i-th span of the page's text layer. A board set in a
 * chess font is not read: it is a diagram at its place in the text ({ at, placement, side, font: true, box: where it
 * is on the page, [x0, y0, x1, y1] as shares of its width and height — with the page's `viewport` at scale 1 }).
 */
export function pageText(content, viewport = null) {
  const boards = fontBoards(content.items);
  const of = new Map();
  for (const b of boards) {
    for (const i of b.items) of.set(i, b);
    // (and the line ends between its rows)
    for (let i = Math.min(...b.rows); i < Math.max(...b.rows); i++) if (!of.has(i) && !content.items[i].str?.trim()) of.set(i, b);
  }
  let text = '';
  const items = [];
  const diagrams = [];
  const placed = new Set();
  content.items.forEach((it, i) => {
    if (it.str === undefined) return; // (marked content: no span)
    const b = of.get(i);
    if (b) {
      if (!placed.has(b)) {
        if (text && !text.endsWith('\n')) text += '\n';
        placed.add(b);
        diagrams.push({ at: text.length, placement: b.placement, side: b.side, font: true, box: viewport ? boxOn(viewport, b) : null, ...(b.label ? { label: b.label } : {}) });
      }
      items.push({ start: text.length, end: text.length, skip: true });
      return;
    }
    const start = text.length;
    text += it.str;
    items.push({ start, end: text.length });
    if (it.hasEOL) text += '\n';
  });
  return { text, items, diagrams };
}

function boxOn(viewport, b) {
  const [x0, y0] = viewport.convertToViewportPoint(b.x0, b.y0);
  const [x1, y1] = viewport.convertToViewportPoint(b.x1, b.y1);
  const r = v => Math.round(v * 10000) / 10000;
  return [r(Math.min(x0, x1) / viewport.width), r(Math.min(y0, y1) / viewport.height), r(Math.max(x0, x1) / viewport.width), r(Math.max(y0, y1) / viewport.height)];
}

/**
 * The text of page `n` (from 1), see pageText; .scan when the page has (almost) no text — a scanned page, read by OCR
 * (scan.js) —, .picture when it has text and a large picture (a scan with its text, or a picture of diagrams),
 * .figures when it has pictures shaped like a diagram (see pictureBoxes): where they are, to look for a board in each.
 */
export async function readPageText(doc, n) {
  const { OPS } = await pdfjs();
  const page = await doc.getPage(n);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const out = pageText(await page.getTextContent(), viewport);
    if ((out.text.match(/\p{L}/gu)?.length || 0) < 30) out.scan = true;
    else if (!out.diagrams.length) {
      const pictures = pictureBoxes(await page.getOperatorList(), OPS, viewport);
      if (pictures.some(p => p.w * p.h >= 800 * 800)) out.picture = true;
      const figures = diagramShaped(pictures, viewport);
      if (figures.length) out.figures = figures;
    }
    return out;
  } finally {
    page.cleanup();
  }
}

const multiply = (m, k) => [m[0] * k[0] + m[2] * k[1], m[1] * k[0] + m[3] * k[1], m[0] * k[2] + m[2] * k[3], m[1] * k[2] + m[3] * k[3], m[0] * k[4] + m[2] * k[5] + m[4], m[1] * k[4] + m[3] * k[5] + m[5]];

/**
 * Where a page draws its pictures, from its operator list (following the transformations, also of forms): [{ box:
 * [x0, y0, x1, y1] as shares of the page (`viewport` at scale 1), w, h (the picture's own pixels) }].
 */
export function pictureBoxes(ops, OPS, viewport) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const out = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const a = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(a?.[0]) && a[0].length === 6) ctm = multiply(ctm, a[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const w = fn === OPS.paintImageXObject ? a[1] : a[0]?.width;
      const h = fn === OPS.paintImageXObject ? a[2] : a[0]?.height;
      if (!(w > 0 && h > 0)) continue;
      // (a picture fills the unit square of its transformation)
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => viewport.convertToViewportPoint(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
      const xs = pts.map(p => p[0] / viewport.width);
      const ys = pts.map(p => p[1] / viewport.height);
      out.push({ box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], w, h });
    }
  }
  return out;
}

/**
 * The pictures (as pictureBoxes gives them) that may be diagrams: about square, from an eighth of the page's width to
 * most of it — pictures drawn in strips one under the other (some books cut their diagrams so) joined first. Returns
 * their boxes, rounded.
 */
export function diagramShaped(pictures, viewport) {
  const near = (a, b) => Math.abs(a - b) < 0.006;
  const boxes = pictures.filter(p => p.w >= 16 && p.h >= 8).map(p => [...p.box]);
  for (let joined = true; joined; ) {
    joined = false;
    for (let i = 0; i < boxes.length && !joined; i++)
      for (let j = 0; j < boxes.length && !joined; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (i === j || !near(a[0], b[0]) || !near(a[2], b[2]) || Math.abs(a[3] - b[1]) > 0.004) continue;
        boxes[i] = [Math.min(a[0], b[0]), a[1], Math.max(a[2], b[2]), b[3]];
        boxes.splice(j, 1);
        joined = true;
      }
  }
  const r = v => Math.round(v * 10000) / 10000;
  return boxes
    .filter(([x0, y0, x1, y1]) => {
      const w = (x1 - x0) * viewport.width;
      const h = (y1 - y0) * viewport.height;
      return w >= viewport.width * 0.12 && h >= viewport.width * 0.12 && w <= viewport.width * 0.95 && w / h > 0.7 && w / h < 1.45;
    })
    .map(b => b.map(r));
}

/** The items of page `n`'s text (as pageText gives them) with where each is: box [x0, y0, x1, y1], shares of the page. */
export async function pageBoxes(doc, n) {
  const page = await doc.getPage(n);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const { items } = pageText(content, viewport);
    let k = 0;
    for (const it of content.items) {
      if (it.str === undefined) continue;
      const item = items[k++];
      if (item.skip || !it.transform) continue;
      const [x, y] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      item.box = [x / viewport.width, (y - it.height) / viewport.height, (x + it.width) / viewport.width, y / viewport.height];
    }
    return items;
  } finally {
    page.cleanup();
  }
}

/**
 * A page's lines of words (`items` with boxes, `words(item)`: it has some): the items whose bottoms are level, cut where
 * a gap wider than 2% of the page parts them (columns side by side): [{ x0, x1, y: its middle }].
 */
function lines(items, words) {
  const out = [];
  for (const it of items.filter(words).sort((a, b) => a.box[3] - b.box[3] || a.box[0] - b.box[0])) {
    const l = out.find(l => Math.abs(l.bottom - it.box[3]) < 0.004 && it.box[0] - l.x1 < 0.02 && l.x0 - it.box[2] < 0.02);
    if (l) (l.x0 = Math.min(l.x0, it.box[0])), (l.x1 = Math.max(l.x1, it.box[2]));
    else out.push({ x0: it.box[0], x1: it.box[2], bottom: it.box[3], y: (it.box[1] + it.box[3]) / 2 });
  }
  return out;
}

/**
 * Where a board found in a picture of a page with text goes in that text (`items`: pageBoxes', of `text`; `box`: the
 * board's, as shares of the page): before the first line under it — its caption, maybe — or, set in the text with lines
 * beside it, before the first line level with it, whichever the text has first (a caption may be read in the middle of
 * the lines beside it); when its caption numbers it ("DIAGRAM 10.") and the page's text names it ("Look at Diagram 10
 * again: …"), where the text names it — the caption of a board beside the text may be read before those lines, or after
 * their moves, which are played from the board. { at, number: the one its caption gives it (words far after it may name
 * it: "Exercise 4 (Diagram 61): … 1...Rd2+"), caption: the caption's text when the board went where it is named (its
 * side to move goes with it: "DIAGRAM 7. White is to move"), else null }.
 */
export function boardAt(items, text, box) {
  const words = it => !!it.box && /\p{L}{2}/u.test(text.slice(it.start, it.end));
  const middle = it => (it.box[1] + it.box[3]) / 2;
  const under = items.find(it => it.box && it.box[1] >= box[3] - 0.01 && it.box[0] < box[2] && it.box[2] > box[0]);
  // (a line of words — not a coordinate — whose middle is level with the board, left or right of it: the board is set
  // in the text when a line right over or under it runs across it and the lines beside it — not in a column of its
  // own, with another column beside it, Zurich 1953's —; not the page's top line or its last, a running head or a foot)
  const beside = items.find(it => words(it) && (it.box[2] <= box[0] || it.box[0] >= box[2]) && middle(it) > box[1] && middle(it) < box[3]);
  const [left, right] = beside ? [Math.min(box[0], beside.box[0]), Math.max(box[2], beside.box[2])] : [];
  const near = l => (l.y > box[1] - 0.08 && l.y < box[1]) || (l.y > box[3] && l.y < box[3] + 0.08);
  const all = beside ? lines(items, words).sort((a, b) => a.y - b.y) : [];
  const set = all.slice(1, -1).some(l => near(l) && l.x0 < left + 0.03 && l.x1 > right - 0.03);
  const at = Math.min(under ? under.start : text.length, set ? beside.start : text.length);
  if (!under) return { at, number: null, caption: null };
  const eol = text.indexOf('\n', under.start);
  const end = eol < 0 ? text.length : eol;
  const number = diagramNumber(text.slice(under.start, end));
  const named = number ? namedAt(text, number, [under.start, end]) : null;
  return named === null ? { at, number, caption: null } : { at: named, number, caption: text.slice(under.start, end) };
}

/**
 * Page `n` drawn for reading its scan: about `dpi` dots per inch (at most `maxSide` pixels high or wide), on white.
 * Returns the canvas.
 */
export async function renderPage(doc, n, { dpi = 300, maxSide = 4200 } = {}) {
  const page = await doc.getPage(n);
  try {
    const one = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(dpi / 72, maxSide / Math.max(one.width, one.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport }).promise;
    return canvas;
  } finally {
    page.cleanup();
  }
}

/**
 * Draws page `n` into `canvas` — at `scale` (CSS pixels per PDF point), or as large as fits in `fit` ({ width, height }:
 * a height of Infinity for a width)
 * — and its text layer into `layer` (transparent text over the picture, where the reader marks sentences and moves;
 * none when `layer` is null: a scanned page's words come from its OCR). Returns { width, height, spans } — spans[i] is
 * the element of the page's i-th text item —, or null when cancelled() says another page was asked for meanwhile.
 */
export async function drawPage(doc, n, { canvas, layer, scale, fit, cancelled = () => false }) {
  const { TextLayer } = await pdfjs();
  const page = await doc.getPage(n);
  if (fit) {
    const one = page.getViewport({ scale: 1 });
    scale = Math.max(0.2, Math.min(fit.width / one.width, fit.height / one.height));
  }
  const viewport = page.getViewport({ scale });
  // (a page zoomed in far: fewer of the screen's pixels — a canvas of 40 million pixels at most, 16384 a side)
  const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(40e6 / (viewport.width * viewport.height)), 16384 / Math.max(viewport.width, viewport.height));
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  await page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
  if (cancelled()) return null;
  if (!layer) return { width: viewport.width, height: viewport.height, spans: [] };
  const content = await page.getTextContent();
  layer.replaceChildren();
  layer.style.setProperty('--total-scale-factor', String(scale));
  layer.style.setProperty('--scale-round-x', '1px');
  layer.style.setProperty('--scale-round-y', '1px');
  const text = new TextLayer({ textContentSource: content, container: layer, viewport });
  await text.render();
  if (cancelled()) return null;
  return { width: viewport.width, height: viewport.height, spans: text.textDivs };
}
