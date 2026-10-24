// Plymentor's updates, in the main process. Plymentor looks for a new version on its GitHub releases (when it starts,
// every 12 hours, and when the student asks), shows it, and installs it only when the student says so:
//   check     electron-updater reads latest.yml of the newest release (github.com/zomBeeone/plymentor). The release
//             must be signed with Studio Nox's key and newer than this version (update-manifest.js), or it is ignored.
//   download  on "Update": the installed app gets the new installer — only the parts that changed, worked out from the
//             blockmaps of the installer it was installed with and of the new one —, a portable .exe (built with
//             npm run dist:portable; the releases have only the installer) the new portable .exe when the release has
//             one, saved next to the one it runs from, or else the release's page, for the installer. A download is
//             checked against the signed SHA-512.
//   install   on "Restart and update": the window saves a backup of the games (backups\ in the data folder), the app
//             closes as usual (the window its games database, the coach host its sessions) and, as it quits, runs the
//             installer, silently: it replaces the program in %LOCALAPPDATA%\Programs\plymentor — the data in
//             %LOCALAPPDATA%\Plymentor is not touched — and starts Plymentor again. The portable app starts the new
//             .exe instead (the old one stays where it is).
//   after     the new version says so once, and removes the installer it was installed with once that has quit (it is
//             still finishing as it starts the app).
// Nothing is sent but the requests for those files (no account, no token, no identifier). Test hooks, only with
// PLYMENTOR_UPDATE_URL on 127.0.0.1 or localhost (a stand-in for GitHub): PLYMENTOR_UPDATE_KEY (the public key to trust
// instead), PLYMENTOR_UPDATE_MODE (installed | portable); downloads then stay in the data folder, and the installer or
// the new .exe is not started: the command is written to update-test-install.json.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import runtime from 'builder-util-runtime';
import nsis from 'electron-updater/out/NsisUpdater.js';
import { checkFile, isNewer, readRelease } from './update-manifest.js';
import { RELEASE_KEYS } from './update-key.js';

const { CancellationToken } = runtime;
const OWNER = 'zomBeeone';
const REPO = 'plymentor';
const CACHE_NAME = 'plymentor-updater'; // the installer keeps a copy of itself there, for the next differential download
const FIRST_CHECK = 15_000;
const EVERY = 12 * 3600_000;
const KEEP_BACKUPS = 3;
const BACKUP_FRESH = 30 * 60_000;
const DROP_RETRIES = 10; // the installer that just ran: tried again 1, 2… 10 s later (about a minute in all)
const SQLITE_HEADER = 'SQLite format 3\0';

/** The stand-in for GitHub of a test (PLYMENTOR_UPDATE_URL on this computer), or null. */
export function testSource(env = process.env) {
  if (!env.PLYMENTOR_UPDATE_URL) return null;
  try {
    const u = new URL(env.PLYMENTOR_UPDATE_URL);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u;
  } catch {
    /* not a URL */
  }
  return null;
}

/** electron-updater for Plymentor's releases: it checks and downloads; installing is the Updates' job. */
export function githubUpdater({ source, cacheBase, log, verifyFile }) {
  const feed = source ? { provider: 'github', owner: OWNER, repo: REPO, host: source.host, protocol: source.protocol.slice(0, -1) } : { provider: 'github', owner: OWNER, repo: REPO };
  class SignedUpdater extends nsis.NsisUpdater {
    // electron-updater asks this of every installer it downloads, where it would check Windows' code signature
    // (which needs a certificate): the file must be the installer of the signed release
    async verifySignature(file) {
      try {
        await verifyFile(file);
        return null;
      } catch (e) {
        return e.message;
      }
    }
  }
  const u = new SignedUpdater(feed);
  u.logger = { info: m => log(`[updates] ${m}`), warn: m => log(`[updates] warning: ${m}`), error: m => log(`[updates] error: ${m}`) };
  u.autoDownload = false; // only when the student says so
  u.autoInstallOnAppQuit = false; // Updates.install runs the installer
  u.allowPrerelease = false;
  u.allowDowngrade = false;
  u.disableWebInstaller = true;
  // what electron-updater would read from app-update.yml (the app does not depend on that file)
  u.configOnDisk = { value: Promise.resolve({ ...feed, updaterCacheDirName: CACHE_NAME }) };
  // electron-updater sends a random id kept per installation (for staged roll-outs): the same one for everybody instead
  u.stagingUserIdPromise = { value: Promise.resolve('00000000-0000-0000-0000-000000000000') };
  if (source) {
    u.forceDevUpdateConfig = true; // also in the development app
    Object.defineProperty(u.app, 'baseCachePath', { get: () => cacheBase });
  }
  return u;
}

