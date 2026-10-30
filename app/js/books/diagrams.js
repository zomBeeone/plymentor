// Chess diagrams in book pages (Book reader): finding the boards in a page's picture and reading their positions.
// Book diagrams draw the dark squares hatched with thin diagonal lines (or grey); the boards are found by that texture —
// dense diagonal strokes with few horizontal or vertical ones, which text does not have — and their 8×8 grid by the
// period of the hatching and the frame around it. Works on grey pictures: { width, height, data } (one byte per pixel,
// 0 black … 255 white), in the window (a canvas's pixels) and in Node (the tests).

/**
 * A grey picture from RGBA pixels (a canvas's ImageData), with each pixel's saturation (`sat`, 0 … 255): a square a
 * book colours to mark it is told from the board's own squares by it.
 */
export function grayFrom(rgba, width, height) {
  const data = new Uint8Array(width * height);
  const sat = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const r = rgba[j];
    const g = rgba[j + 1];
    const b = rgba[j + 2];
    data[i] = (r * 77 + g * 150 + b * 29) >> 8;
    const max = Math.max(r, g, b);
    sat[i] = max ? Math.round(((max - Math.min(r, g, b)) * 255) / max) : 0;
  }
  return { width, height, data, sat };
}

// A square more saturated than this (of 255) is coloured — a mark —, not one of the board's light or dark squares
// (a board's own squares are grey, or a pale colour: about 45 for a beige)
const COLOURED = 90;

/** Summed-area table of a 0/1 map (width+1 × height+1). */
function integral(map, width, height) {
  const w = width + 1;
  const sum = new Int32Array(w * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += map[y * width + x];
      sum[(y + 1) * w + x + 1] = sum[y * w + x + 1] + row;
    }
  }
  return { sum, w };
}
const box = (t, x0, y0, x1, y1) => t.sum[y1 * t.w + x1] - t.sum[y0 * t.w + x1] - t.sum[y1 * t.w + x0] + t.sum[y0 * t.w + x0];

/**
 * Where the picture is hatched: a 0/1 map on a coarse grid (cells of `step` pixels) — 1 where, around the cell, many
 * ink pixels continue diagonally and few horizontally or vertically. Returns { map, cols, rows, step }.
 */
export function hatchMap(img, { step = 4, window = 12, ink = 150 } = {}) {
  const { width: W, height: H, data } = img;
  const inkAt = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) inkAt[i] = data[i] < ink ? 1 : 0;
  const diag = new Uint8Array(W * H);
  const straight = new Uint8Array(W * H);
  for (let y = 3; y < H - 3; y++)
    for (let x = 3; x < W - 3; x++) {
      const i = y * W + x;
      if (!inkAt[i]) continue;
      // a "/" or "\" stroke through the pixel, 4 pixels long
      const up = inkAt[i - W + 1] && inkAt[i - 2 * W + 2] && inkAt[i - 3 * W + 3];
      const down = inkAt[i + W + 1] && inkAt[i + 2 * W + 2] && inkAt[i + 3 * W + 3];
      if (up || down) diag[i] = 1;
      if ((inkAt[i + 1] && inkAt[i + 2] && inkAt[i + 3]) || (inkAt[i + W] && inkAt[i + 2 * W] && inkAt[i + 3 * W])) straight[i] = 1;
    }
  const D = integral(diag, W, H);
  const S = integral(straight, W, H);
  const I = integral(inkAt, W, H);
  const cols = Math.floor(W / step);
  const rows = Math.floor(H / step);
  const map = new Uint8Array(cols * rows);
  const half = window >> 1;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const cx = c * step + (step >> 1);
      const cy = r * step + (step >> 1);
      const x0 = Math.max(0, cx - half);
      const y0 = Math.max(0, cy - half);
      const x1 = Math.min(W, cx + half);
      const y1 = Math.min(H, cy + half);
      const area = (x1 - x0) * (y1 - y0);
      const d = box(D, x0, y0, x1, y1) / area;
      const s = box(S, x0, y0, x1, y1) / area;
      const n = box(I, x0, y0, x1, y1) / area;
      // hatching: a good share of ink, most of it in diagonal strokes
      map[r * cols + c] = n > 0.12 && n < 0.75 && d > 0.1 && d > 1.6 * s ? 1 : 0;
    }
  return { map, cols, rows, step };
}

/** The connected regions of a 0/1 map (8-connected): [{ x0, y0, x1, y1, count }] in map cells. */
function regions(map, cols, rows) {
  const seen = new Uint8Array(map.length);
  const out = [];
  const stack = [];
  for (let start = 0; start < map.length; start++) {
    if (!map[start] || seen[start]) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    let count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % cols;
      const y = (i / cols) | 0;
      count++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const j = ny * cols + nx;
          if (map[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, count });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The grid of a board

/**
 * Hatching density around each pixel of a rectangle of the picture: the share of pixels on thin diagonal strokes (not on
 * horizontal or vertical runs, so neither solid black pieces nor lines count) in a (2r+1)² box. Float32Array w × h.
 */
function hatchDensity(img, rx, ry, w, h, r = 4, ink = 150) {
  const { width: W, data } = img;
  const at = (x, y) => (x >= 0 && y >= 0 && x < img.width && y < img.height && data[y * W + x] < ink ? 1 : 0);
  const fine = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const X = rx + x;
      const Y = ry + y;
      if (!at(X, Y)) continue;
      const diag = (at(X + 1, Y - 1) && at(X + 2, Y - 2)) || (at(X + 1, Y + 1) && at(X + 2, Y + 2)) || (at(X - 1, Y + 1) && at(X - 2, Y + 2));
      const straight = (at(X + 1, Y) && at(X + 2, Y) && at(X + 3, Y) && at(X - 1, Y)) || (at(X, Y + 1) && at(X, Y + 2) && at(X, Y + 3) && at(X, Y - 1));
      fine[y * w + x] = diag && !straight ? 1 : 0;
    }
  const t = integral(fine, w, h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const y0 = Math.max(0, y - r);
      const x1 = Math.min(w, x + r + 1);
      const y1 = Math.min(h, y + r + 1);
      out[y * w + x] = box(t, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
    }
  return out;
}

/** The best comb over an edge profile: { size, offset, score } — teeth every `size` pixels from `offset`. */
function comb(profile, sizes) {
  let best = { size: 0, offset: 0, score: -Infinity };
  for (const size of sizes)
    for (let offset = 0; offset < size; offset += 0.5) {
      let sum = 0;
      let n = 0;
      for (let p = offset; p < profile.length - 1; p += size) {
        const i = Math.floor(p);
        const f = p - i;
        sum += profile[i] * (1 - f) + profile[i + 1] * f;
        n++;
      }
      if (n < 3) continue;
      const score = sum / n;
      if (score > best.score) best = { size, offset, score };
    }
  return best;
}

/**
 * The 8×8 grid of a board around a hatched area (from findHatchedAreas): { x, y, size (of a square, in pixels), cols,
 * rows, firstDark (the top-left square shown is dark), dark: [row][col] hatched } — or null when no checkerboard is
 * there. A board shown in part (a few of its rows or files) gives fewer rows or columns.
 */
export function fitGrid(img, area) {
  const pad = Math.round(Math.max(area.width, area.height) * 0.14);
  const rx = Math.max(0, area.x - pad);
  const ry = Math.max(0, area.y - pad);
  const w = Math.min(img.width, area.x + area.width + pad) - rx;
  const h = Math.min(img.height, area.y + area.height + pad) - ry;
  const D = hatchDensity(img, rx, ry, w, h);
  // where the hatching starts or stops: the edges of the squares
  const ex = new Float32Array(w);
  const ey = new Float32Array(h);
  const d = 3;
  for (let y = 0; y < h; y++)
    for (let x = d; x < w - d; x++) {
      const v = Math.abs(D[y * w + x + d] - D[y * w + x - d]);
      ex[x] += v;
    }
  for (let y = d; y < h - d; y++)
    for (let x = 0; x < w; x++) ey[y] += Math.abs(D[(y + d) * w + x] - D[(y - d) * w + x]);
  // the square's size: an eighth of the area's width, give or take (a board shown in part: of its larger side)
  const guess = Math.max(area.width, area.height * (area.height > area.width ? 1 : 0)) / 8;
  const sizes = [];
  for (let s = guess * 0.72; s <= guess * 1.45; s += 0.25) sizes.push(s);
  let best = null;
  for (const s of sizes) {
    const bx = comb(ex, [s]);
    const by = comb(ey, [s]);
    const score = bx.score + by.score;
    if (!best || score > best.score) best = { size: s, ox: bx.offset, oy: by.offset, score };
  }
  if (!best) return null;
  const { size, ox, oy } = best;
  // the cells of the lattice over the region: hatched or not — measured in a ring along the cell's sides, where the
  // hatching shows even when a piece stands on the square
  const nc = Math.floor((w - ox) / size);
  const nr = Math.floor((h - oy) / size);
  const cell = (r, c) => {
    let sum = 0;
    let n = 0;
    const x0 = ox + c * size;
    const y0 = oy + r * size;
    for (let y = Math.round(y0 + size * 0.07); y < y0 + size * 0.93; y += 2)
      for (let x = Math.round(x0 + size * 0.07); x < x0 + size * 0.93; x += 2) {
        const edge = Math.min(x - x0, y - y0, x0 + size - x, y0 + size - y);
        if (edge > size * 0.22) continue;
        sum += D[y * w + x] || 0;
        n++;
      }
    return n ? sum / n : 0;
  };
  const dens = [];
  for (let r = 0; r < nr; r++) dens.push(Array.from({ length: nc }, (_, c) => cell(r, c)));
  // the hatched level: dark squares have it, light squares (and most pieces) not
  const all = dens.flat().sort((a, b) => a - b);
  const level = all.length ? all[Math.floor(all.length * 0.75)] : 0;
  if (level < 0.05) return null;
  const dark = dens.map(row => row.map(v => v > level * 0.45));
  // ink in the middle of each cell (a piece, which may hide a dark square's hatching)
  const inked = dens.map((row, r) =>
    row.map((_, c) => {
      let k = 0;
      let n = 0;
      const x0 = rx + ox + c * size;
      const y0 = ry + oy + r * size;
      for (let y = Math.round(y0 + size * 0.25); y < y0 + size * 0.75; y += 2)
        for (let x = Math.round(x0 + size * 0.25); x < x0 + size * 0.75; x += 2) {
          n++;
          if (x >= 0 && y >= 0 && x < img.width && y < img.height && img.data[y * img.width + x] < 150) k++;
        }
      return n && k / n > 0.2;
    }),
  );
  // the rectangle of cells (at most 8×8) that is most like a board: where a dark square should be, +1 when hatched,
  // -0.3 when not but inked (a piece hides the hatching), -2 when blank; where a light square should be, +1 when not
  // hatched, -2 when hatched (a light square never is)
  const value = (isDark, want, ink) => (want ? (isDark ? 1 : ink ? -0.3 : -2) : isDark ? -2 : 1);
  let found = null;
  for (const firstDark of [false, true])
    for (let r0 = 0; r0 < nr; r0++)
      for (let c0 = 0; c0 < nc; c0++) {
        // sums over growing rectangles from (r0, c0)
        const colSum = Array(Math.min(8, nc - c0)).fill(0);
        for (let rows = 1; rows <= Math.min(8, nr - r0); rows++) {
          const r = r0 + rows - 1;
          for (let k = 0; k < colSum.length; k++) {
            const want = ((r - r0 + k) & 1) === 1 ? !firstDark : firstDark;
            colSum[k] += value(dark[r][c0 + k], want, inked[r][c0 + k]);
          }
          let total = 0;
          let wanted = 0;
          for (let cols = 1; cols <= colSum.length; cols++) {
            total += colSum[cols - 1];
            for (let rr = 0; rr < rows; rr++) if ((((rr + cols - 1) & 1) === 1 ? !firstDark : firstDark) && dark[r0 + rr][c0 + cols - 1]) wanted++;
            if (rows * cols < 6 || wanted < 2) continue;
            if (!found || total > found.score) found = { r0, c0, rows, cols, firstDark, score: total };
          }
        }
      }
  if (!found) return null;
  // (a square's colour from its place on the board: a big piece can hide most of a dark square's hatching)
  return {
    x: rx + ox + found.c0 * size,
    y: ry + oy + found.r0 * size,
    size,
    cols: found.cols,
    rows: found.rows,
    firstDark: found.firstDark,
    dark: Array.from({ length: found.rows }, (_, r) => Array.from({ length: found.cols }, (_, c) => (((r + c) & 1) === 0) === found.firstDark)),
  };
}

// ---------------------------------------------------------------------------------------------
// The squares: the piece's silhouette, whatever the square's colour

export const CELL = 24; // the silhouettes' size

/** A 0/1 map eroded or dilated with a 3×3 square, `n` times. */
function morph(map, w, h, n, dilate) {
  let cur = map;
  for (let k = 0; k < n; k++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx;
            const Y = y + dy;
            const p = X < 0 || Y < 0 || X >= w || Y >= h ? 0 : cur[Y * w + X];
            if (dilate ? p : !p) v = dilate ? 1 : 0;
          }
        next[y * w + x] = v;
      }
    cur = next;
  }
  return cur;
}

