// Repertoire trees and their groups, spaced repetition, and exercises generated from the student's mistakes.
import { parsePgn, parseComment, startingPosition } from 'chessops/pgn';
import { parseSan, makeSan } from 'chessops/san';
import { run, get, all, tx, now, json } from './db.js';
import { initialPos, fenOf, keyOf, playLine, formatLine, moveFromUci, uciOf, posFromFen, INITIAL_FEN } from './chess/core.js';
import { evaluate, evaluateMove } from './engine/pool.js';
import { winningChances } from './chess/evalmath.js';
import { playerStats } from './analysis/stats.js';

const DAY = 86_400_000;

/** SM-2 style scheduling. grade: 0 = wrong, 1 = hard, 2 = good, 3 = easy. */
export function schedule(item, grade) {
  let { interval = 0, ease = 2.5, reps = 0, lapses = 0 } = item;
  let due;
  if (grade <= 0) {
    reps = 0;
    lapses++;
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
    due = now() + 10 * 60_000;
  } else {
    reps++;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 3;
    else interval = Math.max(interval + 1, Math.round(interval * ease * (grade === 1 ? 0.8 : grade === 3 ? 1.3 : 1)));
    ease = Math.max(1.3, ease + (grade === 3 ? 0.15 : grade === 1 ? -0.15 : 0));
    due = now() + interval * DAY;
  }
  return { interval, ease, reps, lapses, due };
}

// ---------------------------------------------------------------------------------------------
// Repertoire

const badRequest = message => Object.assign(new Error(message), { status: 400 });

function checkColor(color) {
  if (color !== 'white' && color !== 'black') throw badRequest('color must be white or black');
}

/** Moves by the position they are played in. */
function byPosition(entries) {
  const m = new Map();
  for (const e of entries) {
    if (!m.has(e.key)) m.set(e.key, []);
    m.get(e.key).push(e);
  }
  return m;
}

/**
 * The ids of the moves of `entries` that `keep` takes and of the moves that lead to them from the initial position (a
 * move no line from the initial position reaches is in neither).
 */
function movesLeadingTo(entries, keep) {
  const at = byPosition(entries);
  const known = new Map(); // position key -> whether a kept move is reached from it
  const ids = new Set();
  const visit = (pos, way) => {
    const k = keyOf(pos);
    if (known.has(k)) return known.get(k);
    if (way.has(k)) return false; // (a repetition: nothing new that way)
    way.add(k);
    let any = false;
    for (const e of at.get(k) || []) {
      const move = moveFromUci(pos, e.uci);
      if (!move) continue;
      const next = pos.clone();
      next.play(move);
      if (visit(next, way) || keep(e)) {
        ids.add(e.id);
        any = true;
      }
    }
    way.delete(k);
    known.set(k, any);
    return any;
  };
  visit(initialPos(), new Set());
  return ids;
}

/** Removes the moves of a repertoire that no line from the initial position reaches any more. */
function pruneUnreachable(color) {
  const entries = repertoire(color);
  const reachable = movesLeadingTo(entries, () => true);
  for (const e of entries) if (!reachable.has(e.id)) run('DELETE FROM repertoire WHERE id = ?', e.id);
}

