// The heavy part of adding a game database, in a process of its own (an Electron utility process started by
// manager.js): unpacking a .7z archive and building the opening index. It reports its progress and ends.
//
// Message in: { archive?, base?, dir } — an archive to unpack into `dir`, or a database already on disk (`base`, the
// path without extension); the opening index is written to dir/openings.book.
// Messages out: { type: 'progress', stage: 'unpack' | 'index', fraction, label }, { type: 'done', base, info },
// { type: 'error', message }.

import { mkdirSync, statfsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { open7z, extract7z } from './sevenzip.js';
import { buildBook } from './book.js';

const DB_EXTS = ['.si5', '.sn5', '.sg5'];

/** The Scid 5 database in an archive: the first name that has all three files. */
export function databaseIn(files) {
  const byBase = new Map();
  for (const f of files) {
    if (f.dir) continue;
    const ext = extname(f.name).toLowerCase();
    if (!DB_EXTS.includes(ext)) continue;
    const name = basename(f.name.replace(/\\/g, '/'), extname(f.name));
    const key = f.name.replace(/\\/g, '/').slice(0, -ext.length).toLowerCase();
    if (!byBase.has(key)) byBase.set(key, { name, files: {} });
    byBase.get(key).files[ext] = f;
  }
  for (const db of byBase.values()) if (DB_EXTS.every(e => db.files[e])) return db;
  return null;
}

const safeName = name => name.replace(/[^\p{L}\p{N} ._()+-]/gu, '_').replace(/^\.+/, '').slice(0, 100) || 'database';

export function runJob({ archive, base, dir }, post) {
  mkdirSync(dir, { recursive: true });
  if (archive) {
    const a = open7z(archive);
    let db;
    try {
      db = databaseIn(a.files);
    } finally {
      a.close();
    }
    if (!db) throw new Error('The archive does not hold a Scid 5 database (.si5, .sn5 and .sg5 files).');
    const name = safeName(db.name);
    // the sizes the archive declares must fit on the disk, with room for the index (an archive cannot fill the disk)
    const need = DB_EXTS.reduce((n, e) => n + db.files[e].size, 0) + 2 * 1024 ** 3;
    let free = Infinity;
    try {
      const s = statfsSync(dir);
      free = Number(s.bavail) * Number(s.bsize);
    } catch {}
    if (need > free) throw new Error(`Not enough free disk space to unpack the database: it needs ${(need / 1024 ** 3).toFixed(1)} GB, ${(free / 1024 ** 3).toFixed(1)} GB are free.`);
    const wanted = new Map(DB_EXTS.map(e => [db.files[e].stream, join(dir, name + e)]));
    let last = 0;
    extract7z(archive, f => wanted.get(f.stream) ?? null, {
      onProgress: (done, total) => {
        const now = Date.now();
        if (now - last < 250 && done < total) return;
        last = now;
        post({ type: 'progress', stage: 'unpack', fraction: total ? done / total : 0, label: 'Unpacking' });
      },
    });
    base = join(dir, name);
  }
  let last = 0;
  const info = buildBook(base, join(dir, 'openings.book'), {
    tmpDir: join(dir, 'tmp'),
    onProgress: (fraction, label) => {
      const now = Date.now();
      if (now - last < 250 && fraction < 1) return;
      last = now;
      post({ type: 'progress', stage: 'index', fraction, label });
    },
  });
  return { base, info };
}

// As a utility process: one job, then exit.
if (process.parentPort) {
  process.parentPort.once('message', e => {
    const post = m => process.parentPort.postMessage(m);
    try {
      const { base, info } = runJob(e.data, post);
      post({ type: 'done', base, info });
    } catch (err) {
      post({ type: 'error', message: err?.message || String(err) });
    }
    setTimeout(() => process.exit(0), 100);
  });
}