/**
 * Whether a dark square's hatching is ink (`ink`: its 0/1 ink at the reading's cut, n × n pixels): its sides — where a
 * piece seldom reaches — have pixels on thin diagonal strokes (ink continuing diagonally, not on a straight run across
 * or down). A small scan's hatching may be lighter grey: no ink at all there.
 */
function hatchedInk(ink, n) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < n && y < n ? ink[y * n + x] : 0);
  let strokes = 0;
  let all = 0;
  const band = Math.max(2, Math.round(n * 0.18));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (Math.min(x, y, n - 1 - x, n - 1 - y) >= band) continue;
      all++;
      if (!ink[y * n + x]) continue;
      const diag = (at(x + 1, y - 1) && at(x + 2, y - 2)) || (at(x + 1, y + 1) && at(x + 2, y + 2)) || (at(x - 1, y + 1) && at(x - 2, y + 2)) || (at(x - 1, y - 1) && at(x - 2, y - 2));
      if (diag) strokes++;
    }
  return strokes >= all * 0.06;
}

/**
 * What is on one square: { silhouette (Float32Array CELL×CELL: the piece's shape, filled), area (its share of the
 * square), fill (the share of ink inside it: high for a black piece, low for a white one), ink (ink in the square) }.
 * The square's background — white, or hatched for a dark square — is everything reachable from the square's sides
 * between the ink; thin strokes left over (hatching, outlines) are taken off by opening, then the shape is filled. (A
 * piece whose outline is broken on a dark square comes out smaller: the book's other pieces of its kind make up for it.)
 */
