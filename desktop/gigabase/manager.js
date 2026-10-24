// The game database the student added — a Scid 5 database (.si5 with its .sn5 and .sg5), or a .7z archive that holds
// one — in the main process: adding it (unpacking an archive, building the opening index), remembering it between
// starts, and passing the explorer's and the coach's questions on. The heavy work runs in utility processes: job.js
// (unpacking, indexing) and query.js (reading the database).
//
// Everything lives in <home>\gigabase\: state.json (the database that was added) and one folder for it, with its
// opening index (openings.book) and — when it came in an archive — the unpacked database files. A .si5 file is read
// where it is. A database added later replaces the first one when it is ready.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { BOOK_VERSION } from './book.js';

const REQUEST_TIMEOUT = 60_000;
const GB = 1024 ** 3;
const DB_EXTS = ['.si5', '.sn5', '.sg5'];

/** "Master_Games_2026" → "Master Games 2026" */
const titleOf = base => basename(base).replace(/_+/g, ' ').trim() || 'Game database';
const fileDate = path => {
  try {
    return statSync(path).mtime.toISOString().slice(0, 10);
  } catch {
    return '';
  }
};

export class GameDatabases {
  /**
   * home: the app's data folder; fork(script, name): starts a utility process (Electron's utilityProcess.fork);
   * onStatus(status): the window is told about every change.
   */
  constructor({ home, jobScript, queryScript, fork, log = () => {}, onStatus = () => {} }) {
    this.dir = join(home, 'gigabase');
    Object.assign(this, { jobScript, queryScript, fork, log, onStatus });
    this.job = null; // { stage: 'unpack' | 'index', fraction, label }
    this.error = null;
    this.busy = null; // { cancel }
    this.running = null;
    this.query = null; // the query process (a promise of { child, pending })
    this.queryChild = null;
    this.seq = 0;
    this.lastPush = 0;
    this.state = this.#readState();
    this.#cleanOrphans();
  }

  // -------------------------------------------------------------------------------------------
  // State

