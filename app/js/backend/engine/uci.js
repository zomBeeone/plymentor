// UCI engine wrapper. In the app the engine is Stockfish compiled to WebAssembly, running in its own Web Worker;
// in tests it can be any UCI process. Searches are serialized; scores are normalized to White's point of view.
import { Emitter } from '../emitter.js';

/** Parses an `info` line. Returns null for lines without a principal variation. */
export function parseInfo(line) {
  const t = line.trim().split(/\s+/);
  const info = {};
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth':
        info.depth = +t[++i];
        break;
      case 'seldepth':
        info.seldepth = +t[++i];
        break;
      case 'multipv':
        info.multipv = +t[++i];
        break;
      case 'score': {
        const kind = t[++i];
        const v = +t[++i];
        if (kind === 'cp') info.cp = v;
        else if (kind === 'mate') info.mate = v;
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') info.bound = t[++i];
        break;
      }
      case 'wdl':
        info.wdl = [+t[++i], +t[++i], +t[++i]];
        break;
      case 'nodes':
        info.nodes = +t[++i];
        break;
      case 'nps':
        info.nps = +t[++i];
        break;
      case 'time':
        info.time = +t[++i];
        break;
      case 'hashfull':
        info.hashfull = +t[++i];
        break;
      case 'tbhits':
        info.tbhits = +t[++i];
        break;
      case 'currmove':
      case 'currmovenumber':
      case 'string':
        return null;
      case 'pv':
        info.pv = t.slice(i + 1);
        i = t.length;
        break;
    }
  }
  return info.pv && info.depth !== undefined ? info : null;
}

/** Converts a side-to-move info into a White-POV line. */
function toLine(info, sign) {
  const score = info.mate !== undefined ? { mate: info.mate * sign } : { cp: (info.cp ?? 0) * sign };
  return {
    multipv: info.multipv || 1,
    depth: info.depth,
    seldepth: info.seldepth,
    score,
    wdl: info.wdl ? (sign > 0 ? info.wdl : [info.wdl[2], info.wdl[1], info.wdl[0]]) : undefined,
    pv: info.pv,
    nodes: info.nodes,
    nps: info.nps,
    time: info.time,
    bound: info.bound,
  };
}

/**
 * A transport for Stockfish in a Web Worker (the classic-worker builds of stockfish.js: UCI commands in, one output
 * line per message out).
 */
export function workerTransport(url) {
  return () => {
    const worker = new Worker(url);
    let onLine = () => {};
    let onExit = () => {};
    worker.onmessage = e => {
      if (typeof e.data !== 'string') return;
      for (const line of e.data.split('\n')) if (line) onLine(line);
    };
    worker.onerror = e => {
      e.preventDefault?.();
      onExit(new Error(`Stockfish stopped working${e.message ? `: ${e.message}` : ''}`));
    };
    return {
      send: cmd => worker.postMessage(cmd),
      onLine: fn => (onLine = fn),
      onExit: fn => (onExit = fn),
      close: () => worker.terminate(),
    };
  };
}

export class UciEngine extends Emitter {
  /** createTransport() -> { send(cmd), onLine(fn), onExit(fn), close() } */
  constructor(createTransport, name = 'engine') {
    super();
    this.createTransport = createTransport;
    this.name = name;
    this.transport = null;
    this.alive = false;
    this.started = null;
    this.waiters = [];
    this.current = null;
    this.queue = Promise.resolve();
    this.options = {};
    this.optionInfo = {};
    this.idName = '';
  }

  start() {
    if (this.started) return this.started;
    this.started = new Promise((resolve, reject) => {
      let t;
      try {
        t = this.createTransport();
      } catch (e) {
        reject(e);
        return;
      }
      this.transport = t;
      this.alive = true;
      t.onLine(line => this.onLine(line));
      t.onExit(err => {
        this.die(err);
        reject(err);
      });
      this.send('uci');
      this.waitFor(l => l === 'uciok', 60000).then(
        () => resolve(this),
        err => {
          this.quit();
          reject(err);
        },
      );
    });
    return this.started;
  }