export function cellShape(img, x0, y0, size, { ink = 150, darkSquare = false } = {}) {
  const inset = Math.max(1, Math.round(size * 0.04));
  const X = Math.round(x0) + inset;
  const Y = Math.round(y0) + inset;
  const n = Math.max(8, Math.round(size) - 2 * inset);
  const dark = new Uint8Array(n * n);
  let inkCount = 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = X + x;
      const py = Y + y;
      const v = px >= 0 && py >= 0 && px < img.width && py < img.height ? img.data[py * img.width + px] : 255;
      if (v < ink) {
        dark[y * n + x] = 1;
        inkCount++;
      }
    }
  // (a hatched square whose hatching is lighter than the ink — a small scan's grey strokes — is read as a light one:
  // only its pieces are ink)
  const crisp = darkSquare && hatchedInk(dark, n);
  // the background: reachable from the sides through light pixels (the ink grown by a pixel first, closing gaps in a
  // piece's outline — not on a square hatched in ink: that would close the hatching's gaps too)
  const walls = crisp ? dark : morph(dark, n, n, 1, true);
  const reach = new Uint8Array(n * n);
  const stack = [];
  for (let i = 0; i < n; i++) for (const p of [i, (n - 1) * n + i, i * n, i * n + n - 1]) if (!walls[p] && !reach[p]) (reach[p] = 1), stack.push(p);
  while (stack.length) {
    const p = stack.pop();
    const x = p % n;
    const y = (p / n) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const q = ny * n + nx;
        if (!reach[q] && !walls[q]) (reach[q] = 1), stack.push(q);
      }
  }
  // what is not background, without thin strokes (hatching, outlines), then grown back and filled
  const rest = new Uint8Array(n * n);
  for (let i = 0; i < rest.length; i++) rest[i] = reach[i] ? 0 : 1;
  const t = Math.max(1, Math.round(size / 40));
  let shape = morph(morph(rest, n, n, t, false), n, n, crisp ? t + 1 : t, true);
  let found = 0;
  for (let y = Math.round(n * 0.1); y < n * 0.9; y++) for (let x = Math.round(n * 0.1); x < n * 0.9; x++) found += shape[y * n + x];
  // (on a dark square: horizontal and vertical strokes in its middle — a piece's outline has them, hatching never)
  let straight = 0;
  if (crisp && found < n * n * 0.15)
    for (let y = Math.round(n * 0.15); y < n * 0.85; y++)
      for (let x = Math.round(n * 0.15); x < n * 0.85; x++) {
        const i = y * n + x;
        if (dark[i] && ((dark[i + 1] && dark[i + 2] && dark[i + 3] && dark[i + 4] && dark[i + 5]) || (dark[i + n] && dark[i + 2 * n] && dark[i + 3 * n] && dark[i + 4 * n] && dark[i + 5 * n]))) straight++;
      }
  if (straight > n * n * 0.025) {
    // A white piece whose outline has a gap: the background ran into it. Its strokes are curved, a hatching line is
    // straight (its pixels lie along one direction); the shape is what lies between the curved strokes both across
    // and down, without thin bits sticking out.
    const comp = new Int32Array(n * n).fill(-1);
    const glyph = new Uint8Array(n * n);
    let strokes = 0;
    for (let start = 0; start < dark.length; start++) {
      if (!dark[start] || comp[start] >= 0) continue;
      const pixels = [];
      stack.push(start);
      comp[start] = start;
      while (stack.length) {
        const p = stack.pop();
        pixels.push(p);
        const x = p % n;
        const y = (p / n) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
            const q = ny * n + nx;
            if (dark[q] && comp[q] < 0) (comp[q] = start), stack.push(q);
          }
      }
      if (pixels.length < 12) continue;
      // how much longer than wide: the spread of its pixels along their main direction against across it
      let mx = 0;
      let my = 0;
      for (const p of pixels) (mx += p % n), (my += (p / n) | 0);
      mx /= pixels.length;
      my /= pixels.length;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (const p of pixels) {
        const dx = (p % n) - mx;
        const dy = ((p / n) | 0) - my;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
      }
      const tr = sxx + syy;
      const det = sxx * syy - sxy * sxy;
      const root = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const long = tr / 2 + root;
      const across = Math.max(1e-6, tr / 2 - root);
      if (long / across > 25) continue;
      for (const p of pixels) glyph[p] = 1;
      strokes += pixels.length;
    }
    if (strokes > n * n * 0.03) {
      const minX = new Int32Array(n).fill(n);
      const maxX = new Int32Array(n).fill(-1);
      const minY = new Int32Array(n).fill(n);
      const maxY = new Int32Array(n).fill(-1);
      for (let i = 0; i < glyph.length; i++)
        if (glyph[i]) {
          const x = i % n;
          const y = (i / n) | 0;
          minX[y] = Math.min(minX[y], x);
          maxX[y] = Math.max(maxX[y], x);
          minY[x] = Math.min(minY[x], y);
          maxY[x] = Math.max(maxY[x], y);
        }
      const filled = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) for (let x = minX[y]; x <= maxX[y]; x++) if (y >= minY[x] && y <= maxY[x]) filled[y * n + x] = 1;
      const solid = morph(morph(filled, n, n, t + 1, false), n, n, t + 1, true);
      // only what looks like a white piece: about a piece's size, mostly light inside (a mark — a solid star — with
      // bits of hatching around it is neither)
      let size = 0;
      let inked = 0;
      for (let i = 0; i < solid.length; i++)
        if (solid[i]) {
          size++;
          if (dark[i]) inked++;
        }
      if (size > n * n * 0.12 && size < n * n * 0.6 && inked < size * 0.55) for (let i = 0; i < shape.length; i++) if (solid[i]) shape[i] = 1;
    }
  }
  // keep the parts near the middle (hatching left at the sides is no piece)
  const keep = new Uint8Array(n * n);
  const seen = new Uint8Array(n * n);
  for (let start = 0; start < shape.length; start++) {
    if (!shape[start] || seen[start]) continue;
    const comp = [];
    stack.push(start);
    seen[start] = 1;
    let cx = 0;
    let cy = 0;
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      const x = p % n;
      const y = (p / n) | 0;
      cx += x;
      cy += y;
      for (const q of [p - 1, p + 1, p - n, p + n]) {
        if (q < 0 || q >= shape.length || seen[q] || !shape[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === n - 1)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    cx /= comp.length;
    cy /= comp.length;
    const central = Math.abs(cx - n / 2) < n * 0.3 && Math.abs(cy - n / 2) < n * 0.32;
    if (central && comp.length > n * n * 0.012) for (const p of comp) keep[p] = 1;
  }
  shape = keep;
  // its ink and its area, and the shape at CELL × CELL; the colour from the ink of its core (the shape without its
  // outline: a white piece is hollow there, a black one solid)
  let area = 0;
  let inside = 0;
  let top = n;
  let bottom = -1;
  for (let i = 0; i < shape.length; i++)
    if (shape[i]) {
      area++;
      if (dark[i]) inside++;
      top = Math.min(top, (i / n) | 0);
      bottom = Math.max(bottom, (i / n) | 0);
    }
  const core = morph(shape, n, n, t + 1, false);
  let coreArea = 0;
  let coreInk = 0;
  for (let i = 0; i < core.length; i++)
    if (core[i]) {
      coreArea++;
      if (dark[i]) coreInk++;
    }
  const silhouette = new Float32Array(CELL * CELL);
  const f = n / CELL;
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      let s = 0;
      let k = 0;
      for (let yy = Math.floor(y * f); yy < Math.floor((y + 1) * f); yy++)
        for (let xx = Math.floor(x * f); xx < Math.floor((x + 1) * f); xx++) {
          s += shape[yy * n + xx];
          k++;
        }
      silhouette[y * CELL + x] = k ? s / k : 0;
    }
  return { silhouette, area: area / (n * n), height: bottom >= top ? (bottom - top + 1) / n : 0, fill: coreArea > area * 0.15 ? coreInk / coreArea : area ? inside / area : 0, ink: inkCount / (n * n) };
}

/**
 * An example of a piece (`type`: 'p' … 'k') from a picture of it alone on a light square (a chess font's or a piece
 * set's: grey pixels), made the way a book's squares are read — to read a book's boards by until its own pieces teach
 * better.
 */
export function pieceExample(type, img) {
  return { type, silhouette: cellShape(img, 0, 0, Math.min(img.width, img.height)).silhouette };
}

