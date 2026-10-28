// Small chess books for the Book reader's tests — the same text as an EPUB and as a PDF: a Najdorf with a variation
// in brackets, a note, a move only named, a square, a diagram, then a second game, and a third in descriptive notation
// ("P-K4") with a diagram of its own; and a scanned book (a page that is a picture: its text and hatched diagrams).
// The EPUB's diagrams are pictures of boards, as ebooks have them: the app's piece sets on coloured or grey squares.
//   node test/e2e/make-books.mjs <folder>   writes test-book.epub, test-book.pdf and scanned-book.pdf there
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';

export const CHAPTERS = [
  {
    title: 'The Najdorf',
    paragraphs: [
      'Game 1',
      '1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6 6.Bg5 e6 7.f4 Be7 8.Qf3 Qc7 9.O-O-O Nbd7',
      'Now 10.g4 is the sharpest move. (10.Bd3 b5 11.Rhe1 Bb7 is calmer.) 10...b5 11.Bxf6 Nxf6 12.g5 Nd7 13.f5',
      'White wants the d5 square for a knight. Black can also consider ...Bb7 here.',
      '13...Nc5 14.f6 gxf6 15.gxf6 Bf8',
      // (the position after 15...Bf8)
      { diagram: 'r1b1kb1r/2q2p1p/p2ppP2/1pn5/3NP3/2N2Q2/PPP4P/2KR1B1R', set: 'merida', dark: '#b58863', light: '#f0d9b5', alt: 'Diagram: the position after 15...Bf8' },
      'The position after 15...Bf8. White has a big lead in development.',
    ],
  },
  {
    title: 'A Queen\'s Gambit',
    paragraphs: ['Game 2', '1.d4 Nf6 2.c4 e6 3.Nc3 Bb4 4.e3 O-O 5.Bd3 d5 6.Nf3 c5', 'Both sides have developed quickly. Black is fine.'],
  },
  {
    title: 'An Old Game',
    paragraphs: [
      'Game 3',
      '1. P-K4 P-K4 2. Kt-KB3 Kt-QB3 3. B-Kt5 P-QR3 4. B-R4 Kt-B3 5. Castles B-K2',
      'The main line goes on 6. R-K1 P-QKt4 7. B-Kt3 P-Q3 8. P-B3 Castles, and the position is this:',
      // (the position after 8...O-O)
      { diagram: 'r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1', set: 'cburnett', dark: '#a9a9a9', light: '#ffffff', alt: 'Diagram 2' },
      'White to play. 9. P-KR3 Kt-QR4 10. B-B2 P-B4 11. P-Q4 Q-B2',
    ],
  },
];

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PIECES = join(dirname(fileURLToPath(import.meta.url)), '../../app/assets/piece');

/** A diagram as an ebook has it: a PNG of a board — squares of two colours, a frame, the app's pieces (`set`). */
export async function diagramPng({ diagram, set, dark, light }) {
  const { default: sharp } = await import('sharp');
  const sq = 46;
  const m = 14;
  const size = sq * 8 + 2 * m;
  let rects = '';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) rects += `<rect x="${m + c * sq}" y="${m + r * sq}" width="${sq}" height="${sq}" fill="${(r + c) % 2 ? dark : light}"/>`;
  const board = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#fff"/>${rects}<rect x="${m - 1.5}" y="${m - 1.5}" width="${sq * 8 + 3}" height="${sq * 8 + 3}" fill="none" stroke="#000" stroke-width="2"/></svg>`;
  const pieces = [];
  diagram.split('/').forEach((row, r) => {
    let c = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) c += Number(ch);
      else pieces.push({ file: join(PIECES, set, `${ch === ch.toUpperCase() ? 'w' : 'b'}${ch.toUpperCase()}.svg`), left: m + c++ * sq, top: m + r * sq });
    }
  });
  const composite = await Promise.all(pieces.map(async p => ({ input: await sharp(p.file).resize(sq, sq).png().toBuffer(), left: p.left, top: p.top })));
  return sharp(Buffer.from(board)).composite(composite).png().toBuffer();
}

const coverSvg = () => '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#2c6ab0"/><text x="150" y="200" font-size="34" text-anchor="middle" fill="#fff" font-family="serif">Test Chess Book</text></svg>';

