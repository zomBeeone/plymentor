// What the coach reads of a chess book (its tools list_books, read_book and search_books: coach.js): a page as the
// reader has it, written for a language model rather than an eye — the moves the reader followed in plain notation (a
// font's figurines are nothing to a model, an OCR's spellings little more), each diagram as its FEN at its place in the
// text, no board coordinates —, long chapters in parts, and finding words in the books' texts. It needs no window: the
// reader's worker searches with it too.

// (Unicode's private use area: a chess font's own figurines and signs)
const PRIVATE = /[-]/g;
const hasPrivate = s => /[-]/.test(s);

/** A move as a comparison takes it: no spaces, no check signs, no glyphs. */
const bare = s => s.replace(/[\s+#†‡!?]/g, '');
/** A move number and its dots as a book writes them ("12.", "12...", "12…", "12. ...", "12 "), or Black's dots alone. */
const isNumber = s => !s || /^\d{1,3}\s?(?:\.\s?){0,4}(?:…\s?)?$/.test(s) || /^(?:\.{2,3}|…)\s?$/.test(s);

/**
 * A move of the text as the coach reads it, or null: as the book writes it. Followed to a position (`t.node`), the move
 * that was played — unless the book writes just that; not followed, a lost figurine as the piece the book's moves have
 * shown it to be (`pieceOf`), a font's own one no piece was learnt for as "?" (left in, a knight's Nf3 reads as the pawn
 * move f3). A move in words stays in words.
 */
function plainMove(text, t, pieceOf) {
  if (t.spelled) return null;
  // (where the move itself begins, after its number and dots)
  const at = t.written ? t.written.at : t.start + (/^\d{1,3}\s*(?:\.\s*)*/.exec(text.slice(t.start, t.end))?.[0].length || 0);
  const head = text.slice(t.start, at);
  const body = text.slice(at, t.end);
  let move;
  if (t.node?.san) {
    if (bare(body) === bare(t.node.san) && isNumber(head)) return null;
    move = t.node.san + (/[!?]{1,2}$/.exec(body)?.[0] || '');
  } else if (t.glyph) {
    move = body.replace(t.glyph, pieceOf?.(t.glyph) || (hasPrivate(t.glyph) ? '?' : t.glyph));
    if (move === body && isNumber(head)) return null;
  } else return null;
  const number = isNumber(head) || !t.num ? head : `${t.num}${t.side === 'black' ? '...' : '.'}`;
  return number + move;
}

/** A diagram at its place in the text: its FEN, and whether it can be wrong (`hidden`: the squares of kings the reader added). */
function diagramLine(d, hidden = []) {
  if (d.node?.fen) {
    const exact = d.font || d.fixed || d.known;
    const kings = hidden.length ? `; the book's diagram has no king on ${hidden.join(' or ')}, the app added it` : '';
    return `\n[Diagram${exact ? '' : ', read from a picture (a piece may be wrong)'}: ${d.node.fen}${kings}]\n`;
  }
  if (d.placement) return `\n[Diagram, read from a picture but not a legal position (some pieces are wrong): ${d.placement}]\n`;
  return '\n[Diagram: its position could not be read]\n';
}

// (a board's coordinates in a page's text: its files on one line, its ranks each on a line of its own)
const FILES = /^[ \t]*a[ \t]*b[ \t]*c[ \t]*d[ \t]*e[ \t]*f[ \t]*g[ \t]*h[ \t]*\n?/gm;
const RANKS = /(?:^[ \t]*[1-8][ \t]*(?:\n|$)){4,}/gm;

/** Lines broken with a hyphen mended; what only a font knows, and the spaces at lines' ends, gone. */
function tidy(text) {
  return text
    .replace(/([A-Za-zÀ-ɏ]{2,})[-‐]\n[ \t]*([a-zà-ɏ])/g, '$1$2')
    .replace(PRIVATE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The text of a unit of a book (a PDF's page, an EPUB's chapter; followed by the reader: { text, moves, diagrams }) as the
 * coach reads it, from `from` to `to`. pieceOf(glyph): the piece a lost figurine has been learnt to be; hidden(diagram): the
 * squares of the kings the reader added to it.
 */
export function coachText(unit, { from = 0, to = Infinity, pieceOf = null, hidden = null } = {}) {
  const { text } = unit;
  const end = Math.min(to, text.length);
  const edits = [];
  for (const t of unit.moves || []) {
    if (t.start < from || t.end > end) continue;
    const s = plainMove(text, t, pieceOf);
    if (s !== null) edits.push([t.start, t.end, s]);
  }
  for (const d of unit.diagrams || []) if (d.at >= from && d.at < to) edits.push([d.at, d.at, diagramLine(d, hidden?.(d) || [])]);
  for (const re of [FILES, RANKS]) for (const m of text.matchAll(re)) if (m.index >= from && m.index < end) edits.push([m.index, Math.min(end, m.index + m[0].length), '']);
  edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = '';
  let at = from;
  for (const [s, e, r] of edits) {
    if (s < at) {
      if (s === e) out += r; // (a diagram among its own coordinates)
      continue;
    }
    out += text.slice(at, s) + r;
    at = e;
  }
  return tidy(out + text.slice(at, end));
}

// A long chapter is read in parts (what the coach reads, it — the student — pays for).
export const PART = 20_000;

/** Where the parts of a unit's text begin: about `size` characters each, cut at a line's end. */
export function partStarts(text, size = PART) {
  const out = [0];
  while (text.length - out.at(-1) > size * 1.2) {
    const target = out.at(-1) + size;
    const line = text.lastIndexOf('\n', target);
    out.push(line > target - 2000 ? line + 1 : target);
  }
  return out;
}

/** The part (from 1) a share of a unit's text falls in. */
export function partAt(text, share) {
  const starts = partStarts(text);
  const at = share * text.length;
  let part = 1;
  while (part < starts.length && starts[part] <= at) part++;
  return part;
}

/** Lower case, no accents: one character for each (a position in it is one in the text). */
export const folded = s => s.replace(/[^\x00-\x7F]/g, c => c.normalize('NFD')[0].toLowerCase()[0] || c).toLowerCase();

/** A text as it is searched: no boards' coordinates, words broken at lines' ends mended, its white space single spaces, no font's own signs. */
const flat = text =>
  text
    .replace(FILES, '')
    .replace(RANKS, '')
    .replace(/([A-Za-zÀ-ɏ]{2,})[-‐]\n[ \t]*(?=[a-zà-ɏ])/g, '$1')
    .replace(PRIVATE, '')
    .replace(/\s+/g, ' ')
    .trim();

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'to', 'and', 'or', 'for', 'with', 'at', 'by', 'is', 'it', 'about']);

/** What to find on a page: the "phrases in quotes" and the other words (the little ones too only when nothing else is left). */
function termsOf(query) {
  const phrases = [...query.matchAll(/["“”]([^"“”]+)["“”]/g)].map(m => m[1]);
  const words = query
    .replace(/["“”][^"“”]*["“”]/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#=]+$/gu, ''))
    .filter(Boolean);
  const kept = words.filter(w => !STOP.has(folded(w)));
  return [...phrases, ...(kept.length ? kept : words)].map(t => folded(t).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Where `term` is in `low` (64 places at most), and how many times. */
function placesOf(low, term) {
  const at = [];
  let count = 0;
  for (let i = low.indexOf(term); i >= 0; i = low.indexOf(term, i + term.length)) if (count++ < 64) at.push(i);
  return { at, count };
}

/** The closest all the `terms` come together in `low` ({ at, end, count (how often they occur), score }), or null. */
function matchOf(low, terms, whole) {
  const found = terms.map(t => placesOf(low, t));
  if (found.some(f => !f.count)) return null;
  let best = null;
  for (const a of found[0].at) {
    let start = a;
    let stop = a + terms[0].length;
    found.slice(1).forEach((f, k) => {
      const near = f.at.reduce((x, y) => (Math.abs(y - a) < Math.abs(x - a) ? y : x));
      start = Math.min(start, near);
      stop = Math.max(stop, near + terms[k + 1].length);
    });
    if (!best || stop - start < best.end - best.at) best = { at: start, end: stop };
  }
  const count = found.reduce((n, f) => n + f.count, 0);
  const phrase = whole ? placesOf(low, whole) : null;
  if (phrase?.count) Object.assign(best, { at: phrase.at[0], end: phrase.at[0] + whole.length });
  return { ...best, count, score: (phrase?.count ? 1000 + phrase.count : 0) + Math.max(0, 300 - (best.end - best.at)) / 3 + Math.min(count, 50) };
}

function snippet(page, at, end, margin = 100) {
  const stop = Math.min(end, at + 240);
  let a = Math.max(0, at - margin);
  let b = Math.min(page.length, stop + margin);
  if (a > 0) a = (x => (x >= 0 && x < at ? x + 1 : a))(page.indexOf(' ', a));
  if (b < page.length) b = (x => (x > stop ? x : b))(page.lastIndexOf(' ', b));
  return `${a > 0 ? '…' : ''}${page.slice(a, b)}${b < page.length ? '…' : ''}`;
}

/**
 * Finds `query` in units' texts ([{ index, text }]): every word on one page — closest together and whole phrases first.
 * { hits: [{ index, share (how far into the unit), snippet }], matched (units with it), searched (units with text) }.
 */
export function searchTexts(items, query, most = 10) {
  const terms = termsOf(query);
  const hits = [];
  let searched = 0;
  if (!terms.length) return { hits, matched: 0, searched };
  const whole = terms.length > 1 ? folded(query.replace(/["“”]/g, '')).replace(/\s+/g, ' ').trim() : null;
  for (const { index, text } of items) {
    if (!text?.trim()) continue;
    searched++;
    const page = flat(text);
    const m = matchOf(folded(page), terms, whole);
    if (m) hits.push({ index, share: m.at / page.length, score: m.score, snippet: snippet(page, m.at, m.end) });
  }
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  return { hits: hits.slice(0, most), matched: hits.length, searched };
}

/** searchTexts over a PDF's pages as they are kept (null: not read yet) — `unread`: the pages without their text so far. */
export function searchPages(pages, query, most = 10) {
  const unread = pages.filter(p => !p || (p.scan && !p.scanned)).length;
  return { ...searchTexts(pages.map((p, index) => ({ index, text: p?.text || '' })), query, most), unread, total: pages.length };
}

/** A book by its id (or the start of it) or words of its title or author: { book } — or { found: the ones it may be }. */
export function pickBook(books, ref) {
  const r = String(ref).trim().toLowerCase();
  const byId = books.find(b => b.id === r) || (/^[0-9a-f]{6,}$/.test(r) ? books.find(b => b.id.startsWith(r)) : null);
  if (byId) return { book: byId };
  const words = folded(r).split(/\s+/).filter(Boolean);
  const found = books.filter(b => {
    const name = folded(`${b.title} ${b.author || ''}`);
    return words.every(w => name.includes(w));
  });
  return found.length === 1 ? { book: found[0] } : { found };
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** A book's name in a sentence. */
export const bookName = b => `“${clip(b.title, 160)}”${b.author ? ` by ${clip(b.author, 80)}` : ''}`;

/** A book of the library in the coach's list. */
export function bookLine(b) {
  const pdf = b.format === 'pdf';
  const at = b.at ? `the student is at ${pdf ? 'page' : 'chapter'} ${b.at.unit + 1}${b.progress ? ` (${Math.round(b.progress * 100)}% of the book)` : ''}` : 'the student has not started it';
  return `- ${b.id}: ${bookName(b)} — ${b.format.toUpperCase()}, ${b.pages} ${pdf ? 'pages' : 'chapters'}; ${at}`;
}

/** A table of contents ([{ title, page, depth }]) as the coach reads it. */
export function contentsText(items) {
  return items.map(it => `${'  '.repeat(it.depth)}- ${it.page ?? '?'}: ${clip(it.title, 120)}`).join('\n');
}