/** A silhouette less its mean, of length 1 (for fast correlations: dot products). */
function unit(s) {
  let m = 0;
  for (const v of s) m += v;
  m /= s.length;
  const u = new Float32Array(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    u[i] = s[i] - m;
    n += u[i] * u[i];
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < u.length; i++) u[i] /= n;
  return u;
}
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** How alike two silhouettes are (normalised correlation, the best of small shifts): -1 … 1. */
export function likeness(a, b, shift = 2) {
  let best = -1;
  for (let sy = -shift; sy <= shift; sy++)
    for (let sx = -shift; sx <= shift; sx++) {
      let ma = 0;
      let mb = 0;
      let n = 0;
      for (let y = 0; y < CELL; y++)
        for (let x = 0; x < CELL; x++) {
          const X = x + sx;
          const Y = y + sy;
          ma += a[y * CELL + x];
          mb += X >= 0 && Y >= 0 && X < CELL && Y < CELL ? b[Y * CELL + X] : 0;
          n++;
        }
      ma /= n;
      mb /= n;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let y = 0; y < CELL; y++)
        for (let x = 0; x < CELL; x++) {
          const X = x + sx;
          const Y = y + sy;
          const va = a[y * CELL + x] - ma;
          const vb = (X >= 0 && Y >= 0 && X < CELL && Y < CELL ? b[Y * CELL + X] : 0) - mb;
          num += va * vb;
          da += va * va;
          db += vb * vb;
        }
      const r = da && db ? num / Math.sqrt(da * db) : -1;
      if (r > best) best = r;
    }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Boards set in a chess font (a PDF's text: eight lines of eight characters, one per square)

// The characters of the usual chess fonts: the empty light and dark squares, and each character's piece — and which
// characters go on light squares (`onLight`), so that a board's squares can be checked against the font's rules.
const lowerOnLight = ch => ch === ch.toLowerCase();
const bothCases = pieces => Object.fromEntries(Object.entries(pieces).flatMap(([c, p]) => [[c, p], [c.toUpperCase(), p]]));
// Alpha, Merida, Leipzig… (Eric Bentzen's and Armando Marroquin's fonts): small letters on light squares
const ALPHA = bothCases({ k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', p: 'P', l: 'k', w: 'q', t: 'r', v: 'b', m: 'n', o: 'p' });
const TEX = Object.fromEntries([...'pnbrqkomaslj'].flatMap((c, i) => [[c, 'pnbrqk'[i % 6]], [c.toUpperCase(), 'PNBRQK'[i % 6]]]));
const FONTS = [
  // ChessBase's diagram fonts (New in Chess and many others): capitals on light squares
  { empty: '._', pieces: bothCases({ k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', i: 'P', m: 'k', d: 'q', t: 'r', l: 'b', s: 'n', j: 'p' }), onLight: ch => ch !== ch.toLowerCase() },
  { empty: ' +', pieces: ALPHA, onLight: lowerOnLight },
  // (some books' Alpha-like fonts draw the empty light square as "*")
  { empty: '*+', pieces: ALPHA, onLight: lowerOnLight },
  // TeX's chess fonts (skak, chessfss: books set with LaTeX): the case is the piece's colour, the letter the square's
  // (P N B R Q K on light squares, O M A S L J on dark ones)
  { empty: '0Z', pieces: TEX, onLight: ch => 'pnbrqk'.includes(ch.toLowerCase()) },
];

// The side to move, a square glyph by the board's bottom row: white (hollow) or black (filled).
const MARKS = { n: 'b', '■': 'b', '□': 'w', '\x86': 'w' };

/**
 * The runs of glyphs of a page's text items: an item, with the items right after it on the same line in the same font
 * and size — a font drawn square by square gives a board's row as eight items. [{ ids, str, x, y, h, w }]
 */
function glyphRuns(items) {
  const runs = [];
  let run = null;
  items.forEach((it, i) => {
    if (typeof it.str !== 'string' || !it.str || !it.transform) {
      run = null;
      return;
    }
    const [x, y] = [it.transform[4], it.transform[5]];
    const h = it.height || Math.abs(it.transform[3]);
    const last = run && items[run.ids.at(-1)];
    const next = last && it.fontName === last.fontName && Math.abs(y - run.y) < 0.3 && Math.abs(h - run.h) < 0.5 && Math.abs(x - (last.transform[4] + last.width)) < Math.max(1, h * 0.2);
    if (next) {
      run.ids.push(i);
      run.str += it.str;
      run.w += it.width;
      return;
    }
    run = { ids: [i], str: it.str, x, y, h, w: it.width || 0 };
    runs.push(run);
  });
  return runs;
}

/**
 * A row of a board in `font` within a run of glyphs (borders around it allowed): { offset, full (fewer than two empty
 * squares: a row of pieces — "rmblkans" — that only a board's other rows show to be one) } or null.
 */
function rowIn(run, font) {
  const glyphs = s => [...s].every(ch => font.empty.includes(ch) || Object.hasOwn(font.pieces, ch));
  const empty = s => [...s].filter(ch => font.empty.includes(ch)).length;
  const n = [...run.str].length;
  if (n < 8 || n > 12) return null;
  for (let offset = 0; offset + 8 <= n; offset++) {
    const s = [...run.str].slice(offset, offset + 8).join('');
    if (glyphs(s) && empty(s) >= 2) return { offset, full: false };
  }
  // (a row of pieces: the whole run, nothing around it)
  return n === 8 && glyphs(run.str) ? { offset: 0, full: true } : null;
}

/**
 * The boards set in a chess font among a PDF page's text items ({ str, transform, width, height, fontName }): eight
 * rows of eight characters (one item each, or one item per square), one under the other (a row drawn twice, in two
 * fonts, is one). The board's coordinates (rank numbers, file letters around it) are part of it. Returns [{ items (the
 * indices of its rows, coordinates and mark), rows (of its rows), placement (FEN), side ('w', 'b' or null: no mark),
 * x0, y0, x1, y1 (PDF points, y upwards) }].
 */
export function fontBoards(items) {
  const rows = [];
  for (const run of glyphRuns(items))
    for (const font of FONTS) {
      const r = rowIn(run, font);
      if (!r) continue;
      const each = run.w / [...run.str].length; // (one square's width)
      rows.push({ i: run.ids[0], ids: run.ids, str: [...run.str].slice(r.offset, r.offset + 8).join(''), x: run.x + r.offset * each, y: run.y, h: run.h, w: each * 8, font, full: r.full });
    }
  const out = [];
  const used = new Set();
  for (const first of rows) {
    if (used.has(first.i)) continue;
    // the rows under it: the same font, size and x, a row's height apart
    const column = rows.filter(r => r.font === first.font && Math.abs(r.x - first.x) < 1 && Math.abs(r.h - first.h) < 0.5 && r.y <= first.y + 0.5).sort((a, b) => b.y - a.y);
    const board = [];
    for (const r of column) {
      const last = board.at(-1);
      if (last && Math.abs(last.y - r.y) < 0.5) {
        last.also.push(...r.ids);
        continue;
      }
      if (board.length === 8 || (last && Math.abs(last.y - r.y - first.h) > first.h * 0.3)) break;
      board.push({ ...r, also: [] });
    }
    // (rows of pieces only among rows that show the board: half of them at least)
    if (board.length !== 8 || board.filter(r => r.full).length > 4) continue;
    // empty squares where the font has them: light and dark taking turns, a8 light; and its pieces on the squares the
    // font draws them on (a page that only looks like a board, or a board of another font, does not)
    const { font } = first;
    let wrong = 0;
    const ok = board.every((r, rank) =>
      [...r.str].every((ch, file) => {
        const light = !((rank + file) & 1);
        if (font.empty.includes(ch)) return ch === font.empty[light ? 0 : 1];
        if (font.onLight(ch) !== light) wrong++;
        return true;
      }),
    );
    if (!ok || wrong > 2) continue;
    const ids = board.flatMap(r => [...r.ids, ...r.also]);
    for (const i of ids) used.add(i);
    const placement = board
      .map(r => [...r.str].map(ch => (font.empty.includes(ch) ? '.' : font.pieces[ch])).join('').replace(/\.+/g, m => String(m.length)))
      .join('/');
    const pitch = (first.y - board[7].y) / 7;
    const b = { items: [...ids], rows: ids, placement, side: null, x0: first.x, y0: board[7].y - pitch * 0.22, x1: first.x + (first.w || first.h * 8), y1: first.y + pitch * 0.78 };
    // its coordinates: rank numbers beside its rows, file letters under or over it
    items.forEach((it, i) => {
      if (used.has(i) || typeof it.str !== 'string' || !it.transform || !/^(?:[1-8]|[a-h]|(?:[a-h] ?){8}|\s+)$/.test(it.str)) return;
      const x = it.transform[4];
      const y = it.transform[5];
      const side = y > b.y0 - pitch * 0.2 && y < b.y1 && ((x < b.x0 && x > b.x0 - pitch * 1.5) || (x > b.x1 - pitch * 0.1 && x < b.x1 + pitch * 1.2));
      const edge = x > b.x0 - pitch * 1.5 && x < b.x1 + pitch * 0.5 && ((y < b.y0 && y > b.y0 - pitch * 1.1) || (y > b.y1 && y < b.y1 + pitch * 0.9));
      if ((/^[1-8]$/.test(it.str) && side) || (/[a-h]/.test(it.str) && edge) || (!it.str.trim() && (side || edge))) {
        b.items.push(i);
        used.add(i);
      }
    });
    // the side to move: a lone glyph left or right of the board, about level with its bottom row
    items.forEach((it, i) => {
      if (b.side || typeof it.str !== 'string' || !it.transform || !Object.hasOwn(MARKS, it.str)) return;
      const x = it.transform[4];
      const y = it.transform[5];
      const beside = (x < b.x0 && x > b.x0 - pitch * 2) || (x > b.x1 && x < b.x1 + pitch * 2);
      if (beside && y > b.y0 - pitch * 0.5 && y < board[6].y && (it.height || 0) > pitch * 0.6) {
        b.side = MARKS[it.str];
        b.items.push(i);
      }
    });
    out.push(b);
  }
  return out;
}

/**
 * The tone between a board's light and dark squares, half of them each: midway between the lower and upper quartiles
 * of their tones (a few pieces reaching a square's sides, or marks, do not move it) — null when they are one tone.
 */
function halves(tones) {
  if (tones.length < 16) return null;
  const v = [...tones].sort((a, b) => a - b);
  const q1 = v[Math.floor(v.length * 0.25)];
  const q3 = v[Math.floor(v.length * 0.75)];
  return q3 - q1 < 0.05 ? null : (q1 + q3) / 2;
}

// ---------------------------------------------------------------------------------------------
// The positions of a book's boards

/** The 64 squares of a FEN's piece placement, from a8 to h1: a piece's letter or '.'. */
const squaresOf = placement => placement.split('/').map(r => r.replace(/\d/g, d => '.'.repeat(Number(d)))).join('');

const START = ['rnbqkbnr', 'pppppppp', '........', '........', '........', '........', 'PPPPPPPP', 'RNBQKBNR'];
const TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];
const PIECE_MIN = 0.05; // a silhouette smaller than this share of its square is no piece (a mark, a speck)

/** Two groups of numbers (k-means, k = 2): the value between them, or null when they are not two groups. */
function split(values) {
  if (values.length < 4) return null;
  const v = [...values].sort((a, b) => a - b);
  let lo = v[0];
  let hi = v.at(-1);
  if (hi - lo < 0.08) return null;
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    const a = v.filter(x => x <= mid);
    const b = v.filter(x => x > mid);
    if (!a.length || !b.length) return null;
    lo = a.reduce((s, x) => s + x, 0) / a.length;
    hi = b.reduce((s, x) => s + x, 0) / b.length;
  }
  return (lo + hi) / 2;
}

/**
 * Reads the positions of a book's boards — the same glyphs throughout a book, so its own boards teach them: the
 * boards that look like the start of a game (pieces on the first two ranks of each side, few elsewhere) give a first
 * example of each piece; every piece is then read by the examples it is most like, the surest readings join the
 * examples, and the rules of a position (one king a side; no pawn on the first or last rank) settle what stays close.
 * boards: [{ cells: [[{ shape (cellShape), darkSquare }] per column] per row, rows, cols }]; examples: more examples
 * ({ type, silhouette }) to start with (from a font's pieces); labels: the positions some of the boards are known to show
 * (a FEN's piece placement, or null, per board: a diagram the reading found in its game, one the student set right) —
 * their squares are the book's own examples, and they read as they are known. Each board gets .pieces ([row][col]:
 * 'P'…'k' or '.') and .sure (0…1). Returns { examples, whiteFill (the fill between white and black pieces) }.
 */
export function readBoards(boards, { examples = [], labels = [] } = {}) {
  const all = boards.flatMap(b => b.cells.flat().filter(c => c.shape.area >= PIECE_MIN));
  // white and black: the share of ink in the silhouette's core, in two groups for this book (and per piece below: a
  // book's white king may be drawn with much ink inside)
  const whiteFill = split(all.map(c => c.shape.fill)) ?? 0.7;
  const known = [];
  const labelled = boards.map((b, i) => (labels[i] && b.rows === 8 && b.cols === 8 ? squaresOf(labels[i]) : null));
  const taught = new Map(); // piece, colour, colour of the square → the labelled squares
  boards.forEach((b, i) => {
    const sq = labelled[i];
    if (!sq) return;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const cell = b.cells[r][c];
        const p = sq[r * 8 + c];
        if (p === '.' || cell.shape.area < PIECE_MIN) continue;
        const e = { type: p.toLowerCase(), white: p !== p.toLowerCase(), dark: cell.darkSquare, fill: cell.shape.fill, area: cell.shape.area, height: cell.shape.height, silhouette: cell.shape.silhouette, seed: true };
        const key = `${p}${e.dark}`;
        taught.set(key, [...(taught.get(key) || []), e]);
      }
  });
  // (a known position may be a move off — the piece that took on a square labelling the one it took —: a labelled
  // square much less like the others of its piece than they are like each other teaches nothing)
  for (const list of taught.values()) {
    const like = list.map(e => (list.length < 3 ? 1 : list.reduce((s, o) => s + (o === e ? 0 : dot((e.unit ||= unit(e.silhouette)), (o.unit ||= unit(o.silhouette)))), 0) / (list.length - 1)));
    const typical = [...like].sort((a, b) => a - b)[like.length >> 1];
    list.forEach((e, k) => like[k] >= typical - 0.15 && known.push(e));
  }
  // a first example of each piece from the boards that look like the start of a game
  for (const b of boards) {
    if (b.rows !== 8 || b.cols !== 8) continue;
    let fit = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const has = b.cells[r][c].shape.area >= PIECE_MIN;
        if ((START[r][c] !== '.') === has) fit++;
      }
    if (fit < 60) continue;
    for (const r of [0, 1, 6, 7])
      for (let c = 0; c < 8; c++) {
        const cell = b.cells[r][c];
        if (cell.shape.area >= PIECE_MIN) known.push({ type: START[r][c].toLowerCase(), white: r >= 6, dark: cell.darkSquare, fill: cell.shape.fill, area: cell.shape.area, height: cell.shape.height, silhouette: cell.shape.silhouette, seed: true });
      }
  }
  // (none yet: the given examples to start from — a common chess font's pieces — until the book's own come; the
  // pieces the book's own do not show yet, too)
  const seeded = known.length > 0;
  known.push(...(labelled.some(Boolean) ? examples : examples.filter(e => !known.some(k => k.type === e.type))));
  if (!known.length) return { examples: known, whiteFill };
  // enough examples of each piece and colour, on each colour of square (a book of openings has hundreds from its
  // starting positions)
  const kept = new Map();
  for (const e of known) {
    const key = `${e.type}${e.white}${e.dark}`;
    const list = kept.get(key) || [];
    if (list.length < 10) list.push(e);
    kept.set(key, list);
  }
  known.length = 0;
  for (const list of kept.values()) known.push(...list);
  // the fill between white and black, per piece, where the examples have both colours
  const fills = Object.fromEntries(TYPES.map(t => [t, whiteFill]));
  const both = new Set();
  for (const t of TYPES) {
    const w = known.filter(e => e.type === t && e.white === true).map(e => e.fill);
    const b = known.filter(e => e.type === t && e.white === false).map(e => e.fill);
    if (w.length && b.length && Math.max(...w) < Math.min(...b)) (fills[t] = (Math.max(...w) + Math.min(...b)) / 2), both.add(t);
  }
  // read every piece by its likeness to the examples: the best of each type — first as they are (fast), then the
  // best two of each type allowing a pixel's shift
  const scores = cell => {
    const v = unit(cell.shape.silhouette);
    const near = Object.fromEntries(TYPES.map(t => [t, []]));
    for (const e of known) {
      e.unit ||= unit(e.silhouette);
      near[e.type].push({ e, l: dot(v, e.unit) });
    }
    const best = Object.fromEntries(TYPES.map(t => [t, -1]));
    for (const t of TYPES)
      for (const { e } of near[t].sort((a, b) => b.l - a.l).slice(0, 2)) best[t] = Math.max(best[t], likeness(cell.shape.silhouette, e.silhouette, 1));
    return best;
  };
  for (let round = 0; round < 2; round++) {
    const sure = [];
    for (const cell of all) {
      cell.scores = scores(cell);
      const ranked = TYPES.slice().sort((a, b) => cell.scores[b] - cell.scores[a]);
      cell.margin = cell.scores[ranked[0]] - cell.scores[ranked[1]];
      // (a font's pieces are less like the book's than its own: a reading by them is sure sooner)
      if (cell.scores[ranked[0]] > (seeded ? 0.85 : 0.7) && cell.margin > 0.08) sure.push({ type: ranked[0], silhouette: cell.shape.silhouette, fill: cell.shape.fill, l: cell.scores[ranked[0]] });
    }
    // the surest readings teach the book's other glyphs (at most 12 more of each type)
    if (round === 0)
      for (const t of TYPES)
        sure
          .filter(s => s.type === t)
          .sort((a, b) => b.l - a.l)
          .slice(0, 12)
          .forEach(s => known.push({ type: t, silhouette: s.silhouette }));
  }
  // (a font's pawn and bishop may look alike, where the book's do not: the pieces read as one or the other fall in two
  // groups by their silhouettes, when the two are different enough — the pawns the larger, a book's commonest piece;
  // a piece whose two scores were close goes by its group)
  const top = c => TYPES.reduce((a, t) => (c.scores[t] > c.scores[a] ? t : a), 'p');
  if (!seeded) {
    const pb = all.filter(c => ['p', 'b'].includes(top(c)));
    const g = twoGroups(pb);
    const size = [0, 1].map(k => (g ? g.group.filter(x => x === k).length : 0));
    if (g && g.alike < 0.95 && Math.min(...size) >= Math.max(4, pb.length * 0.05)) {
      const pawn = size[0] >= size[1] ? 0 : 1;
      pb.forEach((c, i) => {
        if (Math.abs(c.scores.p - c.scores.b) >= 0.1) return;
        const best = Math.max(c.scores.p, c.scores.b);
        const p = g.group[i] === pawn;
        c.scores = { ...c.scores, p: p ? best : Math.min(c.scores.p, best - 0.01), b: p ? Math.min(c.scores.b, best - 0.01) : best };
      });
    }
  }
  // the smallest piece is a pawn: a mark on a square (a dot, an asterisk) is much smaller and lower than the book's pawns
  const pawns = known.filter(e => e.type === 'p' && e.area);
  const median = list => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const smallest = pawns.length ? median(pawns.map(e => e.area)) * 0.55 : PIECE_MIN;
  const lowest = pawns.length ? median(pawns.map(e => e.height)) * 0.75 : 0;
  for (const cell of all) if (cell.shape.area < smallest || cell.shape.height < lowest) cell.scores = null;
  // the fill between white and black of each piece the examples do not have in both colours, from the book's squares
  // read as it (a book's white rook or queen may have much more ink inside than its pawn: Kotov's are black with a
  // window): of the cuts, the one that leaves the fewest boards with more of the piece on a side than a game has — two
  // black queens, three white bishops —, of those the nearest to the cut between its two groups of fills (or the book's)
  for (const t of TYPES) {
    if (both.has(t)) continue;
    const per = boards.map(b => b.cells.flat().filter(c => c.shape.area >= PIECE_MIN && c.scores && top(c) === t).map(c => c.shape.fill)).filter(f => f.length);
    const values = per.flat();
    if (values.length < 6) continue;
    const near = twoFills(values) ?? fills[t];
    let best = { cut: near, over: Infinity };
    for (let cut = 0.2; cut <= 0.96; cut += 0.02) {
      let over = 0;
      for (const f of per) {
        const white = f.filter(v => v < cut).length;
        over += (white > MOST[t]) + (f.length - white > MOST[t]);
      }
      if (over < best.over || (over === best.over && Math.abs(cut - near) < Math.abs(best.cut - near))) best = { cut, over };
    }
    fills[t] = best.cut;
  }
  // (a shape as large and tall as the book's pieces is one, however unlike the examples it is: a book's king in a
  // font unlike the app's)
  const big = median(all.filter(c => c.scores).map(c => c.shape.area)) * 0.9;
  for (const b of boards) placePieces(b, fills, big);
  // (a board whose position is known reads as it)
  boards.forEach((b, i) => {
    const sq = labelled[i];
    if (!sq) return;
    b.pieces = [0, 1, 2, 3, 4, 5, 6, 7].map(r => [...sq.slice(r * 8, r * 8 + 8)]);
    b.sure = 1;
    b.alts = [];
  });
  return { examples: known, whiteFill, fills };
}

// How many of each piece a side has at most in a game (no promotions).
const MOST = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

/**
 * Two groups of a book's squares by their silhouettes (2-means, from a small piece's and a large one's): each square's
 * group (0 or 1) and how alike the groups' middles are (a correlation: -1 … 1); null for fewer than 8.
 */
function twoGroups(cells) {
  if (cells.length < 8) return null;
  const byArea = [...cells].sort((a, b) => a.shape.area - b.shape.area);
  let middles = [byArea[Math.floor(cells.length * 0.1)], byArea[Math.floor(cells.length * 0.9)]].map(c => Float32Array.from(c.shape.silhouette));
  const units = cells.map(c => unit(c.shape.silhouette));
  let group = [];
  for (let round = 0; round < 12; round++) {
    const u = middles.map(unit);
    group = units.map(v => (dot(v, u[0]) >= dot(v, u[1]) ? 0 : 1));
    middles = middles.map((old, k) => {
      const members = cells.filter((c, i) => group[i] === k);
      if (!members.length) return old;
      const m = new Float32Array(old.length);
      for (const c of members) for (let i = 0; i < m.length; i++) m[i] += c.shape.silhouette[i] / members.length;
      return m;
    });
  }
  return { group, alike: dot(unit(middles[0]), unit(middles[1])) };
}

/** Two groups of fills (each a tenth of them at least, their means 0.15 apart): the value between them, else null. */
function twoFills(values) {
  const cut = split(values);
  if (cut === null) return null;
  const lo = values.filter(v => v < cut);
  const hi = values.filter(v => v >= cut);
  const mean = list => list.reduce((s, v) => s + v, 0) / list.length;
  return Math.min(lo.length, hi.length) >= Math.max(3, values.length * 0.1) && mean(hi) - mean(lo) >= 0.15 ? cut : null;
}

const LIKE_MIN = 0.55; // less like any piece than this: a mark on the square (a dot, an asterisk), not a piece

/** A board's pieces from its cells' scores, with the rules of a position (a whole board: one king a side). */
function placePieces(b, fills, big = Infinity) {
  const pieces = b.cells.map(row => row.map(() => '.'));
  const whole = b.rows === 8 && b.cols === 8;
  const choice = [];
  b.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.shape.area < PIECE_MIN || !cell.scores) return;
      const edge = whole && (r === 0 || r === 7); // (rank 8 or 1, the board seen from White)
      const ranked = TYPES.filter(t => !(t === 'p' && edge)).sort((x, y) => cell.scores[y] - cell.scores[x]);
      if (cell.scores[ranked[0]] < LIKE_MIN && !(cell.shape.area >= big && cell.shape.height >= 0.8)) return;
      choice.push({ r, c, ranked, cell });
    }),
  );
  const colour = x => x.cell.shape.fill < fills[x.ranked[0]];
  for (const x of choice) x.white = colour(x);
  // at most one king a side: of the pieces of a colour about as like a king as like anything else, the most like one
  // (one on a light square first, its colour sure)
  const certain = x => x.cell.scores.k + (x.cell.darkSquare ? 0 : 0.08);
  for (const white of [true, false]) {
    const kingLike = choice.filter(x => (x.cell.shape.fill < fills.k) === white && x.cell.scores.k > x.cell.scores[x.ranked[0]] - 0.08);
    if (!kingLike.length) continue;
    const king = kingLike.reduce((a, x) => (certain(x) > certain(a) ? x : a));
    for (const x of choice) {
      if (x === king) {
        x.ranked = ['k'];
        x.white = white;
      } else if (x.white === white && x.ranked[0] === 'k') {
        x.ranked = x.ranked.filter(t => t !== 'k');
        x.white = colour(x);
      }
    }
  }
  // (and a king a side: a side without one gets the piece most like a king — its colour misread, most often, on a
  // dark square)
  const unsure = x => x.cell.scores.k + (x.cell.darkSquare ? 0.08 : 0);
  if (whole)
    for (const white of [true, false]) {
      if (choice.some(x => x.white === white && x.ranked[0] === 'k')) continue;
      const others = choice.filter(x => x.ranked[0] !== 'k' && x.cell.scores.k >= LIKE_MIN);
      if (!others.length) continue;
      const king = others.reduce((a, x) => (unsure(x) > unsure(a) ? x : a));
      king.ranked = ['k'];
      king.white = white;
    }
  // at most as many of a piece on a side as a game has (no promotions): the ones least sure of it are the piece they
  // are next most like (a white pawn on a hatched square, its outline grown by the hatching, read as a bishop)
  const margin = x => x.cell.scores[x.ranked[0]] - (x.ranked[1] ? x.cell.scores[x.ranked[1]] : -1);
  for (const t of ['q', 'r', 'b', 'n', 'p'])
    for (const white of [true, false])
      for (let mine = choice.filter(x => x.white === white && x.ranked[0] === t); mine.length > MOST[t]; mine = choice.filter(x => x.white === white && x.ranked[0] === t)) {
        const least = mine.reduce((a, x) => (margin(x) < margin(a) ? x : a));
        least.ranked = least.ranked.slice(1).filter(u => u !== 'k');
        if (!least.ranked.length) choice.splice(choice.indexOf(least), 1);
        else least.white = colour(least);
      }
  let sure = 1;
  const alts = [];
  const letter = (t, white) => (white ? t.toUpperCase() : t);
  for (const x of choice) {
    const t = x.ranked[0];
    pieces[x.r][x.c] = letter(t, x.white);
    sure = Math.min(sure, Math.max(0, x.cell.scores[t]));
    // what else an unsure square may be (the moves after the diagram may tell): the next likeliest piece, the other
    // colour (on a dark square, where it is hard to tell), or nothing
    const options = [letter(t, x.white)];
    const second = x.ranked[1];
    if (second && x.cell.scores[second] > x.cell.scores[t] - 0.12) options.push(letter(second, x.white));
    if (x.cell.darkSquare && t !== 'k' && Math.abs(x.cell.shape.fill - fills[t]) < 0.15) options.push(letter(t, !x.white));
    if (x.cell.scores[t] < 0.7) options.push('.');
    if (options.length > 1) alts.push({ sq: x.r * 8 + x.c, options });
  }
  b.pieces = pieces;
  b.sure = choice.length ? sure : 0;
  b.alts = b.cols === 8 ? alts : [];
}

