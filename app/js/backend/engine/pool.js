// Engine roles: live (board analysis), agent (coach tools + move judgement — with helpers beside it, agent-2…, when
// several are asked for at once), batch workers, play (sparring).
// Each role is its own Stockfish (WebAssembly, in a Web Worker): multi-threaded when the page is cross-origin
// isolated (SharedArrayBuffer available), single-threaded otherwise.
import { Emitter } from '../emitter.js';
import { UciEngine, workerTransport } from './uci.js';
import { getSettings, cpuThreads } from '../settings.js';
import { run, get } from '../db.js';
import { posFromFen, fenOf, keyOf, moveFromUci, uciOf, ucisToSans, formatLine, outcomeText } from '../chess/core.js';
import { makeSan } from 'chessops/san';
import { classifyMove, judge, chanceLoss, cpLoss, povWin, winningChances, formatScore } from '../chess/evalmath.js';

export const ENGINE_FILES = {
  threaded: '/engine/stockfish-19-lite.js',
  single: '/engine/stockfish-19-lite-single.js',
};
const threadedAvailable = () => typeof self !== 'undefined' && !!self.crossOriginIsolated && typeof SharedArrayBuffer === 'function';

// How engines are created; tests replace it with a native Stockfish process.
let engineFactory = () => workerTransport(threadedAvailable() ? ENGINE_FILES.threaded : ENGINE_FILES.single);
export function setEngineFactory(factory) {
  engineFactory = factory;
}

const engines = new Map(); // role -> { engine, ready }

export function engineOptions(role) {
  const s = getSettings().engine;
  if (role === 'live') return { Threads: s.liveThreads, Hash: s.liveHash, UCI_ShowWDL: 'true' };
  if (role === 'agent') return { Threads: s.agentThreads, Hash: s.agentHash, UCI_ShowWDL: 'true' };
  // (a helper: as many threads as the agent engine — the four together no more than the computer has)
  if (role.startsWith('agent-')) return { Threads: Math.max(1, Math.min(s.agentThreads, Math.floor((cpuThreads() - s.agentThreads) / 3))), Hash: s.agentHash, UCI_ShowWDL: 'true' };
  if (role === 'play') return { Threads: 1, Hash: 16 };
  return { Threads: s.batchThreads, Hash: s.batchHash };
}

/** The engine of a role, started and configured (concurrent callers share the start-up). */
export function getEngine(role) {
  const existing = engines.get(role);
  if (existing && existing.engine.alive) return existing.ready;
  const engine = new UciEngine(engineFactory(), role);
  const entry = { engine, ready: null };
  entry.ready = (async () => {
    await engine.start();
    await engine.setOptions(engineOptions(role));
    return engine;
  })();
  engines.set(role, entry);
  const forget = () => {
    if (engines.get(role) === entry) engines.delete(role);
  };
  engine.on('dead', forget);
  entry.ready.catch(forget);
  return entry.ready;
}

const runningEngine = role => {
  const e = engines.get(role)?.engine;
  return e?.alive ? e : null;
};

/** The roles whose engine runs now ("agent", "agent-2", "batch-1"…). */
export const runningEngines = () => [...engines.keys()].filter(runningEngine);

export function stopEngine(role) {
  const entry = engines.get(role);
  if (entry) {
    engines.delete(role);
    entry.engine.quit();
  }
}

export function stopAllEngines() {
  live.stop();
  for (const role of [...engines.keys()]) stopEngine(role);
}

/** Restart every engine (after thread/hash settings change). */
export function restartEngines() {
  for (const role of [...engines.keys()]) stopEngine(role);
  live.restart();
}

export async function engineInfo() {
  try {
    const e = await getEngine('agent');
    return { ok: true, name: e.idName || 'Stockfish', threaded: threadedAvailable(), maxThreads: e.optionInfo.Threads?.max ?? null };
  } catch (err) {
    return { ok: false, error: err.message, threaded: threadedAvailable() };
  }
}

// ---------------------------------------------------------------------------------------------
// Live analysis: one continuously running search, the latest request always wins.

class LiveAnalysis extends Emitter {
  constructor() {
    super();
    this.pending = null;
    this.active = null;
    this.looping = false;
  }

  analyze(req) {
    this.pending = { ...req, multipv: Math.max(1, Math.min(5, Number(req.multipv) || 3)) };
    runningEngine('live')?.stop();
    if (!this.looping) this.loop();
  }

  stop() {
    this.pending = null;
    runningEngine('live')?.stop();
  }

  restart() {
    this.pending = null;
    this.active = null;
  }