/** A PGN move's notes: the comments before and after it, without their [%…] commands (clocks, arrows). */
function pgnNote(data) {
  const text = [...(data.startingComments || []), ...(data.comments || [])]
    .map(c => parseComment(c).text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
  return text ? text.slice(0, 2000) : null;
}

export function addLineToRepertoire(color, moves, comment, { group = null } = {}) {
  checkColor(color);
  const r = playLine(INITIAL_FEN, moves);
  if (r.error) throw badRequest(r.error);
  const g = group ? repertoireGroup(group) : null;
  if (group && g?.color !== color) throw badRequest('There is no such group.');
  let added = 0;
  const pos = initialPos();
  tx(() => {
    r.steps.forEach((s, i) => {
      const res = run(
        'INSERT OR IGNORE INTO repertoire (color, key, fen, uci, san, comment, due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        color,
        keyOf(pos),
        fenOf(pos),
        s.uci,
        s.san,
        i === r.steps.length - 1 ? comment || null : null,
        now(),
        now(),
      );
      added += res.changes;
      pos.play(moveFromUci(pos, s.uci));
    });
    if (g) putInGroup(g.id, color, r.steps.map(s => s.uci));
  });
  return { added, line: formatLine(initialPos(), r.steps.map(s => s.san)), group: g };
}

/** Adds a single move at a position (used when building the repertoire on the board). */
export function addMoveToRepertoire(color, fen, uci, comment) {
  const pos = posFromFen(fen);
  const move = moveFromUci(pos, uci);
  if (!move) throw new Error('Illegal move');
  run(
    'INSERT OR IGNORE INTO repertoire (color, key, fen, uci, san, comment, due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    color,
    keyOf(pos),
    fenOf(pos),
    uciOf(pos, move),
    makeSan(pos, move),
    comment || null,
    now(),
    now(),
  );
}

/** A repertoire's moves, each with `groups`: the ids of the groups it is in. */
export function repertoire(color) {
  return all('SELECT r.*, (SELECT group_concat(m.group_id) FROM repertoire_group_moves m WHERE m.move_id = r.id) AS group_ids FROM repertoire r WHERE r.color = ? ORDER BY r.id', color).map(
    ({ group_ids, ...e }) => ({ ...e, groups: group_ids ? String(group_ids).split(',').map(Number) : [] }),
  );
}

/** Removes a move and every repertoire position that is no longer reachable from the start. */
export function removeFromRepertoire(color, key, uci) {
  tx(() => {
    run('DELETE FROM repertoire WHERE color = ? AND key = ? AND uci = ?', color, key, uci);
    pruneUnreachable(color);
  });
}

/**
 * The repertoire's lines from the initial position, each a list of its rows (move, notes): { lines, truncated } — at
 * most `limit` lines (a transposition ends a line). entries: the moves to follow (a group's, say; default all).
 */
export function repertoireLines(color, limit = 80, entries = repertoire(color)) {
  const byKey = byPosition(entries);
  const lines = [];
  let truncated = false;
  const walk = (pos, path, seen) => {
    if (lines.length >= limit) return void (truncated = true);
    const k = keyOf(pos);
    const here = seen.has(k) ? [] : byKey.get(k) || [];
    if (!here.length) return void (path.length && lines.push(path));
    const next = new Set(seen).add(k);
    for (const e of here) {
      const move = moveFromUci(pos, e.uci);
      if (!move) continue;
      const p = pos.clone();
      p.play(move);
      walk(p, [...path, e], next);
    }
  };
  walk(initialPos(), [], new Set());
  return { lines, truncated };
}

/**
 * Imports every line (variations included) of a PGN into a repertoire, its comments as the moves' notes (a move already
 * there keeps its note, or takes this one when it had none). group: the id of a group the PGN's moves go into.
 */
export function importRepertoirePgn(color, text, { group = null } = {}) {
  checkColor(color);
  const g = group ? repertoireGroup(group) : null;
  if (group && g?.color !== color) throw badRequest('There is no such group.');
  let added = 0;
  const read = new Set(); // "key uci" of every move of the PGN
  tx(() => {
    for (const game of parsePgn(text)) {
      const start = startingPosition(game.headers);
      if (start.isErr) continue;
      const walk = (node, pos) => {
        for (const child of node.children) {
          const move = parseSan(pos, child.data.san);
          if (!move) continue;
          const key = keyOf(pos);
          const uci = uciOf(pos, move);
          const note = pgnNote(child.data);
          const res = run(
            'INSERT OR IGNORE INTO repertoire (color, key, fen, uci, san, comment, due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            color,
            key,
            fenOf(pos),
            uci,
            makeSan(pos, move),
            note,
            now(),
            now(),
          );
          added += res.changes;
          if (!res.changes && note) run(`UPDATE repertoire SET comment = ? WHERE color = ? AND key = ? AND uci = ? AND (comment IS NULL OR comment = '')`, note, color, key, uci);
          read.add(`${key} ${uci}`);
          const next = pos.clone();
          next.play(move);
          walk(child, next);
        }
      };
      walk(game.moves, start.value);
    }
    if (!read.size) throw badRequest('No moves could be read from that PGN.');
    if (g)
      for (const e of repertoire(color))
        if (read.has(`${e.key} ${e.uci}`)) run('INSERT OR IGNORE INTO repertoire_group_moves (group_id, move_id) VALUES (?, ?)', g.id, e.id);
  });
  return { added, moves: read.size, group: g };
}

// ---------------------------------------------------------------------------------------------
// Repertoire groups: the student's folders of lines ("French", "Against the Sicilian"…). A group's lines start at the
// initial position; a move can be in several groups, and the lines in none are the repertoire's other lines.

function cleanGroupName(name) {
  const n = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) throw badRequest('Give the group a name.');
  if (n.length > 60) throw badRequest('A group’s name can have at most 60 characters.');
  return n;
}

