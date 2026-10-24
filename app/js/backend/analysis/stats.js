// Player statistics across analysed games (metrics follow lichess Tutor: awareness, luck, conversion,
// resourcefulness, phase accuracy, openings, pieces, clock).
import { getGame, studentColor, gameSummary } from '../games.js';
import { fenOf } from '../chess/core.js';
import { gamePositions } from './game.js';
import { MOTIF_LABELS } from './motifs.js';

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const avg = a => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null);
const ROLE_OF_SAN = san => ({ N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king', O: 'king' })[san[0]] || 'pawn';

export function playerStats({ names, gameIds }) {
  const lower = names.map(n => n.toLowerCase());
  const S = {
    player: names.join(', '),
    games: 0,
    skipped: 0,
    notAnalyzed: 0,
    results: { win: 0, draw: 0, loss: 0 },
    byColor: { white: newColorAgg(), black: newColorAgg() },
    accuracy: [],
    acpl: [],
    phases: { opening: newPhaseAgg(), middlegame: newPhaseAgg(), endgame: newPhaseAgg() },
    errors: { inaccuracy: 0, mistake: 0, blunder: 0 },
    awareness: { chances: 0, taken: 0 },
    luck: { errors: 0, unpunished: 0 },
    conversion: { games: 0, won: 0 },
    resourcefulness: { games: 0, saved: 0 },
    time: { gamesWithClock: 0, timeTroubleErrors: 0, fastErrors: 0, errorsWithClock: 0, spentByPhase: { opening: [], middlegame: [], endgame: [] } },
    openings: new Map(),
    motifs: {},
    pieces: {},
    critical: [],
    missed: [],
    gameList: [],
    ratings: [],
    dates: [],
  };
  for (const id of gameIds) {
    const g = getGame(id);
    if (!g) continue;
    if (!g.analysis) {
      S.notAnalyzed++;
      continue;
    }
    const color = studentColor(g, lower);
    if (!color) {
      S.skipped++;
      continue;
    }
    addGame(S, g, color);
  }
  return finalize(S);
}

const newColorAgg = () => ({ games: 0, win: 0, draw: 0, loss: 0, accuracy: [] });
const newPhaseAgg = () => ({ accuracy: [], moves: 0, inaccuracy: 0, mistake: 0, blunder: 0 });

function addGame(S, g, color) {
  const a = g.analysis;
  S.games++;
  const res = g.result === '1/2-1/2' ? 'draw' : (g.result === '1-0') === (color === 'white') ? 'win' : g.result === '*' ? 'draw' : 'loss';
  S.results[res]++;
  const bc = S.byColor[color];
  bc.games++;
  bc[res]++;
  const acc = a.summary[color].accuracy;
  if (acc !== null && acc !== undefined) {
    S.accuracy.push(acc);
    bc.accuracy.push(acc);
  }
  if (a.summary[color].acpl !== null) S.acpl.push(a.summary[color].acpl);
  const rating = color === 'white' ? g.white_elo : g.black_elo;
  if (rating) S.ratings.push(rating);
  if (g.date) S.dates.push(g.date);
  for (const [phase, v] of Object.entries(a.phaseAccuracy[color] || {})) S.phases[phase].accuracy.push(v);

  const moves = a.moves;
  let positions = null;
  const fenAt = ply => {
    positions ||= gamePositions(g);
    return positions[ply] ? fenOf(positions[ply]) : null;
  };
  let reachedWinning = false;
  let reachedLosing = false;
  let hasClock = false;
  for (let k = 0; k < moves.length; k++) {
    const m = moves[k];
    if (m.color !== color) continue;
    const ph = S.phases[m.phase];
    ph.moves++;
    if (m.judgement) {
      ph[m.judgement]++;
      S.errors[m.judgement]++;
    }
    const role = ROLE_OF_SAN(m.san);
    (S.pieces[role] ||= []).push(m.acc);
    if (m.ply > 2) {
      if (m.wpAfter >= 66.6) reachedWinning = true;
      if (m.wpAfter <= 33.3) reachedLosing = true;
    }
    if (m.clock !== null && m.clock !== undefined) hasClock = true;
    if (m.spent !== null && m.spent !== undefined) S.time.spentByPhase[m.phase].push(m.spent);
    // awareness: the opponent just erred — did we keep the advantage?
    const prevOpp = moves[k - 1];
    if (prevOpp && (prevOpp.judgement === 'mistake' || prevOpp.judgement === 'blunder')) {
      S.awareness.chances++;
      if (m.judgement === 'mistake' || m.judgement === 'blunder') {
        S.missed.push({
          gameId: g.id,
          ply: m.ply,
          fen: fenAt(m.ply - 1),
          opponentMove: label(prevOpp),
          played: label(m),
          best: m.bestSan,
          bestLine: m.bestLine,
          loss: m.loss,
          phase: m.phase,
          game: gameSummary(g),
        });
      } else S.awareness.taken++;
    }
    if (m.judgement === 'mistake' || m.judgement === 'blunder') {
      S.luck.errors++;
      const nextOpp = moves[k + 1];
      if (nextOpp && (nextOpp.judgement === 'mistake' || nextOpp.judgement === 'blunder')) S.luck.unpunished++;
      for (const t of m.motifs || []) S.motifs[t] = (S.motifs[t] || 0) + 1;
      if (m.clock !== null && m.clock !== undefined) {
        S.time.errorsWithClock++;
        if ((m.motifs || []).includes('time_trouble')) S.time.timeTroubleErrors++;
        if (m.spent !== null && m.spent !== undefined && m.spent < 5) S.time.fastErrors++;
      }
    }
    if (m.judgement)
      S.critical.push({
        gameId: g.id,
        ply: m.ply,
        fen: fenAt(m.ply - 1),
        move: label(m),
        san: m.san,
        judgement: m.judgement,
        best: m.bestSan,
        bestLine: m.bestLine,
        reply: m.reply,
        wpBefore: m.wpBefore,
        wpAfter: m.wpAfter,
        loss: m.loss,
        phase: m.phase,
        motifs: m.motifs || [],
        clock: m.clock,
        spent: m.spent,
        color,
        game: gameSummary(g),
      });
  }
  if (hasClock) S.time.gamesWithClock++;
  if (reachedWinning) {
    S.conversion.games++;
    if (res === 'win') S.conversion.won++;
  }
  if (reachedLosing) {
    S.resourcefulness.games++;
    if (res !== 'loss') S.resourcefulness.saved++;
  }
  const family = (g.opening || 'Unknown opening').split(':')[0];
  const okey = `${color}|${family}`;
  const o = S.openings.get(okey) || { color, family, games: 0, points: 0, accuracy: [], openingAccuracy: [], openingErrors: 0, eco: g.eco };
  o.games++;
  o.points += res === 'win' ? 1 : res === 'draw' ? 0.5 : 0;
  if (acc !== null && acc !== undefined) o.accuracy.push(acc);
  if (a.phaseAccuracy[color]?.opening !== undefined) o.openingAccuracy.push(a.phaseAccuracy[color].opening);
  o.openingErrors += moves.filter(m => m.color === color && m.phase === 'opening' && (m.judgement === 'mistake' || m.judgement === 'blunder')).length;
  S.openings.set(okey, o);
  S.gameList.push({ id: g.id, color, result: res, accuracy: acc, opponent: color === 'white' ? g.black : g.white, opening: g.opening, date: g.date, summary: gameSummary(g) });
}

const label = m => (m.color === 'white' ? `${m.moveNumber}. ${m.san}` : `${m.moveNumber}... ${m.san}`);

function finalize(S) {
  const severity = { blunder: 3, mistake: 2, inaccuracy: 1 };
  S.critical.sort((a, b) => b.loss - a.loss || severity[b.judgement] - severity[a.judgement]);
  S.missed.sort((a, b) => b.loss - a.loss);
  const n = S.games || 1;
  return {
    player: S.player,
    games: S.games,
    skipped: S.skipped,
    notAnalyzed: S.notAnalyzed,
    results: { ...S.results, score: pct(S.results.win + S.results.draw / 2, S.games) },
    byColor: Object.fromEntries(
      Object.entries(S.byColor).map(([c, v]) => [c, { games: v.games, win: v.win, draw: v.draw, loss: v.loss, score: pct(v.win + v.draw / 2, v.games), accuracy: avg(v.accuracy) }]),
    ),
    accuracy: avg(S.accuracy),
    acpl: avg(S.acpl),
    rating: S.ratings.length ? Math.round(S.ratings.reduce((s, x) => s + x, 0) / S.ratings.length) : null,
    period: S.dates.length ? { from: [...S.dates].sort()[0], to: [...S.dates].sort().at(-1) } : null,
    errorsPerGame: {
      inaccuracy: Math.round((S.errors.inaccuracy / n) * 100) / 100,
      mistake: Math.round((S.errors.mistake / n) * 100) / 100,
      blunder: Math.round((S.errors.blunder / n) * 100) / 100,
    },
    phases: Object.fromEntries(
      Object.entries(S.phases).map(([p, v]) => [
        p,
        { accuracy: avg(v.accuracy), moves: v.moves, inaccuracy: v.inaccuracy, mistake: v.mistake, blunder: v.blunder, errorsPer100Moves: v.moves ? Math.round(((v.mistake + v.blunder) / v.moves) * 1000) / 10 : null },
      ]),
    ),
    awareness: { ...S.awareness, percent: pct(S.awareness.taken, S.awareness.chances) },
    luck: { ...S.luck, percent: pct(S.luck.unpunished, S.luck.errors) },
    conversion: { ...S.conversion, percent: pct(S.conversion.won, S.conversion.games) },
    resourcefulness: { ...S.resourcefulness, percent: pct(S.resourcefulness.saved, S.resourcefulness.games) },
    time: {
      gamesWithClock: S.time.gamesWithClock,
      timeTroubleErrors: S.time.timeTroubleErrors,
      fastErrors: S.time.fastErrors,
      errorsWithClock: S.time.errorsWithClock,
      avgSecondsPerMove: Object.fromEntries(Object.entries(S.time.spentByPhase).map(([p, v]) => [p, avg(v)])),
    },
    openings: [...S.openings.values()]
      .map(o => ({ color: o.color, family: o.family, eco: o.eco, games: o.games, score: pct(o.points, o.games), accuracy: avg(o.accuracy), openingAccuracy: avg(o.openingAccuracy), openingErrors: o.openingErrors }))
      .sort((a, b) => b.games - a.games),
    motifs: Object.entries(S.motifs)
      .map(([id, count]) => ({ id, label: MOTIF_LABELS[id] || id, count }))
      .sort((a, b) => b.count - a.count),
    pieces: Object.fromEntries(Object.entries(S.pieces).map(([r, v]) => [r, { moves: v.length, accuracy: avg(v) }])),
    critical: S.critical.slice(0, 60),
    missed: S.missed.slice(0, 25),
    gameList: S.gameList,
  };
}

/** Compact text summary of the statistics, for the coach. */
export function describeStats(st, { moments = 25 } = {}) {
  const L = [];
  L.push(`Player: ${st.player}. Analysed games: ${st.games}${st.skipped ? ` (${st.skipped} skipped — player not found)` : ''}${st.notAnalyzed ? ` (${st.notAnalyzed} not analysed yet)` : ''}.`);
  if (st.period) L.push(`Period: ${st.period.from} to ${st.period.to}. Average rating in these games: ${st.rating ?? 'unknown'}.`);
  L.push(`Results: +${st.results.win} =${st.results.draw} -${st.results.loss} (score ${st.results.score}%). As White: ${fmtColor(st.byColor.white)}. As Black: ${fmtColor(st.byColor.black)}.`);
  L.push(`Average accuracy ${st.accuracy}% (lichess formula), average centipawn loss ${st.acpl}.`);
  L.push(`Errors per game: ${st.errorsPerGame.inaccuracy} inaccuracies, ${st.errorsPerGame.mistake} mistakes, ${st.errorsPerGame.blunder} blunders.`);
  L.push(
    'By phase: ' +
      Object.entries(st.phases)
        .map(([p, v]) => `${p} accuracy ${v.accuracy ?? '–'}%, ${v.mistake + v.blunder} mistakes+blunders in ${v.moves} moves (${v.errorsPer100Moves ?? '–'} per 100 moves)`)
        .join('; ') +
      '.',
  );
  L.push(
    `Tactical awareness (punishing opponent mistakes): ${st.awareness.percent ?? '–'}% of ${st.awareness.chances} chances. Luck (own mistakes not punished): ${st.luck.percent ?? '–'}% of ${st.luck.errors}.`,
  );
  L.push(
    `Conversion (won after reaching ≥66.6% win chance): ${st.conversion.percent ?? '–'}% of ${st.conversion.games} games. Resourcefulness (did not lose after falling to ≤33.3%): ${st.resourcefulness.percent ?? '–'}% of ${st.resourcefulness.games} games.`,
  );
  if (st.time.gamesWithClock)
    L.push(
      `Clock: ${st.time.gamesWithClock} games with clock data; ${st.time.timeTroubleErrors} of ${st.time.errorsWithClock} mistakes/blunders made in time trouble; ${st.time.fastErrors} played in under 5 seconds. Average seconds per move: ${Object.entries(st.time.avgSecondsPerMove).map(([p, v]) => `${p} ${v ?? '–'}`).join(', ')}.`,
    );
  if (st.motifs.length) L.push(`Error patterns (mistakes+blunders): ${st.motifs.map(m => `${m.label} ×${m.count}`).join(', ')}.`);
  L.push(`Accuracy by piece moved: ${Object.entries(st.pieces).map(([r, v]) => `${r} ${v.accuracy}% (${v.moves} moves)`).join(', ')}.`);
  L.push('Openings (colour, family: games, score, accuracy, opening-phase accuracy, opening mistakes):');
  for (const o of st.openings.slice(0, 15)) L.push(`  ${o.color} ${o.family} (${o.eco || '?'}): ${o.games} games, ${o.score}%, acc ${o.accuracy ?? '–'}%, opening acc ${o.openingAccuracy ?? '–'}%, ${o.openingErrors} errors`);
  L.push(`\nWorst moments (largest drops in winning chances; FEN is the position BEFORE the student's move):`);
  st.critical.slice(0, moments).forEach((c, i) => {
    L.push(
      `${i + 1}. [game ${c.gameId}, ply ${c.ply}, ${c.phase}] ${c.move} — ${c.judgement}; win chance ${c.wpBefore}% → ${c.wpAfter}%. Better: ${c.best || '?'}${c.bestLine ? ` (${c.bestLine})` : ''}. ${c.reply ? `Punishment: ${c.reply}. ` : ''}Tags: ${c.motifs.join(', ') || '–'}.${c.clock !== null && c.clock !== undefined ? ` Clock ${Math.round(c.clock)}s, spent ${c.spent ?? '?'}s.` : ''}\n   FEN: ${c.fen}\n   Game: ${c.game}`,
    );
  });
  if (st.missed.length) {
    L.push('\nMissed punishments (opponent erred, student did not exploit it):');
    st.missed.slice(0, 10).forEach((c, i) =>
      L.push(`${i + 1}. [game ${c.gameId}, ply ${c.ply}] after ${c.opponentMove}, played ${c.played} instead of ${c.best || '?'}${c.bestLine ? ` (${c.bestLine})` : ''}. FEN: ${c.fen}`),
    );
  }
  return L.join('\n');
}

const fmtColor = c => (c.games ? `${c.games} games, ${c.score}%, accuracy ${c.accuracy ?? '–'}%` : 'no games');