export class Updates {
  /**
   * home: the data folder; version: this version; isPackaged, execPath; log(...); onStatus(status) on every change;
   * quit() closes the app; showItem(file); openExternal(url); downloadsDir(); createUpdater(options) (tests pass a
   * stand-in for githubUpdater); env (process.env).
   */
  constructor({ home, version, isPackaged, execPath, log, onStatus, quit, showItem, openExternal, downloadsDir, createUpdater = githubUpdater, env = process.env }) {
    Object.assign(this, { home, version, log, onStatus, quit, showItem, openExternal, downloadsDir, createUpdater, env });
    this.source = testSource(env);
    if (env.PLYMENTOR_UPDATE_URL && !this.source) log('PLYMENTOR_UPDATE_URL is not on this computer: ignored');
    this.keys = this.source && env.PLYMENTOR_UPDATE_KEY ? [env.PLYMENTOR_UPDATE_KEY] : RELEASE_KEYS;
    const forced = this.source && ['installed', 'portable'].includes(env.PLYMENTOR_UPDATE_MODE) ? env.PLYMENTOR_UPDATE_MODE : null;
    // installed: by the installer (its uninstaller is next to the program); portable: the portable .exe
    this.mode = forced || (env.PORTABLE_EXECUTABLE_FILE ? 'portable' : isPackaged && existsSync(join(dirname(execPath), 'Uninstall Plymentor.exe')) ? 'installed' : 'none');
    this.cacheBase = this.source ? join(home, 'update-cache') : env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    this.state = 'idle'; // checking | available | downloading | ready | installing
    this.release = null; // the newest release, signed and newer than this version
    this.tag = null;
    this.progress = null; // { transferred, total } bytes while downloading
    this.file = null; // the downloaded installer or portable .exe, checked
    this.error = null; // what went wrong with the student's last request
    this.checked = null; // { at, manual, found, error }
    this.dismissed = null; // the version the student said "Later" to
    this.backup = null; // { file, at, version }
    this.pending = null; // { file, args, cwd }: run as the app quits
    this.updater = null;
    this.timers = [];
    this.prefs = { auto: true, lastVersion: null, ...this.#readPrefs() };
    // an update just finished: say so once (start() then removes the installer it ran)
    this.updatedFrom = this.prefs.lastVersion && isNewer(version, this.prefs.lastVersion) ? this.prefs.lastVersion : null;
    if (this.prefs.lastVersion !== version) this.#savePrefs({ lastVersion: version });
    this.cleaning = null; // that removal, which a download waits for
  }

  status() {
    const r = this.release;
    const portable = this.mode === 'portable' && r?.files.portable;
    return {
      mode: this.mode,
      version: this.version,
      state: this.state,
      auto: this.prefs.auto,
      // download: false when the release has nothing this copy can install itself (a portable .exe; its page has the installer)
      release: r && { version: r.version, date: r.date, notes: r.notes, size: (portable || r.files.setup).size, download: this.mode === 'installed' || !!portable },
      progress: this.progress,
      file: this.file && this.mode === 'portable' ? this.file : null,
      error: this.error,
      checked: this.checked,
      dismissed: !!r && this.dismissed === r.version,
      updatedFrom: this.updatedFrom,
    };
  }

  /** Starts the regular checks (when the student has them on); after an update, removes the installer it ran. */
  start() {
    if (this.updatedFrom && this.mode === 'installed') this.cleaning ||= this.#dropInstaller();
    this.#schedule();
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  #schedule() {
    this.stop();
    if (this.mode === 'none' || !this.prefs.auto) return;
    const run = () => this.check({ manual: false }).catch(() => {});
    this.timers.push(setTimeout(run, FIRST_CHECK));
    const every = setInterval(run, EVERY);
    every.unref?.();
    this.timers.push(every);
  }

  setAuto(on) {
    this.#savePrefs({ auto: !!on });
    this.#schedule();
    return this.#changed();
  }

  /** Looks for a newer release (manual: the student asked; a check already running answers them too). */
  async check({ manual }) {
    if (this.mode === 'none') {
      this.checked = { at: Date.now(), manual, found: false, error: 'Updates work in the installed Plymentor and in the portable .exe.' };
      return this.#changed();
    }
    if (manual) this.dismissed = null;
    if (this.checking) {
      this.askedToo ||= manual;
      return this.checking;
    }
    if (this.state !== 'idle' && this.state !== 'available') return this.#changed();
    this.checking = this.#check(manual).finally(() => (this.checking = null));
    return this.checking;
  }

  async #check(manual) {
    this.state = 'checking';
    this.error = null;
    this.askedToo = false;
    this.#changed();
    const done = (found, error) => (this.checked = { at: Date.now(), manual: manual || this.askedToo, found, ...(error ? { error } : {}) });
    try {
      const r = await this.#updater().checkForUpdates();
      if (!r?.isUpdateAvailable) {
        this.release = null;
        done(false);
      } else {
        const rel = readRelease(r.updateInfo, this.keys);
        if (!isNewer(rel.version, this.version)) throw new Error(`The newest release (${rel.version}) is not newer than this version.`);
        if (this.release?.version !== rel.version) this.file = null;
        this.release = rel;
        this.tag = r.updateInfo.tag || `v${rel.version}`;
        done(true);
        this.log(`Plymentor ${rel.version} is available (signed)`);
      }
    } catch (e) {
      this.log('the update check failed:', e);
      done(false, reason(e));
    }
    this.state = this.release ? 'available' : 'idle';
    if (this.release) await this.#findDownloaded();
    return this.#changed();
  }