  onLine(raw) {
    const line = raw.trim();
    if (line.startsWith('id name ')) this.idName = line.slice(8).trim();
    else if (line.startsWith('option name ')) {
      const m = /^option name (.+?) type (\w+)(?: default (\S*))?(?: min (-?\d+))?(?: max (-?\d+))?/.exec(line);
      if (m) this.optionInfo[m[1]] = { type: m[2], default: m[3], min: m[4] !== undefined ? +m[4] : undefined, max: m[5] !== undefined ? +m[5] : undefined };
    }
    for (const w of [...this.waiters])
      if (w.test(line)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(line);
      }
    this.current?.onLine(line);
  }

  waitFor(test, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { test, resolve, reject };
      if (timeoutMs)
        w.timer = setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`${this.name} engine did not answer in time`));
        }, timeoutMs);
      this.waiters.push(w);
    });
  }

  send(cmd) {
    if (this.alive) this.transport?.send(cmd);
  }

  async isReady() {
    this.send('isready');
    await this.waitFor(l => l === 'readyok', 60000);
  }

  async setOptions(opts) {
    let changed = false;
    for (const [k, v] of Object.entries(opts)) {
      if (v === undefined || this.options[k] === String(v)) continue;
      if (Object.keys(this.optionInfo).length && !this.optionInfo[k]) continue; // unsupported by this engine
      const info = this.optionInfo[k];
      let value = v;
      if (info?.type === 'spin' && Number.isFinite(Number(v))) {
        if (info.min !== undefined) value = Math.max(info.min, Number(value));
        if (info.max !== undefined) value = Math.min(info.max, Number(value));
      }
      this.send(`setoption name ${k} value ${value}`);
      this.options[k] = String(v);
      changed = true;
    }
    if (changed) await this.isReady();
  }

  die(err) {
    if (!this.alive) return;
    this.alive = false;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.current?.fail(err);
    try {
      this.transport?.close();
    } catch {
      /* already closed */
    }
    this.emit('dead', err);
  }

  /**
   * Queues a search. params: { fen, moves, multipv, depth, nodes, movetime, infinite, options }.
   * onUpdate(lines, info) receives White-POV lines as they arrive.
   * Resolves { bestmove, ponder, lines } (lines sorted by multipv, exact scores preferred).
   */
  search(params, onUpdate) {
    const run = () => this.runSearch(params, onUpdate);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async runSearch({ fen, moves = [], multipv = 1, depth, nodes, movetime, infinite, options }, onUpdate) {
    await this.start();
    if (!this.alive) throw new Error(`${this.name} engine is not running`);
    await this.setOptions({ ...(options || {}), MultiPV: multipv });
    const blackToMove = (fen.split(' ')[1] === 'b') !== (moves.length % 2 === 1);
    const sign = blackToMove ? -1 : 1;
    this.send(`position fen ${fen}${moves.length ? ' moves ' + moves.join(' ') : ''}`);
    const parts = ['go'];
    if (infinite) parts.push('infinite');
    else {
      if (depth) parts.push('depth', depth);
      if (nodes) parts.push('nodes', nodes);
      if (movetime) parts.push('movetime', movetime);
      if (parts.length === 1) parts.push('depth', 18);
    }
    return new Promise((resolve, reject) => {
      const latest = new Map(); // multipv -> exact line
      const latestAny = new Map();
      this.current = {
        onLine: line => {
          if (line.startsWith('info ')) {
            const info = parseInfo(line);
            if (!info) return;
            const l = toLine(info, sign);
            latestAny.set(l.multipv, l);
            if (!l.bound) latest.set(l.multipv, l);
            onUpdate?.(collect(latest.size ? latest : latestAny), l);
          } else if (line.startsWith('bestmove')) {
            const [, best, , ponder] = line.trim().split(/\s+/);
            this.current = null;
            resolve({ bestmove: best && best !== '(none)' ? best : null, ponder, lines: collect(latest.size ? latest : latestAny) });
          }
        },
        fail: err => {
          this.current = null;
          reject(err);
        },
      };
      this.send(parts.join(' '));
    });
  }

  stop() {
    if (this.current) this.send('stop');
  }

  get busy() {
    return !!this.current;
  }

  /** Ends the engine; a search still running fails. */
  quit() {
    if (!this.alive) return;
    this.send('quit');
    this.die(new Error(`${this.name} engine was stopped`));
  }
}

const collect = map => [...map.values()].sort((a, b) => a.multipv - b.multipv);