  async loop() {
    this.looping = true;
    try {
      while (this.pending) {
        const req = this.pending;
        this.pending = null;
        this.active = req;
        let engine;
        try {
          engine = await getEngine('live');
        } catch (err) {
          this.emit('event', { type: 'error', id: req.id, message: err.message });
          break;
        }
        const started = Date.now();
        const maxMs = (getSettings().engine.liveMaxSeconds || 60) * 1000;
        let lastEmit = 0;
        let lastDepth = 0;
        let pos;
        try {
          pos = posFromFen(req.fen);
        } catch (err) {
          this.emit('event', { type: 'error', id: req.id, message: err.message });
          continue;
        }
        const over = outcomeText(pos);
        if (over) {
          this.emit('event', { type: 'info', id: req.id, fen: req.fen, done: true, gameOver: over, lines: [] });
          continue;
        }
        const timer = setTimeout(() => engine.stop(), maxMs);
        const emit = (lines, done) =>
          this.emit('event', {
            type: 'info',
            id: req.id,
            fen: req.fen,
            done,
            depth: lines[0]?.depth || 0,
            nodes: lines[0]?.nodes,
            nps: lines[0]?.nps,
            elapsed: Date.now() - started,
            lines: lines.map(l => ({ ...l, san: ucisToSans(pos, l.pv.slice(0, 16)) })),
          });
        try {
          const result = await engine.search({ fen: req.fen, multipv: req.multipv, infinite: true }, lines => {
            if (this.pending) return;
            const depth = lines[0]?.depth || 0;
            const t = Date.now();
            if (depth > lastDepth || t - lastEmit > 250) {
              lastDepth = Math.max(lastDepth, depth);
              lastEmit = t;
              emit(lines, false);
            }
            if (depth >= 50) engine.stop();
          });
          clearTimeout(timer);
          if (!this.pending) {
            emit(result.lines, true);
            const best = result.lines[0];
            if (best && !best.bound) cacheEval(keyOf(pos), best, best.depth, best.nodes);
          }
        } catch (err) {
          clearTimeout(timer);
          this.emit('event', { type: 'error', id: req.id, message: err.message });
        }
      }
    } finally {
      this.looping = false;
      this.active = null;
    }
  }
}

export const live = new LiveAnalysis();

// ---------------------------------------------------------------------------------------------
// Evaluation cache (by position key, White POV)

export function cachedEval(key) {
  const r = get('SELECT * FROM evals WHERE key = ?', key);
  if (!r) return null;
  return { depth: r.depth, nodes: r.nodes, score: r.mate !== null ? { mate: r.mate } : { cp: r.cp }, best: r.best, pv: r.pv ? r.pv.split(' ') : [] };
}

export function cacheEval(key, line, depth, nodes) {
  if (!line?.score || !Array.isArray(line.pv)) return;
  const prev = get('SELECT depth, nodes FROM evals WHERE key = ?', key);
  if (prev && (prev.nodes || 0) > (nodes || 0) && (prev.depth || 0) >= (depth || 0)) return;
  run(
    `INSERT INTO evals (key, depth, nodes, cp, mate, best, pv, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET depth = excluded.depth, nodes = excluded.nodes, cp = excluded.cp, mate = excluded.mate,
       best = excluded.best, pv = excluded.pv, updated_at = excluded.updated_at`,
    key,
    depth || null,
    nodes || null,
    line.score.mate !== undefined ? null : line.score.cp,
    line.score.mate !== undefined ? line.score.mate : null,
    line.pv[0] || null,
    line.pv.slice(0, 20).join(' '),
    Date.now(),
  );
}

// ---------------------------------------------------------------------------------------------
// The agent's searches (the coach's analyses, the judgement of the student's moves): on the agent engine — or, while
// it is busy, on a helper beside it (agent-2…agent-4: a quarter of its threads; started when first needed, stopped
// after two idle minutes), so that the analyses the coach asks for together run side by side, not one after the other.

const AGENT_ROLES = ['agent', 'agent-2', 'agent-3', 'agent-4'];
const agentBusy = new Set();
const agentWaiting = []; // { params, resolve, reject }
const helperTimers = new Map();
const brokenHelpers = new Set(); // (a helper that could not start is not used again)

function agentSearch(params) {
  return new Promise((resolve, reject) => {
    agentWaiting.push({ params, resolve, reject });
    nextAgentSearch();
  });
}

function nextAgentSearch() {
  while (agentWaiting.length) {
    const role = AGENT_ROLES.find(r => !agentBusy.has(r) && !brokenHelpers.has(r));
    if (!role) return;
    const job = agentWaiting.shift();
    agentBusy.add(role);
    clearTimeout(helperTimers.get(role));
    let started = false;
    getEngine(role)
      .then(engine => {
        started = true;
        return engine.search(job.params);
      })
      .then(job.resolve, err => {
        if (role !== 'agent' && !started) {
          brokenHelpers.add(role);
          agentWaiting.unshift(job); // (the main engine or another helper takes it)
        } else job.reject(err);
      })
      .finally(() => {
        agentBusy.delete(role);
        if (role !== 'agent') helperTimers.set(role, setTimeout(() => !agentBusy.has(role) && stopEngine(role), 120_000));
        nextAgentSearch();
      });
  }
}