export function repertoireGroup(id) {
  return get('SELECT id, color, name FROM repertoire_groups WHERE id = ?', Number(id)) || null;
}

/** A group by its name (any case). */
export function findRepertoireGroup(color, name) {
  return get('SELECT id, color, name FROM repertoire_groups WHERE color = ? AND name = ?', color, String(name ?? '').replace(/\s+/g, ' ').trim()) || null;
}

/** A repertoire's groups by name, each with its numbers: { id, name, moves, studentMoves, due }. */
export function repertoireGroups(color, entries = repertoire(color)) {
  const t = now();
  return all('SELECT id, name FROM repertoire_groups WHERE color = ? ORDER BY name COLLATE NOCASE, id', color).map(g => {
    const moves = entries.filter(e => e.groups.includes(g.id));
    const mine = moves.filter(e => e.fen.split(' ')[1] === color[0]);
    return { id: g.id, name: g.name, moves: moves.length, studentMoves: mine.length, due: mine.filter(e => (e.due || 0) <= t).length };
  });
}

/** The moves of the lines in no group: those moves, and the ones (of any group) that lead to them. */
export function otherRepertoireMoves(entries) {
  const ids = movesLeadingTo(entries, e => !e.groups.length);
  return entries.filter(e => ids.has(e.id));
}

export function createRepertoireGroup(color, name) {
  checkColor(color);
  const n = cleanGroupName(name);
  if (findRepertoireGroup(color, n)) throw badRequest(`There is already a group called “${n}”.`);
  const { id } = run('INSERT INTO repertoire_groups (color, name, created_at) VALUES (?, ?, ?)', color, n, now());
  return { id, color, name: n };
}

export function renameRepertoireGroup(id, name) {
  const g = repertoireGroup(id);
  if (!g) throw badRequest('There is no such group.');
  const n = cleanGroupName(name);
  const other = findRepertoireGroup(g.color, n);
  if (other && other.id !== g.id) throw badRequest(`There is already a group called “${n}”.`);
  run('UPDATE repertoire_groups SET name = ? WHERE id = ?', n, g.id);
  return { ...g, name: n };
}

/**
 * Deletes a group. keepLines: its lines stay in the repertoire (in their other groups, or in none); otherwise the moves
 * only this group had go too — except those that lead to lines that stay (a deleted French's 1. e4 stays when Sicilian
 * lines in no group begin with it). Returns { removed } (moves).
 */
export function deleteRepertoireGroup(id, { keepLines = false } = {}) {
  const g = repertoireGroup(id);
  if (!g) throw badRequest('There is no such group.');
  return tx(() => {
    const before = repertoire(g.color);
    const only = new Set(before.filter(e => e.groups.length === 1 && e.groups[0] === g.id).map(e => e.id));
    run('DELETE FROM repertoire_groups WHERE id = ?', g.id); // (its moves leave it with it)
    if (keepLines || !only.size) return { removed: 0 };
    const stay = movesLeadingTo(before, e => !only.has(e.id));
    for (const e of before) if (only.has(e.id) && !stay.has(e.id)) run('DELETE FROM repertoire WHERE id = ?', e.id);
    pruneUnreachable(g.color);
    return { removed: before.length - repertoire(g.color).length };
  });
}

