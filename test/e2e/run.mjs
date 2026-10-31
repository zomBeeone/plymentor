// End-to-end test of the Plymentor desktop app: starts the real app (Electron) with a DevTools port and drives its
// window — the games database, Stockfish, import, batch analysis, the board, a training game, reports, openings,
// the coach (a fake coach program, no subscription used) through the real MCP server, a game database added by the
// student (a small Scid 5 database; PLYMENTOR_PICK_FILE stands in for the file dialog), Settings (no 1.x import and no
// Lichess token any more), backup and restore, closing cleanly, starting again with the same data (and the database
// still added), one running copy, and
// updates from a stand-in for GitHub on 127.0.0.1 (fake-github.mjs, a release signed with the test's own key): up to
// date, a release with another key refused, then an update downloaded — only its changed parts — and handed over to the
// installer when the student says so (the installer itself is not run: the app writes what it would start); and the
// first start after an update, while the installer is still finishing (a program running from its folder).
//
// Run: npm run build && npm run test:e2e            (the app from build/, with the Electron of node_modules)
//      E2E_EXE=release\win-unpacked\Plymentor.exe npm run test:e2e   (a packaged app; the portable .exe works too)
//      E2E_VOICE=1 also downloads and tests the natural voice (~90 MB); E2E_ONLINE=1 downloads games from Lichess.
// Everything happens in test/.tmp (PLYMENTOR_HOME, and PLYMENTOR_LEGACY_HOME for the Chess Coach 1.x data): your own
// data is never touched.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap.js';
import { App, sleep } from './cdp.mjs';
import { startFakeGitHub } from './fake-github.mjs';
import { makeEpub, makePdf, makeScannedPdf } from './make-books.mjs';
import { extract7z } from '../../desktop/gigabase/sevenzip.js';
import { hashFile, portableName, setupName, signRelease } from '../../desktop/update-manifest.js';
import { APP_VERSION, LOCAL_PROFILE_ID } from '../../shared/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = join(ROOT, 'test', '.tmp');
const HOME = join(TMP, 'e2e-home');
const LEGACY = join(TMP, 'e2e-legacy'); // where Chess Coach 1.x kept its data
const DOWNLOADS = join(TMP, 'e2e-downloads');
const SCID = join(TMP, 'e2e-scid'); // a game database the student downloaded and unpacked themselves
const fixture = readFileSync(join(ROOT, 'test', 'fixtures', 'games.pgn'), 'utf8');
const EXE = process.env.E2E_EXE ? join(ROOT, process.env.E2E_EXE) : join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARGS = process.env.E2E_EXE ? [] : [ROOT];
const ENV = {
  PLYMENTOR_HOME: HOME,
  PLYMENTOR_LEGACY_HOME: LEGACY,
  PLYMENTOR_CLAUDE_PATH: join(ROOT, 'test', 'e2e', 'fake-cli.mjs'), // the fake coach (a script: runs on this Node.js)
  PLYMENTOR_DOWNLOAD_DIR: DOWNLOADS,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
};

let failures = 0;
let passes = 0;
let app = null;
const apps = [];
let updates = null;

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passes++;
    log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failures++;
    log(`✖ ${name}: ${e.message}`);
    await app?.page?.screenshot(join(TMP, `fail-${failures}.png`)).catch(() => {});
    if (process.env.E2E_STOP_ON_FAIL) throw e;
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function launch(more = {}) {
  const a = await App.launch({ exe: EXE, args: ARGS, env: ENV, ...more });
  apps.push(a);
  return a;
}