  #readState() {
    try {
      const s = JSON.parse(readFileSync(join(this.dir, 'state.json'), 'utf8'));
      if (s?.installed?.base && s.installed.book) return { installed: s.installed };
    } catch {}
    return { installed: null };
  }

  #writeState() {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, 'state.json');
    writeFileSync(file + '.tmp', JSON.stringify(this.state, null, 2));
    renameSync(file + '.tmp', file);
  }

  /** Are the database's files there? (A .si5 read where it is may have been moved, or be on a drive not connected.) */
  #filesThere(inst) {
    return DB_EXTS.every(e => existsSync(inst.base + e));
  }

  status() {
    const inst = this.state.installed;
    return {
      installed: inst
        ? {
            title: inst.title,
            version: inst.version,
            source: inst.source === 'file' ? 'file' : 'archive', // read where it is, or unpacked into the app's folder
            path: inst.base + '.si5',
            games: inst.games,
            positions: inst.positions,
            bytes: inst.bytes,
            addedAt: inst.addedAt || inst.installedAt,
            missing: !this.#filesThere(inst),
            needsIndex: inst.bookVersion !== BOOK_VERSION || !existsSync(inst.book),
          }
        : null,
      job: this.job,
      error: this.error,
    };
  }

  /** The folder to show: where the database files are. */
  folder() {
    const inst = this.state.installed;
    if (!inst) return this.dir;
    return inst.source === 'file' ? dirname(inst.base) : inst.dir;
  }

  #push(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPush < 200) return;
    this.lastPush = now;
    this.onStatus(this.status());
  }

  #setJob(job) {
    const stageChanged = this.job?.stage !== job?.stage;
    this.job = job;
    this.#push(stageChanged || !job);
  }

  // -------------------------------------------------------------------------------------------
  // Adding a database

  /** Adds a database (in the background; follow it with status()): a .si5 file, or a .7z archive holding one. */
  add(path) {
    const file = resolve(String(path || ''));
    const ext = extname(file).toLowerCase();
    return this.#start({ stage: ext === '.7z' ? 'unpack' : 'index', fraction: 0, label: 'Starting' }, async (signal, setChild) => {
      if (!existsSync(file)) throw new Error(`${basename(file)} is not there.`);
      const dir = this.#newDir(`db-${basename(file, extname(file)).replace(/[^\w.-]+/g, '_').slice(0, 40)}`);
      if (ext === '.7z') {
        this.#checkSpace(statSync(file).size * 5 + 2 * GB);
        const { base, info } = await this.#runJob({ archive: file, dir }, signal, setChild);
        await this.#adopt({ dir, base, info, title: titleOf(base), version: fileDate(file), source: 'archive', own: true });
      } else if (ext === '.si5') {
        const base = file.slice(0, -ext.length);
        for (const e of ['.sn5', '.sg5']) if (!existsSync(base + e)) throw new Error(`${basename(base + e)} must be in the same folder as ${basename(file)}.`);
        this.#checkSpace(2 * GB);
        const { info } = await this.#runJob({ base, dir }, signal, setChild);
        await this.#adopt({ dir, base, info, title: titleOf(base), version: fileDate(file), source: 'file', own: false });
      } else throw new Error('Choose a Scid 5 database (.si5) or a .7z archive that holds one.');
    });
  }

  /** Builds the opening index again (after an app update changed its format). */
  reindex() {
    const inst = this.state.installed;
    if (!inst) return this.status();
    return this.#start({ stage: 'index', fraction: 0, label: 'Starting' }, async (signal, setChild) => {
      if (!this.#filesThere(inst)) throw new Error(`The database files are not there (${inst.base}.si5).`);
      const dir = this.#newDir('index');
      const { info } = await this.#runJob({ base: inst.base, dir }, signal, setChild);
      await this.#closeQuery();
      renameSync(join(dir, 'openings.book'), inst.book + '.new');
      rmSync(inst.book, { force: true });
      renameSync(inst.book + '.new', inst.book);
      rmSync(dir, { recursive: true, force: true });
      Object.assign(inst, { bookVersion: BOOK_VERSION, positions: info.positions, games: info.games });
      this.#writeState();
    });
  }

  cancel() {
    this.busy?.cancel();
    return this.status();
  }

  /** Forgets the database: its index (and an unpacked copy) are deleted; the student's own .si5 files stay. */
  async remove() {
    if (this.busy) {
      this.busy.cancel();
      await this.running;
    }
    await this.#closeQuery();
    const inst = this.state.installed;
    if (inst) {
      this.#removeDir(inst.dir);
      this.state.installed = null;
      this.#writeState();
    }
    this.error = null;
    this.#push(true);
    return this.status();
  }

  /** Runs one piece of work at a time; `first` is the progress shown until it reports its own. */
  #start(first, work) {
    if (this.busy) return this.status();
    const ac = new AbortController();
    let child = null;
    this.busy = {
      cancel: () => {
        ac.abort();
        child?.kill();
      },
    };
    this.error = null;
    this.#setJob(first);
    this.running = (async () => {
      try {
        await work(ac.signal, c => (child = c));
      } catch (e) {
        if (!ac.signal.aborted) {
          this.error = e?.message || String(e);
          this.log('[database]', e);
        }
      } finally {
        this.busy = null;
        this.#cleanNewDirs();
        this.#setJob(null);
        this.#push(true);
      }
    })();
    return this.status();
  }

  #checkSpace(need) {
    mkdirSync(this.dir, { recursive: true });
    let free = Infinity;
    try {
      const s = statfsSync(this.dir);
      free = Number(s.bavail) * Number(s.bsize);
    } catch {}
    if (free < need) throw new Error(`Not enough free disk space: this needs about ${(need / GB).toFixed(1)} GB in ${this.dir}, and ${(free / GB).toFixed(1)} GB are free.`);
  }

  #newDir(name) {
    const dir = join(this.dir, `${name}.new-${Date.now().toString(36)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Folders of work that did not finish (cancelled, failed). */
  #cleanNewDirs() {
    try {
      for (const name of readdirSync(this.dir)) if (/\.new-[0-9a-z]+$/.test(name)) rmSync(join(this.dir, name), { recursive: true, force: true });
    } catch {}
  }

  #removeDir(dir) {
    const d = resolve(dir);
    if (!d.startsWith(resolve(this.dir) + sep)) return;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch (e) {
      this.log('[database] could not remove (next start tries again):', d, e.message); // e.g. a file still open
    }
  }

  /** Folders left by an earlier start (work that stopped, a database that was replaced while still in use). */
  #cleanOrphans() {
    const keep = this.state.installed?.dir ? resolve(this.state.installed.dir) : null;
    try {
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const d = resolve(join(this.dir, entry.name));
        if (d !== keep) this.#removeDir(d);
      }
    } catch {}
  }

  /** Makes finished work the added database (replacing the previous one). */
  async #adopt({ dir, base, info, title, version, source, own }) {
    const finalDir = dir.replace(/\.new-[0-9a-z]+$/, '');
    await this.#closeQuery();
    const old = this.state.installed;
    if (existsSync(finalDir) && resolve(finalDir) !== resolve(old?.dir || '')) rmSync(finalDir, { recursive: true, force: true });
    let target = finalDir;
    if (old && resolve(old.dir) === resolve(finalDir)) target = `${finalDir}-${Date.now().toString(36)}`;
    renameSync(dir, target);
    const moved = p => (p.startsWith(dir + sep) ? join(target, p.slice(dir.length + 1)) : p);
    const finalBase = own ? moved(base) : base;
    let bytes = 0;
    for (const e of DB_EXTS) bytes += statSync(finalBase + e).size;
    this.state.installed = {
      dir: target,
      base: finalBase,
      book: join(target, 'openings.book'),
      bookVersion: BOOK_VERSION,
      title,
      version,
      source,
      games: info.games,
      positions: info.positions,
      bytes,
      addedAt: new Date().toISOString(),
    };
    this.#writeState();
    if (old) this.#removeDir(old.dir);
    this.log(`[database] added ${title} (${source === 'file' ? `read from ${finalBase}.si5` : 'unpacked'}): ${info.games} games, ${info.positions} positions in the opening index`);
  }

  /** Runs job.js in a utility process. */
  #runJob(msg, signal, setChild) {
    return new Promise((res, rej) => {
      if (signal.aborted) return rej(new Error('cancelled'));
      const child = this.fork(this.jobScript, 'Plymentor database job');
      setChild(child);
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (err) rej(err);
        else res(value);
      };
      const onAbort = () => {
        child.kill();
        finish(new Error('cancelled'));
      };
      signal.addEventListener('abort', onAbort);
      child.on('message', m => {
        if (m?.type === 'progress') this.#setJob({ stage: m.stage === 'unpack' ? 'unpack' : 'index', fraction: Number(m.fraction) || 0, label: String(m.label || '') });
        else if (m?.type === 'done') finish(null, { base: m.base, info: m.info });
        else if (m?.type === 'error') finish(new Error(m.message));
      });
      child.on('exit', code => finish(new Error(`The database job stopped unexpectedly (${code}).`)));
      child.postMessage(msg);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Questions (the explorer, the coach)

  async request(type, args) {
    const inst = this.state.installed;
    if (!inst) throw new Error('No game database has been added. Add a Scid 5 database (.si5) in Openings → Explorer → Database.');
    const s = this.status().installed;
    if (s.missing) throw new Error(`The files of ${inst.title} are not there any more (${inst.base}.si5). Connect the drive they are on, or add the database again.`);
    if (s.needsIndex) throw new Error('The opening index of the game database needs to be built again (Settings → Game database).');
    if (!this.query) this.query = this.#startQuery(inst);
    const q = await this.query;
    return this.#ask(q, { type, args });
  }

  async #startQuery(inst) {
    const child = this.fork(this.queryScript, 'Plymentor database');
    const q = { child, pending: new Map() };
    child.on('message', m => {
      const p = q.pending.get(m?.id);
      if (!p) return;
      q.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    });
    child.on('exit', () => {
      for (const p of q.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('The game database stopped. Try again.'));
      }
      q.pending.clear();
      if (this.query && this.queryChild === child) {
        this.query = null;
        this.queryChild = null;
      }
    });
    this.queryChild = child;
    try {
      await this.#ask(q, { type: 'open', base: inst.base, book: inst.book, info: { title: inst.title, version: inst.version } });
    } catch (e) {
      child.kill();
      this.query = null;
      this.queryChild = null;
      throw e;
    }
    return q;
  }

  #ask(q, msg) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        q.pending.delete(id);
        reject(new Error('The game database did not answer in time.'));
      }, REQUEST_TIMEOUT);
      q.pending.set(id, { resolve, reject, timer });
      q.child.postMessage({ ...msg, id });
    });
  }

  async #closeQuery() {
    const pending = this.query;
    this.query = null;
    const child = this.queryChild;
    this.queryChild = null;
    if (!pending) return;
    try {
      await pending;
    } catch {}
    child?.kill();
    await new Promise(r => setTimeout(r, 150)); // let Windows release the files
  }

  /** The app is closing: stop the work and the reader. */
  close() {
    this.busy?.cancel();
    this.queryChild?.kill();
    this.query = null;
  }
}