// ---------------------------------------------------------------------------------------------
// EPUB (a ZIP: "mimetype" first and stored, the rest deflated)

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, store] of files) {
    const data = Buffer.from(content);
    const packed = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt32LE(crc32(data) >>> 0, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(store ? 0 : 8, 10);
    dir.writeUInt32LE(crc32(data) >>> 0, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, packed);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

export async function makeEpub(file) {
  const chapter = (ch, i) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(ch.title)}</title><style>p { color: red }</style><script>alert(1)</script></head>
<body><h1>${esc(ch.title)}</h1>
${ch.paragraphs.map(p => (typeof p === 'string' ? (/^Game/.test(p) ? `<h2>${esc(p)}</h2>` : `<p>${esc(p).replace(/(\d+\.\.\.|\d+\.)([A-Za-z]+\d*)/, '<b>$1$2</b>')}</p>`) : `<figure><img src="images/diagram${i}.png" alt="${esc(p.alt)}"/></figure>`)).join('\n')}
<p><a href="ch2.xhtml" onclick="alert(2)">Next chapter</a></p>
</body></html>`;
  const diagrams = await Promise.all(CHAPTERS.map(ch => ch.paragraphs.find(p => typeof p !== 'string')).map(d => d && diagramPng(d)));
  const files = [
    ['mimetype', 'application/epub+zip', true],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    [
      'OEBPS/content.opf',
      `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">plymentor-test-book</dc:identifier><dc:title>Test Chess Book</dc:title><dc:creator>Plymentor Tests</dc:creator><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>${CHAPTERS.map((_, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>${diagrams[i] ? `<item id="d${i}" href="images/diagram${i}.png" media-type="image/png"/>` : ''}`).join('')}</manifest>
<spine>${CHAPTERS.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('')}</spine></package>`,
    ],
    ['OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${CHAPTERS.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${esc(c.title)}</a></li>`).join('')}</ol></nav></body></html>`],
    ['OEBPS/images/cover.svg', coverSvg()],
    ...CHAPTERS.flatMap((ch, i) => [[`OEBPS/ch${i + 1}.xhtml`, chapter(ch, i)], ...(diagrams[i] ? [[`OEBPS/images/diagram${i}.png`, diagrams[i], true]] : [])]),
  ];
  writeFileSync(file, zip(files));
}

// ---------------------------------------------------------------------------------------------
// PDF (Helvetica, one page per chapter, lines wrapped at 80 characters, the diagram drawn as squares)

function wrap(text, width = 80) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

export function makePdf(file) {
  const pdfText = s => s.replace(/[\\()]/g, c => `\\${c}`);
  const contents = CHAPTERS.map(ch => {
    let y = 780;
    const ops = [`BT /F2 18 Tf 56 ${y} Td (${pdfText(ch.title)}) Tj ET`];
    y -= 34;
    for (const p of ch.paragraphs) {
      if (typeof p !== 'string') {
        // the diagram: 8x8 squares
        const size = 20;
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) ops.push(`${(r + c) % 2 ? '0.7 0.53 0.39' : '0.94 0.85 0.71'} rg ${200 + c * size} ${y - (r + 1) * size} ${size} ${size} re f`);
        ops.push('0 g');
        y -= 8 * size + 18;
        continue;
      }
      for (const line of wrap(p)) {
        ops.push(`BT /F1 12 Tf 56 ${y} Td (${pdfText(line)}) Tj ET`);
        y -= 16;
      }
      y -= 8;
    }
    return ops.join('\n');
  });
  const objects = [];
  const pageIds = contents.map((_, i) => 6 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = '<< /Title (Test Chess Book) /Author (Plymentor Tests) >>';
  contents.forEach((c, i) => {
    objects[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] = `<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    if (objects[id] === undefined) continue;
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += offsets[id] === undefined ? '0000000000 65535 f \n' : `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(file, Buffer.from(out, 'latin1'));
}

// ---------------------------------------------------------------------------------------------
// A scanned book: one page that is only a picture (300 dpi, grey), its text and two boards drawn the way old books
// print them (dark squares hatched): the starting position, and the position the moves under it reach.

export const SCANNED_LINES = [
  [200, 'Scanned Test Book', 64],
  [310, 'The pieces stand like this at the start:'],
  [1010, '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6'],
  [1090, 'This is the Ruy Lopez, after the third move of Black:'],
  [1790, '4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6'],
  [1870, 'Both sides have developed their pieces well.'],
];

export async function makeScannedPdf(file) {
  const { default: sharp } = await import('sharp');
  const { drawBoard } = await import('../unit/diagram-picture.mjs');
  const W = 1800;
  const H = 2700; // 6 × 9 inches
  const texts = SCANNED_LINES.map(([y, s, size = 44]) => `<text x="150" y="${y}" font-family="Georgia, 'Times New Roman', serif" font-size="${size}" fill="#000">${esc(s)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${texts}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const img = { width: W, height: H, data: new Uint8Array(W * H) };
  for (let i = 0; i < W * H; i++) img.data[i] = data[i * info.channels];
  drawBoard(img, 620, 360, 70, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
  drawBoard(img, 620, 1140, 70, 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R');
  const pixels = deflateSync(Buffer.from(img.data));
  const content = 'q 432 0 0 648 0 0 cm /Im1 Do Q';
  const objects = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 432 648] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    [`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`, pixels, '\nendstream'],
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Title (Scanned Test Book) /Author (Plymentor Tests) >>',
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let size = parts[0].length;
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = size;
    for (const p of [`${id} 0 obj\n`, ...[objects[id]].flat(), '\nendobj\n']) {
      const b = Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1');
      parts.push(b);
      size += b.length;
    }
  }
  let tail = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) tail += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  writeFileSync(file, Buffer.concat(parts));
}

if (process.argv[1]?.endsWith('make-books.mjs') && process.argv[2]) {
  mkdirSync(process.argv[2], { recursive: true });
  await makeEpub(join(process.argv[2], 'test-book.epub'));
  makePdf(join(process.argv[2], 'test-book.pdf'));
  await makeScannedPdf(join(process.argv[2], 'scanned-book.pdf'));
  console.log(`wrote test-book.epub, test-book.pdf and scanned-book.pdf in ${process.argv[2]}`);
}