// The agent's analyses of the last 300 positions, kept: asked again — as deep or less, as many lines or fewer —, the
// answer comes at once. (A position's best line is also kept in the database: evals.)
const recent = new Map(); // position key → { depth, multipv, lines, bestmove }, the latest last

function remembered(key, depth, multipv) {
  const r = recent.get(key);
  if (!r || r.depth < depth || r.multipv < multipv) return null;
  recent.delete(key);
  recent.set(key, r);
  return r;
}

function remember(key, entry) {
  const prev = recent.get(key);
  if (prev && prev.depth >= entry.depth && prev.multipv >= entry.multipv) return;
  recent.delete(key);
  recent.set(key, entry);
  if (recent.size > 300) recent.delete(recent.keys().next().value);
}

/**
 * One-shot analysis on the agent engine. Returns lines with SAN. Uses the cache for single-line requests, and the
 * analyses kept of the last positions for any as deep with as many lines.
 * maxTime (ms) caps a depth search: with WebAssembly a deep search can take long, and the best line so far is used.
 */
export async function evaluate(fen, { depth = 18, multipv = 1, movetime, nodes, maxTime = 20_000 } = {}) {
  const pos = posFromFen(fen);
  const over = outcomeText(pos);
  if (over) {
    const score = pos.isCheckmate() ? { mated: pos.turn } : { cp: 0 };
    return { fen: fenOf(pos), gameOver: over, lines: [{ multipv: 1, depth: 0, score, pv: [], san: [] }], bestmove: null };
  }
  const key = keyOf(pos);
  multipv = Math.max(1, Math.min(5, multipv));
  if (multipv === 1 && !movetime && !nodes) {
    const c = cachedEval(key);
    if (c && c.depth >= depth && c.pv.length)
      return { fen: fenOf(pos), cached: true, bestmove: c.best, lines: [{ multipv: 1, depth: c.depth, score: c.score, pv: c.pv, san: ucisToSans(pos, c.pv) }] };
  }
  const kept = !movetime && !nodes && remembered(key, depth, multipv);
  if (kept) return { fen: fenOf(pos), cached: true, bestmove: kept.bestmove, lines: kept.lines.slice(0, multipv) };
  const result = await agentSearch({ fen: fenOf(pos), multipv, depth, movetime: movetime || (nodes ? undefined : maxTime), nodes });
  const lines = result.lines.map(l => ({ ...l, san: ucisToSans(pos, l.pv) }));
  if (lines[0] && !lines[0].bound) cacheEval(key, lines[0], lines[0].depth, lines[0].nodes);
  if (!lines.length) throw new Error('Stockfish returned no analysis for this position.');
  // (as deep as its least deep line: a search stopped by maxTime is kept for what it reached)
  if (!movetime && !nodes) remember(key, { depth: Math.min(...lines.map(l => l.depth || 0)), multipv, lines, bestmove: result.bestmove });
  return { fen: fenOf(pos), bestmove: result.bestmove, lines };
}

/** Text rendering of an evaluation for the coach. */
export function describeEval(evalResult, maxLines = 5) {
  const pos = posFromFen(evalResult.fen);
  if (evalResult.gameOver) return `Game over: ${evalResult.gameOver}`;
  return evalResult.lines
    .slice(0, maxLines)
    .map(l => `${l.multipv}) ${formatScore(l.score)} (depth ${l.depth}${l.wdl ? `, W/D/L ${l.wdl.map(x => Math.round(x / 10)).join('/')}%` : ''}): ${formatLine(pos, l.san.slice(0, 12))}`)
    .join('\n');
}

/**
 * Judges a move: evaluation before (MultiPV 3) and after, lichess judgement, positive grades,
 * best alternative and refutation line.
 */
