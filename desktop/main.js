// Plymentor (by Studio Nox), the desktop app: the Electron main process.
//
// - Shows the app (app/, built into build/app) in a native window. The pages come from the app:// scheme
//   (app://plymentor/), a fixed secure origin, so the window's storage — the games database (SQLite in the origin's
//   private file system), the natural voice's model — stays the same between starts.
// - Runs the coach host (host.js): the coach CLI in a pseudo-terminal, the MCP bridge on 127.0.0.1, CLI installation,
//   the coach's settings and notes. The window talks to it over an Electron message port.
// - Keeps everything on this computer, in %LOCALAPPDATA%\Plymentor (PLYMENTOR_HOME overrides it, e.g. for tests):
//   app\ (the window's storage), users\ (the coach's settings and notes), coach-workspace\, logs\, gigabase\ (the game
//   database the student added, for the opening explorer — see gigabase/manager.js), backups\ (the games, saved before
//   each update), update.json.
// - Looks for updates on Plymentor's GitHub releases and installs one when the student says so (updates.js).
import { app, BrowserWindow, Menu, MessageChannelMain, dialog, ipcMain, protocol, session, shell, utilityProcess } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIR, userDir } from './store.js';
import { CoachHost } from './host.js';
import { GameDatabases } from './gigabase/manager.js';
import { Updates } from './updates.js';
import { APP_ORIGIN, APP_VERSION, LOCAL_PROFILE_ID } from '../shared/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // build/desktop (inside app.asar when packaged)
const APP_DIR = join(HERE, '..', 'app'); // build/app
const SCHEME = 'app';
const APP_HOST = new URL(APP_ORIGIN).host;
const START_URL = `${APP_ORIGIN}/index.html`;
// The CLIs start the MCP server as a separate process: it must be a real file, outside app.asar.
const MCP_SCRIPT = join(HERE, 'mcp.cjs').replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
const SOURCE_URL = 'https://github.com/zomBeeone/plymentor';

// ---------------------------------------------------------------------------------------------
// Where things live, the log, one running copy

const LOG_DIR = join(HOME_DIR, 'logs');
const LOG_FILE = join(LOG_DIR, 'plymentor.log');
mkdirSync(LOG_DIR, { recursive: true });
try {
  if (statSync(LOG_FILE).size > 2 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.old`);
} catch {
  /* no log yet */
}
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(p => (p instanceof Error ? p.stack || p.message : String(p))).join(' ')}`;
  if (!app.isPackaged) console.log(line);
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    /* the log is a convenience */
  }
}
// Until the window is there, an uncaught error means the rest of the start did not happen: Plymentor says so and quits,
// rather than run on unseen and keep the one-copy lock, so that its shortcut would do nothing.
// From the window on, such an error is only logged.
let starting = true;
let secondCopy = false;
function startFailed(e) {
  if (!starting) return;
  starting = false;
  if (!secondCopy) dialog.showErrorBox('Plymentor', `Plymentor could not start:\n\n${e?.message || e}\n\nYour games are not affected. Start Plymentor again; if this happens again, the log has the details: ${LOG_FILE}`);
  app.exit(1);
}
process.on('uncaughtException', e => {
  log('uncaught exception:', e);
  startFailed(e);
});
process.on('unhandledRejection', e => {
  log('unhandled rejection:', e);
  startFailed(e);
});

// A new portable .exe that the old one started after downloading it waits until the old copy has quit (one copy runs).
const replacing = Number(/^--replacing=(\d+)$/.exec(process.argv.find(a => a.startsWith('--replacing=')) || '')?.[1]);
if (replacing) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const until = Date.now() + 20_000; Date.now() < until; Atomics.wait(pause, 0, 0, 100)) {
    try {
      process.kill(replacing, 0);
    } catch {
      break; // gone
    }
  }
}

app.setPath('userData', join(HOME_DIR, 'app'));
app.setAppUserModelId('com.studionox.plymentor');
if (!app.requestSingleInstanceLock()) {
  // Plymentor is already running (its games database can only be open once): the first copy comes to the front.
  secondCopy = true;
  app.quit();
} else {
  log(`Plymentor ${APP_VERSION} starting (Electron ${process.versions.electron}, ${app.isPackaged ? 'packaged' : 'development'}), data in ${HOME_DIR}`);
}

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

