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
const middle = list => list[list.length >> 1];

/** A line made of some of a line's words: { words, box, par, text }. */
function lineOf(words, par) {
  const box = { x0: Math.min(...words.map(w => w.bbox.x0)), y0: Math.min(...words.map(w => w.bbox.y0)), x1: Math.max(...words.map(w => w.bbox.x1)), y1: Math.max(...words.map(w => w.bbox.y1)) };
  return { words, box, par, text: words.map(w => w.text.trim()).join(' ') };
}

/**
 * The gutter of a page in two columns: the x (pixels) of a strip down the middle of its text that hardly any line
 * crosses, with lines on either side of it (a column may stand beside the other one's diagram) — or null (one column).
 */
function gutterOf(lines, width) {
  if (lines.length < 6) return null;
  const x0s = lines.map(l => l.box.x0).sort((a, b) => a - b);
  const x1s = lines.map(l => l.box.x1).sort((a, b) => a - b);
  const left = x0s[Math.floor(x0s.length * 0.05)];
  const right = x1s[Math.floor(x1s.length * 0.95)];
  const body = right - left;
  if (body < width * 0.3) return null;
  let best = null;
  let run = null; // (the x's that do as well, one after the other: the gutter's middle)
  const step = Math.max(1, width * 0.002);
  for (let x = left + body * 0.3; x <= left + body * 0.7; x += step) {
    let l = 0;
    let r = 0;
    let across = 0;
    for (const line of lines) {
      let a = false;
      let b = false;
      let c = false;
      for (const w of line.words) {
        if (w.bbox.x1 <= x) a = true;
        else if (w.bbox.x0 >= x) b = true;
        else c = true;
      }
      if (c) across++;
      else {
        if (a) l++;
        if (b) r++;
      }
    }
    if (!best || across < best.across) (best = { across, l, r }), (run = [x, x]);
    else if (across === best.across && run[1] >= x - step * 1.01) run[1] = x;
  }
  if (best.across > lines.length * 0.15 || Math.min(best.l, best.r) < 3 || best.l + best.r < lines.length * 0.6) return null;
  // the strip between the columns: around it, where hardly any line has a word (a tenth of them, or two: a centred
  // running head's space between words may stand where the gutter is) — wider than a space between words
  const x = Math.round((run[0] + run[1]) / 2);
  const lo = Math.max(0, Math.floor(x - width * 0.1));
  const cover = new Int32Array(Math.min(width, Math.ceil(x + width * 0.1)) - lo);
  for (const l of lines) for (const w of l.words) for (let p = Math.max(lo, Math.floor(w.bbox.x0)); p < Math.min(lo + cover.length, Math.ceil(w.bbox.x1)); p++) cover[p - lo]++;
  const few = Math.max(2, lines.length * 0.1);
  let a = x - lo;
  let b = a;
  if (!(cover[a] <= few)) return null;
  while (a > 0 && cover[a - 1] <= few) a--;
  while (b + 1 < cover.length && cover[b + 1] <= few) b++;
  const strip = [lo + a, lo + b + 1];
  return strip[1] - strip[0] >= width * 0.012 ? { x, left, right, strip } : null;
}

/**
 * The lines of a page (Tesseract's, top to bottom: { words, box, par }) in reading order. Tesseract reads the page as one
 * block of lines — its own page layout drops whole parts of a book's columns, and reads less well —, so on a page in two
 * columns a line holds a line of each: its words are parted at the gutter, and a stretch of lines whose parts are lines
 * of text (most of them ending where their column ends, as a book's lines do — or long, of several words) is read
 * column by column, the left one first — each column looked at for columns of its own (two pages side by side, each in
 * two). A table of moves in two columns ("1 P to K 4   1 P to Q B 4": short, ragged) is no columns of text: read line by
 * line, as are lines across the gutter (a heading, the running head). A column's
 * paragraphs: a line set in, or after a short line that ends a sentence; the right column goes on with the left one's
 * paragraph when it begins with a small letter.
 */
