// The coach's tools for the student's books — list_books, read_book, search_books (shared/tools.js) — run here, in the
// window: the books are in its storage, and only it can read a PDF or an EPUB. A book the coach reads is the one the
// Book reader has open, or a copy opened for it (reader.js holdBook): the moves followed, the diagrams read and set
// right, what is kept of a scanned book, all as in the Book reader. A scanned page nobody has read yet is read when the
// coach asks for it, that page only. What the coach is told is text from outside (host.js cleans it).
import { hiddenSquares } from './moves.js';
import { listBooks, bookFile, cacheFile } from './library.js';
import { holdBook, heldBook, layOut } from './reader.js';
import { Scanner } from './scan.js';
import { openEpub } from './epub.js';
import { openPdf, closePdf, pdfOutline } from './pdf.js';
import { coachText, partStarts, partAt, searchTexts, searchPages, pickBook, bookName, bookLine, contentsText } from './coachtext.js';

class BookError extends Error {}

const WAIT = 120_000; // how long read_book waits for pages still to be read (OCR: seconds each) before saying so
const SEARCHING = 30_000; // how long search_books goes through the student's books
const TEXT = 24_000; // the characters of one answer, about 8,000 tokens: what the coach reads, the student pays for

const noun = meta => (meta.format === 'pdf' ? 'page' : 'chapter');

/** Waits until `ready()`, the book closes or fails, or `ms` pass. */
function until(book, ready, ms) {
  return new Promise(resolve => {
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      book.listeners.delete(check);
      resolve();
    };
    const check = () => (ready() || book.closed || book.error) && done();
    timer = setTimeout(done, ms);
    book.listeners.add(check);
    check();
  });
}

/** The book the coach names (its id, or words of its title) — without a name, the one the student opened last. */
function chosen(books, ref) {
  if (!books.length) throw new BookError('The student has not added any books yet. They can add a PDF or an EPUB on the Book reader tab.');
  if (!ref?.trim()) return books[0];
  const { book, found } = pickBook(books, ref);
  if (book) return book;
  if (!found.length) throw new BookError(`No book of the student's is called "${ref.slice(0, 80)}". Their books:\n${books.map(bookLine).join('\n')}`);
  throw new BookError(`More than one book fits "${ref.slice(0, 80)}": give its id.\n${found.map(bookLine).join('\n')}`);
}

/** "after 17...Bd6", of a position reached by a move. */
function afterMove(node) {
  if (!node.san) return '';
  const [, turn, , , , full] = node.fen.split(' ');
  return ` (after ${turn === 'b' ? `${full}.` : `${Number(full) - 1}...`}${node.san})`;
}

async function readTool({ book: ref, page, pages = 1, part = 1 }) {
  const meta = chosen(await listBooks(), ref);
  const { book, release } = await holdBook(meta);
  try {
    const name = noun(meta);
    const first = page === undefined ? book.meta.at?.unit || 0 : page - 1;
    if (first >= book.count) throw new BookError(`${bookName(meta)} has ${book.count} ${name}s: there is no ${name} ${first + 1}.`);
    const units = Array.from({ length: Math.min(pages, book.count - first) }, (_, i) => first + i);
    book.want(units);
    await until(book, () => units.every(u => book.isRead(u)), WAIT);
    if (book.closed) throw new BookError('This book was removed from the student’s books.');
    if (book.error && !book.units[first]) throw new BookError(`This book could not be read: ${book.error.message}`);
    const out = [`${bookName(meta)} — ${name} ${first + 1}${units.length > 1 ? `–${units.at(-1) + 1}` : ''} of ${book.count}.`];
    if (part === 1 && first > 0) {
      const at = book.nodeAt(first - 1)?.node;
      if (at) out.push(`The position the book had reached before this ${name}${afterMove(at)}: ${at.fen}`);
    }
    const options = { pieceOf: g => book.moves.pieceOf(g), hidden: d => hiddenSquares(d.tree, d.node?.fen) };
    let used = 0;
    let more = null;
    let missing = 0;
    for (const [k, u] of units.entries()) {
      const unit = book.units[u];
      if (!unit) {
        missing = units.length - k;
        break;
      }
      const starts = partStarts(unit.text);
      const p = k ? 1 : part;
      if (p > starts.length) throw new BookError(`${name} ${u + 1} has ${starts.length} part${starts.length === 1 ? '' : 's'}: there is no part ${p}.`);
      const text = coachText(unit, { from: starts[p - 1], to: starts[p] ?? Infinity, ...options });
      if (k && used + text.length > TEXT) {
        more = `${name} ${u + 1}`;
        break;
      }
      used += text.length;
      const title = name === 'chapter' && unit.title ? `: ${unit.title}` : '';
      out.push(`--- ${name[0].toUpperCase()}${name.slice(1)} ${u + 1}${title}${starts.length > 1 ? ` (part ${p} of ${starts.length})` : ''} ---\n${text || `(No text on this ${name}: a picture.)`}`);
      if (p < starts.length) {
        more = `${name} ${u + 1}, part ${p + 1}`;
        break;
      }
    }
    if (missing) out.push(`(${missing === 1 ? `That ${name} is` : `The last ${missing} ${name}s are`} still being read: the text of a scanned page is recognised on this computer, which takes a while. Ask for ${missing === 1 ? 'it' : 'them'} again in a minute.)`);
    else if (more) out.push(`(Enough for one answer: ${more} comes next.)`);
    else if (units.at(-1) + 1 < book.count) out.push(`(${name} ${units.at(-1) + 2} comes next.)`);
    else out.push('(The end of the book.)');
    return out.join('\n\n');
  } finally {
    release();
  }
}