/**
 * Puts a line into a group: its moves from the initial position and the repertoire's moves after its last one ("this
 * line" is what the student plays from there on, too). The moves must be in the repertoire already.
 */
function putInGroup(groupId, color, ucis) {
  const entries = repertoire(color);
  const at = byPosition(entries);
  const ids = new Set();
  const pos = initialPos();
  for (const u of ucis) {
    const e = (at.get(keyOf(pos)) || []).find(x => x.uci === u);
    const move = moveFromUci(pos, u);
    if (!e || !move) break;
    ids.add(e.id);
    pos.play(move);
  }
  const seen = new Set();
  const after = p => {
    const k = keyOf(p);
    if (seen.has(k)) return;
    seen.add(k);
    for (const e of at.get(k) || []) {
      const move = moveFromUci(p, e.uci);
      if (!move) continue;
      ids.add(e.id);
      const next = p.clone();
      next.play(move);
      after(next);
    }
  };
  after(pos);
  for (const id of ids) run('INSERT OR IGNORE INTO repertoire_group_moves (group_id, move_id) VALUES (?, ?)', groupId, id);
}

/**
 * Takes a line out of a group: the move, the group's moves after it that no other line of the group reaches, and the
 * moves before it that led only there. They stay in the repertoire (in their other groups, or in none). Returns
 * { taken } (moves).
 */
export function removeFromRepertoireGroup(id, key, uci) {
  const g = repertoireGroup(id);
  if (!g) throw badRequest('There is no such group.');
  return tx(() => {
    const inGroup = repertoire(g.color).filter(e => e.groups.includes(g.id));
    const target = inGroup.find(e => e.key === key && e.uci === uci);
    if (!target) throw badRequest(`That move is not in the group “${g.name}”.`);
    const at = byPosition(inGroup);
    const afterKey = e => {
      const p = posFromFen(e.fen);
      const move = moveFromUci(p, e.uci);
      if (move) p.play(move);
      return keyOf(p);
    };
    const ends = new Set(inGroup.filter(e => !at.has(afterKey(e))).map(e => e.id)); // the group's lines end there
    const keep = movesLeadingTo(
      inGroup.filter(e => e !== target),
      e => ends.has(e.id),
    );
    let taken = 0;
    for (const e of inGroup)
      if (!keep.has(e.id)) {
        run('DELETE FROM repertoire_group_moves WHERE group_id = ? AND move_id = ?', g.id, e.id);
        taken++;
      }
    return { taken };
  });
}

export function reviewRepertoireMove(id, grade) {
  const e = get('SELECT * FROM repertoire WHERE id = ?', Number(id));
  if (!e) throw new Error('Unknown repertoire move');
  const s = schedule(e, grade);
  run('UPDATE repertoire SET interval = ?, ease = ?, reps = ?, lapses = ?, due = ? WHERE id = ?', s.interval, s.ease, s.reps, s.lapses, s.due, e.id);
  return s;
}

export function repertoireStats(color) {
  const rows = repertoire(color);
  const mine = rows.filter(r => r.fen.split(' ')[1] === color[0]);
  return { moves: rows.length, studentMoves: mine.length, due: mine.filter(r => (r.due || 0) <= now()).length };
}

// ---------------------------------------------------------------------------------------------
// Exercises

export function listExercises({ dueOnly = false } = {}) {
  const rows = all(`SELECT * FROM exercises ${dueOnly ? 'WHERE due IS NULL OR due <= ?' : ''} ORDER BY due IS NOT NULL, due, id`, ...(dueOnly ? [now()] : []));
  return rows.map(r => ({ ...r, solution: json(r.solution, {}), themes: json(r.themes, []), data: json(r.data, null) }));
}

