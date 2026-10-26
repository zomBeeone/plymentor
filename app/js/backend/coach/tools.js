// The coach's tools that run in the Plymentor window: Stockfish, chess logic, and the student's games.
// The coach (a CLI on the student's computer) calls them through its MCP server and the app's coach host:
// mcp.cjs -> coach host (main process) -> page -> this worker. Definitions and input validation are shared with the
// coach host (shared/tools.js). The notes about the student (get/update_player_memory) are answered by the host itself.
import { getSettings } from '../settings.js';
import { run, get, now, json } from '../db.js';
import { posFromFen, fenOf, keyOf, parseMove, playLine, formatLine, moveLabel, moveFromUci, legalMoves, uciOf, initialPos, ChessError, INITIAL_FEN } from '../chess/core.js';
import { describePosition } from '../chess/features.js';
import { evaluate, describeEval, evaluateMove, describeMoveEval } from '../engine/pool.js';
import { lookup, bookMoves, bookPathTo, search as searchOpenings } from '../chess/openings.js';
import { explorer, listGames, getGame, gameSummary, studentColor, myNames, allGameIds } from '../games.js';
import { playerStats, describeStats } from '../analysis/stats.js';
import { jobs } from '../analysis/batch.js';
import { lichessExplorer } from '../online.js';
import { formatScore } from '../chess/evalmath.js';
import { addLineToRepertoire, removeFromRepertoire, repertoire, repertoireLines, repertoireStats } from '../training.js';
import { createReport } from '../reports.js';
import { describeAppState, ENGINE_SCREENS } from './state.js';
import { toolDef, validate, HOST_TOOLS, SCREENS } from '../../../../shared/tools.js';

export class ToolError extends Error {}

const sideName = c => (c === 'white' ? 'White' : 'Black');
const resolveFen = fen => (!fen || fen === 'startpos' ? INITIAL_FEN : fen);

function safePos(fen) {
  try {
    return posFromFen(resolveFen(fen));
  } catch (e) {
    throw new ToolError(e.message);
  }
}

const duration = s => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

/** The coach's written report (save_report, create_report), checked. */
function reportText(markdown) {
  const text = markdown.trim();
  if (!text) throw new ToolError('The report text is empty.');
  if (text.length > 150_000) throw new ToolError('The report is too long (more than 150,000 characters).');
  return text;
}

/**
 * The line on the student's board (the moves from the initial position, as the window reports them) when the position
 * `key` is the one they are looking at or comes one or two moves after it: playLine steps, or null.
 */
function pathOnBoard(screen, key) {
  const c = screen?.context;
  if (!c || c.startFen || !Array.isArray(c.ucis) || c.ucis.length > 300) return null;
  const here = playLine(INITIAL_FEN, c.ucis);
  if (here.error) return null;
  if (keyOf(here.pos) === key) return here.steps;
  const on = ucis => playLine(INITIAL_FEN, [...c.ucis, ...ucis]).steps;
  for (const m1 of legalMoves(here.pos)) {
    const p1 = here.pos.clone();
    const u1 = uciOf(p1, m1);
    p1.play(m1);
    if (keyOf(p1) === key) return on([u1]);
    for (const m2 of legalMoves(p1)) {
      const p2 = p1.clone();
      const u2 = uciOf(p2, m2);
      p2.play(m2);
      if (keyOf(p2) === key) return on([u1, u2]);
    }
  }
  return null;
}