/**
 * A board's position as the piece-placement field of a FEN, seen from White, when the board is whole or shows the
 * top rows of one (rank 8 down) — a part-board's other ranks empty; null for a strip of fewer than 8 files.
 */
export function placement(b) {
  if (b.cols !== 8) return null;
  const ranks = [];
  for (let r = 0; r < 8; r++) {
    const row = r < b.rows ? b.pieces[r] : Array(8).fill('.');
    ranks.push(row.join('').replace(/\.+/g, m => String(m.length)));
  }
  return ranks.join('/');
}

/**
 * The hatched areas of a page that may be boards: [{ x, y, width, height }] in pixels — at least `minSize` pixels wide
 * and high, about as wide as high (a board shown in part may be lower), and hatched over a good part of their area.
 */
export function findHatchedAreas(img, { minSize = 120 } = {}) {
  const hm = hatchMap(img);
  // parts of one board that came apart (a column without hatching between them): side by side, at the same height
  const parts = regions(hm.map, hm.cols, hm.rows).filter(r => r.count >= 12);
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < parts.length && !merged; i++)
      for (let j = i + 1; j < parts.length && !merged; j++) {
        const a = parts[i];
        const b = parts[j];
        const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        const high = Math.min(a.y1 - a.y0, b.y1 - b.y0);
        if (overlap > high * 0.6 && gap < Math.max(a.y1 - a.y0, b.y1 - b.y0) * 0.35) {
          parts[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), count: a.count + b.count };
          parts.splice(j, 1);
          merged = true;
        }
      }
  }
  const out = [];
  for (const r of parts) {
    const w = (r.x1 - r.x0) * hm.step;
    const h = (r.y1 - r.y0) * hm.step;
    if (w < minSize || h < minSize * 0.4) continue;
    const fill = r.count / ((r.x1 - r.x0) * (r.y1 - r.y0));
    if (fill < 0.25 || h > w * 1.25) continue;
    out.push({ x: r.x0 * hm.step, y: r.y0 * hm.step, width: w, height: h, fill });
  }
  return out;
}

