// Chess diagrams in book pages (Book reader): finding the boards in a page's picture and reading their positions.
// Book diagrams draw the dark squares hatched with thin diagonal lines (or grey); the boards are found by that texture —
// dense diagonal strokes with few horizontal or vertical ones, which text does not have — and their 8×8 grid by the
// period of the hatching and the frame around it. Works on grey pictures: { width, height, data } (one byte per pixel,
// 0 black … 255 white), in the window (a canvas's pixels) and in Node (the tests).

/** A grey picture from RGBA pixels (a canvas's ImageData). */
export function grayFrom(rgba, width, height) {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return { width, height, data };
}

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
  // the background: reachable from the sides through light pixels (on a light square the ink is grown by a pixel
  // first, closing gaps in a piece's outline; on a dark square that would close the hatching's gaps too)
  const walls = darkSquare ? dark : morph(dark, n, n, 1, true);
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
  let shape = morph(morph(rest, n, n, t, false), n, n, darkSquare ? t + 1 : t, true);
  let found = 0;
  for (let y = Math.round(n * 0.1); y < n * 0.9; y++) for (let x = Math.round(n * 0.1); x < n * 0.9; x++) found += shape[y * n + x];
  // (on a dark square: horizontal and vertical strokes in its middle — a piece's outline has them, hatching never)
  let straight = 0;
  if (darkSquare && found < n * n * 0.15)
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

