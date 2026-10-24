// Opening names from lichess-org/chess-openings (CC0), indexed by position so transpositions are recognised.
// The TSV files (a.tsv … e.tsv) are passed in by the backend worker, which fetches them from the site.
import { parseSan, makeSan } from 'chessops/san';
import { initialPos, keyOf, fenOf, uciOf, moveFromUci, posFromFen } from './core.js';

const named = new Map(); // key -> entry
const tree = new Map(); // key -> Map(uci -> { san, child })
const nearest = new Map(); // key -> deepest named entry on a book line through this position
const entries = [];

const fold = s =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Loads the opening book from the contents of the TSV files (header line + "eco\tname\tpgn" lines). */
export function loadOpenings(tsvTexts) {
  if (entries.length) return;
  for (const text of tsvTexts) {
    const lines = String(text).split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const [eco, name, pgn] = line.split('\t');
      if (!eco || !name || !pgn) continue;
      const sans = pgn.split(/\s+/).map(t => t.replace(/^\d+\.+/, '')).filter(Boolean);
      const pos = initialPos();
      const ucis = [];
      const keys = [keyOf(pos)];
      let ok = true;
      for (const san of sans) {
        const move = parseSan(pos, san);
        if (!move) {
          ok = false;
          break;
        }
        const uci = uciOf(pos, move);
        const parentKey = keyOf(pos);
        const normalizedSan = makeSan(pos, move);
        pos.play(move);
        const childKey = keyOf(pos);
        if (!tree.has(parentKey)) tree.set(parentKey, new Map());
        if (!tree.get(parentKey).has(uci)) tree.get(parentKey).set(uci, { san: normalizedSan, child: childKey });
        ucis.push(uci);
        keys.push(childKey);
      }
      if (!ok) continue;
      const entry = { eco, name, pgn, ucis, ply: ucis.length, fen: fenOf(pos), key: keys[keys.length - 1], family: name.split(':')[0], folded: fold(`${eco} ${name}`) };
      entries.push(entry);
      if (!named.has(entry.key)) named.set(entry.key, entry);
      entry.keys = keys;
    }
  }
  // Second pass: deepest named position along each book line.
  for (const entry of entries) {
    let last;
    for (const key of entry.keys) {
      const n = named.get(key);
      if (n) last = n;
      const prev = nearest.get(key);
      if (last && (!prev || last.ply > prev.ply)) nearest.set(key, last);
    }
    delete entry.keys;
  }
}

export const openingCount = () => entries.length;

/** Opening name at exactly this position, or the deepest named opening on a book line through it. */
export function lookup(key) {
  const exact = named.get(key);
  if (exact) return { ...brief(exact), exact: true };
  const near = nearest.get(key);
  return near ? { ...brief(near), exact: false } : null;
}

const brief = e => ({ eco: e.eco, name: e.name, family: e.family, pgn: e.pgn });

/**
 * The moves (UCI) from the initial position to the position `key` along the book: a named position's own move order,
 * otherwise the shortest book line through it. null when no book line passes there.
 */
export function bookPathTo(key) {
  const start = keyOf(initialPos());
  if (key === start) return [];
  const own = named.get(key);
  if (own) return own.ucis;
  const from = new Map([[start, null]]); // key -> [parent key, uci]
  for (let level = [start]; level.length; ) {
    const next = [];
    for (const k of level)
      for (const [uci, { child }] of tree.get(k) || []) {
        if (from.has(child)) continue;
        from.set(child, [k, uci]);
        if (child === key) {
          const ucis = [];
          for (let at = key; from.get(at); at = from.get(at)[0]) ucis.unshift(from.get(at)[1]);
          return ucis;
        }
        next.push(child);
      }
    level = next;
  }
  return null;
}

/** Deepest named opening reached by a game (looks at the first 40 plies, transpositions included). */
export function openingOfGame(startPos, ucis, maxPly = 40) {
  const pos = startPos.clone();
  let found = named.get(keyOf(pos)) || null;
  let leftBookAt = null;
  for (let i = 0; i < Math.min(ucis.length, maxPly); i++) {
    const move = moveFromUci(pos, ucis[i]);
    if (!move) break;
    pos.play(move);
    const key = keyOf(pos);
    const n = named.get(key);
    if (n) found = n;
    if (leftBookAt === null && !tree.has(key) && !named.has(key)) leftBookAt = i + 1;
  }
  return found ? { ...brief(found), leftBookAt } : leftBookAt !== null ? { eco: null, name: null, leftBookAt } : null;
}

/** Book continuations from a position, each labelled with the most general opening it leads to. */
export function bookMoves(fen) {
  const pos = posFromFen(fen);
  const children = tree.get(keyOf(pos));
  if (!children) return [];
  const out = [];
  for (const [uci, { san, child }] of children) {
    const label = named.get(child) || nearest.get(child) || generalEntryThrough(child);
    out.push({ uci, san, eco: label?.eco ?? null, name: label?.name ?? null });
  }
  return out.sort((a, b) => (a.eco || '').localeCompare(b.eco || '') || a.san.localeCompare(b.san));
}

const generalCache = new Map();
function generalEntryThrough(key) {
  if (generalCache.has(key)) return generalCache.get(key);
  // shortest named line that passes through `key`
  let best = null;
  const queue = [key];
  const seen = new Set(queue);
  while (queue.length && !best) {
    const k = queue.shift();
    const n = named.get(k);
    if (n && k !== key) best = n;
    for (const { child } of tree.get(k)?.values() || []) if (!seen.has(child)) seen.add(child), queue.push(child);
  }
  generalCache.set(key, best);
  return best;
}

export const inBook = key => tree.has(key) || named.has(key);

/** Name / ECO search ("najdorf", "B90", "queen's gambit declined"). */
export function search(query, limit = 20) {
  const terms = fold(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  const hits = entries.filter(e => terms.every(t => e.folded.includes(t)));
  hits.sort((a, b) => a.ply - b.ply || a.name.length - b.name.length);
  return hits.slice(0, limit).map(e => ({ ...brief(e), fen: e.fen, ucis: e.ucis, ply: e.ply }));
}

/** All named lines of a family / name prefix, e.g. every "Sicilian Defense: Najdorf Variation" line. */
export function linesUnder(namePrefix, limit = 50) {
  const p = namePrefix.toLowerCase();
  return entries.filter(e => e.name.toLowerCase().startsWith(p)).slice(0, limit).map(e => ({ ...brief(e), ply: e.ply }));
}