/**
 * The boards in a page's picture (about 300 dpi), with what is on each square: [{ x, y, width, height (pixels), rows,
 * cols, cells: [[{ darkSquare, shape (cellShape) }]] }] — to read with the book's other boards (readBoards).
 */
export function findBoards(img, { minSize = Math.round(Math.min(img.width, img.height) * 0.12) } = {}) {
  const out = [];
  for (const area of findHatchedAreas(img, { minSize })) {
    const g = fitGrid(img, area);
    if (!g) continue;
    const b = { x: g.x, y: g.y, width: g.cols * g.size, height: g.rows * g.size, rows: g.rows, cols: g.cols };
    // (two areas of one board give it once)
    const overlap = o => Math.max(0, Math.min(o.x + o.width, b.x + b.width) - Math.max(o.x, b.x)) * Math.max(0, Math.min(o.y + o.height, b.y + b.height) - Math.max(o.y, b.y));
    if (out.some(o => overlap(o) > 0.5 * Math.min(o.width * o.height, b.width * b.height))) continue;
    b.cells = g.dark.map((row, r) => row.map((darkSquare, c) => ({ darkSquare, shape: cellShape(img, g.x + c * g.size, g.y + r * g.size, g.size, { darkSquare }) })));
    out.push(b);
  }
  return out;
}

