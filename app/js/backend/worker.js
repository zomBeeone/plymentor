// The app's backend, running in a Web Worker of the Plymentor window: the games database (SQLite in the window's
// private file system), the Stockfish engines, game analysis, statistics, training and the coach's tools.
//
// Messages from the page:
//   { type: 'init', userId }                                  -> { type: 'ready', storage } | { type: 'fatal', message }
//   { type: 'request', id, method, path, body }               -> { type: 'response', id, data } | { type: 'response', id, error, status }
//   { type: 'live', id, fen, multipv } / { type: 'live-stop' } -> pushes on topic 'live'
//   { type: 'close' }                                         -> closes the database (the window is closing)
// Pushes to the page: { type: 'push', topic: 'live' | 'jobs' | 'coach-ui', data }
import { openDatabase, closeDatabase } from './db.js';
import { loadSettings } from './settings.js';
import { loadOpenings } from './chess/openings.js';
import { live, stopAllEngines } from './engine/pool.js';
import { jobs } from './analysis/batch.js';
import { handle, setStorageInfo } from './router.js';

const post = msg => self.postMessage(msg);
const push = (topic, data) => post({ type: 'push', topic, data });

let ready = null;

async function init({ userId }) {
  const texts = await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map(async f => {
      const res = await fetch(`/data/openings/${f}.tsv`);
      if (!res.ok) throw new Error(`Could not load the opening book (${res.status})`);
      return res.text();
    }),
  );
  loadOpenings(texts);
  const storage = await openDatabase({ userId, wasmUrl: '/js/sqlite3.wasm' });
  setStorageInfo(storage);
  loadSettings();
  live.on('event', e => push('live', e));
  jobs.on('event', e => push('jobs', e));
  return storage;
}

self.onmessage = async e => {
  const m = e.data || {};
  switch (m.type) {
    case 'init':
      if (ready) return;
      ready = init(m);
      ready.then(
        storage => post({ type: 'ready', storage }),
        err => post({ type: 'fatal', message: err?.message || String(err), name: err?.name || null }),
      );
      return;
    case 'request': {
      try {
        await ready;
        const data = await handle(m.method, m.path, m.body, { push });
        post({ type: 'response', id: m.id, data });
      } catch (err) {
        post({ type: 'response', id: m.id, error: err?.message || String(err), status: err?.status || 500 });
      }
      return;
    }
    case 'live':
      await ready?.catch(() => null);
      live.analyze({ id: m.id, fen: m.fen, multipv: m.multipv });
      return;
    case 'live-stop':
      live.stop();
      return;
    case 'close':
      // (a batch analysis that is still running is marked "interrupted" the next time the database opens)
      stopAllEngines();
      try {
        closeDatabase();
      } catch {
        /* not open */
      }
      post({ type: 'closed' });
      return;
  }
};
