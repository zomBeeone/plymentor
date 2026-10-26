// Live Stockfish analysis client: Stockfish runs in the backend worker; the latest position always wins.
import { useEffect, useState } from '../vendor/preact.js';
import { send, subscribe } from './local.js';
import { stored, store } from './util.js';

// The student's Stockfish switches: the live analysis on the Board and on the Openings screen, each kept across starts.
// The screens show them; the coach reads them (get_board_state) and turns them (set_engine).
const SWITCH_KEYS = { board: 'analysis.engine', openings: 'openings.engine' };
const switches = { board: stored(SWITCH_KEYS.board, true), openings: stored(SWITCH_KEYS.openings, true) };
const switchSubs = new Set();

export const engineSwitches = () => ({ ...switches });

/** Turns the switch of `screen` (board or openings); returns whether it changed. */
export function setEngineSwitch(screen, on) {
  if (!Object.hasOwn(switches, screen) || switches[screen] === on) return false;
  switches[screen] = on;
  store(SWITCH_KEYS[screen], on);
  for (const fn of [...switchSubs]) fn();
  return true;
}

/** The switch of `screen`; the calling component re-renders when it changes (the student's doing or the coach's). */
export function useEngineSwitch(screen) {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force(x => x + 1);
    switchSubs.add(fn);
    return () => switchSubs.delete(fn);
  }, []);
  return switches[screen];
}

class LiveEngine {
  constructor() {
    this.id = 0;
    this.fen = null;
    this.data = null;
    this.subs = new Set();
    this.timer = null;
    this.listening = false;
  }

  listen() {
    if (this.listening) return;
    this.listening = true;
    subscribe('live', d => {
      if (d.id !== this.id) return;
      this.data = d.type === 'error' ? { ...(this.data || {}), error: d.message, pending: false } : d;
      this.emit();
    });
  }

  analyze(fen, multipv = 3) {
    this.listen();
    if (this.fen === fen && this.multipv === multipv && this.data && !this.data.error) return;
    this.id++;
    const id = this.id;
    this.fen = fen;
    this.multipv = multipv;
    this.data = { id, fen, lines: [], depth: 0, pending: true };
    this.emit();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (id === this.id) send({ type: 'live', id, fen, multipv });
    }, 60);
  }

  stop() {
    if (!this.fen && !this.data) return;
    this.id++;
    this.fen = null;
    this.data = null;
    clearTimeout(this.timer);
    this.emit();
    send({ type: 'live-stop' });
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit() {
    for (const s of [...this.subs]) s(this.data);
  }
}

export const engine = new LiveEngine();

/** Current live analysis for `fen` (null when the engine is analysing something else). */
export function useLiveEval(fen) {
  const [data, setData] = useState(engine.fen === fen ? engine.data : null);
  useEffect(() => {
    let raf = 0;
    const un = engine.subscribe(d => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setData(d && d.fen === fen ? { ...d } : null));
    });
    setData(engine.fen === fen ? engine.data : null);
    return () => {
      cancelAnimationFrame(raf);
      un();
    };
  }, [fen]);
  return data;
}