/** A book's contents: a PDF's bookmarks, an EPUB's chapters — [{ title, page, depth }]. */
async function contentsOf(meta) {
  const file = await bookFile(meta);
  if (!file) throw new BookError('The file of this book is missing.');
  if (meta.format === 'epub') {
    const epub = await openEpub(file);
    try {
      return epub.chapters.map((c, i) => ({ title: c.title, page: i + 1, depth: 0 }));
    } finally {
      epub.close();
    }
  }
  const doc = await openPdf(await file.arrayBuffer());
  try {
    return await pdfOutline(doc);
  } finally {
    closePdf(doc);
  }
}

async function listTool({ book: ref }) {
  const books = await listBooks();
  if (!ref?.trim()) {
    if (!books.length) return 'The student has not added any books yet. They can add a PDF or an EPUB on the Book reader tab.';
    return [`The student's books, the one opened last first (${books.length}). read_book and search_books take a book's id or words of its title.`, ...books.map(bookLine)].join('\n');
  }
  const meta = chosen(books, ref);
  const items = await contentsOf(meta);
  return `${bookLine(meta)}\n\n${
    items.length
      ? `Contents (the numbers are what read_book takes):\n${contentsText(items)}`
      : 'This PDF has no table of contents of its own: its printed one is in its first pages (read_book), or search_books finds a subject.'
  }`;
}

/** The chapters of an EPUB as texts (no need to open it as the Book reader does: no diagrams are looked at). */
async function epubTexts(meta) {
  const epub = await openEpub(await bookFile(meta));
  try {
    const out = [];
    for (let i = 0; i < epub.chapters.length; i++) out.push({ index: i, text: layOut((await epub.chapter(i)).blocks), title: epub.chapters[i].title });
    return out;
  } finally {
    epub.close();
  }
}

/**
 * `query` in one book: { hits, matched, searched, unread, total } — or { unknown: true } for a PDF of which nothing has
 * been read yet (read then only when the coach `named` it: that takes a while).
 */
async function searchBook(meta, query, scanner, named) {
  if (meta.format === 'epub') {
    const texts = await epubTexts(meta);
    const found = searchTexts(texts, query);
    for (const h of found.hits) {
      const { text, title } = texts[h.index];
      h.title = title;
      h.part = partStarts(text).length > 1 ? partAt(text, h.share) : null;
    }
    return found;
  }
  const open = heldBook(meta.id);
  if (open?.listed) return searchPages(open.pages, query);
  const kept = await cacheFile(meta.id);
  if (kept) return scanner.call({ op: 'search', file: kept, query });
  if (!named) return { unknown: true };
  const { book, release } = await holdBook(meta);
  try {
    await until(book, () => book.listed, WAIT);
    if (book.error) throw new BookError(`This book could not be read: ${book.error.message}`);
    return searchPages(book.pages || [], query);
  } finally {
    release();
  }
}

async function searchTool({ query, book: ref }) {
  if (!query.trim()) throw new BookError('Say what to look for.');
  const all = await listBooks();
  const books = ref?.trim() ? [chosen(all, ref)] : all;
  if (!books.length) throw new BookError('The student has not added any books yet. They can add a PDF or an EPUB on the Book reader tab.');
  // (the kept text of a PDF is read in the worker: the file can be tens of megabytes, the window goes on meanwhile)
  const scanner = new Scanner(null);
  const out = [];
  const skipped = [];
  const end = Date.now() + SEARCHING;
  let matched = 0;
  try {
    for (const meta of books) {
      if (Date.now() > end) {
        skipped.push(`${bookName(meta)} (${meta.id}): no time left in this search`);
        continue;
      }
      const name = noun(meta);
      let r;
      try {
        r = await searchBook(meta, query, scanner, !!ref?.trim());
      } catch (e) {
        if (ref?.trim()) throw e; // (the one book asked about)
        skipped.push(`${bookName(meta)} (${meta.id}): it could not be read`);
        continue;
      }
      if (r.unknown) {
        skipped.push(`${bookName(meta)} (${meta.id}): the app has not read it yet — search it by its id to have it read first`);
        continue;
      }
      if (r.unread) skipped.push(`${bookName(meta)} (${meta.id}): ${r.unread} of its ${r.total} pages are scanned pages not read yet`);
      if (!r.hits.length) continue;
      matched += r.matched;
      const lines = r.hits.map(h => `- ${name} ${h.index + 1}${h.title ? ` (“${h.title.slice(0, 60)}”)` : ''}${h.part ? `, part ${h.part}` : ''}: ${h.snippet}`);
      out.push(`${bookName(meta)} (${meta.id}), ${r.matched} ${name}${r.matched === 1 ? '' : 's'}${r.matched > r.hits.length ? `, the best ${r.hits.length}` : ''}:\n${lines.join('\n')}`);
    }
  } finally {
    scanner.close();
  }
  const head = matched ? `"${query.slice(0, 120)}" — found in ${matched} place${matched === 1 ? '' : 's'}. read_book reads a page.` : `"${query.slice(0, 120)}" — not found in ${books.length === 1 ? 'this book' : `the student's ${books.length} books`}.`;
  return [head, ...out, ...(skipped.length ? [`Not searched:\n${skipped.map(s => `- ${s}`).join('\n')}`] : [])].join('\n\n');
}

const TOOLS = { list_books: listTool, read_book: readTool, search_books: searchTool };

/** Runs one of the book tools: { content, isError }. */
export async function bookTool(name, args) {
  try {
    return { content: await TOOLS[name](args), isError: false };
  } catch (e) {
    if (e instanceof BookError) return { content: e.message, isError: true };
    throw e;
  }
}