/** What the coach reads about a batch analysis (jobs.status). */
function describeJob(st, { started = false } = {}) {
  const p = st.progress || {};
  const { gameIds = [], preset, nodes } = st.params || {};
  const head = `Analysis #${st.id} (${gameIds.length} game${gameIds.length === 1 ? '' : 's'}, ${preset}: ${Math.round((nodes || 0) / 1000)}k nodes per position)`;
  if (st.status === 'running')
    return `${head} ${started ? 'has started and ' : ''}is still running: ${p.gamesDone ?? 0} of ${p.gamesTotal ?? gameIds.length} games done${p.positionsTotal ? ` (${p.positionsDone} of ${p.positionsTotal} positions)` : ''}${p.eta ? `, about ${duration(p.eta)} left` : ''}. The student sees its progress in the app and can keep using it. Check it with get_analysis_status (wait_seconds up to 240).`;
  if (st.status === 'failed') return `${head} failed: ${st.error || 'unknown error'}.`;
  const L = [st.status === 'cancelled' ? `${head} was stopped by the student after ${p.gamesDone ?? 0} of ${gameIds.length} games.` : `${head} is finished.`];
  const games = gameIds.length ? listGames({ ids: gameIds.join(','), limit: gameIds.length }).games : [];
  const analysed = games.filter(g => g.analyzed);
  if (analysed.length) {
    L.push('Analysed (accuracy White / Black):');
    for (const g of analysed.slice(0, 40)) L.push(`- ${gameSummary(g)} — ${g.white_acc ?? '?'}% / ${g.black_acc ?? '?'}%`);
    if (analysed.length > 40) L.push(`- and ${analysed.length - 40} more`);
  }
  const rest = games.filter(g => !g.analyzed);
  if (rest.length) L.push(`Not analysed: ${rest.map(g => `#${g.id}`).join(', ')}.`);
  if (analysed.length) L.push("A game's moves and errors: get_game; patterns across games: find_mistakes and get_player_stats.");
  return L.join('\n');
}

const executors = {
  async analyze_position({ fen, multipv = 3, depth = 20 }) {
    const pos = safePos(fen);
    const ev = await evaluate(fenOf(pos), { depth, multipv, maxTime: 25_000 });
    return `Position ${fenOf(pos)} — ${sideName(pos.turn)} to move.\n${describeEval(ev)}`;
  },

  async evaluate_move({ fen, move }) {
    const pos = safePos(fen);
    const parsed = parseMove(pos, move);
    if (!parsed) throw new ToolError(`"${move}" is not a legal move in ${fenOf(pos)} (${sideName(pos.turn)} to move).`);
    const m = await evaluateMove(fenOf(pos), parsed.uci, { depth: 18, maxTime: 15_000 });
    return `${describeMoveEval(m)}\nFEN after the move: ${m.afterFen}`;
  },

  async play_moves({ fen, moves }) {
    const start = fenOf(safePos(fen));
    const r = playLine(start, moves);
    const out = r.steps.map(s => `${moveLabel(s.moveNumber, s.color, s.san)}${s.mate ? ' (checkmate)' : s.check ? ' (check)' : ''} → ${s.fen}`);
    if (r.error) out.push(`ERROR: ${r.error}`);
    if (!r.steps.length && !r.error) out.push('No moves given.');
    return out.join('\n');
  },

  async get_position_features({ fen }) {
    return describePosition(safePos(fen));
  },

  async opening_info({ fen }) {
    const pos = safePos(fen);
    const f = fenOf(pos);
    const lines = [];
    const op = lookup(keyOf(pos));
    lines.push(op ? `Opening: ${op.eco} ${op.name}${op.exact ? '' : ' (nearest named position on this line)'}; reference moves: ${op.pgn}` : 'Opening: no named opening at this position (out of the book or a rare line).');
    const book = bookMoves(f);
    if (book.length) lines.push(`Book continuations: ${book.slice(0, 15).map(b => `${b.san}${b.name ? ` → ${b.eco} ${b.name}` : ''}`).join('; ')}`);
    const names = myNames();
    if (names.length) {
      const mine = explorer({ fen: f, player: names.join(',') });
      if (mine.moves.length)
        lines.push(
          `The student's games from here: ${mine.moves
            .slice(0, 8)
            .map(m => `${m.san} ×${m.games} (+${m.white} =${m.draws} -${m.black} for White)`)
            .join(', ')}`,
        );
      else lines.push("The student's games: this position has not occurred in their imported games.");
    }
    const all = explorer({ fen: f });
    if (all.moves.length) lines.push(`All imported games from here: ${all.moves.slice(0, 8).map(m => `${m.san} ×${m.games}`).join(', ')}`);
    const masters = await lichessExplorer({ db: 'masters', fen: f }).catch(() => null);
    if (masters && !masters.error && Array.isArray(masters.moves)) {
      const total = (masters.white || 0) + (masters.draws || 0) + (masters.black || 0);
      lines.push(
        `Lichess Masters database (${total} games): ${masters.moves
          .slice(0, 8)
          .map(m => {
            const n = m.white + m.draws + m.black || 1;
            return `${m.san} ${n} games (White ${Math.round((m.white / n) * 100)}% / draw ${Math.round((m.draws / n) * 100)}% / Black ${Math.round((m.black / n) * 100)}%)`;
          })
          .join('; ')}`,
      );
      if (masters.topGames?.length)
        lines.push(`Top master games: ${masters.topGames.map(g => `${g.white?.name} – ${g.black?.name} ${g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½'} (${g.year})`).join('; ')}`);
    }
    return lines.join('\n');
  },

  async search_openings({ query, limit = 10 }) {
    const hits = searchOpenings(query, limit);
    if (!hits.length) return `No opening matches "${query}".`;
    return hits.map(h => `${h.eco} ${h.name}: ${h.pgn}\n  FEN: ${h.fen}`).join('\n');
  },

  async search_games({ player, color = 'any', result = 'any', opening, analyzed_only, limit = 20 }) {
    const names = player ? [player] : myNames();
    if (!names.length && !player) return 'The student has not set their usernames in Settings, so their games cannot be identified. Ask them to add their usernames, or pass a player name.';
    const res = listGames({
      player: names.join(','),
      color: color === 'any' ? undefined : color,
      result: result === 'any' ? undefined : result,
      opening,
      analyzed: analyzed_only ? '1' : undefined,
      limit,
      sort: 'date',
    });
    if (!res.games.length) return 'No games match.';
    return [
      `${res.total} games match; showing ${res.games.length}:`,
      ...res.games.map(g => `${gameSummary(g)}${g.analyzed ? ` — accuracy W ${g.white_acc ?? '?'}% / B ${g.black_acc ?? '?'}%` : ' — not analysed'}`),
    ].join('\n');
  },

  async get_game({ game_id, from_ply = 0, to_ply }) {
    const g = getGame(game_id);
    if (!g) throw new ToolError(`No game with id ${game_id}.`);
    const color = studentColor(g);
    const L = [gameSummary(g) + (color ? `. The student played ${color}.` : '')];
    const a = g.analysis;
    const start = posFromFen(g.start_fen || INITIAL_FEN);
    if (a) {
      const s = a.summary;
      L.push(
        `Engine analysis: accuracy White ${s.white.accuracy}% / Black ${s.black.accuracy}%; ACPL ${s.white.acpl}/${s.black.acpl}; White ${s.white.inaccuracies}?! ${s.white.mistakes}? ${s.white.blunders}??; Black ${s.black.inaccuracies}?! ${s.black.mistakes}? ${s.black.blunders}??.`,
      );
      const d = a.division;
      L.push(`Phases: middlegame from ply ${d.middle ?? '–'}, endgame from ply ${d.end ?? '–'}.`);
    } else L.push('Not analysed yet (no engine evaluations).');
    const to = Math.min(to_ply ?? g.sans.length, g.sans.length);
    const parts = [];
    const pos = start.clone();
    for (let i = 0; i < to; i++) {
      const san = g.sans[i];
      const isWhite = pos.turn === 'white';
      const prefix = isWhite ? `${pos.fullmoves}. ` : i === from_ply ? `${pos.fullmoves}... ` : '';
      const m = a?.moves[i];
      if (i >= from_ply) {
        let ann = '';
        if (m) {
          const glyph = { inaccuracy: '?!', mistake: '?', blunder: '??' }[m.judgement] || '';
          ann = `${glyph} {${formatScore(m.score)}${m.judgement ? `, ${m.judgement}; best ${m.bestSan}` : ''}${m.clock !== null && m.clock !== undefined ? `, ${Math.round(m.clock)}s` : ''}}`;
        } else if (g.clocks?.[i] !== null && g.clocks?.[i] !== undefined) ann = ` {${Math.round(g.clocks[i])}s}`;
        parts.push(`${prefix}${san}${ann}`);
      }
      const mv = moveFromUci(pos, g.moves[i]);
      if (!mv) break;
      pos.play(mv);
    }
    L.push(`Moves (ply ${from_ply + 1}–${to}): ${parts.join(' ')}`);
    L.push(`Result: ${g.result}${g.termination ? ` (${g.termination})` : ''}`);
    if (a) {
      const critical = a.moves.filter(m => m.judgement && (m.judgement !== 'inaccuracy' || !color || m.color === color));
      if (critical.length) {
        L.push('Critical moments (FEN before the move):');
        const p2 = start.clone();
        const fens = [fenOf(p2)];
        for (const u of g.moves) {
          const mv = moveFromUci(p2, u);
          if (!mv) break;
          p2.play(mv);
          fens.push(fenOf(p2));
        }
        for (const m of critical.slice(0, 20))
          L.push(
            `- ply ${m.ply}: ${moveLabel(m.moveNumber, m.color, m.san)} (${m.color}${color ? (m.color === color ? ', student' : ', opponent') : ''}) ${m.judgement}${m.mate ? ` (mate ${m.mate})` : ''}, win chance ${m.wpBefore}%→${m.wpAfter}%; best ${m.bestSan}${m.bestLine ? `: ${m.bestLine}` : ''}${m.reply ? `; punishment: ${m.reply}` : ''}; tags: ${(m.motifs || []).join(', ')}\n  FEN: ${fens[m.ply - 1]}`,
          );
      }
    }
    return L.join('\n');
  },

  async find_mistakes({ game_ids, phase = 'any', motif, min_judgement = 'mistake', include_missed_punishments = false, limit = 15 }) {
    const names = myNames();
    if (!names.length) return 'The student has not set their usernames in Settings, so their side in each game is unknown.';
    const ids = game_ids?.length ? game_ids : allGameIds({ player: names.join(','), analyzed: '1' });
    if (!ids.length) return 'No analysed games of the student yet: analyse their games with analyze_games (or they can, on the Games screen).';
    const st = playerStats({ names, gameIds: ids });
    const rank = { inaccuracy: 1, mistake: 2, blunder: 3 };
    const list = st.critical
      .filter(c => rank[c.judgement] >= rank[min_judgement])
      .filter(c => phase === 'any' || c.phase === phase)
      .filter(c => !motif || c.motifs.includes(motif))
      .slice(0, limit);
    const L = [`${list.length} moments (from ${st.games} analysed games):`];
    list.forEach((c, i) =>
      L.push(
        `${i + 1}. [game ${c.gameId}, ply ${c.ply}, ${c.phase}] ${c.move} (${c.color}) — ${c.judgement}, win chance ${c.wpBefore}%→${c.wpAfter}%. Better: ${c.best}${c.bestLine ? ` (${c.bestLine})` : ''}.${c.reply ? ` Punishment: ${c.reply}.` : ''} Tags: ${c.motifs.join(', ')}.\n   FEN: ${c.fen}\n   ${c.game}`,
      ),
    );
    if (include_missed_punishments && st.missed.length) {
      L.push('Missed punishments:');
      st.missed.slice(0, 8).forEach((c, i) => L.push(`${i + 1}. [game ${c.gameId}, ply ${c.ply}] after ${c.opponentMove}, the student played ${c.played} instead of ${c.best}${c.bestLine ? ` (${c.bestLine})` : ''}. FEN: ${c.fen}`));
    }
    return L.join('\n');
  },

  async get_player_stats({ game_ids }) {
    const names = myNames();
    if (!names.length) return 'The student has not set their usernames in Settings.';
    const ids = game_ids?.length ? game_ids : allGameIds({ player: names.join(','), analyzed: '1' });
    if (!ids.length) return 'No analysed games of the student yet: analyse some with analyze_games.';
    return describeStats(playerStats({ names, gameIds: ids }), { moments: 10 });
  },

  async analyze_games({ game_ids, limit = 10, depth, reanalyse = false, wait_seconds = 240 }) {
    let ids = game_ids;
    if (!ids?.length) {
      const names = myNames();
      if (!names.length) return 'The student has not set their usernames in Settings, so their games are not known. Pass game_ids (from search_games), or ask them to add their usernames.';
      ids = listGames({ player: names.join(','), analyzed: reanalyse ? undefined : '0', limit, sort: 'date' }).games.map(g => g.id);
      if (!ids.length) return reanalyse ? 'The student has no imported games.' : "All of the student's games are analysed already: get_game, find_mistakes and get_player_stats use them. (With reanalyse and a deeper depth, games are analysed again.)";
    }
    const known = new Set(listGames({ ids: ids.join(','), limit: ids.length }).games.map(g => g.id));
    const unknown = ids.filter(id => !known.has(id));
    if (!known.size) throw new ToolError(`No game with the id${ids.length === 1 ? '' : 's'} ${ids.join(', ')}.`);
    let job;
    try {
      job = jobs.startAnalysis({ gameIds: ids.filter(id => known.has(id)), preset: depth, force: reanalyse });
    } catch (e) {
      const r = e.running;
      if (r) return `Stockfish is already analysing games (analysis #${r.id}: ${r.progress.gamesDone} of ${r.progress.gamesTotal} games done) — one analysis runs at a time. Wait for it with get_analysis_status, then start yours.`;
      throw new ToolError(e.message);
    }
    const text = describeJob(await jobs.wait(job.id, wait_seconds * 1000), { started: true });
    return unknown.length ? `${text}\n(No game with the id${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}.)` : text;
  },

  async get_analysis_status({ job_id, wait_seconds = 0 }) {
    const id = job_id ?? jobs.latestId();
    if (!id) return 'No games have been analysed with Stockfish yet: start an analysis with analyze_games.';
    if (!jobs.status(id)) throw new ToolError(`There is no analysis #${id}.`);
    return describeJob(await jobs.wait(id, wait_seconds * 1000));
  },

  async set_board({ fen, moves_from_start: fromStart, moves = [], arrows = [], highlights = [], caption, orientation, ask_move = false }, ctx) {
    if (!fen && !fromStart) throw new ToolError('Give the position: fen, or moves_from_start (the moves from the initial position that lead to it).');
    // How the position arises from the initial position, when that is known: the coach's own moves, the line on the
    // student's board, or the opening book. The board shows those moves (the Openings board plays them out).
    let pos;
    let path = null;
    let pathFrom = null;
    if (fromStart) {
      const r = playLine(INITIAL_FEN, fromStart);
      if (r.error) throw new ToolError(`moves_from_start: ${r.error}`);
      if (fen && keyOf(safePos(fen)) !== keyOf(r.pos))
        throw new ToolError(`moves_from_start lead to ${r.fen}, not to the fen you gave (${fenOf(safePos(fen))}). Check the moves with play_moves, or leave fen out.`);
      pos = r.pos;
      path = r.steps;
      pathFrom = 'moves';
    } else pos = safePos(fen);
    const start = fenOf(pos);
    if (!path) {
      path = pathOnBoard(ctx.screen, keyOf(pos));
      if (path) pathFrom = 'board';
    }
    if (!path) {
      const ucis = bookPathTo(keyOf(pos));
      if (ucis) {
        path = playLine(INITIAL_FEN, ucis).steps;
        pathFrom = 'book';
      }
    }
    let line = [];
    if (moves.length) {
      const r = playLine(start, moves);
      if (r.error) throw new ToolError(r.error);
      line = r.steps.map(s => ({ san: s.san, uci: s.uci, fen: s.fen }));
    }
    const shapes = [];
    for (const a of arrows) {
      const m = /^([a-h][1-8])\s*-?\s*([a-h][1-8])?\s*([grby])?/i.exec(a.trim());
      if (m) shapes.push({ orig: m[1].toLowerCase(), dest: m[2]?.toLowerCase(), brush: { g: 'green', r: 'red', b: 'blue', y: 'yellow' }[(m[3] || 'g').toLowerCase()] });
    }
    for (const h of highlights) if (/^[a-h][1-8]$/i.test(h.trim())) shapes.push({ orig: h.trim().toLowerCase(), brush: 'yellow' });
    ctx.emit({
      type: 'ui',
      action: 'set_board',
      fen: start,
      path: path ? path.map(s => ({ uci: s.uci, san: s.san })) : null,
      pathFrom,
      line,
      shapes,
      caption: caption ? String(caption).slice(0, 300) : null,
      orientation: orientation || null,
      askMove: ask_move,
    });
    const openings = ctx.screen?.view === 'openings' || ctx.screen?.view === 'drill';
    let how = '';
    if (path?.length && pathFrom !== 'board') {
      const shown = formatLine(initialPos(), path.map(s => s.san));
      how = openings ? ` The board plays it out from the initial position: ${shown}.` : ` Its moves from the initial position are in the move list: ${shown}.`;
    } else if (!path && openings) how = ' The moves that lead to it are not known, so the board shows it on its own; give moves_from_start to show how it arises.';
    return ask_move
      ? `Shown on the student's board (${sideName(pos.turn)} to move).${how} They will answer by playing a move; end your turn now and wait for it.`
      : `Shown on the student's board${line.length ? ` with a ${line.length}-move line to step through` : ''}.${how}`;
  },

  async switch_screen({ screen, tab }, ctx) {
    const s = SCREENS[screen];
    if (tab && !s.tabs.includes(tab)) throw new ToolError(s.tabs.length ? `The ${s.label} screen has the tabs ${s.tabs.join(', ')}, not ${tab}.` : `The ${s.label} screen has no tabs.`);
    const t = tab || s.defaultTab || null;
    ctx.emit({ type: 'ui', action: 'switch_screen', view: s.view, tab: t });
    const seen = s.coach && t !== 'repertoire';
    return `Switched the app to the ${s.label} screen${t ? ` (${t} tab)` : ''}.${seen ? '' : ' Your panel is not shown there: the student reads your messages again on the Board, Openings (coach tab), Reports or Train screen — switch back when you are done there.'}`;
  },

  async set_engine({ on, screen }, ctx) {
    const view = ctx.screen?.view;
    const here = ENGINE_SCREENS[view];
    const screens = screen === 'both' || (!screen && !here) ? ['board', 'openings'] : [screen || here];
    ctx.emit({ type: 'ui', action: 'set_engine', screens, on });
    const state = on ? 'on' : 'off';
    const where = `the ${screens.map(s => SCREENS[s].label).join(' and ')} screen${screens.length > 1 ? 's' : ''}`;
    const before = ctx.screen?.engines;
    const L = [
      before && screens.every(s => before[s] === on)
        ? `The student's live Stockfish analysis on ${where} was already ${state}.`
        : `Switched ${state} the student's live Stockfish analysis on ${where}: ${on ? 'they see its evaluation bar, engine lines and best-move arrow there' : 'they see no evaluation bar, engine lines or best-move arrow there; your own Stockfish tools work as always'}.`,
    ];
    if (on && screens.includes(here) && view === 'play') L.push('It stays hidden while their training game is on the board, and shows when they leave the game.');
    if (on && screens.includes(here) && view === 'drill') L.push('It stays hidden during the repertoire drill they are doing.');
    return L.join(' ');
  },

  async create_exercise({ fen, solution, prompt, themes = [], game_id, ply }, ctx) {
    const pos = safePos(fen);
    const r = playLine(fenOf(pos), solution);
    if (r.error) throw new ToolError(`Solution is not legal: ${r.error}`);
    const ucis = r.steps.map(s => s.uci);
    run(
      `INSERT INTO exercises (fen, solution, prompt, themes, source, game_id, ply, due, created_at) VALUES (?, ?, ?, ?, 'coach', ?, ?, ?, ?)
       ON CONFLICT(fen) DO UPDATE SET solution = excluded.solution, prompt = excluded.prompt, themes = excluded.themes`,
      fenOf(pos),
      JSON.stringify({ ucis, sans: r.steps.map(s => s.san) }),
      String(prompt).slice(0, 300),
      JSON.stringify(themes.map(t => String(t).slice(0, 60))),
      game_id ?? null,
      ply ?? null,
      now(),
      now(),
    );
    ctx.emit({ type: 'ui', action: 'exercise_created' });
    const id = get('SELECT id FROM exercises WHERE fen = ?', fenOf(pos))?.id; // (an upsert does not report the row id)
    return `Exercise saved to the training deck (id ${id}). Solution: ${formatLine(pos, r.steps.map(s => s.san))}.`;
  },

  async get_repertoire({ color }) {
    const st = repertoireStats(color);
    if (!st.moves) return `The student's ${color} repertoire is empty.`;
    const { lines, truncated } = repertoireLines(color);
    const L = [`The student's ${color} repertoire: ${st.moves} moves, ${st.studentMoves} of them ${color}'s (${st.due} due for review). Its lines from the initial position:`];
    for (const line of lines)
      L.push(
        `- ${line
          .map((e, i) => {
            const [, turn, , , , n] = e.fen.split(' ');
            return `${turn === 'w' ? `${n}. ` : i === 0 ? `${n}... ` : ''}${e.san}${e.comment ? ` {${e.comment}}` : ''}`;
          })
          .join(' ')}`,
      );
    if (truncated) L.push(`(and more lines: only the first ${lines.length} are listed)`);
    return L.join('\n');
  },

  async remove_from_repertoire({ color, moves }, ctx) {
    const r = playLine(INITIAL_FEN, moves);
    if (r.error) throw new ToolError(r.error);
    const last = r.steps.at(-1);
    const key = keyOf(posFromFen(r.steps.length > 1 ? r.steps.at(-2).fen : INITIAL_FEN));
    const label = moveLabel(last.moveNumber, last.color, last.san);
    const entries = repertoire(color);
    if (!entries.some(e => e.key === key && e.uci === last.uci)) {
      const there = entries.filter(e => e.key === key).map(e => e.san);
      throw new ToolError(`${label} is not in the student's ${color} repertoire after ${r.steps.length > 1 ? formatLine(initialPos(), r.steps.slice(0, -1).map(s => s.san)) : 'the initial position'}${there.length ? `; there it has ${there.join(', ')}` : ''}. get_repertoire shows its lines.`);
    }
    removeFromRepertoire(color, key, last.uci);
    const removed = entries.length - repertoire(color).length;
    ctx.emit({ type: 'ui', action: 'repertoire_updated', color });
    return `Removed ${label} from the student's ${color} repertoire, with what followed it: ${removed} move${removed === 1 ? '' : 's'} in all.`;
  },

  async add_to_repertoire({ color, moves, comment }, ctx) {
    let r;
    try {
      r = addLineToRepertoire(color, moves, comment ? String(comment).slice(0, 500) : comment);
    } catch (e) {
      throw new ToolError(e.message);
    }
    ctx.emit({ type: 'ui', action: 'repertoire_updated', color });
    return `Added to the ${color} repertoire: ${r.line} (${r.added} new moves).`;
  },

  async get_board_state(_input, ctx) {
    return describeAppState(ctx.screen || null);
  },

  async open_game({ game_id, ply = 0 }, ctx) {
    const g = getGame(game_id);
    if (!g) throw new ToolError(`No game with id ${game_id}.`);
    const at = Math.min(ply, g.moves.length);
    ctx.emit({ type: 'ui', action: 'open_game', gameId: g.id, ply: at });
    return `Opened on the analysis board: ${gameSummary(g)}, ${at ? `after ply ${at} (${g.sans[at - 1]})` : 'at the start'}.`;
  },

  async create_report({ game_ids, title, markdown }, ctx) {
    const names = myNames();
    if (!names.length) throw new ToolError('The student has not set their usernames in Settings, so their side in each game is unknown and no report can be made. Ask them to add their usernames.');
    const narrative = markdown === undefined ? null : reportText(markdown);
    const gameIds = game_ids && [...new Set(game_ids)];
    const r = createReport({ names, gameIds, title: title?.replace(/\s+/g, ' ').trim(), display: getSettings().profile.usernames?.[0] || names[0], narrative });
    if (!r.id) {
      if (!gameIds) throw new ToolError('No analysed games of the student yet: analyse their games with analyze_games first (or they can, on the Games screen).');
      const { notAnalyzed, skipped } = r.stats;
      const missing = gameIds.length - notAnalyzed - skipped;
      throw new ToolError(
        `None of these games can go into a report: ${[notAnalyzed && `${notAnalyzed} not analysed yet (analyse them with analyze_games first)`, skipped && `${skipped} not played by the student`, missing && `${missing} not found`].filter(Boolean).join(', ')}.`,
      );
    }
    ctx.emit({ type: 'ui', action: 'report_created', id: r.id, title: r.title });
    const n = r.stats.games;
    return [
      `Added report #${r.id} "${r.title}" to the Reports screen: statistics over ${n} analysed game${n === 1 ? '' : 's'} of the student${narrative ? `, with your written report (${narrative.length} characters)` : ''}.`,
      describeStats(r.stats, { moments: 20 }),
      narrative ? '' : `\nSave your written report to it with save_report (report_id ${r.id}).`,
    ]
      .join('\n')
      .trim();
  },

  async get_report({ report_id }) {
    const r = report_id ? get('SELECT * FROM reports WHERE id = ?', report_id) : get('SELECT * FROM reports ORDER BY id DESC LIMIT 1');
    if (!r) throw new ToolError(report_id ? `No report #${report_id}.` : "There are no reports yet: add one with create_report (statistics over the student's analysed games).");
    const stats = json(r.stats);
    return [
      `Report #${r.id}: "${r.title}" — player ${r.player}, ${stats?.games ?? 0} analysed games.`,
      stats ? describeStats(stats, { moments: 20 }) : '(no statistics)',
      r.narrative ? `\nYour saved written report:\n${r.narrative}` : '\nNo written report has been saved for it yet.',
    ].join('\n');
  },

  async save_report({ report_id, markdown }, ctx) {
    const r = get('SELECT id, title FROM reports WHERE id = ?', report_id);
    if (!r) throw new ToolError(`No report #${report_id}.`);
    const text = reportText(markdown);
    run('UPDATE reports SET narrative = ?, updated_at = ? WHERE id = ?', text, now(), r.id);
    ctx.emit({ type: 'ui', action: 'report_saved', id: r.id });
    return `Saved your report to "${r.title}" on the Reports screen (${text.length} characters).`;
  },

  async speak({ text }, ctx) {
    if (!getSettings().voice?.enabled)
      return 'The student has your voice switched off, so nothing was said out loud. Do not call speak again until the app tells you the voice is on.';
    const say = text.trim().slice(0, 2000);
    if (!say) throw new ToolError('Nothing to say.');
    ctx.emit({ type: 'ui', action: 'speak', id: crypto.randomUUID(), text: say }); // the open page plays it
    return 'Said out loud in the app.';
  },
};

/**
 * Runs a tool. ctx: { emit(uiEvent), screen ({ view, context } of the page, for get_board_state) }.
 * Returns { content: string, isError: boolean }.
 */
export async function executeTool(name, input, ctx) {
  const def = toolDef(name);
  const fn = Object.hasOwn(executors, name) ? executors[name] : null;
  if (!def || !fn || HOST_TOOLS.has(name)) return { content: `Unknown tool ${name}`, isError: true };
  const errs = validate(def.input_schema, input);
  if (errs.length) return { content: `Invalid input for ${name}: ${errs.join('; ')}`, isError: true };
  try {
    const content = await fn(input, ctx);
    return { content: String(content), isError: false };
  } catch (e) {
    if (e instanceof ToolError || e instanceof ChessError) return { content: e.message, isError: true };
    console.error(`tool ${name} failed:`, e);
    return { content: `Tool failed: ${e.message}`, isError: true };
  }
}
