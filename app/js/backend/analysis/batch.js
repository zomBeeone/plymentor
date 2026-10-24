// Batch analysis jobs: many games evaluated by several Stockfish workers, cached by position.
import { Emitter } from '../emitter.js';
import { run, get, all, now, json } from '../db.js';
import { getSettings, BATCH_PRESETS } from '../settings.js';
import { getEngine, stopEngine, cachedEval, cacheEval } from '../engine/pool.js';
import { fenOf, keyOf } from '../chess/core.js';
import { getGame } from '../games.js';
import { analyzeGame, gamePositions, terminalScore } from './game.js';

// A cached evaluation at least this deep is as good as a fresh one at the preset's node count.
const DEPTH_EQUIVALENT = { fast: 14, standard: 17, deep: 20 };

class JobManager extends Emitter {
  constructor() {
    super();
    this.jobs = new Map(); // id -> runtime state
    this.setMaxListeners(50);
  }

  list() {
    return all('SELECT id, kind, status, params, progress, error, created_at, finished_at FROM jobs ORDER BY id DESC LIMIT 20').map(j => ({
      ...j,
      params: json(j.params, {}),
      progress: this.jobs.get(j.id)?.progress || json(j.progress, {}),
    }));
  }

  active() {
    return [...this.jobs.values()].map(j => ({ id: j.id, kind: 'analysis', status: 'running', progress: j.progress, params: j.params }));
  }

  /** Starts an analysis — one at a time: its workers are the same Stockfish engines (batch-1, batch-2…). */
  startAnalysis({ gameIds, preset, force = false }) {
    const s = getSettings().engine;
    preset = BATCH_PRESETS[preset] ? preset : s.batchPreset;
    const nodes = BATCH_PRESETS[preset].nodes;
    const ids = [...new Set(gameIds.map(Number).filter(Boolean))];
    if (!ids.length) throw new Error('No games selected');
    const running = this.active()[0];
    if (running) {
      const p = running.progress;
      throw Object.assign(new Error(`An analysis is already running (${p.gamesDone} of ${p.gamesTotal} games done): start the next one when it has finished.`), { status: 409, running });
    }
    const params = { gameIds: ids, preset, nodes, force };
    const id = run(`INSERT INTO jobs (kind, status, params, created_at) VALUES ('analysis', 'running', ?, ?)`, JSON.stringify(params), now()).id;
    const job = { id, params, cancelled: false, progress: { gamesTotal: ids.length, gamesDone: 0, positionsTotal: 0, positionsDone: 0, startedAt: now(), eta: null, current: null } };
    this.jobs.set(id, job);
    this.runJob(job).catch(err => {
      run(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, err.message, now(), id);
      this.jobs.delete(id);
      this.emit('event', { type: 'job', id, status: 'failed', error: err.message, progress: job.progress });
    });
    return { id, ...params };
  }

  /** A job's state — { id, status: running | done | cancelled | failed, params, progress, error } — or null. */
  status(id) {
    const j = this.jobs.get(Number(id));
    if (j) return { id: j.id, status: 'running', params: j.params, progress: j.progress, error: null };
    const row = get('SELECT id, status, params, progress, error FROM jobs WHERE id = ?', Number(id));
    return row ? { ...row, params: json(row.params, {}), progress: json(row.progress, {}) } : null;
  }

  /** The newest job's id, or null. */
  latestId() {
    return get('SELECT id FROM jobs ORDER BY id DESC LIMIT 1')?.id ?? null;
  }

