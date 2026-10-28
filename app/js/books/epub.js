// EPUB books (Book reader): an EPUB is a ZIP archive of XHTML chapters. This reads the archive (with the browser's own
// DecompressionStream), the book's metadata, its chapters in reading order and their titles, and turns each chapter
// into plain blocks of text and pictures — nothing of the book's markup, styles, scripts or links reaches the page.

// ---------------------------------------------------------------------------------------------
// ZIP

/** The files of a ZIP archive (a Blob): { names, has(name), bytes(name), text(name) }. */
export async function openZip(blob) {
  const tailStart = Math.max(0, blob.size - 65_557);
  const tail = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('This is not an EPUB file (no ZIP directory).');
  const end = new DataView(tail.buffer, eocd);
  const count = end.getUint16(10, true);
  const dirSize = end.getUint32(12, true);
  const dirAt = end.getUint32(16, true);
  if (dirAt === 0xffffffff || dirAt + dirSize > blob.size) throw new Error('This EPUB file is damaged or too large.');
  const dir = new Uint8Array(await blob.slice(dirAt, dirAt + dirSize).arrayBuffer());
  const dv = new DataView(dir.buffer);
  const utf8 = new TextDecoder();
  const entries = new Map();
  for (let p = 0, i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('This EPUB file is damaged.');
    const flags = dv.getUint16(p + 8, true);
    const nameLength = dv.getUint16(p + 28, true);
    const name = utf8.decode(dir.subarray(p + 46, p + 46 + nameLength));
    entries.set(name, { encrypted: !!(flags & 1), method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), at: dv.getUint32(p + 42, true) });
    p += 46 + nameLength + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  const zip = {
    names: [...entries.keys()],
    has: name => entries.has(name),
    async bytes(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`The EPUB has no ${name}.`);
      if (e.encrypted) throw new Error('This book is protected (DRM): it cannot be read here.');
      const head = new DataView(await blob.slice(e.at, e.at + 30).arrayBuffer());
      if (head.getUint32(0, true) !== 0x04034b50) throw new Error('This EPUB file is damaged.');
      const from = e.at + 30 + head.getUint16(26, true) + head.getUint16(28, true);
      const raw = blob.slice(from, from + e.size);
      if (e.method === 0) return new Uint8Array(await raw.arrayBuffer());
      if (e.method !== 8) throw new Error(`The EPUB uses a compression this reader does not know (${name}).`);
      return new Uint8Array(await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    },
    async text(name) {
      return utf8.decode(await zip.bytes(name));
    },
  };
  return zip;
}

// ---------------------------------------------------------------------------------------------
// The book