/**
 * The board in a picture of its own (an EPUB's diagram): a whole board filling most of the picture (a frame and
 * coordinates around it), its dark squares hatched or plain — grey or coloured. Found by the lines between its squares:
 * the picture's tone, blurred, changes along each of them, across the whole board; then its 64 squares must be light
 * and dark in turn. Returns a board as findBoards gives them (with `hatched`), or null when the picture shows none
 * (`why(reason)` hears why: for tests and tools).
 */
export function findPictureBoard(img, { why = () => {} } = {}) {
  const { width: W, height: H, data } = img;
  const m = Math.min(W, H);
  if (m < 96 || Math.max(W, H) > m * 1.6) return why('size'), null;
  // the tone: the darkness (0 … 1) around each pixel
  const r = Math.max(1, Math.round(m / 130));
  const w1 = W + 1;
  const sum = new Float64Array(w1 * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += 255 - data[y * W + x];
      sum[(y + 1) * w1 + x + 1] = sum[y * w1 + x + 1] + row;
    }
  }
  const T = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r);
      const y0 = Math.max(0, y - r);
      const x1 = Math.min(W, x + r + 1);
      const y1 = Math.min(H, y + r + 1);
      T[y * W + x] = (sum[y1 * w1 + x1] - sum[y0 * w1 + x1] - sum[y1 * w1 + x0] + sum[y0 * w1 + x0]) / ((x1 - x0) * (y1 - y0) * 255);
    }
  // where the tone changes, column by column and row by row: the lines between the squares. A change counts less the
  // larger it is (v / (v + EDGE): highest still where it is largest): a line between squares changes the tone along the
  // whole board — faintly, between a light square and a pale coloured one — while a piece's outline, much darker, does
  // so only along the piece.
  const d = r + 1;
  const EDGE = 0.05;
  const soft = v => v / (v + EDGE);
  const ex = new Float32Array(W);
  const ey = new Float32Array(H);
  for (let y = d; y < H - d; y++)
    for (let x = d; x < W - d; x++) {
      const i = y * W + x;
      ex[x] += soft(Math.abs(T[i + d] - T[i - d]));
      ey[y] += soft(Math.abs(T[i + d * W] - T[i - d * W]));
    }
  // the square's size: the board is 55–100% of the picture (one size for both sides, then each side's own, a scan
  // being a little out of square)
  let best = null;
  for (let s = (m * 0.55) / 8; s <= m / 8; s += 0.25) {
    const score = comb(ex, [s]).score + comb(ey, [s]).score;
    if (!best || score > best.score) best = { s, score };
  }
  const near = [];
  for (let s = best.s * 0.96; s <= best.s * 1.04; s += 0.125) near.push(s);
  const bx = comb(ex, near);
  const by = comb(ey, near);
  const sx = bx.size;
  const sy = by.size;
  // the grid from its first line in the picture: a board filling the picture has its outer lines at the picture's
  // edges, where the tone's changes are weak — the comb may start a square in; the first and last columns and rows may
  // run a fifth of a square past the picture (its size rounded)
  const first = c => (c.offset % c.size > c.size * 0.8 ? (c.offset % c.size) - c.size : c.offset % c.size);
  bx.offset = first(bx);
  by.offset = first(by);
  const nc = Math.floor((W - bx.offset) / sx + 0.2);
  const nr = Math.floor((H - by.offset) / sy + 0.2);
  if (nc < 8 || nr < 8) return why(`grid ${nc}×${nr} (squares ${sx.toFixed(1)}×${sy.toFixed(1)} from ${bx.offset},${by.offset})`), null;
  // each cell's tone along its sides — the most common one there (a piece's outline may reach a side, but is little of
  // it) —, light or dark; and its colour: a square coloured to mark it (a move's squares, a king's) is neither
  const median = list => list.sort((a, b) => a - b)[list.length >> 1];
  const ring = (row, col) => {
    const x0 = bx.offset + col * sx;
    const y0 = by.offset + row * sy;
    const t = [];
    const s = [];
    const step = Math.max(1, Math.round(Math.min(sx, sy) / 24));
    for (let y = Math.max(0, Math.round(y0 + sy * 0.07)); y < Math.min(H, y0 + sy * 0.93); y += step)
      for (let x = Math.max(0, Math.round(x0 + sx * 0.07)); x < Math.min(W, x0 + sx * 0.93); x += step) {
        if (Math.min((x - x0) / sx, (y - y0) / sy, (x0 + sx - x) / sx, (y0 + sy - y) / sy) > 0.2) continue;
        t.push(T[y * W + x]);
        if (img.sat) s.push(img.sat[y * W + x]);
      }
    return { tone: t.length ? median(t) : 0, colour: s.length ? median(s) > COLOURED : false };
  };
  const cellAt = Array.from({ length: nr }, (_, row) => Array.from({ length: nc }, (_, col) => ring(row, col)));
  const tones = cellAt.map(row => row.map(c => c.tone));
  // the 8 × 8 cells most like a board: light and dark in turn (a cell coloured to mark it may be either: a few of them —
  // half the board coloured is the board's own colour) — light and dark told apart by the tones of those cells (cells
  // around the board may be its frame, darker than any square)
  const darkAt = (row, col, firstDark) => (((row + col) & 1) === 0) === firstDark;
  let found = null;
  for (let r0 = 0; r0 + 8 <= nr; r0++)
    for (let c0 = 0; c0 + 8 <= nc; c0++) {
      const window = cellAt.slice(r0, r0 + 8).flatMap(row => row.slice(c0, c0 + 8));
      const marked = window.filter(c => c.colour).length <= 24;
      const isMark = c => marked && c.colour;
      const coloured = window.filter(isMark).length;
      const cut = halves(window.filter(c => !isMark(c)).map(c => c.tone));
      if (cut === null) continue;
      for (const firstDark of [false, true]) {
        let ok = 0;
        for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) if (!isMark(cellAt[r0 + row][c0 + col]) && tones[r0 + row][c0 + col] > cut === darkAt(row, col, firstDark)) ok++;
        if (!found || ok + coloured > found.ok + found.coloured) found = { r0, c0, firstDark, ok, coloured, isMark };
      }
    }
  if (!found) return why('tones'), null;
  if (found.ok + found.coloured < 56) return why(`squares ${found.ok + found.coloured}`), null;
  const { isMark } = found;
  const isDark = (row, col) => darkAt(row, col, found.firstDark);
  // dark squares and light ones apart: their tones, and whether the dark ones are hatched — strokes of ink with the
  // paper between them — or of one plain tone
  const dark = [];
  const light = [];
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) if (!isMark(cellAt[found.r0 + row][found.c0 + col])) (isDark(row, col) ? dark : light).push(tones[found.r0 + row][found.c0 + col]);
  const darkTone = median(dark);
  if (darkTone - median(light) < 0.08) return why('contrast'), null;
  // (along the top of the dark squares — a piece seldom reaches there —, the middle half of their pixels' greys:
  // narrow for a plain tone, wide for strokes of ink with the paper between them, however blurred)
  const greys = new Uint32Array(256);
  let band = 0;
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) {
      if (!isDark(row, col)) continue;
      const x0 = Math.round(bx.offset + (found.c0 + col) * sx);
      const y0 = Math.round(by.offset + (found.r0 + row) * sy);
      for (let y = Math.max(0, y0 + Math.round(sy * 0.08)); y < Math.min(H, y0 + sy * 0.2); y++)
        for (let x = Math.max(0, x0 + Math.round(sx * 0.08)); x < Math.min(W, x0 + sx * 0.92); x++) {
          greys[data[y * W + x]]++;
          band++;
        }
    }
  const quantile = q => {
    for (let v = 0, n = 0; v < 256; v++) if ((n += greys[v]) >= band * q) return v;
    return 255;
  };
  const hatched = quantile(0.75) - quantile(0.25) > 30;
  // a plain square may be darker than a piece's outline at 150 (a dark one, a coloured one): the ink is then darker
  // than the square
  const inkOn = tone => Math.min(150, Math.round(255 * (1 - tone) * 0.7));
  const darkInk = hatched ? 150 : inkOn(darkTone);
  // the board's own grid: its seven lines inside (between light and dark squares all along, never at the picture's
  // edge), the comb's size and start refined on them
  const [x, fx] = refine(ex, bx.offset + found.c0 * sx, sx);
  const [y, fy] = refine(ey, by.offset + found.r0 * sy, sy);
  const size = (fx + fy) / 2;
  const cells = Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 8 }, (_, col) => {
      const darkSquare = isDark(row, col);
      const mark = isMark(cellAt[found.r0 + row][found.c0 + col]);
      const ink = mark ? inkOn(cellAt[found.r0 + row][found.c0 + col].tone) : darkSquare ? darkInk : 150;
      const shape = cellShape(img, x + col * fx + (fx - size) / 2, y + row * fy + (fy - size) / 2, size, { ink, darkSquare: darkSquare && hatched && !mark });
      return { darkSquare, shape };
    }),
  );
  return { x, y, width: 8 * fx, height: 8 * fy, rows: 8, cols: 8, cells, hatched };
}