  /** Downloads the update the student said yes to. */
  async download() {
    if (this.state !== 'available' || !this.release) throw new Error('There is no update to download.');
    if (this.mode === 'portable' && !this.release.files.portable) throw new Error('This release has only the installer: get it from the release’s page.');
    if (this.file) return this.status();
    this.state = 'downloading';
    this.progress = { transferred: 0, total: 0 };
    this.error = null;
    this.cancelToken = new CancellationToken();
    this.#changed();
    try {
      await this.cleaning; // (the installer of the last update goes first: it is in the folder the download goes to)
      this.file = this.mode === 'installed' ? await this.#downloadInstaller() : await this.#downloadPortable();
      this.log(`Plymentor ${this.release.version} downloaded and checked: ${this.file}`);
    } catch (e) {
      if (!this.cancelToken.cancelled) {
        this.log('the update download failed:', e);
        this.error = `The download failed: ${reason(e)}`;
      }
    }
    this.cancelToken = null;
    this.progress = null;
    this.state = this.file ? 'ready' : 'available';
    return this.#changed();
  }

  cancel() {
    this.cancelToken?.cancel();
    return this.status();
  }

  later() {
    if (this.release) this.dismissed = this.release.version;
    return this.#changed();
  }

  /** The backup of the games the window makes before an update (the bytes of the SQLite file). */
  saveBackup(bytes) {
    if (!this.release) throw new Error('There is no update.');
    if (!(bytes instanceof Uint8Array) || bytes.length < 512 || Buffer.from(bytes.subarray(0, 16)).toString('latin1') !== SQLITE_HEADER) throw new Error('The backup of your games could not be made.');
    const dir = join(this.home, 'backups');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `plymentor-${this.version}-before-${this.release.version}-${new Date().toLocaleDateString('sv')}.sqlite`);
    writeFileSync(`${file}.tmp`, bytes);
    renameSync(`${file}.tmp`, file);
    // the newest few stay
    const old = readdirSync(dir)
      .filter(n => /^plymentor-[\d.]+-before-[\d.]+-[\d-]+\.sqlite$/.test(n) && join(dir, n) !== file)
      .map(n => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(KEEP_BACKUPS - 1);
    for (const { n } of old) rmSync(join(dir, n), { force: true });
    this.backup = { file, at: Date.now(), version: this.release.version };
    this.log(`backup of the games before the update: ${file}`);
    return { file };
  }

  /** "Restart and update": checks the file once more and closes the app, which then starts it (runPending). */
  async install() {
    if (this.state !== 'ready' || !this.file) throw new Error('No update is ready to install.');
    const b = this.backup;
    if (!b || b.version !== this.release.version || Date.now() - b.at > BACKUP_FRESH || !existsSync(b.file)) throw new Error('Plymentor backs up your games before it updates, and that has not happened.');
    const installed = this.mode === 'installed';
    try {
      await checkFile(this.file, installed ? this.release.files.setup : this.release.files.portable);
    } catch (e) {
      this.file = null;
      this.state = 'available';
      this.error = e.message;
      this.#changed();
      throw e;
    }
    this.pending = installed
      ? { file: this.file, args: ['--updated', '/S', '--force-run'], cwd: dirname(this.file) }
      : { file: this.file, args: [`--replacing=${process.pid}`], cwd: dirname(this.file) };
    this.state = 'installing';
    this.log(`installing Plymentor ${this.release.version} as the app quits: ${this.file}`);
    this.#changed();
    this.stop();
    setTimeout(() => this.quit(), 300); // (the window gets this answer first)
    return this.status();
  }

