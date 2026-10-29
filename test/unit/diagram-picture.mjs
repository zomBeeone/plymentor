// Pictures of book diagrams for the tests (Book reader): a page with boards drawn the way old books print them — dark
// squares hatched with thin diagonal lines, white pieces outlined, black pieces solid — with simple shapes for the
// pieces (each kind its own outline).

const SHAPES = {
  p: [[0.42, 0.3], [0.58, 0.3], [0.62, 0.4], [0.56, 0.52], [0.66, 0.78], [0.34, 0.78], [0.44, 0.52], [0.38, 0.4]],
  r: [[0.28, 0.22], [0.36, 0.22], [0.36, 0.3], [0.46, 0.3], [0.46, 0.22], [0.54, 0.22], [0.54, 0.3], [0.64, 0.3], [0.64, 0.22], [0.72, 0.22], [0.72, 0.38], [0.66, 0.42], [0.66, 0.7], [0.74, 0.8], [0.26, 0.8], [0.34, 0.7], [0.34, 0.42], [0.28, 0.38]],
  b: [[0.5, 0.16], [0.62, 0.34], [0.6, 0.52], [0.7, 0.8], [0.3, 0.8], [0.4, 0.52], [0.38, 0.34]],
  q: [[0.2, 0.26], [0.34, 0.5], [0.38, 0.2], [0.5, 0.46], [0.62, 0.2], [0.66, 0.5], [0.8, 0.26], [0.72, 0.8], [0.28, 0.8]],
  k: [[0.44, 0.12], [0.56, 0.12], [0.56, 0.2], [0.64, 0.2], [0.64, 0.29], [0.56, 0.29], [0.56, 0.34], [0.72, 0.42], [0.66, 0.8], [0.34, 0.8], [0.28, 0.42], [0.44, 0.34], [0.44, 0.29], [0.36, 0.29], [0.36, 0.2], [0.44, 0.2]],
  n: [[0.34, 0.8], [0.36, 0.56], [0.26, 0.5], [0.28, 0.38], [0.46, 0.24], [0.5, 0.14], [0.56, 0.24], [0.7, 0.36], [0.72, 0.8]],
};

/** Fills a polygon (pixel points) with `v` (even-odd, by scanlines). */
function fillPolygon(img, pts, v) {
  const ys = pts.map(p => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(img.height - 1, Math.ceil(Math.max(...ys))); y++) {
    const cy = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if (y1 <= cy !== y2 <= cy) xs.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.round(xs[k])); x < Math.min(img.width, Math.round(xs[k + 1])); x++) img.data[y * img.width + x] = v;
  }
}

/** Draws a polygon's outline, `w` pixels wide (each side a filled quadrilateral, each corner a square). */
function strokePolygon(img, pts, w, v) {
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = ((y1 - y2) / len) * (w / 2);
    const ny = ((x2 - x1) / len) * (w / 2);
    fillPolygon(img, [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]], v);
    fillPolygon(img, [[x1 - w / 2, y1 - w / 2], [x1 + w / 2, y1 - w / 2], [x1 + w / 2, y1 + w / 2], [x1 - w / 2, y1 + w / 2]], v);
  }
}

/** Draws a board at (x0, y0), squares of `size` pixels, with a FEN placement on it. */
export function drawBoard(img, x0, y0, size, placement) {
  const rows = placement.split('/').map(r => r.replace(/\d/g, d => '.'.repeat(Number(d))));
  const n = size * 8;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dark = (Math.floor(x / size) + Math.floor(y / size)) % 2 === 1;
      img.data[(y0 + y) * img.width + x0 + x] = dark && (x + y) % 5 < 2 ? 0 : 255;
    }
  // the frame
  for (let k = -4; k < n + 4; k++)
    for (let t = 1; t <= 3; t++)
      for (const [x, y] of [[x0 + k, y0 - t], [x0 + k, y0 + n + t - 1], [x0 - t, y0 + k], [x0 + n + t - 1, y0 + k]]) img.data[y * img.width + x] = 0;
  rows.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (ch === '.') return;
      const pts = SHAPES[ch.toLowerCase()].map(([x, y]) => [x0 + c * size + x * size, y0 + r * size + y * size]);
      // a piece covers the hatching: white with a margin, then outlined (a white piece) or solid (a black one)
      const w = Math.max(2, Math.round(size * 0.05));
      strokePolygon(img, pts, w * 3, 255);
      fillPolygon(img, pts, ch === ch.toLowerCase() ? 0 : 255);
      strokePolygon(img, pts, w, 0);
    }),
  );
}