// The characters of the usual chess fonts: the empty light and dark squares, and each letter's piece (in either
// case — the case tells the square's colour).
const FONTS = [
  // ChessBase's diagram fonts (New in Chess and many others): capitals on light squares
  { empty: '._', pieces: { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', i: 'P', m: 'k', d: 'q', t: 'r', l: 'b', s: 'n', j: 'p' } },
  // Alpha, Merida, Leipzig… (Eric Bentzen's and Armando Marroquin's fonts): small letters on light squares
  { empty: ' +', pieces: { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', p: 'P', l: 'k', w: 'q', t: 'r', v: 'b', m: 'n', o: 'p' } },
];

// The side to move, a square glyph by the board's bottom row: white (hollow) or black (filled).
const MARKS = { n: 'b', '■': 'b', '□': 'w', '\x86': 'w' };

/**
 * The boards set in a chess font among a PDF page's text items ({ str, transform, width, height }): eight rows of
 * eight characters, one under the other (a row drawn twice, in two fonts, is one). Returns [{ items (the indices of
 * its rows and of its mark), rows (of its rows), placement (FEN), side ('w', 'b' or null: no mark), x0, y0, x1, y1
 * (PDF points, y upwards) }].
 */
export function fontBoards(items) {
  const rows = [];
  items.forEach((it, i) => {
    if (typeof it.str !== 'string' || it.str.length !== 8 || !it.transform) return;
    const font = FONTS.find(f => [...it.str].every(ch => f.empty.includes(ch) || Object.hasOwn(f.pieces, ch.toLowerCase())));
    if (!font || [...it.str].filter(ch => font.empty.includes(ch)).length < 2) return;
    rows.push({ i, str: it.str, x: it.transform[4], y: it.transform[5], h: it.height || Math.abs(it.transform[3]), w: it.width, font });
  });
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
        last.also.push(r.i);
        continue;
      }
      if (board.length === 8 || (last && Math.abs(last.y - r.y - first.h) > first.h * 0.3)) break;
      board.push({ ...r, also: [] });
    }
    if (board.length !== 8) continue;
    // empty squares where the font has them: light and dark taking turns, a8 light
    const { font } = first;
    const ok = board.every((r, rank) => [...r.str].every((ch, file) => !font.empty.includes(ch) || ch === font.empty[(rank + file) & 1]));
    if (!ok) continue;
    const ids = board.flatMap(r => [r.i, ...r.also]);
    for (const i of ids) used.add(i);
    const placement = board
      .map(r => [...r.str].map(ch => (font.empty.includes(ch) ? '.' : font.pieces[ch.toLowerCase()])).join('').replace(/\.+/g, m => String(m.length)))
      .join('/');
    const pitch = (first.y - board[7].y) / 7;
    const b = { items: [...ids], rows: ids, placement, side: null, x0: first.x, y0: board[7].y - pitch * 0.22, x1: first.x + (first.w || first.h * 8), y1: first.y + pitch * 0.78 };
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

// ---------------------------------------------------------------------------------------------
// The positions of a book's boards

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
 * ({ type, silhouette }) to start with (from a font's pieces). Each board gets .pieces ([row][col]: 'P'…'k' or '.')
 * and .sure (0…1). Returns { examples, whiteFill (the fill between white and black pieces) }.
 */
export function readBoards(boards, { examples = [] } = {}) {
  const all = boards.flatMap(b => b.cells.flat().filter(c => c.shape.area >= PIECE_MIN));
  // white and black: the share of ink in the silhouette's core, in two groups for this book (and per piece below: a
  // book's white king may be drawn with much ink inside)
  const whiteFill = split(all.map(c => c.shape.fill)) ?? 0.7;
  const known = [];
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
        if (cell.shape.area >= PIECE_MIN) known.push({ type: START[r][c].toLowerCase(), white: r >= 6, fill: cell.shape.fill, area: cell.shape.area, height: cell.shape.height, silhouette: cell.shape.silhouette, seed: true });
      }
  }
  // (none yet: the given examples to start from — a common chess font's pieces — until the book's own come)
  const seeded = known.length > 0;
  if (!seeded) known.push(...examples);
  if (!known.length) return { examples: known, whiteFill };
  // enough examples of each piece and colour (a book of openings has hundreds from its starting positions)
  const kept = new Map();
  for (const e of known) {
    const key = `${e.type}${e.white}`;
    const list = kept.get(key) || [];
    if (list.length < 10) list.push(e);
    kept.set(key, list);
  }
  known.length = 0;
  for (const list of kept.values()) known.push(...list);
  // the fill between white and black, per piece, where the examples have both colours
  const fills = Object.fromEntries(TYPES.map(t => [t, whiteFill]));
  for (const t of TYPES) {
    const w = known.filter(e => e.type === t && e.white === true).map(e => e.fill);
    const b = known.filter(e => e.type === t && e.white === false).map(e => e.fill);
    if (w.length && b.length && Math.max(...w) < Math.min(...b)) fills[t] = (Math.max(...w) + Math.min(...b)) / 2;
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
  // (a font's pawn and bishop may look alike, where the book's do not: the book's pawns are its smallest pieces — the
  // pieces read as one or the other fall in two groups by their area, when there are both)
  if (!seeded) {
    const top = c => TYPES.reduce((a, t) => (c.scores[t] > c.scores[a] ? t : a), 'p');
    const pb = all.filter(c => ['p', 'b'].includes(top(c)));
    const cut = split(pb.map(c => c.shape.area));
    const small = pb.filter(c => c.shape.area < cut);
    const big = pb.filter(c => c.shape.area >= cut);
    const mean = list => list.reduce((s, c) => s + c.shape.area, 0) / list.length;
    if (cut !== null && small.length && big.length && mean(big) > mean(small) * 1.25)
      for (const c of pb) {
        const best = Math.max(c.scores.p, c.scores.b);
        c.scores = { ...c.scores, p: c.shape.area < cut ? best : Math.min(c.scores.p, best - 0.01), b: c.shape.area < cut ? Math.min(c.scores.b, best - 0.01) : best };
      }
  }
  // the smallest piece is a pawn: a mark on a square (a dot, an asterisk) is much smaller and lower than the book's pawns
  const pawns = known.filter(e => e.type === 'p' && e.area);
  const median = list => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const smallest = pawns.length ? median(pawns.map(e => e.area)) * 0.55 : PIECE_MIN;
  const lowest = pawns.length ? median(pawns.map(e => e.height)) * 0.75 : 0;
  for (const cell of all) if (cell.shape.area < smallest || cell.shape.height < lowest) cell.scores = null;
  for (const b of boards) placePieces(b, fills);
  return { examples: known, whiteFill, fills };
}

const LIKE_MIN = 0.55; // less like any piece than this: a mark on the square (a dot, an asterisk), not a piece

/** A board's pieces from its cells' scores, with the rules of a position (a whole board: one king a side). */
function placePieces(b, fills) {
  const pieces = b.cells.map(row => row.map(() => '.'));
  const whole = b.rows === 8 && b.cols === 8;
  const choice = [];
  b.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.shape.area < PIECE_MIN || !cell.scores) return;
      const edge = whole && (r === 0 || r === 7); // (rank 8 or 1, the board seen from White)
      const ranked = TYPES.filter(t => !(t === 'p' && edge)).sort((x, y) => cell.scores[y] - cell.scores[x]);
      if (cell.scores[ranked[0]] < LIKE_MIN) return;
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
export function findBoards(img, { minSize = Math.round(img.width * 0.12) } = {}) {
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
 * and dark in turn. Returns a board as findBoards gives them (with `hatched`), or null when the picture shows none.
 */
export function findPictureBoard(img) {
  const { width: W, height: H, data } = img;
  const m = Math.min(W, H);
  if (m < 96 || Math.max(W, H) > m * 1.6) return null;
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
  // where the tone changes, column by column and row by row: the lines between the squares
  const d = r + 1;
  const ex = new Float32Array(W);
  const ey = new Float32Array(H);
  for (let y = d; y < H - d; y++)
    for (let x = d; x < W - d; x++) {
      const i = y * W + x;
      ex[x] += Math.abs(T[i + d] - T[i - d]);
      ey[y] += Math.abs(T[i + d * W] - T[i - d * W]);
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
  const nc = Math.floor((W - bx.offset) / sx);
  const nr = Math.floor((H - by.offset) / sy);
  if (nc < 8 || nr < 8) return null;
  // each cell's tone along its sides (a piece seldom reaches there), light or dark
  const ring = (row, col) => {
    const x0 = bx.offset + col * sx;
    const y0 = by.offset + row * sy;
    let t = 0;
    let n = 0;
    const step = Math.max(1, Math.round(Math.min(sx, sy) / 24));
    for (let y = Math.round(y0 + sy * 0.07); y < y0 + sy * 0.93; y += step)
      for (let x = Math.round(x0 + sx * 0.07); x < x0 + sx * 0.93; x += step) {
        if (Math.min((x - x0) / sx, (y - y0) / sy, (x0 + sx - x) / sx, (y0 + sy - y) / sy) > 0.2) continue;
        t += T[y * W + x];
        n++;
      }
    return n ? t / n : 0;
  };
  const tones = Array.from({ length: nr }, (_, row) => Array.from({ length: nc }, (_, col) => ring(row, col)));
  const cut = split(tones.flat());
  if (cut === null) return null;
  // the 8 × 8 cells most like a board: light and dark in turn
  const darkAt = (row, col, firstDark) => (((row + col) & 1) === 0) === firstDark;
  let found = null;
  for (const firstDark of [false, true])
    for (let r0 = 0; r0 + 8 <= nr; r0++)
      for (let c0 = 0; c0 + 8 <= nc; c0++) {
        let ok = 0;
        for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) if (tones[r0 + row][c0 + col] > cut === darkAt(row, col, firstDark)) ok++;
        if (!found || ok > found.ok) found = { r0, c0, firstDark, ok };
      }
  if (found.ok < 56) return null;
  const isDark = (row, col) => darkAt(row, col, found.firstDark);
  // dark squares and light ones apart: their tones, and whether the dark ones are hatched — strokes of ink with the
  // paper between them — or of one plain tone
  const dark = [];
  const light = [];
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) (isDark(row, col) ? dark : light).push(tones[found.r0 + row][found.c0 + col]);
  const median = list => list.sort((a, b) => a - b)[list.length >> 1];
  const darkTone = median(dark);
  if (darkTone - median(light) < 0.08) return null;
  // (along the top of the dark squares — a piece seldom reaches there —, the middle half of their pixels' greys:
  // narrow for a plain tone, wide for strokes of ink with the paper between them, however blurred)
  const greys = new Uint32Array(256);
  let band = 0;
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) {
      if (!isDark(row, col)) continue;
      const x0 = Math.round(bx.offset + (found.c0 + col) * sx);
      const y0 = Math.round(by.offset + (found.r0 + row) * sy);
      for (let y = y0 + Math.round(sy * 0.08); y < y0 + sy * 0.2; y++)
        for (let x = x0 + Math.round(sx * 0.08); x < x0 + sx * 0.92; x++) {
          greys[data[y * W + x]]++;
          band++;
        }
    }
  const quantile = q => {
    for (let v = 0, n = 0; v < 256; v++) if ((n += greys[v]) >= band * q) return v;
    return 255;
  };
  const hatched = quantile(0.75) - quantile(0.25) > 30;
  // a plain dark square may be darker than a piece's outline at 150: the ink is then darker than the square
  const darkInk = hatched ? 150 : Math.min(150, Math.round(255 * (1 - darkTone) * 0.7));
  const size = (sx + sy) / 2;
  const x = bx.offset + found.c0 * sx;
  const y = by.offset + found.r0 * sy;
  const cells = Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 8 }, (_, col) => {
      const darkSquare = isDark(row, col);
      const shape = cellShape(img, x + col * sx + (sx - size) / 2, y + row * sy + (sy - size) / 2, size, { ink: darkSquare ? darkInk : 150, darkSquare: darkSquare && hatched });
      return { darkSquare, shape };
    }),
  );
  return { x, y, width: 8 * sx, height: 8 * sy, rows: 8, cols: 8, cells, hatched };
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
