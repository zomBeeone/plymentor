// Learning a repertoire's lines (Openings → Learn): which lines there are, how far each is learned, and what comes next.
// A line is shown move by move, the student repeating them; between new lines it drills lines from memory. Gone through
// once and drilled right twice, a line is learned — only learned lines are drilled in Drill.
import { repKey, playUci, turnOf, INITIAL_FEN } from './chess.js';

export const DRILLS_TO_LEARN = 2;
// (lines gone through but not learned yet: from this many on no new line comes until the in-betweens have caught up)
const WAITING = 4;
// (how often an in-between takes a line learned already, when there is one: lines not learned yet have the priority)
const LEARNED_SHARE = 0.1;

/** The lines of some repertoire moves from the initial position: [{ id (its moves, uci), moves }], `most` at most. */
export function linesOf(entries, most = 3000) {
  const map = new Map();
  for (const e of entries) map.has(e.key) ? map.get(e.key).push(e) : map.set(e.key, [e]);
  const lines = [];
  const walk = (fen, path, way) => {
    if (lines.length >= most) return;
    const k = repKey(fen);
    const here = way.has(k) ? [] : map.get(k) || []; // (a position come back to ends the line)
    if (!here.length) {
      if (path.length) lines.push({ id: path.map(e => e.uci).join(' '), moves: path });
      return;
    }
    way.add(k);
    for (const e of here) {
      const r = playUci(e.fen, e.uci);
      if (r) walk(r.fen, [...path, e], way);
    }
    way.delete(k);
  };
  walk(INITIAL_FEN, [], new Set());
  return lines;
}

/**
 * The lines the student of `color` can learn (they make a move in them), with how far each is: { id, moves, mine (their
 * moves), shown, drilled, learned }. progress: { line id: { shown, drilled, learned } }. A line with no progress of its own
 * whose moves were all answered right in a drill before Learn existed counts as learned: nothing drilled is lost.
 */
export function learningLines(entries, progress, color) {
  return linesOf(entries)
    .map(l => {
      const p = progress?.[l.id];
      const mine = l.moves.filter(e => turnOf(e.fen) === color);
      const learned = p ? !!p.learned : mine.length > 0 && mine.every(e => e.reps > 0);
      return { ...l, mine, shown: p?.shown || (learned ? 1 : 0), drilled: p?.drilled || 0, learned };
    })
    .filter(l => l.mine.length);
}

/** The moves of some lines, each once. */
export const movesOfLines = lines => [...new Map(lines.flatMap(l => l.moves).map(e => [e.id, e])).values()];

/** Of `list`, one to drill: not the line just done when another can be, among those drilled least. */
function pick(list, last, rnd) {
  const others = list.length > 1 ? list.filter(l => l.id !== last) : list;
  const least = Math.min(...others.map(l => l.drilled));
  const first = others.filter(l => l.drilled === least);
  return first[Math.floor(rnd() * first.length)];
}

/**
 * What a Learn session does next, from its lines as they stand: { kind: 'learn' | 'drill', line }, or null when all are
 * learned. session: { sinceDrill (new lines since the last in-between), last (the line just done), reviewed (a Set: the
 * learned lines that have come back and were played right) }.
 */
export function nextStep(lines, session = {}, rnd = Math.random) {
  const fresh = lines.filter(l => !l.learned && !l.shown);
  const waiting = lines.filter(l => !l.learned && l.shown);
  if (!fresh.length && !waiting.length) return null;
  // (a learned line comes back once a session at most, and never right after it was done)
  const learned = lines.filter(l => l.learned && l.id !== session.last && !session.reviewed?.has(l.id));
  const since = session.sinceDrill || 0;
  // (an in-between once in a while among new lines; only those when no new line is left, or too many wait for theirs)
  const inBetween = !fresh.length || waiting.length >= WAITING || (since > 0 && (since >= 2 || rnd() < 0.5));
  if (inBetween && (waiting.length || learned.length)) {
    const fromLearned = learned.length > 0 && (!waiting.length || rnd() < LEARNED_SHARE);
    return { kind: 'drill', line: pick(fromLearned ? learned : waiting, session.last, rnd) };
  }
  return { kind: 'learn', line: fresh[0] };
}
