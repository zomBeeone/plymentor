// The student's books (Book reader): the files they added — PDF or EPUB — with what the reader knows about each (title,
// author, where they stopped reading, a cover picture), in the window's own storage (the origin-private file system,
// in %LOCALAPPDATA%\Plymentor\app, next to the games database): books/<id>.pdf|.epub, <id>.json, <id>.cover.webp and
// <id>.text.json (a PDF's text, read once). A book's id is the start of its SHA-256: the same file is added once.
import { openEpub } from './epub.js';
import { openPdf, closePdf, pdfInfo, drawPage } from './pdf.js';

const FORMATS = { pdf: 'application/pdf', epub: 'application/epub+zip' };

async function folder() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('books', { create: true });
}

// The writes go one after the other, and a read waits for the ones under way: a file read while a write replaces it
// cannot be read (the list of books would leave out the book the reader was saving as the student went back to it).
let writing = Promise.resolve();

function write(name, data) {
  const done = writing.then(async () => {
    const handle = await (await folder()).getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
  });
  writing = done.catch(() => {});
  return done;
}

async function read(name) {
  await writing;
  try {
    return await (await (await folder()).getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

async function readJson(name) {
  const f = await read(name);
  if (!f) return null;
  try {
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}

/** The books, the last opened first: [{ id, format, title, author, size, pages, added, opened, at, progress }]. */
export async function listBooks() {
  await writing;
  const dir = await folder();
  const out = [];
  for await (const [name] of dir.entries()) {
    if (!/^[0-9a-f]{20}\.json$/.test(name)) continue;
    const meta = await readJson(name);
    if (meta?.id) out.push(meta);
  }
  return out.sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
}

export const getBook = id => readJson(`${id}.json`);
export const saveBook = meta => write(`${meta.id}.json`, JSON.stringify(meta));
export const bookFile = meta => read(`${meta.id}.${meta.format}`);
export const coverUrl = async meta => {
  const f = await read(`${meta.id}.cover.webp`);
  return f ? URL.createObjectURL(f) : null;
};
export const loadCache = id => readJson(`${id}.text.json`);
export const saveCache = (id, data) => write(`${id}.text.json`, JSON.stringify(data));

/** Adds a book (a File the student chose). Returns { meta, added } — added false when it was there already. */
export async function addBook(file) {
  const format = /\.epub$/i.test(file.name) || file.type === FORMATS.epub ? 'epub' : /\.pdf$/i.test(file.name) || file.type === FORMATS.pdf ? 'pdf' : null;
  if (!format) throw new Error('Choose a PDF or EPUB file.');
  const bytes = await file.arrayBuffer();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const id = [...hash.slice(0, 10)].map(b => b.toString(16).padStart(2, '0')).join('');
  const known = await getBook(id);
  if (known) return { meta: known, added: false };
  const name = file.name.replace(/\.(pdf|epub)$/i, '').replace(/[_]+/g, ' ').trim();
  const meta = { id, format, title: name, author: '', size: file.size, pages: 0, added: Date.now(), opened: 0, at: null, progress: 0 };
  let cover = null;
  if (format === 'epub') {
    const book = await openEpub(new Blob([bytes]));
    try {
      Object.assign(meta, { title: book.title || name, author: book.author, language: book.language, pages: book.chapters.length });
      if (book.cover) cover = await picture(await book.image(book.cover));
    } finally {
      book.close();
    }
  } else {
    const doc = await openPdf(bytes.slice(0));
    try {
      const info = await pdfInfo(doc);
      Object.assign(meta, { title: info.title && !/^untitled|\.(docx?|indd|tex|pdf)$/i.test(info.title) ? info.title : name, author: info.author, pages: info.pages });
      cover = await pdfCover(doc);
    } finally {
      closePdf(doc);
    }
  }
  await write(`${id}.${format}`, bytes);
  if (cover) await write(`${id}.cover.webp`, cover).catch(() => {});
  await saveBook(meta);
  return { meta, added: true };
}

/** Removes a book and everything kept for it. */
export async function removeBook(id) {
  const dir = await folder();
  for await (const [name] of dir.entries()) if (name.startsWith(`${id}.`)) await dir.removeEntry(name).catch(() => {});
}

// A cover: the EPUB's picture, or the PDF's first page, 240 px wide.
async function picture(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = Math.round((240 * img.naturalHeight) / img.naturalWidth) || 320;
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.8));
}

async function pdfCover(doc) {
  try {
    const page = await doc.getPage(1);
    const scale = 240 / page.getViewport({ scale: 1 }).width;
    const canvas = document.createElement('canvas');
    await drawPage(doc, 1, { canvas, layer: document.createElement('div'), scale });
    const small = document.createElement('canvas');
    small.width = 240;
    small.height = Math.round((canvas.height * 240) / canvas.width);
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    return await new Promise(resolve => small.toBlob(resolve, 'image/webp', 0.8));
  } catch {
    return null;
  }
}
