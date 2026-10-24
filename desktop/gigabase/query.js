// Answers questions about the installed game database, in a process of its own (an Electron utility process started
// by manager.js), so reading the database never holds up the app.
//
// Messages in: { id, type: 'open', base, book, info } | { id, type: 'close' } | { id, type: 'explore' | 'game' | 'summary', args }.
// Messages out: { id, result } or { id, error }.

import { GameDatabase } from './service.js';

let db = null;

export function handle(m) {
  switch (m.type) {
    case 'open':
      db?.close();
      db = null;
      db = new GameDatabase({ base: m.base, bookFile: m.book, info: m.info });
      return db.info;
    case 'close':
      db?.close();
      db = null;
      return true;
    case 'explore':
      if (!db) throw new Error('No game database is open.');
      return db.explore(m.args);
    case 'game':
      if (!db) throw new Error('No game database is open.');
      return db.game(m.args.id);
    case 'summary':
      if (!db) throw new Error('No game database is open.');
      return db.summary(m.args.id);
    default:
      throw new Error(`Unknown request ${m.type}`);
  }
}

if (process.parentPort) {
  process.parentPort.on('message', e => {
    const m = e.data || {};
    try {
      process.parentPort.postMessage({ id: m.id, result: handle(m) });
    } catch (err) {
      process.parentPort.postMessage({ id: m.id, error: err?.message || String(err) });
    }
  });
}
