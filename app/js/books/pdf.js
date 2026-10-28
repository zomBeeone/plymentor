// PDF books (Book reader), with pdf.js (Mozilla, Apache-2.0): it is loaded the first time a PDF is opened, renders the
// pages in its own worker, and gives each page's text. Never with eval (the window's security policy forbids it).
import { fontBoards } from './diagrams.js';

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
        diagrams.push({ at: text.length, placement: b.placement, side: b.side, font: true, box: viewport ? boxOn(viewport, b) : null });
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
 * (scan.js) —, .picture when it has text and a large picture (a scan with its text, or a picture of diagrams).
 */
export async function readPageText(doc, n) {
  const { OPS } = await pdfjs();
  const page = await doc.getPage(n);
  try {
    const out = pageText(await page.getTextContent(), page.getViewport({ scale: 1 }));
    if ((out.text.match(/\p{L}/gu)?.length || 0) < 30) out.scan = true;
    else if (!out.diagrams.length) {
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length && !out.picture; i++) {
        const fn = ops.fnArray[i];
        const a = ops.argsArray[i];
        const size = fn === OPS.paintImageXObject ? a[1] * a[2] : fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject ? a[0]?.width * a[0]?.height : 0;
        if (size >= 800 * 800) out.picture = true;
      }
    }
    return out;
  } finally {
    page.cleanup();
  }
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
 * Draws page `n` into `canvas` — at `scale` (CSS pixels per PDF point), or as large as fits in `fit` ({ width, height })
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
  const ratio = window.devicePixelRatio || 1;
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