export function readingOrder(lines, width) {
  const g = gutterOf(lines, width);
  if (!g) return lines;
  const { x, strip } = g;
  // (a line across the gutter has a word in its middle half)
  const quarter = (strip[1] - strip[0]) / 4;
  const across = l => l.words.some(w => w.bbox.x1 > strip[0] + quarter && w.bbox.x0 < strip[1] - quarter);
  const side = (l, right) => l.words.filter(w => (w.bbox.x0 + w.bbox.x1) / 2 >= x === right);
  const columns = [x - g.left, g.right - x];
  const ends = [strip[0], g.right];
  const lh = middle(lines.flatMap(l => l.words.map(w => w.bbox.y1 - w.bbox.y0)).sort((a, b) => a - b));
  const out = [];
  let section = [];
  const flush = () => {
    const parts = section.flatMap(l => [0, 1].map(k => ({ k, words: side(l, !!k), line: l }))).filter(p => p.words.length);
    const text = p => {
      const x1 = p.words.at(-1).bbox.x1;
      return Math.abs(x1 - ends[p.k]) <= width * 0.02 || (x1 - p.words[0].bbox.x0 >= columns[p.k] * 0.6 && p.words.length >= 4);
    };
    const number = p => /^\d/.test(p.words[0].text.trim());
    // (a column's own table of moves — its rows a number and a move or two, "8 Re2 Bg7", beside the other column's
    // text or its own rows, "29 Kf3 Rb7": a page in two columns, a game's score in each — is that column's lines as
    // much as its text is; not a table in two columns read across, its two cells of a line with one number, "1 P to K
    // 4  1 P to Q B 4", nor one table cut in two, White's moves on one side and Black's on the other, "12 Rd1  Nf6")
    const other = p => parts.find(q => q.line === p.line && q !== p);
    const lone = q => !number(q) && q.words.length <= 2 && !text(q);
    // (a row: a number, then a move or two — a square in one of them, or Black's dots —, short words: not a board's rank
    // number beside what the OCR made of its pieces, "5 & HW")
    const row = p => /^\d{1,3}\.?$/.test(p.words[0].text.trim()) && p.words.length >= 2 && p.words.length <= 4 && p.words.every(w => w.text.trim().length <= 8) && p.words.slice(1).some(w => /[a-h][1-8]|^(?:\.{2,}|…)/.test(w.text.trim()));
    const own = p => {
      const q = other(p);
      return row(p) && !text(p) && !(q && ((number(q) && q.words[0].text.trim() === p.words[0].text.trim()) || lone(q)));
    };
    const full = parts.filter(text).length;
    const rows = parts.filter(own).length;
    // (a table's cells begin with their move numbers, and are short: a book's columns of notes are lines of text, many
    // of them beginning with a move too)
    const numbered = parts.filter(number).length - rows;
    if (section.length < 3 || full + rows < 3 || full + rows < parts.length * 0.5 || (numbered >= parts.length * 0.5 && full < parts.length * 0.8)) out.push(...section);
    else
      for (const right of [false, true]) {
        const col = section.map(l => side(l, right)).filter(p => p.length).map(p => lineOf(p, false));
        if (!col.length) continue;
        // (two pages side by side: each page may be in two columns of its own)
        const inner = readingOrder(col, width);
        if (inner !== col) {
          out.push(...inner);
          continue;
        }
        const margin = middle(col.map(l => l.box.x0).sort((a, b) => a - b));
        const end = middle(col.map(l => l.box.x1).sort((a, b) => b - a).slice(0, Math.max(1, col.length >> 1)));
        col.forEach((l, i) => {
          const prev = i ? col[i - 1] : right ? out.at(-1) : null;
          if (!prev) l.par = true;
          else if (!i) l.par = !/^[\p{Ll}]/u.test(l.text) && !/[-‐,]$/.test(prev.text);
          else l.par = l.box.x0 - margin >= lh * 0.6 || (prev.box.x1 < end - (columns[right ? 1 : 0] * 0.12) && /[.!?:"'”’)]$/.test(prev.text));
        });
        out.push(...col);
      }
    section = [];
  };
  for (const l of lines) {
    if (across(l)) {
      flush();
      out.push(l);
    } else section.push(l);
  }
  flush();
  return out;
}

// A game's score set as a table: a row is a move number, White's move and Black's, each at its column ("12 Rd1 Nf6"),
// and after a note Black's move on a row of its own ("12 ... Nf6"). A small scan's OCR may misread such a row's number
// and dots as signs or letters it is unsure of ("EI Kg8", "LE Kd7", "T eae Rd8"), or lose the dots ("21. vs exd5",
// "2 Kd6" for "21 ... Kd6"): a line of one move right of White's column, its words before it no move — numbers, single
// characters, words read with little confidence —, after a row of White's move alone (N, a note between maybe) and
// before the next one's (N + 1), is Black's move N — written so: "N ...", where the misread words were.
const ROW_NUMBER = /^\d{1,3}\.?$/;
const MOVE_WORD = /^(?:[KQRBN][a-h1-8]|[a-h][1-8xéobsSlIij?d]|[O0]-[O0])\S{0,6}$/;

function blackRows(lines) {
  const rows = lines.map(l => {
    const ws = l.words;
    return ws.length >= 2 && ws.length <= 3 && ROW_NUMBER.test(ws[0].text.trim()) && ws.slice(1).every(w => MOVE_WORD.test(w.text.trim())) ? { num: Number(ws[0].text.trim().replace('.', '')), moves: ws.slice(1) } : null;
  });
  lines.forEach((l, i) => {
    const ws = l.words;
    if (ws.length < 2 || ws.length > 3) return;
    const move = ws.at(-1);
    const lead = ws.slice(0, -1);
    if (!MOVE_WORD.test(move.text.trim()) || lead.some(w => MOVE_WORD.test(w.text.trim()) || /^\d{1,3}(?:\.{2,}|…)$/.test(w.text.trim()))) return;
    if (!lead.every(w => ROW_NUMBER.test(w.text.trim()) || w.text.trim().length === 1 || (w.confidence ?? 100) < 60)) return;
    let num;
    const unsure = w => !ROW_NUMBER.test(w.text.trim()) && w.text.trim().length <= 4 && (w.confidence ?? 100) < 60;
    // (its number read, the dots after it misread: "13 ou Rc1+")
    if (lead.length === 2 && ROW_NUMBER.test(lead[0].text.trim()) && unsure(lead[1])) num = Number(lead[0].text.trim().replace('.', ''));
    else {
      // (the rows around it, a note's lines between them)
      let p = i - 1;
      while (p >= 0 && !rows[p] && i - p <= 12) p--;
      let q = i + 1;
      while (q < lines.length && !rows[q] && q - i <= 12) q++;
      const before = rows[p];
      const after = rows[q];
      if (!before || before.moves.length !== 1 || (after && after.num !== before.num + 1) || Number(lead[0].text.trim().replace('.', '')) === before.num + 1) return;
      if (move.bbox.x0 <= before.moves[0].bbox.x1) return;
      num = before.num;
    }
    const box = { x0: Math.min(...lead.map(w => w.bbox.x0)), y0: Math.min(...lead.map(w => w.bbox.y0)), x1: Math.max(...lead.map(w => w.bbox.x1)), y1: Math.max(...lead.map(w => w.bbox.y1)) };
    l.words = [{ text: `${num} ...`, confidence: 0, bbox: box }, move];
    l.text = l.words.map(w => w.text.trim()).join(' ');
    rows[i] = null;
  });
}

/**
 * The words that are the boards' coordinates (a Set of Tesseract's words): a board's rank numbers in a column beside it
 * and its files' letters in a row under or over it — words of one or two characters (as the OCR reads them: "¢" for c,
 * "ee" for e, "gg" for g; two files' letters as one word, "bc"), in a line along the board's side, four ranks or files
 * at least with one in their middle (two letters: in the middle of two). They are no text: "1 gg" under a board, its f
 * and g, is no move 1.g4.
 */
function coordinates(words, boards) {
  const out = new Set();
  for (const b of boards) {
    const sq = b.width / 8;
    const sides = [
      // (along the left side and the right one: the rank numbers; under and over: the files' letters)
      { across: w => (w.bbox.y0 + w.bbox.y1) / 2 - b.y, along: w => (w.bbox.x0 + w.bbox.x1) / 2, near: w => w.bbox.x1 <= b.x + sq * 0.15 && w.bbox.x0 >= b.x - sq * 1.5 },
      { across: w => (w.bbox.y0 + w.bbox.y1) / 2 - b.y, along: w => (w.bbox.x0 + w.bbox.x1) / 2, near: w => w.bbox.x0 >= b.x + b.width - sq * 0.15 && w.bbox.x1 <= b.x + b.width + sq * 1.5 },
      { across: w => (w.bbox.x0 + w.bbox.x1) / 2 - b.x, along: w => (w.bbox.y0 + w.bbox.y1) / 2, near: w => w.bbox.y0 >= b.y + b.height - sq * 0.15 && w.bbox.y1 <= b.y + b.height + sq * 1.2 },
      { across: w => (w.bbox.x0 + w.bbox.x1) / 2 - b.x, along: w => (w.bbox.y0 + w.bbox.y1) / 2, near: w => w.bbox.y1 <= b.y + sq * 0.15 && w.bbox.y0 >= b.y - sq * 1.2 },
    ];
    for (const { across, along, near } of sides) {
      // (short words beside the board, as far along it as it goes)
      const short = words.filter(w => w.text.trim().length <= 2 && w.bbox.x1 - w.bbox.x0 <= sq * 1.8 && w.bbox.y1 - w.bbox.y0 <= sq * 0.8 && near(w) && across(w) > -sq * 0.25 && across(w) < sq * 8.25);
      // (the ranks or files a word stands in the middle of: one, or two for two letters read as one word)
      const marks = w => {
        const k = across(w) / sq - 0.5;
        if (k <= -0.5 || k >= 7.5) return [];
        if (Math.abs(k - Math.round(k)) <= 0.3) return [Math.round(k)];
        return w.text.trim().length === 2 && Math.abs(k - Math.floor(k) - 0.5) <= 0.3 ? [Math.floor(k), Math.floor(k) + 1] : [];
      };
      const placed = short.filter(w => marks(w).length);
      if (placed.length < 3) continue;
      // (in a line: within a third of a square of their middle)
      const mid = middle(placed.map(along).sort((p, q) => p - q));
      const lined = short.filter(w => Math.abs(along(w) - mid) <= sq / 3);
      if (new Set(lined.flatMap(marks)).size >= 4) for (const w of lined) out.add(w);
    }
  }
  return out;
}

/**
 * A scanned page's text from what Tesseract read in its picture (width × height pixels; its blocks of paragraphs of
 * lines of words): { text, items: [{ start, end, box }] — a word each, box: [x0, y0, x1, y1] as shares of the page —,
 * diagrams: [{ at, box, board }] for the `boards` found in the picture ({ x, y, width, height, board }: each goes before
 * the first line under it) }. The lines in reading order (two columns one after the other: readingOrder), joined by a
 * line break, paragraphs by a blank line. Left out: specks read as letters, the running head and the page number, a
 * scanner's or a preview's mark ("Digitized by Google", "Copyrighted Material"), a diagram's labels ("WHITE",
 * "BLACK") and its coordinates.
 */
export function ocrText(data, { width, height, boards = [] }) {
  const read = [];
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
        read.push({ words, box: line.bbox, par: first, text: s });
        first = false;
      }
    }
  // (the boards' coordinates are no text — but the page's layout is found with them, as it was before they were known)
  const coords = boards.length ? coordinates(read.flatMap(l => l.words), boards) : new Set();
  const lines = readingOrder(read, width).flatMap(l => {
    if (!l.words.some(w => coords.has(w))) return [l];
    const words = l.words.filter(w => !coords.has(w));
    return words.length ? [lineOf(words, l.par)] : [];
  });
  const heights = lines.flatMap(l => l.words.map(w => w.bbox.y1 - w.bbox.y0)).sort((a, b) => a - b);
  const lh = heights.length ? heights[heights.length >> 1] : height / 60;
  const byBoard = l => boards.some(b => l.box.x1 > b.x && l.box.x0 < b.x + b.width && l.box.y1 > b.y - lh * 3 && l.box.y0 < b.y + b.height + lh * 3);
  const top = Math.min(...lines.map(l => l.box.y0));
  const bottom = Math.max(...lines.map(l => l.box.y1));
  const kept = lines.filter(l => {
    const s = l.text;
    if (/\bdigiti[sz]ed\s+by\b/i.test(s) || /^\W*(?:\d{1,4}\s+)?copyrighted\s+material(?:\s+\d{1,4})?\W*$/i.test(s)) return false;
    // the running head: the page's top line, its number and a title in capitals ("12 THE CHESS PRIMER.")
    const letters = s.match(/\p{L}/gu) || [];
    const capitals = letters.filter(c => c !== c.toLowerCase()).length;
    // (a scan of two pages side by side has a head over each, one a little lower than the other when the scan leans)
    const head = l.box.y0 <= top + lh * 1.5 && l.box.y1 < height * 0.25 && s.length < 70;
    if (head && /^\W*\d{1,4}\b|\b\d{1,4}\W*$/.test(s) && /\p{Lu}{3}/u.test(s) && capitals >= letters.length * 0.8) return false;
    // the page number at the foot
    if (l.box.y1 >= bottom - lh * 0.5 && l.box.y0 > height * 0.85 && /^[\divxlc\s.\-–—]{1,8}$/i.test(s)) return false;
    if (byBoard(l) && /^(?:white|black)[.:,]?$/i.test(s)) return false;
    return true;
  });
  blackRows(kept);
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
  // (on a page in one column, the first line under a board may be shorter than the board is far from the margin — a
  // game's moves under a centred diagram, "21...Rf6 22.Rg3+" —: any line under it; in two columns, one of its column)
  const single = !gutterOf(read, width);
  const diagrams = boards
    .map(b => {
      const under = kept.find(l => l.box.y0 >= b.y + b.height - lh && (single || (l.box.x1 > b.x && l.box.x0 < b.x + b.width)));
      return { at: under ? under.start : text.length, box: [share(b.x / width), share(b.y / height), share((b.x + b.width) / width), share((b.y + b.height) / height)], board: b.board };
    })
    .sort((a, b) => a.at - b.at);
  return { text, items, diagrams };
}