  /** Runs the installer (or the new portable .exe) as the app quits, once. */
  runPending() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (this.source) {
      writeFileSync(join(this.home, 'update-test-install.json'), JSON.stringify({ ...p, version: this.release?.version, mode: this.mode }, null, 2));
      return;
    }
    try {
      spawn(p.file, p.args, { cwd: p.cwd, detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      this.log('the update could not be started:', e);
    }
  }

  showFile() {
    if (this.file) this.showItem(this.file);
  }

  /** The newest release's page on GitHub (its notes and its installer), in the web browser. */
  openPage() {
    if (!this.release) return;
    const base = this.source ? this.source.origin : 'https://github.com';
    this.openExternal(`${base}/${OWNER}/${REPO}/releases/tag/${encodeURIComponent(this.tag)}`);
  }

  // -------------------------------------------------------------------------------------------

  #updater() {
    if (!this.updater) {
      this.updater = this.createUpdater({ source: this.source, cacheBase: this.cacheBase, log: this.log, verifyFile: f => checkFile(f, this.release.files.setup) });
      let last = 0;
      this.updater.on('download-progress', p => {
        if (this.state !== 'downloading') return;
        this.progress = { transferred: p.transferred, total: p.total };
        if (Date.now() - last > 250) {
          last = Date.now();
          this.#changed();
        }
      });
    }
    return this.updater;
  }

  async #downloadInstaller() {
    const [file] = await this.#updater().downloadUpdate(this.cancelToken);
    await checkFile(file, this.release.files.setup);
    return file;
  }

  /** The new portable .exe, next to the running one (or in Downloads when that folder is not writable). */
  async #downloadPortable() {
    const f = this.release.files.portable;
    const dir = this.#portableDir();
    const file = join(dir, f.name);
    const part = `${file}.download`;
    const base = this.source ? this.source.origin : 'https://github.com';
    const url = new URL(`${base}/${OWNER}/${REPO}/releases/download/${encodeURIComponent(this.tag)}/${f.name}`);
    try {
      await this.#updater().httpExecutor.download(url, part, {
        sha512: f.sha512,
        cancellationToken: this.cancelToken,
        onProgress: p => {
          this.progress = { transferred: p.transferred, total: p.total };
          this.#changed();
        },
      });
      await checkFile(part, f);
      renameSync(part, file);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
    return file;
  }

  #portableDir() {
    if (this.source) {
      const dir = join(this.home, 'update-downloads');
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    const dir = dirname(this.env.PORTABLE_EXECUTABLE_FILE);
    const probe = join(dir, `.plymentor-${process.pid}.tmp`);
    try {
      writeFileSync(probe, '');
      unlinkSync(probe);
      return dir;
    } catch {
      return this.downloadsDir();
    }
  }

  /**
   * The installer of the update that just finished (in electron-updater's pending\ folder), removed in the background:
   * it may still be running — it starts the app as it finishes, and Windows keeps a running program's file —, so it is
   * tried again for about a minute; when it cannot be removed, the next download replaces it. (Removed as the app
   * starts, while the installer still runs, Windows would refuse, and the start would stop: no window.)
   */
  async #dropInstaller() {
    try {
      await rm(join(this.cacheBase, CACHE_NAME, 'pending'), { recursive: true, force: true, maxRetries: DROP_RETRIES, retryDelay: 1000 });
    } catch (e) {
      this.log('the installer of the last update could not be removed:', e);
    }
  }

  /** An update downloaded before (and still intact) is ready again. */
  async #findDownloaded() {
    if (this.file || (this.mode === 'portable' && !this.release.files.portable)) return;
    const installed = this.mode === 'installed';
    const f = installed ? this.release.files.setup : this.release.files.portable;
    const file = installed ? join(this.cacheBase, CACHE_NAME, 'pending', f.name) : join(this.#portableDir(), f.name);
    if (!existsSync(file)) return;
    try {
      await checkFile(file, f);
      this.file = file;
      this.state = 'ready';
    } catch {
      /* incomplete or something else: downloaded again on "Update" */
    }
  }

  #readPrefs() {
    try {
      const p = JSON.parse(readFileSync(join(this.home, 'update.json'), 'utf8'));
      return { auto: p.auto !== false, lastVersion: typeof p.lastVersion === 'string' ? p.lastVersion : null };
    } catch {
      return {};
    }
  }

  #savePrefs(patch) {
    Object.assign(this.prefs, patch);
    try {
      mkdirSync(this.home, { recursive: true });
      writeFileSync(join(this.home, 'update.json'), JSON.stringify(this.prefs));
    } catch (e) {
      this.log('update.json could not be saved:', e);
    }
  }

  #changed() {
    const s = this.status();
    try {
      this.onStatus?.(s);
    } catch {
      /* no window */
    }
    return s;
  }
}

function reason(e) {
  const m = String(e?.message || e).split('\n')[0];
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ECONNREFUSED|ETIMEDOUT/.test(m)) return 'Plymentor could not reach GitHub (no internet connection?).';
  if (/\b404\b|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|No published versions/.test(m)) return 'Plymentor’s releases on GitHub could not be read.';
  return m.length > 240 ? `${m.slice(0, 240)}…` : m;
}
