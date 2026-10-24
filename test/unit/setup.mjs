// Runs the in-browser backend in Node for tests: the same SQLite build (in memory), the opening book from data/, and
// native Stockfish as the engine (the browser uses Stockfish WebAssembly; the UCI protocol is the same).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openDatabase, closeDatabase } from '../../app/js/backend/db.js';
import { loadSettings } from '../../app/js/backend/settings.js';
import { loadOpenings } from '../../app/js/backend/chess/openings.js';
import { setEngineFactory, stopAllEngines } from '../../app/js/backend/engine/pool.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function findStockfish() {
  if (process.env.STOCKFISH_PATH && existsSync(process.env.STOCKFISH_PATH)) return process.env.STOCKFISH_PATH;
  const dir = join(process.env.LOCALAPPDATA || '', 'ChessCoach', 'engine'); // the native Stockfish of Chess Coach 1.x
  const walk = d => {
    if (!existsSync(d)) return null;
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isFile() && /^stockfish.*\.exe$/i.test(n.name)) return p;
      if (n.isDirectory()) {
        const f = walk(p);
        if (f) return f;
      }
    }
    return null;
  };
  return walk(dir);
}

export const STOCKFISH = findStockfish();

export const processTransport = path => () => {
  const proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let onLine = () => {};
  let onExit = () => {};
  createInterface({ input: proc.stdout }).on('line', l => onLine(l));
  proc.stderr.on('data', () => {});
  proc.stdin.on('error', () => {});
  proc.on('exit', code => onExit(new Error(`stockfish exited (${code})`)));
  proc.on('error', err => onExit(err));
  return {
    send: cmd => proc.stdin.writable && proc.stdin.write(`${cmd}\n`),
    onLine: fn => (onLine = fn),
    onExit: fn => (onExit = fn),
    close: () => {
      try {
        proc.kill();
      } catch {
        /* gone */
      }
    },
  };
};

let openingsLoaded = false;
export async function openBackend() {
  if (!openingsLoaded) {
    loadOpenings(['a', 'b', 'c', 'd', 'e'].map(f => readFileSync(join(ROOT, 'data', 'openings', `${f}.tsv`), 'utf8')));
    openingsLoaded = true;
  }
  await openDatabase({ memory: true });
  loadSettings();
  // engineFactory() returns a transport creator (as workerTransport(url) does in the browser)
  if (STOCKFISH) setEngineFactory(() => processTransport(STOCKFISH));
}

export function closeBackend() {
  stopAllEngines();
  closeDatabase();
}

export const fixture = name => readFileSync(join(ROOT, 'test', 'fixtures', name), 'utf8');