export function deleteExercise(id) {
  run('DELETE FROM exercises WHERE id = ?', Number(id));
}

export function reviewExercise(id, grade) {
  const e = get('SELECT * FROM exercises WHERE id = ?', Number(id));
  if (!e) throw new Error('Unknown exercise');
  const s = schedule(e, grade);
  run('UPDATE exercises SET interval = ?, ease = ?, reps = ?, lapses = ?, due = ? WHERE id = ?', s.interval, s.ease, s.reps, s.lapses, s.due, e.id);
  return s;
}

/** Checks an answer: the solution move, or any move that keeps (almost) all of the advantage. */
export async function checkExercise(id, uci) {
  const e = get('SELECT * FROM exercises WHERE id = ?', Number(id));
  if (!e) throw new Error('Unknown exercise');
  const sol = json(e.solution, {});
  const pos = posFromFen(e.fen);
  const move = moveFromUci(pos, uci);
  if (!move) return { correct: false, illegal: true };
  const played = uciOf(pos, move);
  if (played === sol.ucis?.[0]) return { correct: true, exact: true, san: makeSan(pos, move), solution: sol };
  const m = await evaluateMove(e.fen, played, { depth: 18 });
  const correct = m.chanceLoss <= 0.03 && !['inaccuracy', 'mistake', 'blunder'].includes(m.classification);
  return { correct, exact: false, san: m.san, solution: sol, evaluation: { classification: m.classification, reply: m.reply, best: m.best } };
}

/**
 * Turns the student's worst analysed moments into puzzles. A position qualifies when the best move is
 * clearly better than the second best (a single good answer), checked with a MultiPV search.
 */
export async function generateExercises({ names, gameIds, max = 20, onProgress }) {
  const st = playerStats({ names, gameIds });
  const candidates = st.critical.filter(c => c.judgement !== 'inaccuracy' && c.best && c.fen);
  let created = 0;
  let checked = 0;
  const seen = new Set();
  const todo = candidates.filter(c => !seen.has(c.fen) && seen.add(c.fen) && !get('SELECT id FROM exercises WHERE fen = ?', c.fen));
  // (four at a time: the agent engine and its helpers check them side by side)
  for (let i = 0; i < todo.length && created < max; i += 4) {
    const batch = todo.slice(i, i + 4);
    const evs = await Promise.all(batch.map(c => evaluate(c.fen, { depth: 18, multipv: 2 })));
    for (const [k, c] of batch.entries()) {
      if (created >= max) break;
      checked++;
      onProgress?.({ checked, created });
      const [l1, l2] = evs[k].lines;
      if (!l1?.pv?.length) continue;
      const pos = posFromFen(c.fen);
      const sign = pos.turn === 'white' ? 1 : -1;
      const gap = l2 ? (sign * (winningChances(l1.score) - winningChances(l2.score))) / 2 : 1;
      if (gap < 0.12) continue;
      const pv = l1.pv.slice(0, 5);
      const sans = l1.san.slice(0, 5);
      const side = pos.turn === 'white' ? 'White' : 'Black';
      const goal = l1.score.mate !== undefined && l1.score.mate * sign > 0 ? 'and mate' : winningChances(l1.score) * sign > 0.5 ? 'and win' : 'and find the best move';
      run(
        `INSERT OR IGNORE INTO exercises (fen, solution, prompt, themes, source, game_id, ply, data, due, created_at) VALUES (?, ?, ?, ?, 'mistake', ?, ?, ?, ?, ?)`,
        c.fen,
        JSON.stringify({ ucis: pv, sans }),
        `${side} to move ${goal}. (In the game you played ${c.san}.)`,
        JSON.stringify(c.motifs.filter(t => t !== 'positional')),
        c.gameId,
        c.ply,
        JSON.stringify({ played: c.san, judgement: c.judgement, game: c.game, phase: c.phase }),
        now(),
        now(),
      );
      created++;
    }
  }
  return { created, checked };
}