  /** The job's state once it has finished, or after `ms` while it still runs. */
  wait(id, ms) {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.off('event', on);
        resolve(this.status(id));
      };
      const on = e => e.type === 'job' && e.id === Number(id) && e.status !== 'running' && finish();
      const timer = setTimeout(finish, Math.max(0, ms));
      this.on('event', on);
      if (!this.jobs.has(Number(id))) finish();
    });
  }

  cancel(id) {
    const job = this.jobs.get(Number(id));
    if (!job) return false;
    job.cancelled = true;
    for (const w of job.workers || []) stopEngine(w);
    return true;
  }

  async runJob(job) {
    const { gameIds, nodes, preset, force } = job.params;
    const minDepth = DEPTH_EQUIVALENT[preset];
    const games = [];
    const queue = [];
    const queued = new Set();
    const goodEnough = c => c && c.pv?.length && ((c.nodes || 0) >= nodes * 0.9 || (c.depth || 0) >= minDepth);
    for (const id of gameIds) {
      const game = getGame(id);
      if (!game) continue;
      const existing = get('SELECT nodes FROM analyses WHERE game_id = ?', id);
      if (existing && !force && (existing.nodes || 0) >= nodes * 0.9) {
        job.progress.gamesDone++;
        continue;
      }
      const positions = gamePositions(game);
      const keys = [];
      for (const p of positions) {
        if (terminalScore(p)) continue;
        const key = keyOf(p);
        keys.push(key);
        if (!queued.has(key) && (force || !goodEnough(cachedEval(key)))) {
          queued.add(key);
          queue.push({ key, fen: fenOf(p) });
        }
      }
      games.push({ game, keys: new Set(keys), done: false });
    }
    job.progress.positionsTotal = queue.length;
    this.emitProgress(job, true);

    const finishGames = () => {
      for (const g of games) {
        if (g.done) continue;
        let ready = true;
        for (const k of g.keys)
          if (queued.has(k)) {
            ready = false;
            break;
          }
        if (!ready) continue;
        g.done = true;
        const analysis = analyzeGame(g.game, k => {
          const c = cachedEval(k);
          return c ? { score: c.score, best: c.best, pv: c.pv } : null;
        });
        if (analysis) {
          run(
            `INSERT INTO analyses (game_id, nodes, data, white_acc, black_acc, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(game_id) DO UPDATE SET nodes = excluded.nodes, data = excluded.data, white_acc = excluded.white_acc,
               black_acc = excluded.black_acc, updated_at = excluded.updated_at`,
            g.game.id,
            nodes,
            JSON.stringify(analysis),
            analysis.summary.white.accuracy,
            analysis.summary.black.accuracy,
            now(),
          );
          this.emit('event', { type: 'game-analyzed', jobId: job.id, gameId: g.game.id });
        }
        job.progress.gamesDone++;
      }
    };
    finishGames();

    const workerCount = Math.max(1, Math.min(8, getSettings().engine.batchWorkers || 3));
    job.workers = Array.from({ length: workerCount }, (_, i) => `batch-${i + 1}`);
    let next = 0;
    let startError = null;
    const worker = async role => {
      let startFailures = 0;
      while (!job.cancelled && next < queue.length) {
        let engine;
        try {
          engine = await getEngine(role);
          startFailures = 0;
        } catch (err) {
          // an engine that cannot start is not retried endlessly: after two attempts this worker stops
          startError = err;
          if (++startFailures >= 2) return;
          continue;
        }
        // another worker may have taken the last position while this one waited for its engine
        if (job.cancelled || next >= queue.length) break;
        const item = queue[next++];
        try {
          const result = await engine.search({ fen: item.fen, multipv: 1, nodes });
          const line = result.lines[0];
          if (line) cacheEval(item.key, line, line.depth, nodes);
        } catch {
          if (job.cancelled) return;
          // a crashed engine is replaced on the next getEngine; retry this position once later
          if (!item.retried) {
            item.retried = true;
            queue.push(item);
          }
          continue;
        }
        queued.delete(item.key);
        job.progress.positionsDone++;
        job.progress.current = item.fen;
        if (job.progress.positionsDone % 5 === 0) finishGames();
        this.emitProgress(job);
      }
    };
    await Promise.all(job.workers.map(worker));
    for (const w of job.workers) stopEngine(w);
    if (!job.cancelled && next < queue.length && startError) throw new Error(`Stockfish could not be started: ${startError.message}`);
    if (!job.cancelled) finishGames();
    const status = job.cancelled ? 'cancelled' : 'done';
    job.progress.current = null;
    run(`UPDATE jobs SET status = ?, progress = ?, finished_at = ? WHERE id = ?`, status, JSON.stringify(job.progress), now(), job.id);
    this.jobs.delete(job.id);
    this.emit('event', { type: 'job', id: job.id, status, progress: job.progress, params: job.params });
  }

  emitProgress(job, force) {
    const t = Date.now();
    if (!force && job.lastEmit && t - job.lastEmit < 400) return;
    job.lastEmit = t;
    const p = job.progress;
    const elapsed = (t - p.startedAt) / 1000;
    p.eta = p.positionsDone > 3 ? Math.round((elapsed / p.positionsDone) * (p.positionsTotal - p.positionsDone)) : null;
    run('UPDATE jobs SET progress = ? WHERE id = ?', JSON.stringify(p), job.id);
    this.emit('event', { type: 'job', id: job.id, status: 'running', progress: p, params: job.params });
  }
}

export const jobs = new JobManager();
