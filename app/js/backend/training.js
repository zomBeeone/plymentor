// Repertoire trees, spaced repetition, and exercises generated from the student's mistakes.
import { parsePgn, startingPosition } from 'chessops/pgn';
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

export function addLineToRepertoire(color, moves, comment) {
  if (color !== 'white' && color !== 'black') throw new Error('color must be white or black');
  const r = playLine(INITIAL_FEN, moves);
  if (r.error) throw new Error(r.error);
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
  });
  return { added, line: formatLine(initialPos(), r.steps.map(s => s.san)) };
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

export function repertoire(color) {
  return all('SELECT * FROM repertoire WHERE color = ? ORDER BY id', color);
}

/** Removes a move and every repertoire position that is no longer reachable from the start. */
export function removeFromRepertoire(color, key, uci) {
  tx(() => {
    run('DELETE FROM repertoire WHERE color = ? AND key = ? AND uci = ?', color, key, uci);
    const entries = repertoire(color);
    const byKey = new Map();
    for (const e of entries) {
      if (!byKey.has(e.key)) byKey.set(e.key, []);
      byKey.get(e.key).push(e);
    }
    const reachable = new Set();
    const queue = [initialPos()];
    const seen = new Set();
    while (queue.length) {
      const pos = queue.shift();
      const k = keyOf(pos);
      if (seen.has(k)) continue;
      seen.add(k);
      for (const e of byKey.get(k) || []) {
        reachable.add(e.id);
        const m = moveFromUci(pos, e.uci);
        if (!m) continue;
        const next = pos.clone();
        next.play(m);
        queue.push(next);
      }
    }
    for (const e of entries) if (!reachable.has(e.id)) run('DELETE FROM repertoire WHERE id = ?', e.id);
  });
}

/**
 * The repertoire's lines from the initial position, each a list of its rows (move, notes): { lines, truncated } — at
 * most `limit` lines (a transposition ends a line).
 */
export function repertoireLines(color, limit = 80) {
  const byKey = new Map();
  for (const e of repertoire(color)) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }
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

/** Imports every line (variations included) of a PGN into a repertoire. */
export function importRepertoirePgn(color, text) {
  let added = 0;
  tx(() => {
    for (const game of parsePgn(text)) {
      const start = startingPosition(game.headers);
      if (start.isErr) continue;
      const walk = (node, pos) => {
        for (const child of node.children) {
          const move = parseSan(pos, child.data.san);
          if (!move) continue;
          const res = run(
            'INSERT OR IGNORE INTO repertoire (color, key, fen, uci, san, comment, due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            color,
            keyOf(pos),
            fenOf(pos),
            uciOf(pos, move),
            makeSan(pos, move),
            (child.data.comments || []).join(' ').trim() || null,
            now(),
            now(),
          );
          added += res.changes;
          const next = pos.clone();
          next.play(move);
          walk(child, next);
        }
      };
      walk(game.moves, start.value);
    }
  });
  return { added };
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