export async function evaluateMove(fen, moveUci, { depth = 18, maxTime = 12_000 } = {}) {
  const pos = posFromFen(fen);
  const move = moveFromUci(pos, moveUci);
  if (!move) throw Object.assign(new Error(`Illegal move ${moveUci} in ${fen}`), { status: 400 });
  const color = pos.turn;
  const san = makeSan(pos, move);
  const uci = uciOf(pos, move);
  const before = await evaluate(fenOf(pos), { depth, multipv: 3, maxTime });
  const afterPos = pos.clone();
  afterPos.play(move);
  const inLines = before.lines.find(l => l.pv[0] === uci);
  // (the move is one of the engine's lines, searched as deep: its score and the reply in it — no second search)
  const after =
    inLines && !inLines.bound && inLines.pv.length > 1
      ? { lines: [{ multipv: 1, depth: inLines.depth, score: inLines.score, pv: inLines.pv.slice(1), san: inLines.san.slice(1) }] }
      : await evaluate(fenOf(afterPos), { depth, multipv: 1, maxTime });
  const best = before.lines[0];
  const afterScore = after.lines[0]?.score ?? inLines?.score;
  const bestScore = best.score;
  const second = before.lines[1];
  const onlyMove = !!second && ((color === 'white' ? 1 : -1) * (winningChances(bestScore) - winningChances(second.score))) / 2 >= 0.15;
  const isBest = before.bestmove === uci || (inLines && inLines.multipv === 1);
  const classification = classifyMove({ prev: bestScore, next: afterScore, color, isBest, onlyMove });
  return {
    fen: fenOf(pos),
    uci,
    san,
    color,
    moveNumber: pos.fullmoves,
    classification,
    judgement: judge(bestScore, afterScore, color)?.judgement || null,
    scoreBefore: bestScore,
    scoreAfter: afterScore,
    winBefore: povWin(bestScore, color),
    winAfter: povWin(afterScore, color),
    chanceLoss: chanceLoss(bestScore, afterScore, color),
    cpLoss: cpLoss(bestScore, afterScore, color),
    best: best.pv[0] ? { uci: best.pv[0], san: best.san[0], line: formatLine(pos, best.san.slice(0, 10)) } : null,
    alternatives: before.lines.map(l => ({ uci: l.pv[0], san: l.san[0], score: l.score, line: formatLine(pos, l.san.slice(0, 8)) })),
    onlyMove,
    afterFen: fenOf(afterPos),
    reply: after.lines[0]?.pv[0] ? { uci: after.lines[0].pv[0], san: after.lines[0].san[0], line: formatLine(afterPos, after.lines[0].san.slice(0, 10)) } : null,
    gameOver: after.gameOver || null,
    depth,
  };
}

export function describeMoveEval(m) {
  const lines = [
    `Move: ${m.color === 'white' ? `${m.moveNumber}.` : `${m.moveNumber}...`} ${m.san} by ${m.color} — ${m.classification.toUpperCase()}`,
    `Eval before: ${formatScore(m.scoreBefore)}, after: ${formatScore(m.scoreAfter)} (White's view). Mover's win chance ${m.winBefore.toFixed(0)}% → ${m.winAfter.toFixed(0)}%, centipawn loss ${Math.round(m.cpLoss)}.`,
  ];
  if (m.best && m.best.uci !== m.uci) lines.push(`Engine's best was ${m.best.san}: ${m.best.line}`);
  else lines.push(m.onlyMove ? 'This was the only good move.' : 'This was the engine’s top choice.');
  if (m.alternatives?.length > 1) lines.push(`Top candidates: ${m.alternatives.map(a => `${a.san} (${formatScore(a.score)})`).join(', ')}`);
  if (m.gameOver) lines.push(`After the move: ${m.gameOver}`);
  else if (m.reply) lines.push(`Best reply after ${m.san}: ${m.reply.line}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Sparring: engine move at a chosen strength.

export const PLAY_LEVELS = [
  { id: 1, label: 'Beginner', skill: 0, depth: 1, movetime: 50 },
  { id: 2, label: 'Novice', skill: 0, depth: 3, movetime: 100 },
  { id: 3, label: 'Casual (~1300)', skill: 3, depth: 5, movetime: 200 },
  { id: 4, label: 'Club 1500', elo: 1500, movetime: 400 },
  { id: 5, label: 'Club 1700', elo: 1700, movetime: 500 },
  { id: 6, label: 'Strong 1900', elo: 1900, movetime: 600 },
  { id: 7, label: 'Expert 2100', elo: 2100, movetime: 700 },
  { id: 8, label: 'Master 2300', elo: 2300, movetime: 800 },
  { id: 9, label: 'IM 2500', elo: 2500, movetime: 1000 },
  { id: 10, label: 'Super GM 2800', elo: 2800, movetime: 1200 },
  { id: 11, label: 'Full strength', movetime: 1500 },
];

export async function playMove(fen, levelId) {
  const level = PLAY_LEVELS.find(l => l.id === Number(levelId)) || PLAY_LEVELS[4];
  const pos = posFromFen(fen);
  if (outcomeText(pos)) return { uci: null, gameOver: outcomeText(pos) };
  const engine = await getEngine('play');
  const options = level.elo ? { UCI_LimitStrength: 'true', UCI_Elo: level.elo, 'Skill Level': 20 } : { UCI_LimitStrength: 'false', 'Skill Level': level.skill ?? 20 };
  const result = await engine.search({ fen: fenOf(pos), multipv: 1, depth: level.depth, movetime: level.movetime, options });
  const move = result.bestmove && moveFromUci(pos, result.bestmove);
  if (!move) return { uci: null };
  return { uci: uciOf(pos, move), san: makeSan(pos, move), level: level.label };
}