const xml = text => new DOMParser().parseFromString(text, 'application/xml');
const byTag = (doc, tag) => [...doc.getElementsByTagNameNS('*', tag)];
const textOf = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/** A path inside the archive, from `href` written in the file `base`. */
export function resolvePath(base, href) {
  try {
    return decodeURIComponent(new URL(href, `http://epub/${base}`).pathname.slice(1));
  } catch {
    return '';
  }
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

/**
 * Opens an EPUB (a Blob): { title, author, language, chapters: [{ path, title }], cover (path or null),
 * chapter(i) → { blocks } (see blocksOf), image(path) → an object URL, close() }.
 */
export async function openEpub(blob) {
  const zip = await openZip(blob);
  if (zip.has('META-INF/encryption.xml')) {
    const enc = xml(await zip.text('META-INF/encryption.xml'));
    // fonts may be obfuscated (the reader does not use them); anything else encrypted is DRM
    const locked = byTag(enc, 'CipherReference').map(r => r.getAttribute('URI') || '').filter(u => !/\.(otf|ttf|woff2?)$/i.test(u));
    if (locked.length) throw new Error('This book is protected (DRM): it cannot be read here.');
  }
  const container = xml(await zip.text('META-INF/container.xml'));
  const opfPath = byTag(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('This EPUB has no package file.');
  const opf = xml(await zip.text(opfPath));
  const manifest = new Map(byTag(opf, 'item').map(it => [it.getAttribute('id'), { path: resolvePath(opfPath, it.getAttribute('href') || ''), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' }]));
  const spine = byTag(opf, 'itemref')
    .filter(r => r.getAttribute('linear') !== 'no')
    .map(r => manifest.get(r.getAttribute('idref')))
    .filter(it => it && /html/.test(it.type));
  if (!spine.length) throw new Error('This EPUB has no chapters.');
  const titles = await tocTitles(zip, opf, manifest);
  const coverId = byTag(opf, 'meta').find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const cover = [...manifest.values()].find(it => /cover-image/.test(it.props))?.path || manifest.get(coverId)?.path || null;
  const urls = new Map();
  return {
    title: textOf(byTag(opf, 'title')[0]) || '',
    author: textOf(byTag(opf, 'creator')[0]) || '',
    language: textOf(byTag(opf, 'language')[0]) || '',
    cover,
    chapters: spine.map((it, i) => ({ path: it.path, title: titles.get(it.path) || `Chapter ${i + 1}` })),
    async chapter(i) {
      const path = spine[i].path;
      const source = await zip.text(path);
      let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
      if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(source, 'text/html');
      return { blocks: blocksOf(doc.body || doc.documentElement, path) };
    },
    async image(path) {
      if (!urls.has(path)) {
        const type = IMAGE_TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
        urls.set(path, zip.bytes(path).then(bytes => URL.createObjectURL(new Blob([bytes], { type }))));
      }
      return urls.get(path);
    },
    close() {
      for (const u of urls.values()) u.then(URL.revokeObjectURL, () => {});
      urls.clear();
    },
  };
}

/** Chapter titles from the table of contents (EPUB 3 nav, or EPUB 2 toc.ncx): path → title. */
async function tocTitles(zip, opf, manifest) {
  const titles = new Map();
  const add = (base, href, title) => {
    const path = resolvePath(base, String(href || '').split('#')[0]);
    if (path && title && !titles.has(path)) titles.set(path, title);
  };
  try {
    const nav = [...manifest.values()].find(it => /\bnav\b/.test(it.props));
    if (nav) {
      const doc = new DOMParser().parseFromString(await zip.text(nav.path), 'application/xhtml+xml');
      for (const a of byTag(doc, 'a')) add(nav.path, a.getAttribute('href'), textOf(a));
    }
    const ncxId = byTag(opf, 'spine')[0]?.getAttribute('toc');
    const ncx = manifest.get(ncxId) || [...manifest.values()].find(it => it.type === 'application/x-dtbncx+xml');
    if (ncx && !titles.size) {
      const doc = xml(await zip.text(ncx.path));
      for (const p of byTag(doc, 'navPoint')) add(ncx.path, byTag(p, 'content')[0]?.getAttribute('src'), textOf(byTag(p, 'text')[0]));
    }
  } catch {
    /* no table of contents: "Chapter n" */
  }
  return titles;
}

// ---------------------------------------------------------------------------------------------
// A chapter as blocks

const BLOCKS = new Set(['p', 'div', 'section', 'article', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'pre', 'figure', 'figcaption', 'table', 'tr', 'td', 'th', 'caption', 'ul', 'ol', 'dl', 'header', 'footer', 'aside', 'main', 'center', 'hr', 'body', 'tbody', 'thead', 'tfoot']);
const SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'object', 'embed', 'iframe', 'audio', 'video', 'canvas', 'form', 'input', 'button', 'select', 'textarea', 'math', 'template', 'noscript']);
const KIND = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4', li: 'li', blockquote: 'quote', pre: 'pre', figcaption: 'caption', caption: 'caption' };
const MARKS = { b: 'b', strong: 'b', i: 'i', em: 'i', cite: 'i', sup: 'sup', sub: 'sub' };

/**
 * The blocks of a chapter, in reading order: { kind: 'p' | 'h1'…'h4' | 'li' | 'quote' | 'pre' | 'caption', runs: [{ text,
 * b, i, sup, sub }] } or { kind: 'img', path, alt } (a picture: a diagram, most often). A small inline picture with a
 * short alternative text (a figurine: "N", "♘") is that text.
 */
export function blocksOf(root, base) {
  const blocks = [];
  let block = null;
  const marks = [];
  const kinds = []; // the kinds of the blocks the text is in (a list item's paragraphs are the list item)
  const flush = () => {
    if (block && block.runs.some(r => /\S/.test(r.text))) {
      const first = block.runs[0];
      first.text = first.text.replace(/^\s+/, '');
      const last = block.runs.at(-1);
      last.text = last.text.replace(/\s+$/, '');
      blocks.push(block);
    }
    block = null;
  };
  const text = (s, pre) => {
    block ||= { kind: kinds.at(-1) || 'p', runs: [] };
    const t = pre ? s : s.replace(/\s+/g, ' ');
    const m = Object.fromEntries(marks.map(k => [k, true]));
    const last = block.runs.at(-1);
    if (last && ['b', 'i', 'sup', 'sub'].every(k => !!last[k] === !!m[k])) last.text += t;
    else block.runs.push({ text: t, ...m });
  };
  const walk = (node, pre) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        text(child.data, pre);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.localName.toLowerCase();
      if (SKIP.has(tag) || child.getAttribute('aria-hidden') === 'true') continue;
      if (tag === 'br') text('\n', true);
      else if (tag === 'img' || tag === 'image') {
        const href = child.getAttribute('src') || child.getAttribute('href') || child.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
        const alt = (child.getAttribute('alt') || '').trim();
        if (alt && alt.length <= 2) text(alt, pre);
        else if (href) {
          flush();
          blocks.push({ kind: 'img', path: resolvePath(base, href), alt });
        }
      } else if (BLOCKS.has(tag) || tag === 'svg') {
        flush();
        if (KIND[tag]) kinds.push(KIND[tag]);
        walk(child, pre || tag === 'pre');
        flush();
        if (KIND[tag]) kinds.pop();
      } else {
        const mark = MARKS[tag];
        if (mark) marks.push(mark);
        walk(child, pre);
        if (mark) marks.pop();
      }
    }
  };
  walk(root, false);
  flush();
  return blocks;
}