/**
 * A board's start and square size along one side, fitted to its seven inner lines in an edge profile: [start, size]
 * — searched within 4% of the size and a third of a square of the start found.
 */
function refine(profile, start, size) {
  const at = p => {
    const i = Math.floor(p);
    if (i < 0 || i + 1 >= profile.length) return 0;
    return profile[i] * (1 - (p - i)) + profile[i + 1] * (p - i);
  };
  let best = [start, size, -Infinity];
  for (let s = size * 0.96; s <= size * 1.04; s += 0.125)
    for (let o = start - size / 3; o <= start + size / 3; o += 0.5) {
      let score = 0;
      for (let k = 1; k < 8; k++) score += at(o + k * s);
      if (score > best[2]) best = [o, s, score];
    }
  return [best[0], best[1]];
}

/** Part of a grey picture (with its saturation): x, y, width, height in pixels, kept inside the picture. */
export function cropOf(img, x, y, width, height) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const w = Math.min(img.width, Math.round(x + width)) - x0;
  const h = Math.min(img.height, Math.round(y + height)) - y0;
  const out = { width: Math.max(0, w), height: Math.max(0, h), data: new Uint8Array(Math.max(0, w * h)), sat: img.sat ? new Uint8Array(Math.max(0, w * h)) : null, x: x0, y: y0 };
  for (let r = 0; r < out.height; r++) {
    out.data.set(img.data.subarray((y0 + r) * img.width + x0, (y0 + r) * img.width + x0 + w), r * w);
    if (img.sat) out.sat.set(img.sat.subarray((y0 + r) * img.width + x0, (y0 + r) * img.width + x0 + w), r * w);
  }
  return out;
}

/**
 * The long straight lines of a picture's ink, along its rows (`vertical` false) or its columns: [{ at, from, to,
 * thick }] — runs of ink at least `min` pixels long, each row taken with `band` rows on either side (a scan's lines
 * may lean a little), the rows of one line together.
 */
function inkLines(img, min, vertical, band = 1) {
  const { width: W, height: H, data } = img;
  const [n, len] = vertical ? [W, H] : [H, W];
  const ink = (i, j) => (vertical ? data[j * W + i] : data[i * W + j]) < 140;
  const lines = [];
  let open = [];
  for (let i = band; i < n - band; i++) {
    const runs = [];
    let start = -1;
    let gap = 0;
    for (let j = 0; j <= len; j++) {
      let on = false;
      for (let k = -band; k <= band && !on && j < len; k++) on = ink(i + k, j);
      if (on) {
        if (start < 0) start = j;
        gap = 0;
      } else if (start >= 0 && ++gap > 2) {
        if (j - gap - start >= min) runs.push([start, j - gap]);
        start = -1;
        gap = 0;
      }
    }
    // a run under one of the lines still open is more of it
    const next = [];
    for (const [from, to] of runs) {
      const line = open.find(l => Math.abs(l.from - from) < min * 0.05 && Math.abs(l.to - to) < min * 0.05);
      if (line) {
        line.thick = i - line.at + 1;
        next.push(line);
      } else {
        const l = { at: i, from, to, thick: 1 };
        lines.push(l);
        next.push(l);
      }
    }
    open = next;
  }
  return lines.filter(l => l.thick <= Math.max(6, min * 0.04)).map(l => ({ ...l, at: l.at + (l.thick - 1) / 2 }));
}

/**
 * The boards drawn in a frame on a page's picture — the way most books print their diagrams, whatever their dark
 * squares look like (hatched, dotted, grey): two long lines across, as far apart as they are long, joined by two long
 * lines down; inside, a board (findPictureBoard). The lines are looked for as drawn first, then — on a page where
 * none frames a board — as a phone's scan bends them, two pixels either way (looked for so at once, the lines of a
 * frame and of what is near it run together). As findBoards gives them.
 */
export function findFramedBoards(img, { minSize = Math.round(Math.min(img.width, img.height) * 0.12) } = {}) {
  const found = framed(img, minSize, 1);
  return found.length ? found : framed(img, minSize, 2);
}

function framed(img, minSize, band) {
  const across = inkLines(img, minSize, false, band);
  const down = inkLines(img, minSize, true, band);
  const out = [];
  const overlap = (o, b) => Math.max(0, Math.min(o.x + o.width, b.x + b.width) - Math.max(o.x, b.x)) * Math.max(0, Math.min(o.y + o.height, b.y + b.height) - Math.max(o.y, b.y));
  for (const top of across)
    for (const bottom of across) {
      const side = top.to - top.from;
      const tol = side * 0.03;
      const height = bottom.at - top.at;
      if (height < minSize || Math.abs(height - side) > side * 0.12 || Math.abs(bottom.from - top.from) > tol || Math.abs(bottom.to - top.to) > tol) continue;
      // a line down at each end, along most of the height
      const edge = x => down.some(l => Math.abs(l.at - x) < tol * 2 && Math.min(l.to, bottom.at) - Math.max(l.from, top.at) > height * 0.7);
      if (!edge(top.from) || !edge(top.to)) continue;
      const area = { x: top.from, y: top.at, width: side, height };
      if (out.some(o => overlap(o, area) > 0.5 * Math.min(o.width * o.height, area.width * area.height))) continue;
      const m = side * 0.04;
      const crop = cropOf(img, area.x - m, area.y - m, area.width + 2 * m, area.height + 2 * m);
      const b = findPictureBoard(crop);
      if (b) out.push({ ...b, x: b.x + crop.x, y: b.y + crop.y });
    }
  return out;
}

/**
 * The boards on a page's picture (about 200–300 dpi): one in each of its pictures shaped like a diagram (`figures`:
 * boxes [x0, y0, x1, y1] as shares of the page — the page's own pictures, a board drawn or printed plain or hatched),
 * and hatched boards anywhere on it when `whole` (a scan) or when a figure showed none. As findBoards gives them.
 */
export function findFigureBoards(img, figures = [], { whole = true } = {}) {
  const out = [];
  let missed = false;
  for (const [fx0, fy0, fx1, fy1] of figures) {
    const margin = img.width * 0.006;
    const crop = cropOf(img, fx0 * img.width - margin, fy0 * img.height - margin, (fx1 - fx0) * img.width + 2 * margin, (fy1 - fy0) * img.height + 2 * margin);
    const b = crop.width >= 96 && crop.height >= 96 ? findPictureBoard(crop) : null;
    if (!b) {
      missed = true;
      continue;
    }
    out.push({ ...b, x: b.x + crop.x, y: b.y + crop.y });
  }
  if (whole || missed) {
    const overlap = (o, b) => Math.max(0, Math.min(o.x + o.width, b.x + b.width) - Math.max(o.x, b.x)) * Math.max(0, Math.min(o.y + o.height, b.y + b.height) - Math.max(o.y, b.y));
    // boards in frames (on a scan) first, then hatched ones — each board once
    for (const b of [...(whole ? findFramedBoards(img) : []), ...findBoards(img)]) if (!out.some(o => overlap(o, b) > 0.3 * Math.min(o.width * o.height, b.width * b.height))) out.push(b);
  }
  return out;
}

// A board's squares in few bytes (to keep with the page, and to send to a worker): the silhouette of a piece as base64
// bytes, nothing of an empty square's.
const base64 = bytes => btoa(String.fromCharCode(...bytes));
const unbase64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function packBoard(b) {
  return {
    rows: b.rows,
    cols: b.cols,
    cells: b.cells.map(row =>
      row.map(({ darkSquare, shape: s }) => ({
        d: darkSquare ? 1 : 0,
        a: +s.area.toFixed(4),
        h: +s.height.toFixed(4),
        f: +s.fill.toFixed(4),
        i: +s.ink.toFixed(4),
        s: s.area >= PIECE_MIN ? base64(Uint8Array.from(s.silhouette, v => Math.round(v * 255))) : undefined,
      })),
    ),
  };
}

export function unpackBoard(p) {
  return {
    rows: p.rows,
    cols: p.cols,
    cells: p.cells.map(row =>
      row.map(c => ({
        darkSquare: !!c.d,
        shape: { area: c.a, height: c.h, fill: c.f, ink: c.i, silhouette: c.s ? Float32Array.from(unbase64(c.s), v => v / 255) : new Float32Array(CELL * CELL) },
      })),
    ),
  };
}