/**
 * Draws a board the way ebooks show them, at (x0, y0), squares of `size` pixels: dark squares of a plain tone (`dark`:
 * grey, or a colour's grey), light ones `light`, a thin frame, a FEN placement on it (white pieces outlined, black ones
 * solid). A picture with a saturation (`img.sat`) gets the squares' (`darkSat`, `lightSat`: a colour's); `marks`
 * colours squares to mark them (a move's): { e4: [tone, saturation] }.
 */
export function drawPlainBoard(img, x0, y0, size, placement, { dark = 170, light = 245, darkSat = 0, lightSat = 0, marks = {} } = {}) {
  const rows = placement.split('/').map(r => r.replace(/\d/g, d => '.'.repeat(Number(d))));
  const n = size * 8;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const [c, r] = [Math.floor(x / size), Math.floor(y / size)];
      const mark = marks[`${'abcdefgh'[c]}${8 - r}`];
      const i = (y0 + y) * img.width + x0 + x;
      img.data[i] = mark ? mark[0] : (c + r) % 2 === 1 ? dark : light;
      if (img.sat) img.sat[i] = mark ? mark[1] : (c + r) % 2 === 1 ? darkSat : lightSat;
    }
  for (let k = -2; k < n + 2; k++)
    for (let t = 1; t <= 2; t++) for (const [x, y] of [[x0 + k, y0 - t], [x0 + k, y0 + n + t - 1], [x0 - t, y0 + k], [x0 + n + t - 1, y0 + k]]) img.data[y * img.width + x] = 0;
  rows.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (ch === '.') return;
      const pts = SHAPES[ch.toLowerCase()].map(([x, y]) => [x0 + c * size + x * size, y0 + r * size + y * size]);
      fillPolygon(img, pts, ch === ch.toLowerCase() ? 0 : 255);
      strokePolygon(img, pts, Math.max(2, Math.round(size * 0.05)), 0);
    }),
  );
}

/** Each test piece alone on a light square of `size` pixels (a white piece): a "font's" pieces to read boards by. */
export function pieceSquares(size) {
  return Object.keys(SHAPES).map(type => {
    const img = blankPage(size, size);
    const pts = SHAPES[type].map(([x, y]) => [x * size, y * size]);
    strokePolygon(img, pts, Math.max(2, Math.round(size * 0.05)), 0);
    return { type, img };
  });
}

/** A white page (width × height, grey pixels; with a saturation, all grey, when `sat`). */
export function blankPage(width, height, { sat = false } = {}) {
  return { width, height, data: new Uint8Array(width * height).fill(255), ...(sat ? { sat: new Uint8Array(width * height) } : {}) };
}

function fillRect(img, x0, y0, w, h, v) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) img.data[y * img.width + x] = v;
}

/**
 * The coordinates printed around a board drawn at (x0, y0), squares of `size` pixels: a digit left of each rank (a
 * stroke with a foot), a letter under each file (a small ring).
 */
export function drawCoordinates(img, x0, y0, size) {
  const g = Math.max(6, Math.round(size * 0.24)); // (a glyph's height)
  for (let k = 0; k < 8; k++) {
    const dx = x0 - Math.round(size * 0.35);
    const dy = y0 + k * size + Math.round((size - g) / 2);
    fillRect(img, dx, dy, 2, g, 0);
    fillRect(img, dx - 2, dy + g - 2, 6, 2, 0);
    const lx = x0 + k * size + Math.round((size - g) / 2);
    const ly = y0 + 8 * size + Math.round(size * 0.2);
    fillRect(img, lx, ly, g, g, 0);
    fillRect(img, lx + 2, ly + 2, g - 4, g - 4, 255);
  }
}

/** Lines of text (words of letters: stems with a bar on top) from (x0, y0), `width` pixels wide, `count` of them. */
export function drawText(img, x0, y0, width, count, pitch = 24) {
  const h = Math.round(pitch * 0.45);
  for (let l = 0, k = 0; l < count; l++)
    for (let x = x0; x < x0 + width; k++) {
      const w = Math.min(20 + ((k * 37) % 60), x0 + width - x);
      for (let cx = x; cx < x + w - 4; cx += 6) {
        fillRect(img, cx, y0 + l * pitch, 2, h, 30);
        fillRect(img, cx, y0 + l * pitch, 5, 2, 30);
      }
      x += w + 12;
    }
}