// ---------------------------------------------------------------------------------------------
// The app's files (app://plymentor/...) with their security headers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.tsv': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  // game downloads and the opening explorer (Lichess, Chess.com), the natural voice's model (Hugging Face, once)
  "connect-src 'self' https://lichess.org https://explorer.lichess.org https://explorer.lichess.ovh https://api.chess.com https://huggingface.co https://*.huggingface.co https://*.hf.co",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

// Cross-origin isolation gives the pages SharedArrayBuffer: Stockfish (WebAssembly) runs multi-threaded.
const HEADERS = {
  'Content-Security-Policy': CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const ALIASES = { '/': '/index.html', '/licenses': '/licenses.html', '/about': '/about.html' };

async function serveApp(request) {
  const url = new URL(request.url);
  const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', ...HEADERS } });
  if (url.host !== APP_HOST || (request.method !== 'GET' && request.method !== 'HEAD')) return notFound();
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }
  path = ALIASES[path] || path;
  const file = normalize(join(APP_DIR, path));
  if (!file.startsWith(APP_DIR + sep)) return notFound();
  let body;
  try {
    body = await readFile(file);
  } catch {
    return notFound();
  }
  const headers = { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...HEADERS };
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

const isAppUrl = u => {
  try {
    const url = new URL(u);
    return url.protocol === `${SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
};

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href);
  } catch {
    /* not a link */
  }
}

// Permissions the window may use: copying from the coach's terminal, full screen.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

function hardenSession(ses) {
  ses.protocol.handle(SCHEME, serveApp);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Downloads (a backup of the games) open the Save dialog. The end-to-end test saves them in a folder instead.
  const downloads = process.env.PLYMENTOR_DOWNLOAD_DIR;
  if (downloads) ses.on('will-download', (_e, item) => item.setSavePath(join(downloads, item.getFilename())));
}

// The about and licences pages: plain pages (no preload), each in a small window of its own above the main window.
const PAGES = {
  '/about.html': { width: 560, height: 640, title: 'About Plymentor' },
  '/licenses.html': { width: 900, height: 760, title: 'Plymentor — Licences and source code' },
  '/LICENSE.txt': { width: 760, height: 760, title: 'Plymentor — GNU Affero General Public License' },
  '/engine/COPYING.txt': { width: 760, height: 760, title: 'Stockfish — GNU General Public License' },
};
const pageWindows = new Map();

function openPage(path) {
  const page = PAGES[ALIASES[path] || path];
  if (!page) return;
  const open = pageWindows.get(page);
  if (open && !open.isDestroyed()) return open.focus();
  const w = new BrowserWindow({
    ...page,
    parent: win || undefined,
    minimizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#161512',
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  w.removeMenu();
  w.once('ready-to-show', () => w.show());
  w.loadURL(`${APP_ORIGIN}${ALIASES[path] || path}`);
  pageWindows.set(page, w);
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', e => e.preventDefault());
  contents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) {
      const path = new URL(url).pathname;
      // the main window only reloads; the page windows move between the about and licences pages
      if (contents === win?.webContents ? path === '/index.html' : Object.hasOwn(PAGES, ALIASES[path] || path)) return;
      e.preventDefault();
      return;
    }
    e.preventDefault();
    openExternal(url);
  });
  // Links open in the student's web browser; the about and licences pages in their own windows.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) openPage(new URL(url).pathname);
    else openExternal(url);
    return { action: 'deny' };
  });
});

// ---------------------------------------------------------------------------------------------
// The coach host and the window's connections to it

let host = null;
let win = null;
const pageSockets = new Set();

/** A message port wrapped like the WebSocket the host expects ({ readyState, send, close, on }). */
function portSocket(port) {
  const events = new EventEmitter();
  const sock = {
    readyState: 1,
    send(data) {
      if (sock.readyState === 1) port.postMessage(data);
    },
    close() {
      if (sock.readyState !== 1) return;
      sock.readyState = 3;
      port.close();
      pageSockets.delete(sock);
      events.emit('close');
    },
    on: (event, fn) => events.on(event, fn),
  };
  port.on('message', e => events.emit('message', e.data));
  port.on('close', () => sock.close());
  port.start();
  pageSockets.add(sock);
  return sock;
}

ipcMain.on('coach-connect', event => {
  if (!host || !win || event.sender !== win.webContents || !isAppUrl(event.senderFrame?.url || '')) return;
  const { port1, port2 } = new MessageChannelMain();
  host.connectPage(portSocket(port1));
  event.sender.postMessage('coach-port', null, [port2]);
});

const FOLDERS = {
  data: () => HOME_DIR,
  notes: () => userDir(LOCAL_PROFILE_ID),
  logs: () => LOG_DIR,
};

ipcMain.handle('app-info', () => ({
  version: APP_VERSION,
  home: HOME_DIR,
  storage: app.getPath('userData'),
  portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
  exe: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  sourceUrl: SOURCE_URL,
}));
ipcMain.handle('open-folder', async (_e, which) => {
  if (!Object.hasOwn(FOLDERS, which)) return 'Unknown folder';
  const dir = FOLDERS[which]();
  mkdirSync(dir, { recursive: true });
  return shell.openPath(dir); // '' when it worked
});
ipcMain.handle('open-external', (_e, url) => openExternal(String(url)));

// ---------------------------------------------------------------------------------------------
// The game database the student added (a Scid 5 database), for the opening explorer and the coach

const databases = new GameDatabases({
  home: HOME_DIR,
  jobScript: join(HERE, 'gigabase-job.mjs'),
  queryScript: join(HERE, 'gigabase-query.mjs'),
  fork: (script, serviceName) => {
    const child = utilityProcess.fork(script, [], { serviceName, stdio: 'pipe' });
    const relay = stream => stream?.on('data', d => log(`[${serviceName}] ${String(d).trim()}`));
    relay(child.stdout);
    relay(child.stderr);
    return child;
  },
  log,
  onStatus: status => win?.webContents.send('gigabase-status', status),
});

const moveList = moves => (Array.isArray(moves) ? moves.slice(0, 300).map(m => String(m).slice(0, 6)) : []);
ipcMain.handle('gigabase', async (event, method, args) => {
  if (!win || event.sender !== win.webContents) throw new Error('Not allowed');
  const a = args && typeof args === 'object' ? args : {};
  switch (method) {
    case 'status':
      return databases.status();
    case 'add': {
      // the student picks the file in Windows' own dialog; the window never names a path
      // (PLYMENTOR_PICK_FILE: the file the end-to-end test "picks")
      let file = process.env.PLYMENTOR_PICK_FILE;
      if (!file) {
        const r = await dialog.showOpenDialog(win, {
          title: 'Add a game database',
          properties: ['openFile'],
          filters: [{ name: 'Scid 5 database (.si5) or a 7z archive with one', extensions: ['si5', '7z'] }],
        });
        file = r.canceled ? null : r.filePaths[0];
      }
      return file ? databases.add(file) : databases.status();
    }
    case 'reindex':
      return databases.reindex();
    case 'cancel':
      return databases.cancel();
    case 'remove':
      return databases.remove();
    case 'open-folder': {
      const dir = databases.folder();
      mkdirSync(dir, { recursive: true });
      return shell.openPath(dir);
    }
    case 'explore':
      return databases.request('explore', { fen: String(a.fen || '').slice(0, 120), moves: moveList(a.moves) });
    case 'game':
      return databases.request('game', { id: Number(a.id) });
    default:
      throw new Error('Unknown request');
  }
});

// ---------------------------------------------------------------------------------------------
// Updates: found on GitHub, installed when the student says so

// electron-updater's requests (its own in-memory session, 'electron-updater') neither keep nor send cookies.
function hardenUpdateSession() {
  const ses = session.fromPartition('electron-updater', { cache: false });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const h of Object.keys(requestHeaders)) if (h.toLowerCase() === 'cookie') delete requestHeaders[h];
    callback({ requestHeaders });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    for (const h of Object.keys(responseHeaders)) if (h.toLowerCase() === 'set-cookie') delete responseHeaders[h];
    callback({ responseHeaders });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

const updates = new Updates({
  home: HOME_DIR,
  version: APP_VERSION,
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  log,
  onStatus: status => win?.webContents.send('update-status', status),
  quit: () => app.quit(),
  showItem: file => shell.showItemInFolder(file),
  openExternal,
  downloadsDir: () => app.getPath('downloads'),
});

ipcMain.handle('update', async (event, method, args) => {
  if (!win || event.sender !== win.webContents) throw new Error('Not allowed');
  switch (method) {
    case 'status':
      return updates.status();
    case 'check':
      return updates.check({ manual: true });
    case 'download':
      return updates.download();
    case 'cancel':
      return updates.cancel();
    case 'later':
      return updates.later();
    case 'auto':
      return updates.setAuto(!!args?.on);
    case 'backup':
      return updates.saveBackup(args?.bytes);
    case 'install':
      return updates.install();
    case 'show-file':
      return updates.showFile();
    case 'open-page':
      return updates.openPage();
    default:
      throw new Error('Unknown request');
  }
});

// ---------------------------------------------------------------------------------------------
// The window

const STATE_FILE = () => join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE(), 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* first start */
  }
  return { width: 1500, height: 950 };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    writeFileSync(STATE_FILE(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    /* not important */
  }
}

function createWindow() {
  const state = loadWindowState();
  const icon = join(APP_DIR, 'assets', 'icon.png');
  win = new BrowserWindow({
    width: Math.max(1000, state.width),
    height: Math.max(640, state.height),
    ...(Number.isFinite(state.x) && Number.isFinite(state.y) ? { x: state.x, y: state.y } : {}),
    minWidth: 1000,
    minHeight: 640,
    title: 'Plymentor',
    backgroundColor: '#161512',
    ...(existsSync(icon) ? { icon } : {}),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required', // the coach may greet the student out loud
      backgroundThrottling: false, // analysis and the coach keep working while the window is in the background
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // Closing: the window closes its games database first (at most a few seconds).
  let closing = false;
  win.on('close', e => {
    if (closing) return;
    e.preventDefault();
    closing = true;
    saveWindowState();
    const finish = () => {
      clearTimeout(timer);
      ipcMain.removeListener('app-closed', onClosed);
      if (!win.isDestroyed()) win.destroy();
    };
    const onClosed = ev => ev.sender === win.webContents && finish();
    const timer = setTimeout(finish, 4000);
    ipcMain.on('app-closed', onClosed);
    win.webContents.send('app-closing');
  });
  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (!isMainFrame || isSameDocument) return;
    for (const s of [...pageSockets]) s.close(); // a reloaded page connects again
  });
  win.webContents.on('render-process-gone', async (_e, details) => {
    log('window process gone:', details.reason, details.exitCode);
    for (const s of [...pageSockets]) s.close();
    if (details.reason === 'clean-exit' || !win || win.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(win, { type: 'error', title: 'Plymentor', message: 'The Plymentor window stopped working.', detail: `Reason: ${details.reason}. Your games are saved.`, buttons: ['Reload', 'Quit'], defaultId: 0 });
    if (response === 0) win.reload();
    else app.quit();
  });
  win.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    if (level === 'error') log(`[window] ${message} (${sourceId}:${lineNumber})`);
  });
  win.loadURL(START_URL);
}

function buildMenu() {
  const openFolder = which => () => shell.openPath(FOLDERS[which]());
  // No accelerators that the coach's terminal needs (Ctrl+C, Ctrl+R…): the CLIs get those keys.
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open the data folder', click: openFolder('data') },
        { label: "Open the coach's notes folder", click: openFolder('notes') },
        { label: 'Open the log folder', click: openFolder('logs') },
        { type: 'separator' },
        { label: 'Quit Plymentor', click: () => app.quit() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: 'F11' },
        { type: 'separator' },
        { label: 'Reload the window', click: () => win?.webContents.reload() },
        { label: 'Developer tools', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for updates…', click: () => updates.check({ manual: true }) },
        { type: 'separator' },
        { label: 'Licences', click: () => openPage('/licenses.html') },
        { label: 'Source code', click: () => shell.openExternal(SOURCE_URL) },
        { type: 'separator' },
        { label: 'About Plymentor', click: () => openPage('/about.html') },
      ],
    },
  ]);
}

// ---------------------------------------------------------------------------------------------

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.on('window-all-closed', () => app.quit());

// Quitting: the coach host closes its sessions first (at most 3 s); an update the student agreed to starts last.
let hostClosed = false;
app.on('will-quit', e => {
  databases.close();
  updates.stop();
  if (!host || hostClosed) return updates.runPending();
  e.preventDefault();
  hostClosed = true;
  log('closing the coach sessions');
  host.close().finally(() => app.quit());
  setTimeout(() => {
    updates.runPending();
    app.exit(0);
  }, 3000);
});

if (app.hasSingleInstanceLock())
  app.whenReady().then(async () => {
    hardenSession(session.defaultSession);
    if (!existsSync(MCP_SCRIPT)) log('MCP server missing:', MCP_SCRIPT);
    host = new CoachHost({ mcpScript: MCP_SCRIPT, log, databases });
    try {
      const port = await host.listen();
      log(`coach host listening on 127.0.0.1:${port}`);
    } catch (e) {
      log('the coach host could not start:', e);
      dialog.showErrorBox('Plymentor', `The coach could not start: ${e.message}`);
    }
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    starting = false;
    hardenUpdateSession();
    updates.start();
  });