const appReady = page => page.waitFor(`document.querySelector('.topbar .nav') ? true : false`, { timeout: 60000, what: 'the app' });
const go = (page, hash) => page.eval(`(location.hash = ${JSON.stringify(hash)}, true)`);
const text = (page, sel) => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.innerText).join('\\n')`);
const pills = page => text(page, '.status-pills .pill');
const term = page => page.eval(`document.querySelector('.xterm-rows')?.innerText || ''`);
const gameRows = page => page.eval(`document.querySelectorAll('table.data tbody tr').length`);
// Types into the coach's terminal (in the coach panel on the screen), as the student would — input events of the page,
// not key presses: those only arrive while the test window has the keyboard focus.
const ask = (page, text) =>
  page.eval(`(t => { t.focus(); for (const data of [${JSON.stringify(text)}, '\\r']) t.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true })); return true; })([...document.querySelectorAll('.xterm-helper-textarea')].find(t => t.offsetParent))`);

/** The test's game database as the student would have it after unpacking a download: Test_Base.si5/.sn5/.sg5. */
function makeScidDatabase() {
  rmSync(SCID, { recursive: true, force: true });
  mkdirSync(SCID, { recursive: true });
  extract7z(join(ROOT, 'test', 'fixtures', 'gigabase', 'test-db.7z'), f => (f.dir ? null : join(SCID, f.name.split('/').pop())));
  return join(SCID, 'Test_Base.si5');
}

const PORTABLE = /portable\.exe$/i.test(process.env.E2E_EXE || '');
const NEXT = APP_VERSION.replace(/\d+$/, n => String(Number(n) + 1)); // the test's update
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * The test's updates: a release key of its own, a stand-in for GitHub where this version is the newest, the
 * "installers" of this version and of the next (3 MB; the next one has 40 kB changed and 20 kB more) with their
 * blockmaps — this version's is where the installer leaves a copy of itself, for differential downloads —, and the
 * next portable .exe. publish(key) makes the next version the newest release, signed with key.
 */
async function setUpUpdates() {
  const keys = [0, 1].map(() => generateKeyPairSync('ed25519'));
  const github = await startFakeGitHub();
  ENV.PLYMENTOR_UPDATE_URL = github.url;
  ENV.PLYMENTOR_UPDATE_KEY = keys[0].publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  if (!PORTABLE) ENV.PLYMENTOR_UPDATE_MODE = 'installed'; // (the portable .exe is portable by itself)
  const dir = join(TMP, 'e2e-release');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = { old: join(dir, setupName(APP_VERSION)), setup: join(dir, setupName(NEXT)), portable: join(dir, portableName(NEXT)) };
  const old = randomBytes(3 << 20);
  writeFileSync(files.old, old);
  writeFileSync(files.setup, Buffer.concat([old.subarray(0, 1 << 20), randomBytes(40 << 10), old.subarray((1 << 20) + (40 << 10)), randomBytes(20 << 10)]));
  writeFileSync(files.portable, randomBytes(2 << 20));
  for (const f of [files.old, files.setup]) await buildBlockMap(f, 'gzip', `${f}.blockmap`);
  const cache = join(HOME, 'update-cache', 'plymentor-updater');
  mkdirSync(cache, { recursive: true });
  copyFileSync(files.old, join(cache, 'installer.exe'));
  const current = await hashFile(files.old);
  github.release(APP_VERSION, {
    'latest.yml': JSON.stringify({ version: APP_VERSION, files: [{ url: setupName(APP_VERSION), ...current }], path: setupName(APP_VERSION), sha512: current.sha512 }),
    [`${setupName(APP_VERSION)}.blockmap`]: readFileSync(`${files.old}.blockmap`),
  });
  const publish = async key => {
    const [setup, portable] = await Promise.all([hashFile(files.setup), hashFile(files.portable)]);
    const notes = `${NEXT} — 2026-10-23 — the test's update\n\n- **New:** something better.`;
    const latest = { version: NEXT, files: [{ url: setupName(NEXT), ...setup }], path: setupName(NEXT), sha512: setup.sha512, releaseDate: new Date().toISOString(), plymentor: signRelease({ version: NEXT, date: '2026-10-23', notes, setup, portable }, key) };
    github.release(NEXT, {
      'latest.yml': JSON.stringify(latest),
      [setupName(NEXT)]: readFileSync(files.setup),
      [`${setupName(NEXT)}.blockmap`]: readFileSync(`${files.setup}.blockmap`),
      [portableName(NEXT)]: readFileSync(files.portable),
    });
  };
  return { github, files, publish, key: keys[0].privateKey.export({ type: 'pkcs8', format: 'pem' }), otherKey: keys[1].privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** A Chess Coach 1.x database (two games) in the test's old data folder: Settings no longer offers to import it. */
function makeV1Data() {
  mkdirSync(join(LEGACY, 'data'), { recursive: true });
  const db = new DatabaseSync(join(LEGACY, 'data', 'coach.db'));
  db.exec(`
    CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE games (id INTEGER PRIMARY KEY, collection_id INTEGER, hash TEXT UNIQUE, white TEXT, black TEXT, white_elo INTEGER, black_elo INTEGER,
      result TEXT, date TEXT, event TEXT, site TEXT, round TEXT, eco TEXT, opening TEXT, time_control TEXT, termination TEXT, start_fen TEXT,
      ply_count INTEGER NOT NULL DEFAULT 0, moves TEXT NOT NULL DEFAULT '', sans TEXT NOT NULL DEFAULT '', clocks TEXT, pgn TEXT, headers TEXT, created_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO collections (id, name, source, created_at) VALUES (1, ?, ?, ?)').run('My 1.x games', 'file', 1700000000000);
  for (const [i, moves, sans] of [
    [1, 'e2e4 c7c5 g1f3', 'e4 c5 Nf3'],
    [2, 'd2d4 g8f6 c2c4', 'd4 Nf6 c4'],
  ]) {
    const hash = createHash('sha1').update(`old${i}|x|2025.01.0${i}|1-0||${moves}`).digest('hex');
    db.prepare('INSERT INTO games (id, collection_id, hash, white, black, result, date, ply_count, moves, sans, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(i, hash, `old${i}`, 'x', '1-0', `2025.01.0${i}`, 3, moves, sans, 1700000000000);
  }
  db.close();
}

// ---------------------------------------------------------------------------------------------

async function main() {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(LEGACY, { recursive: true, force: true });
  rmSync(DOWNLOADS, { recursive: true, force: true });
  mkdirSync(DOWNLOADS, { recursive: true });
  makeV1Data();
  ENV.PLYMENTOR_PICK_FILE = makeScidDatabase(); // the file "chosen" when the student adds a database
  updates = await setUpUpdates();
  const { makeGames } = await import('../unit/scid-fixtures.mjs');
  const dbGames = makeGames(1);
  if (!process.env.E2E_EXE && !existsSync(join(ROOT, 'build', 'desktop', 'main.mjs'))) throw new Error('Build first: npm run build');
  log(`Starting ${process.env.E2E_EXE || 'the app from build/'} with its data in ${HOME}`);

  app = await launch();
  let page = app.page;

  await step('the app opens in its own window: games database, isolation, Stockfish multi-threaded', async () => {
    await appReady(page);
    const env = await page.eval(`({ origin: location.origin, isolated: crossOriginIsolated, desktop: !!window.plymentor, node: typeof require, title: document.title, brand: document.querySelector('.topbar .brand')?.innerText })`);
    assert(env.origin === 'app://plymentor' && env.isolated && env.desktop, JSON.stringify(env));
    assert(env.title === 'Plymentor' && env.brand === 'Plymentor', `the name: ${env.title} / ${env.brand}`);
    assert(env.node === 'undefined', 'the window has no Node.js');
    const p = await page.waitFor(`(t => /Stockfish/.test(t) && t)([...document.querySelectorAll('.status-pills .pill')].map(e => e.innerText).join(' | '))`, { timeout: 60000, what: 'the engine pill' });
    assert(/Multithread/i.test(p), p);
  });

  await step('the coach starts and greets through the tools (fake coach, real MCP server)', async () => {
    await page.waitFor(`/Claude Code: (ready|working|starting)/.test(document.querySelector('.status-pills').innerText)`, { timeout: 30000, what: 'the coach pill' });
    await page.waitFor(`/Greeting done/.test(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 60000, what: 'the greeting in the terminal' });
    const t = await term(page);
    assert(/board: Active screen: Board/.test(t), 'get_board_state ran in the window');
    assert(/analysis: 1\) /.test(t), 'analyze_position ran with Stockfish');
    assert(/memory saved: Saved/.test(t), 'notes saved by the coach host');
    assert(/set_board: Shown on the student's board/.test(t), 'set_board');
    await page.waitFor(`/The Najdorf/.test(document.querySelector('.board-caption')?.innerText || '')`, { what: 'the position shown on the board' });
    const mem = readFileSync(join(HOME, 'users', LOCAL_PROFILE_ID, 'coach-memory.md'), 'utf8');
    assert(/Najdorf/.test(mem), 'the notes are in the data folder');
  });

  await step('import games by pasting a PGN', async () => {
    await go(page, '#/games');
    // (the coach terminal has a hidden textarea of its own: look inside the import panel)
    await page.waitFor(`document.querySelector('.card .dropzone') || (document.querySelector('.page h1') && [...document.querySelectorAll('button')].some(b => b.textContent.includes('Import games')))`, { what: 'the games page' });
    await page.eval(`(() => { if (!document.querySelector('.card .dropzone')) [...document.querySelectorAll('button')].find(b => b.textContent.includes('Import games')).click(); return true; })()`);
    await page.waitFor(`document.querySelector('.card .dropzone')`, { what: 'the import panel' });
    await page.type('.card .dropzone ~ textarea, .card .col textarea', fixture);
    await page.click('button', 'Import pasted PGN');
    await page.waitFor(`document.body.innerText.includes('4 imported')`, { what: 'the import result' });
    await page.waitFor(`document.querySelectorAll('table.data tbody tr').length === 4`, { what: '4 rows' });
  });

  await step('profile: set my username', async () => {
    await go(page, '#/settings');
    await page.waitFor(`[...document.querySelectorAll('label.field span')].some(s => s.textContent === 'Your usernames')`, { what: 'settings' });
    // the "Saved" toast shows for 1.5 s: record every toast rather than hoping to look at the right moment
    await page.eval(`(() => { window.ccToasts = []; new MutationObserver(() => document.querySelectorAll('.toasts .toast').forEach(t => window.ccToasts.push(t.textContent))).observe(document.querySelector('.toasts'), { childList: true, subtree: true, characterData: true }); return true; })()`);
    // DOM events rather than real key presses: those only arrive while the test window has the keyboard focus
    const field = `[...document.querySelectorAll('label.field')].find(l => l.querySelector('span')?.textContent === 'Your usernames').querySelector('input')`;
    await page.eval(`(i => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'student1'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })(${field})`);
    await sleep(300); // the field re-renders with the typed value before Enter saves it
    await page.eval(`${field}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    try {
      await page.waitFor(`window.ccToasts.includes('Saved')`, { timeout: 10000, what: 'the "Saved" toast' });
    } catch (e) {
      throw new Error(`${e.message}; toasts: ${await page.eval('JSON.stringify(window.ccToasts)')}; field: ${await page.eval(`${field}.value`)}; route: ${await page.eval('location.hash')}`);
    }
  });

  await step('the coach analyses the student’s games with Stockfish (analyze_games through the MCP server)', async () => {
    await go(page, '#/games');
    await page.waitFor(`document.querySelectorAll('table.data tbody tr').length === 4`, { what: 'games' });
    // the analysis bar is there before any game is selected
    await page.waitFor(`/Select games to analyse/.test(document.querySelector('.games-actions')?.innerText || '') && [...document.querySelectorAll('.games-actions button')].find(b => b.textContent.includes('Analyse with Stockfish'))?.disabled`, { what: 'the analysis bar, with nothing selected' });
    // typed into the coach's terminal (in the coach panel of the Board screen), as the student would
    await go(page, '#/analysis');
    await page.waitFor(`[...document.querySelectorAll('.xterm-helper-textarea')].some(t => t.offsetParent)`, { what: 'the coach panel' });
    await ask(page, 'Please analyse my games');
    await page.waitFor(`/> Please analyse my games/.test(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 15000, what: 'the request in the coach’s terminal' });
    await page.waitFor(`/analyze_games: finished, 3 games$/m.test(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 90000, what: 'the coach’s analysis result' });
    await page.waitFor(`/get_analysis_status: finished/.test(document.querySelector('.xterm-rows')?.innerText || '')`, { what: 'the analysis status' });
    // the student's 3 games (student1) have their accuracy in the list; the 4th is someone else's
    await go(page, '#/games');
    await page.waitFor(`[...document.querySelectorAll('td.acc')].filter(td => /\\d/.test(td.innerText)).length === 3`, { timeout: 30000, what: 'accuracy of the student’s 3 games' });
  });

  await step('batch analysis with Stockfish', async () => {
    await go(page, '#/games');
    await page.waitFor(`document.querySelectorAll('table.data tbody tr').length === 4`, { what: 'games' });
    await page.eval(`document.querySelector('table.data thead input[type=checkbox]').click()`);
    await page.waitFor(`document.body.innerText.includes('4 selected')`, { what: 'selection' });
    await page.eval(`(() => { const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'fast')); s.value = 'fast'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await page.click('button', 'Analyse with Stockfish');
    await page.waitFor(`[...document.querySelectorAll('td.acc')].filter(td => /\\d/.test(td.innerText)).length === 4`, { timeout: 240000, what: 'accuracy of 4 games' });
  });

  await step('the board: live analysis and the judgement of a move played on the board', async () => {
    await go(page, '#/analysis');
    await page.waitFor(`document.querySelector('.cg-wrap')`, { what: 'the board' });
    await page.click('button', 'New');
    await sleep(500);
    await page.waitFor(`/depth (1[0-9]|[2-9][0-9])/.test(document.querySelector('.engine')?.innerText || '')`, { timeout: 30000, what: 'live depth ≥ 10' });
    await page.clickSquare('.board-area .cg-wrap', 'e2');
    await page.clickSquare('.board-area .cg-wrap', 'e4');
    await page.waitFor(`document.querySelector('.judgement .tag')?.innerText`, { timeout: 30000, what: 'a move judgement' });
  });

  await step('an app button types a request; the coach reads the board', async () => {
    await page.click('.coach-input .quick button', 'Explain position');
    await page.waitFor(`/explain: Current position/.test(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 30000, what: 'the explain request' });
  });

  await step('the coach sees whether the student’s Stockfish is on, and switches it off and on again (set_engine)', async () => {
    // (on the Board, with its live analysis on)
    await ask(page, 'Please switch Stockfish off');
    await page.waitFor(`/Stockfish off/.test(document.querySelector('.engine')?.innerText || '') && !document.querySelector('.engine .switch.on') && /Your coach turned off Stockfish on the Board screen/.test(document.querySelector('.toasts')?.innerText || '')`, { timeout: 15000, what: 'Stockfish off on the board, and the toast' });
    await page.waitFor(`/engine here: off/.test(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 15000, what: 'the coach seeing it off' });
    await ask(page, 'Please switch Stockfish on');
    await page.waitFor(`/engine here: on/.test(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 15000, what: 'the coach seeing it on' });
    await page.waitFor(`document.querySelector('.engine .switch.on') && /depth [1-9]/.test(document.querySelector('.engine')?.innerText || '')`, { timeout: 30000, what: 'Stockfish on again' });
  });

  await step('a training game against Stockfish', async () => {
    await page.click('button', 'Play vs Stockfish');
    await page.waitFor(`document.querySelector('.modal')`, { what: 'the new-game dialog' });
    await page.waitFor(`!document.querySelector('.modal .btn.primary').disabled`, { what: 'levels' });
    await page.click('.modal .btn.primary', 'Start game');
    await sleep(800);
    await page.clickSquare('.board-area .cg-wrap', 'd2');
    await page.clickSquare('.board-area .cg-wrap', 'd4');
    await page.waitFor(`document.querySelectorAll('.movelist .ml-move:not(.empty)').length >= 2`, { timeout: 20000, what: 'the engine’s reply' });
    await page.click('button', 'Resign');
    await page.waitFor(`document.body.innerText.includes('You lost')`, { what: 'the result' });
  });

  await step('reports: statistics, then the coach writes the report', async () => {
    await go(page, '#/reports');
    await page.click('button', 'Report from all my analysed games');
    await page.waitFor(`document.querySelector('.stat-cards')`, { timeout: 20000, what: 'report tiles' });
    assert(/3 analysed games/.test(await text(page, '.detail')), 'the report counts the 3 games of student1');
    await page.click('button', 'Write my report');
    await page.waitFor(`/A test report written by the fake coach/.test(document.querySelector('.report-text')?.innerText || '')`, { timeout: 30000, what: 'the saved report' });
    await page.waitFor(`document.querySelector('.report-text .diagram .cg-wrap')`, { what: 'the board diagram in the report' });
  });

  await step('the coach adds a report by itself (create_report): it opens on the Reports screen, written', async () => {
    // (typed in the coach panel of the report it has just written)
    await ask(page, 'Please make me a report of all my games');
    await page.waitFor(`/create_report: Added report #\\d+/.test(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 30000, what: 'the coach’s answer' });
    await page.waitFor(`document.querySelector('.detail h1')?.innerText === 'Report by the coach' && /A report the fake coach added by itself/.test(document.querySelector('.report-text')?.innerText || '')`, { timeout: 15000, what: 'the new report, open' });
    await page.waitFor(`(l => l.length === 2 && /Report by the coach[\\s\\S]*3 games[\\s\\S]*coach report/.test(l[0].innerText) && l[0].classList.contains('active'))([...document.querySelectorAll('.report-item')])`, { what: 'the new report first in the list' });
    assert(/3 analysed games/.test(await text(page, '.detail')), 'its statistics: the 3 games of student1');
  });

  await step('openings: search, the opening’s name, and the explorer’s two tabs (Database, My games)', async () => {
    await go(page, '#/openings');
    await page.type('input[type=search]', 'najdorf');
    await page.waitFor(`document.querySelectorAll('.search-results .item').length > 0`, { what: 'search results' });
    await page.click('.search-results .item');
    await page.waitFor(`/Najdorf/.test(document.querySelector('.opening-name')?.innerText || '')`, { what: 'the opening name' });
    const tabs = await page.eval(`[...document.querySelectorAll('.explorer .tab')].map(t => t.textContent.trim())`);
    assert(JSON.stringify(tabs) === '["Database","My games"]', `the explorer's tabs: ${tabs}`);
    assert((await page.eval(`document.querySelector('.explorer .tab.active')?.textContent.trim()`)) === 'Database', 'Database is the first tab');
  });

  await step('game database: add a Scid 5 database (.si5), explore it, open a game and save it', async () => {
    await go(page, '#/openings');
    await page.click('button', 'Reset');
    await page.click('.explorer .tab', 'Database');
    await page.waitFor(`document.body.innerText.includes('Scid 5 format (.si5)')`, { what: 'the card to add a database' });
    await page.click('button', 'Add a database');
    await page.waitFor(`document.querySelector('.gdb .ex-table tbody tr')`, { timeout: 120000, what: 'the explorer of the added database' });
    const std = dbGames.filter(g => !g.fen && g.result !== '*');
    const total = await page.eval(`document.querySelector('.gdb-total span').innerText`);
    assert(total.startsWith(`${std.length.toLocaleString('en-US')} games`), `the start position: ${total}`);
    const e4 = std.filter(g => g.line[0].san === 'e4').length;
    const rows = await page.eval(`[...document.querySelectorAll('.gdb .ex-table tbody tr')].map(r => [...r.cells].slice(0, 2).map(c => c.innerText))`);
    assert(rows.some(([san, n]) => san === 'e4' && Number(n.replace(/\D/g, '')) === e4), `1.e4 in ${e4} games: ${JSON.stringify(rows)}`);
    assert(/Test Base · 342 games/.test(await text(page, '.gdb-foot')), 'the name and size');
    assert(existsSync(ENV.PLYMENTOR_PICK_FILE), 'the database files stay where they are');
    // a move of the table goes on the board and the explorer follows
    await page.click('.gdb .ex-table tbody tr', 'd4');
    await page.waitFor(`[...document.querySelectorAll('.gdb .ex-table tbody tr')].some(r => r.cells[0].innerText === 'd5')`, { what: 'the moves after 1.d4' });
    // a top game opens on the board, at this position, and can be saved to the student's games
    await page.click('.gdb-game');
    await page.waitFor(`location.hash.startsWith('#/analysis?dbgame=') && [...document.querySelectorAll('.tab')].some(t => t.textContent.trim() === 'Game') && document.querySelector('.ml-move.active')?.textContent.includes('d4')`, { timeout: 20000, what: 'the game on the board, at 1.d4' });
    await page.click('.tab', 'Game');
    await page.waitFor(`document.body.innerText.includes('A game from your game database Test Base')`, { what: 'the game tab' });
    await page.click('button', 'Save to my games');
    await page.waitFor(`location.hash.startsWith('#/analysis?game=')`, { timeout: 20000, what: 'the saved game' });
    await go(page, '#/settings');
    await page.waitFor(`/Game database[\\s\\S]*Test Base[\\s\\S]*342 games[\\s\\S]*read from/.test(document.body.innerText)`, { what: 'the database in Settings' });
  });

  await step('the coach takes the student to the Openings screen and plays an opening out from the start; evaluations; the move list scrolls in its own panel', async () => {
    await go(page, '#/analysis');
    await page.waitFor(`[...document.querySelectorAll('.coach-input .quick button')].some(b => b.textContent.includes('Best plan?'))`, { what: 'the coach panel on the board' });
    // every move the Openings board shows from now on (the coach's line is played out one move at a time)
    await page.eval(`(() => { window.ccShown = []; new MutationObserver(() => { const a = document.querySelector('.panel.moves .movelist .active')?.textContent; if (a && window.ccShown.at(-1) !== a) window.ccShown.push(a); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); return true; })()`);
    await page.click('.coach-input .quick button', 'Best plan?');
    await page.waitFor(`location.hash === '#/openings' && [...document.querySelectorAll('.side-col:not(.middle) .tab.active')].some(t => t.textContent === 'Coach')`, { timeout: 30000, what: 'the Openings screen with the coach next to the board (switch_screen)' });
    await page.waitFor(`/The English Attack/.test(document.querySelector('.board-caption')?.innerText || '')`, { timeout: 30000, what: 'the end of the line' });
    try {
      await page.waitFor(`(t => /switched: ok/.test(t) && /opening shown: ok/.test(t))(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 5000, what: 'the answers of switch_screen and set_board' });
    } catch (e) {
      // (the terminal shows the newest lines: it follows the output after moving to the Openings screen's panel)
      throw new Error(`${e.message}; the terminal ends with: ${JSON.stringify((await term(page)).slice(-240))}`);
    }
    const shown = await page.eval('window.ccShown');
    const from = shown.indexOf('e4');
    assert(from >= 0 && shown.at(-1) === 'b4' && shown.length - from >= 20, `played out from 1. e4: ${shown.join(' ')}`);
    assert((await page.eval(`document.querySelectorAll('.panel.moves .movelist .ml-move:not(.empty)').length`)) === 24, 'the 24 moves are the main line');
    // evaluations: the bar next to the board and Stockfish's lines
    await page.waitFor(`document.querySelector('.board-area .eval-bar') && /depth [1-9]/.test(document.querySelector('.side-col.middle .engine')?.innerText || '')`, { timeout: 30000, what: 'the evaluation' });
    // the long move list scrolled inside its panel; the window did not move
    const scroll = await page.eval(`({ main: document.querySelector('main').scrollTop, page: document.scrollingElement.scrollTop, list: document.querySelector('.panel.moves .panel-body').scrollTop, board: document.querySelector('.board-area').getBoundingClientRect().top })`);
    assert(scroll.main === 0 && scroll.page === 0 && scroll.list > 0 && scroll.board > 0, `scrolling: ${JSON.stringify(scroll)}`);
    // back to the starting position, and into another line from there
    await page.click('.board-controls button', '⏮');
    await page.waitFor(`!document.querySelector('.panel.moves .movelist .active') && /Starting position/.test(document.querySelector('.opening-name')?.innerText || '')`, { what: 'the starting position' });
    await page.clickSquare('.board-area .cg-wrap', 'd2');
    await page.clickSquare('.board-area .cg-wrap', 'd4');
    await page.waitFor(`document.querySelector('.panel.moves .movelist .active')?.textContent.includes('d4')`, { what: 'another line' });
    const after = await page.eval(`({ main: document.querySelector('main').scrollTop, moves: document.querySelectorAll('.panel.moves .movelist .ml-move:not(.empty)').length })`);
    assert(after.main === 0 && after.moves === 24, `afterwards: ${JSON.stringify(after)}`);
  });

  await step('train: exercises — the one on the board highlighted in the deck, the ones done marked', async () => {
    await go(page, '#/train');
    await page.waitFor(`document.body.innerText.includes('Generate from my games')`, { what: 'exercises' });
    // (the coach's terminal moves into this screen's panel once the screen is there)
    await page.waitFor(`[...document.querySelectorAll('.xterm-helper-textarea')].some(t => t.offsetParent)`, { what: 'the coach panel' });
    await ask(page, 'Please make me two exercises');
    await page.waitFor(`/create_exercise: ok ok/.test(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 30000, what: 'the coach’s answer' });
    const item = name => `[...document.querySelectorAll('.ex-list .item')].find(i => i.innerText.includes(${JSON.stringify(name)}))`;
    await page.waitFor(`document.querySelectorAll('.ex-list .item').length === 2 && ${item('Back rank')}?.classList.contains('active')`, { timeout: 15000, what: 'the first exercise on the board, highlighted' });
    assert((await page.eval(`document.querySelectorAll('.ex-list .item.active, .ex-list .item.done').length`)) === 1, 'one highlighted, none done yet');
    // solved: marked done at once, still highlighted while it is on the board
    await page.clickSquare('.board-area .cg-wrap', 'd1');
    await page.clickSquare('.board-area .cg-wrap', 'd8');
    await page.waitFor(`/Correct/.test(document.querySelector('.feedback')?.innerText || '')`, { timeout: 15000, what: 'the answer checked' });
    await page.waitFor(`(i => i.classList.contains('active') && i.classList.contains('done') && /✓ Done/.test(i.innerText))(${item('Back rank')})`, { what: 'the solved exercise marked done' });
    // the next one: highlighted in its turn
    await page.click('button', 'Next exercise');
    await page.waitFor(`${item('Queen')}.classList.contains('active') && !${item('Back rank')}.classList.contains('active') && /✓ Done/.test(${item('Back rank')}.innerText) && !/Done/.test(${item('Queen')}.innerText)`, { what: 'the second exercise highlighted, the first still done' });
  });

  await step('book reader: an EPUB and a PDF added, read aloud, the board plays the moves, the student’s own move, a move clicked, the place kept', async () => {
    const dir = join(TMP, 'e2e-books');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await makeEpub(join(dir, 'test-book.epub'));
    makePdf(join(dir, 'test-book.pdf'));
    await go(page, '#/books');
    await page.waitFor(`document.body.innerText.includes('No books yet')`, { what: 'the empty book list' });
    await page.setFiles('input[type=file][accept*=".epub"]', [join(dir, 'test-book.epub'), join(dir, 'test-book.pdf')]);
    await page.waitFor(`document.querySelectorAll('.book-card').length === 2 && document.querySelector('.book-cover img')`, { timeout: 30000, what: 'the two books, with a cover' });
    // a stand-in for the voice: nothing is said out loud, every part "takes" 100 ms
    await page.eval(`(() => { window.ccSaid = []; speechSynthesis.speak = u => { window.ccSaid.push(u.text); setTimeout(() => u.onend?.(), 100); }; speechSynthesis.cancel = () => {}; return true; })()`);
    const active = `(document.querySelector('.book-side .movelist .active')?.innerText || '')`; // (in brackets: compared with ===)
    await page.click('.book-card', 'EPUB');
    await page.waitFor(`document.querySelectorAll('.bk-flow .bk-m').length === 36`, { timeout: 30000, what: 'the 36 moves marked on the EPUB page' });
    assert(!(await page.eval(`!!document.querySelector('.bk-flow :is(script, style, a, [onclick], [style*="red"])')`)), 'nothing of the book’s own markup on the page');
    await page.click('.book-play');
    await page.waitFor(`window.ccSaid.includes('11. bishop takes f6')`, { timeout: 20000, what: 'the reading' });
    await page.waitFor(`/Bxf6|Nxf6|g5|Nd7|f5/.test(${active})`, { what: 'the board following the reading' });
    await page.waitFor(`window.ccSaid.includes('White wants the d5 square for a knight.')`, { what: 'a sentence with a square in it, said at once' });
    // ← while it reads: the reading pauses, the board one move back; → on again, ← back, the reading still waiting
    await page.press('ArrowLeft');
    await page.waitFor(`!document.querySelector('.book-play').innerText.includes('Pause')`, { what: 'the reading paused by ←' });
    const back = JSON.stringify(await page.eval(active));
    await page.press('ArrowRight');
    await page.waitFor(`${active} !== ${back}`, { what: 'a move on (→)' });
    await page.press('ArrowLeft');
    await page.waitFor(`${active} === ${back}`, { what: 'a move back again (←)' });
    const saidSoFar = await page.eval('window.ccSaid.length');
    await sleep(600);
    assert((await page.eval('window.ccSaid.length')) === saidSoFar && (await page.eval(`document.querySelector('.book-play').innerText`)).includes('Continue'), 'the reading waiting while the student goes through the moves');
    const said = await page.eval('window.ccSaid.slice(0, 6)');
    assert(JSON.stringify(said) === '["The Najdorf","Game 1","1. e4","c5","2. knight to f3","d6"]', `said: ${JSON.stringify(said)}`);
    // Stockfish on the reader's board: its evaluation bar and its lines (the Book reader's own switch)
    await page.waitFor(`document.querySelector('.book-side .board-area .eval-bar') && /depth [1-9]/.test(document.querySelector('.book-side .book-engine')?.innerText || '')`, { timeout: 30000, what: 'Stockfish on the reader’s board' });
    // a move of the student's own on the board: the reading pauses; ▶ Continue reads on, and the board keeps the
    // student's move until the reading plays the book's next one (a part "takes" 1.5 s here, to look in between)
    await page.eval(`([...document.querySelectorAll('.bk-flow .bk-m')].find(e => e.textContent === '12.g5').click(), true)`);
    await page.waitFor(`${active} === 'g5'`, { what: '12.g5 on the board' });
    await page.eval(`(() => { window.ccSaid = []; speechSynthesis.speak = u => { window.ccSaid.push(u.text); setTimeout(() => u.onend?.(), 1500); }; return true; })()`);
    await page.click('.book-play');
    await page.waitFor(`window.ccSaid.length === 1`, { what: 'the reading after 12.g5' });
    await page.clickSquare('.book-side .board-area .cg-wrap', 'b5');
    await page.clickSquare('.book-side .board-area .cg-wrap', 'b4');
    await page.waitFor(`${active} === 'b4' && document.querySelector('.book-play').innerText.includes('Continue')`, { what: 'the student’s move on the board, the reading paused' });
    await sleep(2000);
    assert((await page.eval('window.ccSaid.length')) === 1 && (await page.eval(active)) === 'b4', 'nothing more read, the student’s move still on the board');
    // ← and → through the student's move and the book's before it, then on again to the student's move
    await page.press('ArrowLeft');
    await page.waitFor(`${active} === 'g5'`, { what: 'the book’s move before the student’s (←)' });
    await page.press('ArrowLeft');
    await page.waitFor(`${active} === 'Nxf6'`, { what: 'one more move back (←)' });
    await page.press('ArrowRight');
    await page.press('ArrowRight');
    await page.waitFor(`${active} === 'b4' && document.querySelector('.book-play').innerText.includes('Continue')`, { what: 'on again to the student’s move (→ →)' });
    await page.click('.book-play');
    await page.waitFor(`window.ccSaid.length === 2`, { what: 'the reading going on' });
    assert((await page.eval(active)) === 'b4', 'the student’s move on the board until the book’s next move');
    await page.waitFor(`${active} === 'Nd7'`, { timeout: 5000, what: 'the book’s next move on the board' });
    await page.click('.book-play');
    const again = await page.eval('window.ccSaid.slice(0, 2)');
    assert(again[0] === again[1] && /d7/.test(again[0]), `the part it stopped in, said again: ${JSON.stringify(again)}`);
    await page.eval(`(speechSynthesis.speak = u => { window.ccSaid.push(u.text); setTimeout(() => u.onend?.(), 100); }, true)`);
    // a move clicked on the page: the board shows it; the reading goes on after it (and is kept)
    await page.eval(`([...document.querySelectorAll('.bk-flow .bk-m')].find(e => e.textContent === '10.Bd3').click(), true)`);
    await page.waitFor(`${active} === '10.Bd3'`, { what: 'the variation’s move on the board' }); // (a variation's move: with its number)
    await sleep(500); // (the page marks the new sentence a moment after the board shows the move)
    const at = await page.waitFor(`document.querySelector('.bk-flow .bk-cur')?.textContent`, { what: 'the sentence after it' });
    await go(page, '#/books');
    await page.waitFor(`/EPUB · 3 chapters · \\d+% read/.test(document.querySelector('.book-grid')?.innerText || '')`, { what: 'the share read' });
    await page.click('.book-card', 'EPUB');
    await page.waitFor(`document.querySelector('.bk-flow .bk-cur')?.textContent === ${JSON.stringify(at)}`, { timeout: 20000, what: 'the place kept' });
    // its diagram, a picture of a board (merida pieces on coloured squares): read — the position after 15...Bf8 —, clicked
    await page.waitFor(`document.querySelectorAll('.bk-flow .bk-figure[data-d]').length === 1 && !document.querySelector('.bk-flow .bk-figure.unread')`, { timeout: 30000, what: 'the EPUB’s diagram, read' });
    await page.eval(`(document.querySelector('.bk-flow .bk-figure[data-d]').click(), true)`);
    await page.waitFor(`${active} === 'Bf8' && document.querySelector('.bk-flow .bk-figure.bk-shown')`, { what: 'the diagram’s position on the board, marked on the page' });
    // a game in descriptive notation (chapter 3): its moves marked, read aloud as the board plays them, through its
    // diagram (cburnett pieces on grey squares) to the moves after it
    await page.eval(`(s => (s.value = '2', s.dispatchEvent(new Event('change', { bubbles: true })), true))(document.querySelector('.book-chapters'))`);
    await page.waitFor(`document.querySelectorAll('.bk-flow .bk-m').length === 22 && document.querySelector('.bk-flow .bk-figure[data-d]:not(.unread)')`, { timeout: 30000, what: 'the 22 moves of the old game marked, its diagram read' });
    await page.eval(`(window.ccSaid = [], true)`);
    await page.click('.book-play');
    await page.waitFor(`window.ccSaid.includes('9. h3')`, { timeout: 30000, what: 'the reading past the diagram' });
    await page.waitFor(`/h3|Na5|Bc2|c5|d4|Qc7/.test(${active})`, { what: 'the board playing the moves after the diagram' });
    await page.click('.book-play');
    const old = await page.eval('window.ccSaid.slice(0, 8)');
    assert(JSON.stringify(old) === '["An Old Game","Game 3","1. e4","e5","2. knight to f3","knight to c6","3. bishop to b5","a6"]', `said: ${JSON.stringify(old)}`);
    // the PDF: its text over the page, the moves marked, a sentence clicked
    await go(page, '#/books');
    await page.waitFor(`document.querySelectorAll('.book-card').length === 2`, { what: 'the books' });
    await page.click('.book-card', 'PDF');
    await page.waitFor(`document.querySelectorAll('.bk-pdf .textLayer .bk-m').length === 36`, { timeout: 30000, what: 'the 36 moves marked on the PDF page' });
    await page.eval(`([...document.querySelectorAll('.bk-pdf .textLayer [data-s]')].find(e => e.textContent.includes('White wants')).click(), true)`);
    await page.waitFor(`/White wants/.test([...document.querySelectorAll('.bk-pdf .bk-cur')].map(e => e.textContent).join(''))`, { what: 'the sentence clicked' });
    await page.waitFor(`${active} === 'f5'`, { what: 'the position before it on the board' });
    await page.press('ArrowRight', { shift: true });
    await page.waitFor(`/Black can also consider/.test([...document.querySelectorAll('.bk-pdf .bk-cur')].map(e => e.textContent).join(''))`, { what: 'the next sentence (Shift + →)' });
    await page.click('.book-head button', 'Fit width');
    await page.waitFor(`document.querySelector('.book-page.bk-wide') && document.querySelector('.bk-sheet').offsetWidth > document.querySelector('.book-page').clientWidth * 0.9`, { what: 'the page as wide as the panel' });
    // a size of the student's (the slider: 150% of the panel's width, the page scrolling both ways), then the whole page
    await page.eval(`(s => (s.value = '150', s.dispatchEvent(new Event('input', { bubbles: true })), true))(document.querySelector('.book-zoom input[type=range]'))`);
    await page.waitFor(`document.querySelector('.book-page.bk-zoom') && document.querySelector('.book-zoom-pct')?.textContent === '150%' && document.querySelector('.bk-sheet').offsetWidth > document.querySelector('.book-page').clientWidth * 1.3`, { what: 'the page at 150% of the panel’s width' });
    await page.click('.book-head button', 'Whole page');
    await page.waitFor(`!document.querySelector('.book-page.bk-zoom') && !document.querySelector('.book-page.bk-wide') && document.querySelector('.bk-sheet').offsetHeight <= document.querySelector('.book-page').clientHeight`, { what: 'the whole page again' });
    // a page by its number: g puts the cursor in the page box, the number typed, then Enter
    await page.press('g');
    await page.waitFor(`document.activeElement?.classList.contains('book-page-no')`, { what: 'the page box (g)' });
    await page.keyboard('3', { enter: true });
    await page.waitFor(`document.querySelector('.book-page-no').value === '3' && document.activeElement !== document.querySelector('.book-page-no') && /An Old Game/.test(document.querySelector('.bk-pdf .textLayer')?.textContent || '')`, { timeout: 20000, what: 'page 3, gone to by its number' });
  });

  await step('book reader: a scanned PDF — its words read by OCR, its hatched diagrams found and read, the board showing them', async () => {
    const dir = join(TMP, 'e2e-books');
    await makeScannedPdf(join(dir, 'scanned-book.pdf'));
    await go(page, '#/books');
    await page.waitFor(`document.querySelectorAll('.book-card').length === 2`, { what: 'the books' });
    await page.setFiles('input[type=file][accept*=".epub"]', [join(dir, 'scanned-book.pdf')]);
    await page.waitFor(`document.querySelectorAll('.book-card').length === 3`, { timeout: 30000, what: 'the scanned book' });
    await page.click('.book-card', 'Scanned');
    const active = `(document.querySelector('.book-side .movelist .active')?.innerText || '')`; // (in brackets: compared with ===)
    // its text: Tesseract's words over the picture, the moves marked (read right, though the OCR takes a 5 for an s)
    await page.waitFor(`document.querySelectorAll('.bk-pdf .textLayer.bk-ocr .bk-m').length >= 13`, { timeout: 120000, what: 'the moves of the scanned page, read by OCR' });
    const words = await page.eval(`document.querySelector('.bk-pdf .textLayer.bk-ocr').innerText.replace(/\\s+/g, ' ')`);
    assert(/The pieces stand like this at the start/.test(words) && /Ruy Lopez/.test(words), `the page's words: ${words.slice(0, 200)}`);
    // its two diagrams, read: the second one is the position the moves above it reached
    await page.waitFor(`document.querySelectorAll('.bk-diagram').length === 2 && !document.querySelector('.bk-diagram.unread')`, { timeout: 30000, what: 'the two diagrams, read' });
    await page.eval(`(document.querySelectorAll('.bk-diagram')[1].click(), true)`);
    await page.waitFor(`${active} === 'a6' && document.querySelector('.bk-diagram.bk-shown') === document.querySelectorAll('.bk-diagram')[1]`, { what: 'the diagram’s position on the board, marked on the page' });
    // the diagram set right on the board editor (a piece taken away): the board shows it, and it is kept with the book
    const onBoard = sq => `[...document.querySelectorAll('.book-side .board-area cg-board piece')].some(p => p.cgKey === '${sq}')`;
    await page.click('.book-controls button', 'Fix diagram');
    await page.waitFor(`document.querySelectorAll('.board-editor cg-board piece').length >= 30`, { what: 'the board editor with the diagram’s pieces' });
    await page.click('.board-editor button', 'Remove');
    await page.clickSquare('.board-editor .cg-wrap', 'h2');
    await page.waitFor(`![...document.querySelectorAll('.board-editor cg-board piece')].some(p => p.cgKey === 'h2')`, { what: 'the h2 pawn taken away' });
    await page.click('.board-editor button', 'Save the position');
    await page.waitFor(`!document.querySelector('.board-editor') && ${onBoard('g2')} && !${onBoard('h2')}`, { timeout: 15000, what: 'the position as set, on the board' });
    await go(page, '#/books');
    await page.waitFor(`document.querySelectorAll('.book-card').length === 3`, { what: 'the books' });
    await page.click('.book-card', 'Scanned');
    await page.waitFor(`document.querySelectorAll('.bk-diagram').length === 2 && !document.querySelector('.bk-diagram.unread')`, { timeout: 60000, what: 'the scanned book again' });
    await page.eval(`(document.querySelectorAll('.bk-diagram')[1].click(), true)`);
    await page.waitFor(`${onBoard('g2')} && !${onBoard('h2')}`, { what: 'the position set right, kept with the book' });
    // read aloud from the start: the board shows the first diagram, then plays the moves (3.Bbs said as bishop to b5)
    await page.eval(`(window.ccSaid = [], true)`);
    await page.eval(`([...document.querySelectorAll('.bk-pdf .textLayer [data-s]')].find(e => e.textContent.includes('Scanned')).click(), true)`);
    await page.click('.book-play');
    await page.waitFor(`window.ccSaid.includes('3. bishop to b5')`, { timeout: 20000, what: 'a move read by OCR, said right' });
    await page.waitFor(`/Bb5|a6|Ba4/.test(${active})`, { what: 'the board playing the moves after the diagram' });
    await page.click('.book-play');
    const said = await page.eval('window.ccSaid.slice(0, 4)');
    assert(JSON.stringify(said) === '["Scanned Test Book","The pieces stand like this at the start:","1. e4","e5"]', `said: ${JSON.stringify(said)}`);
  });

  await step('settings: the coach’s notes, the coach programs, the data folder; no move comments, Lichess token or 1.x import', async () => {
    await go(page, '#/settings');
    await page.waitFor(`[...document.querySelectorAll('textarea')].some(t => /Najdorf/.test(t.value))`, { timeout: 20000, what: 'the notes in Settings' });
    await page.waitFor(`/Installed \\(9\\.9\\.9\\)/.test(document.body.innerText)`, { timeout: 20000, what: 'the CLI status' });
    await sleep(1500); // (the 1.x card, when there was one, came once the coach host had looked for the old data)
    const body = await page.eval('document.body.innerText');
    assert(body.includes(HOME), 'the data folder is shown');
    assert(/Not installed — Plymentor can install Codex CLI with OpenAI's official installer/.test(body), 'the other coaches can be installed');
    const comments = await page.eval(`[...document.querySelectorAll('label.field')].find(l => l.querySelector('span')?.textContent === 'Automatic move comments')?.querySelector('select')?.value`);
    assert(comments === 'off', `automatic move comments are off by default: ${comments}`);
    assert(!/Chess Coach 1\.x/.test(body) && !/Bring my 1\.x data over/.test(body), 'no 1.x import (although there is 1.x data in the test’s old folder)');
    assert(!/Lichess \(optional\)/.test(body) && !(await page.eval(`!!document.querySelector('input[placeholder="lip_…"]')`)), 'no Lichess token');
    const credit = await page.eval(`(img => img && img.complete && img.naturalWidth > 0)(document.querySelector('.studio-credit img'))`);
    assert(credit, 'the Studio Nox logo is shown');
    assert(new RegExp(`made by[\\s\\S]*Plymentor ${APP_VERSION.replaceAll('.', '\\.')}`, 'i').test(body), 'the credit and the version');
  });

  await step('About Plymentor: its own window with the version and the Studio Nox logo, the licences and the AGPL text', async () => {
    await page.click('.studio-credit a', 'About');
    const about = await app.window('app://plymentor/about.html');
    let licence;
    try {
      await about.waitFor(`document.querySelector('.version')?.textContent === 'Version ${APP_VERSION}'`, { what: 'the version' });
      assert((await about.eval('document.title')) === 'About Plymentor', 'the title');
      await about.waitFor(`(img => img && img.complete && img.naturalWidth > 0)(document.querySelector('img.studio'))`, { what: 'the Studio Nox logo' });
      assert(/no warranty/.test(await about.eval('document.body.innerText')), 'the About window says: no warranty');
      await about.click('a', 'Licences');
      await about.waitFor(`location.pathname.startsWith('/licenses') && document.body.innerText.includes('Studio Nox — is free software') && /without any warranty/.test(document.body.innerText)`, { what: 'the licences page' });
      assert(!/BY-NC|non-commercial/i.test(await about.eval('document.body.innerText')), 'nothing under a non-commercial licence');
      // the licence's full text, shipped with the app
      await about.click('a', 'full text');
      licence = await app.window('app://plymentor/LICENSE.txt');
      await licence.waitFor(`document.body.innerText.includes('GNU AFFERO GENERAL PUBLIC LICENSE') && document.body.innerText.includes('Version 3, 19 November 2007')`, { what: 'the AGPL text' });
      await licence.eval('(window.close(), true)').catch(() => {});
      await about.eval('(window.close(), true)').catch(() => {});
    } finally {
      about.ws?.close();
      licence?.ws?.close();
    }
    assert((await page.eval('document.querySelector(".topbar") ? 1 : 0')) === 1, 'the main window is still there');
  });

  let backup;
  await step('back up the games database, delete games, restore the backup', async () => {
    await go(page, '#/settings');
    await page.click('button', 'Back up my games');
    for (let i = 0; i < 100 && !backup; i++) {
      backup = readdirSync(DOWNLOADS).find(f => /^plymentor-backup-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f));
      await sleep(200);
    }
    assert(backup, 'the backup file was saved');
    await sleep(500); // the download finishes writing
    const bytes = readFileSync(join(DOWNLOADS, backup));
    assert(bytes.subarray(0, 15).toString() === 'SQLite format 3', 'a SQLite file');
    await go(page, '#/games');
    await page.waitFor(`document.querySelectorAll('table.data tbody tr').length === 5`, { what: '4 + 1 (from the database) games' });
    await page.eval(`(window.confirm = () => true, document.querySelector('table.data tbody input[type=checkbox]').click(), true)`);
    await page.click('button.danger', 'Delete');
    await page.waitFor(`document.querySelectorAll('table.data tbody tr').length === 4`, { what: 'one game deleted' });
    await go(page, '#/settings');
    await page.waitFor(`document.querySelector('input[type=file][accept=".sqlite,.db"]')`, { what: 'the restore input' });
    await page.eval(`(window.confirm = () => true, window.ccBeforeRestore = true)`);
    await page.setFiles('input[type=file][accept=".sqlite,.db"]', [join(DOWNLOADS, backup)]);
    // the window reloads with the restored database
    await page.waitFor(`!window.ccBeforeRestore && !!document.querySelector('.topbar .nav')`, { timeout: 60000, what: 'the reloaded window' });
    await go(page, '#/games');
    await page.waitFor(`document.querySelectorAll('table.data tbody tr').length === 5`, { timeout: 30000, what: 'the 5 games of the backup' });
    await page.waitFor(`/Claude Code: (ready|working|starting)/.test(document.querySelector('.status-pills').innerText)`, { timeout: 30000, what: 'the coach after the reload' });
  });

  if (process.env.E2E_VOICE) {
    await step('natural voice: download (~90 MB) and speak', async () => {
      await go(page, '#/settings');
      await page.click('button', 'Download the natural voice');
      await page.waitFor(`document.body.innerText.includes('Downloaded')`, { timeout: 600000, interval: 2000, what: 'the voice download' });
      await page.click('button', 'Test the voice');
      await sleep(4000);
    });
  }

  if (process.env.E2E_ONLINE) {
    await step('download games from Lichess', async () => {
      await go(page, '#/games');
      await page.eval(`(() => { if (!document.querySelector('.card .dropzone')) [...document.querySelectorAll('button')].find(b => b.textContent.includes('Import games')).click(); return true; })()`);
      await page.waitFor(`document.querySelector('.card .dropzone')`, { what: 'the import panel' });
      await page.eval(`(() => { const i = [...document.querySelectorAll('.card input[type=text]')].find(x => x.placeholder === 'Username'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'DrNykterstein'); i.dispatchEvent(new Event('input', { bubbles: true })); const n = document.querySelector('.card input[type=number]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(n, '5'); n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      const before = await gameRows(page);
      await page.click('button', 'Download');
      await page.waitFor(`document.querySelectorAll('table.data tbody tr').length > ${before}`, { timeout: 60000, what: 'Lichess games more' });
    });
  }

  const errorsOf = p => [...p.console.filter(c => c.type === 'error' || c.type === 'log-error'), ...p.errors.map(e => ({ text: e }))];
  await step('no console errors in the window', async () => {
    const bad = errorsOf(page);
    assert(!bad.length, JSON.stringify(bad.slice(0, 8), null, 1));
  });

  await step('closing the window closes the games database and the coach, and the app ends', async () => {
    await page.eval(`(window.close(), true)`).catch(() => {});
    const code = await app.waitForExit(20000);
    assert(code === 0, `exit code ${code}`);
    const logText = readFileSync(join(HOME, 'logs', 'plymentor.log'), 'utf8');
    assert(/closing the coach sessions/.test(logText), 'the coach sessions were closed');
  });

  await step('starting again: the games, the analyses and the settings are still there', async () => {
    app = await launch();
    page = app.page;
    await appReady(page);
    await go(page, '#/games');
    await page.waitFor(`document.querySelectorAll('table.data tbody tr').length === 5`, { timeout: 30000, what: 'the 5 games' });
    await page.waitFor(`[...document.querySelectorAll('td.acc')].filter(td => /\\d/.test(td.innerText)).length === 4`, { what: 'their analyses' });
    const settings = await page.eval(`document.querySelector('.status-pills').innerText`);
    assert(/Claude Code/.test(settings), settings);
    await go(page, '#/openings');
    await page.waitFor(`document.querySelector('.gdb .ex-table tbody tr')`, { timeout: 30000, what: 'the database, still added after the restart' });
  });

  await step('one running copy: starting it again only brings the window to the front', async () => {
    const env = { ...process.env, ...ENV };
    delete env.ELECTRON_RUN_AS_NODE;
    const t0 = Date.now();
    const second = spawn(EXE, ARGS, { env, stdio: 'ignore' });
    // (the portable .exe unpacks itself first: give it time)
    const code = await new Promise(resolve => {
      const t = setTimeout(() => resolve('still running'), 60000);
      second.on('exit', c => (clearTimeout(t), resolve(c)));
    });
    if (code === 'still running') execFileSync('taskkill', ['/PID', String(second.pid), '/T', '/F'], { stdio: 'ignore' });
    assert(code === 0, `the second copy: ${code}`);
    log(`  (the second copy ended after ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    assert((await page.eval('document.querySelector(".topbar") ? 1 : 0')) === 1, 'the first window still works');
  });

  await step('no console errors after the restart', async () => {
    const bad = errorsOf(page);
    assert(!bad.length, JSON.stringify(bad.slice(0, 8), null, 1));
  });

  const bar = () => page.eval(`document.querySelector('.update-bar')?.innerText || ''`);
  await step('updates: Plymentor asks (a stand-in for) GitHub, sends nothing about the student, and is up to date', async () => {
    await go(page, '#/settings');
    await page.waitFor(`[...document.querySelectorAll('.card h2')].some(h => h.textContent === 'Updates')`, { what: 'Settings → Updates' });
    await page.eval(`(() => { window.ccToasts = []; new MutationObserver(() => document.querySelectorAll('.toasts .toast').forEach(t => window.ccToasts.push(t.textContent))).observe(document.querySelector('.toasts'), { childList: true, subtree: true, characterData: true }); return true; })()`);
    await page.click('button', 'Check for updates');
    await page.waitFor(`window.ccToasts.some(t => t.includes('Plymentor ${APP_VERSION} is the newest version'))`, { timeout: 30000, what: 'the "newest version" toast' });
    const asked = updates.github.requests;
    assert(asked.some(r => r.path.endsWith('/releases.atom')) && asked.some(r => r.path.endsWith(`/v${APP_VERSION}/latest.yml`)), `what was asked: ${asked.map(r => r.path).join(', ')}`);
    assert(asked.every(r => !r.headers.authorization && !r.headers.cookie), 'no token, no cookies');
    assert(asked.every(r => !r.headers['x-user-staging-id'] || r.headers['x-user-staging-id'] === '00000000-0000-0000-0000-000000000000'), 'no identifier of this installation');
    assert(!(await bar()), 'no update offered');
  });

  await step('updates: a release signed with another key is not offered', async () => {
    await updates.publish(updates.otherKey);
    await page.click('button', 'Check for updates');
    await page.waitFor(`window.ccToasts.some(t => /could not look for updates: .*Studio Nox’s key/.test(t))`, { timeout: 30000, what: 'the refusal' });
    assert(!(await bar()), 'no update offered');
    assert(!updates.github.sent.has(setupName(NEXT)) && !updates.github.sent.has(portableName(NEXT)), 'nothing downloaded');
  });

  await step(`updates: ${NEXT} is offered; on the student's yes ${PORTABLE ? 'the new .exe' : 'only its changed parts'} downloaded and checked, the games backed up, and the ${PORTABLE ? 'new .exe started' : 'installer started'} as Plymentor closes`, async () => {
    await updates.publish(updates.key);
    await page.click('button', 'Check for updates');
    await page.waitFor(`/Plymentor ${NEXT.replaceAll('.', '\\.')} is available/.test(document.querySelector('.update-bar')?.innerText || '')`, { timeout: 30000, what: 'the update bar' });
    // the notes of the signed release (not the feed's)
    await page.click('.update-bar button', 'What’s new');
    await page.waitFor(`/something better/.test(document.querySelector('.update-notes')?.innerText || '')`, { what: 'the release notes' });
    assert(!updates.github.sent.has(setupName(NEXT)) && !updates.github.sent.has(portableName(NEXT)), 'nothing downloaded before the student says so');
    await page.click('.update-bar button', PORTABLE ? 'Download' : 'Update');
    await page.waitFor(`/is (ready|downloaded)/.test(document.querySelector('.update-bar')?.innerText || '')`, { timeout: 60000, what: 'the downloaded update' });
    const sent = updates.github.sent;
    if (PORTABLE) assert(sent.get(portableName(NEXT)) === statSync(updates.files.portable).size, `the new .exe: ${sent.get(portableName(NEXT))} bytes`);
    else {
      const full = statSync(updates.files.setup).size;
      const got = sent.get(setupName(NEXT)) || 0;
      assert(got > 0 && got < full / 4, `only the changed parts of the installer: ${got} of ${full} bytes`);
      assert(/To download: /.test(readFileSync(join(HOME, 'logs', 'plymentor.log'), 'utf8')), 'a differential download in the log');
    }
    const bad = errorsOf(page);
    assert(!bad.length, JSON.stringify(bad.slice(0, 8), null, 1));
    rmSync(join(HOME, 'update-test-install.json'), { force: true });
    await page.click('.update-bar button', PORTABLE ? 'Start it now' : 'Restart and update');
    const code = await app.waitForExit(30000);
    assert(code === 0, `exit code ${code}`);
    const run = JSON.parse(readFileSync(join(HOME, 'update-test-install.json'), 'utf8'));
    assert(sha256(run.file) === sha256(PORTABLE ? updates.files.portable : updates.files.setup), `the signed file: ${run.file}`);
    if (PORTABLE) assert(run.args.length === 1 && /^--replacing=\d+$/.test(run.args[0]), `the new .exe's arguments: ${run.args}`);
    else assert(JSON.stringify(run.args) === '["--updated","/S","--force-run"]', `the installer's arguments: ${run.args}`);
    const backups = readdirSync(join(HOME, 'backups'));
    assert(backups.length === 1 && new RegExp(`^plymentor-${APP_VERSION}-before-${NEXT}-\\d{4}-\\d{2}-\\d{2}\\.sqlite$`).test(backups[0]), `the backup: ${backups}`);
    assert(readFileSync(join(HOME, 'backups', backups[0])).subarray(0, 15).toString() === 'SQLite format 3', 'a SQLite file');
  });

  await step('starting again: the games are there, and the downloaded update is ready again', async () => {
    app = await launch();
    page = app.page;
    await appReady(page);
    await go(page, '#/games');
    await page.waitFor(`document.querySelectorAll('table.data tbody tr').length === 5`, { timeout: 30000, what: 'the 5 games' });
    // (the check 15 s after the start finds the download of before)
    await page.waitFor(`/is (ready|downloaded)/.test(document.querySelector('.update-bar')?.innerText || '')`, { timeout: 60000, what: 'the update, ready' });
    const bad = errorsOf(page);
    assert(!bad.length, JSON.stringify(bad.slice(0, 8), null, 1));
  });

  if (!PORTABLE)
    await step('the first start after an update, with the installer still finishing: the window opens and says so, and the installer goes once it has quit', async () => {
      // (removing the installer as the app starts, while it still runs, Windows refuses: the start must not stop there
      // and leave no window)
      await page.eval('(window.close(), true)');
      const code = await app.waitForExit(20000);
      assert(code === 0, `Plymentor closed: exit code ${code}`);
      writeFileSync(join(HOME, 'update.json'), JSON.stringify({ auto: true, lastVersion: '0.9.0' }));
      const pending = join(HOME, 'update-cache', 'plymentor-updater', 'pending');
      const installer = join(pending, setupName(APP_VERSION));
      copyFileSync(join(process.env.SystemRoot, 'System32', 'PING.EXE'), installer);
      const running = spawn(installer, ['-n', '60', '127.0.0.1'], { stdio: 'ignore' });
      try {
        app = await launch({ timeout: 30000 });
        page = app.page;
        await appReady(page);
        await page.waitFor(`[...document.querySelectorAll('.toasts .toast')].some(t => t.textContent.includes('Plymentor was updated to ${APP_VERSION}.'))`, { timeout: 15000, what: 'the "updated" toast' });
        await sleep(1500);
        assert(running.exitCode === null && existsSync(installer), 'the installer is left while it runs');
        running.kill(); // it finishes
        for (const t0 = Date.now(); existsSync(pending) && Date.now() - t0 < 30000; ) await sleep(250);
        assert(!existsSync(pending), 'the installer removed once it had quit');
        assert(!/uncaught exception|unhandled rejection/.test(readFileSync(join(HOME, 'logs', 'plymentor.log'), 'utf8')), 'no uncaught error in the log');
        const bad = errorsOf(page);
        assert(!bad.length, JSON.stringify(bad.slice(0, 8), null, 1));
      } finally {
        running.kill();
      }
    });
}

try {
  mkdirSync(TMP, { recursive: true });
  await main();
} catch (e) {
  failures++;
  log(`✖ aborted: ${e.message}`);
} finally {
  // close the app normally (the portable .exe then removes its temporary folder), force it only when that fails
  for (const a of apps) {
    if (a.exitCode === null) await a.page?.eval('(window.close(), true)').catch(() => {});
    if ((await a.waitForExit(20000)) === null) await a.kill().catch(() => {});
  }
  await updates?.github.close();
  writeFileSync(join(TMP, 'e2e-result.json'), JSON.stringify({ passes, failures, at: new Date().toISOString(), exe: process.env.E2E_EXE || 'build' }));
  log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
