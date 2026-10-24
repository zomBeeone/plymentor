// Updates (desktop/updates.js, desktop/update-manifest.js, run here in Node without Electron): the signed description
// of a release and everything that is refused (no signature, another key, a description that does not match
// latest.yml, a file that differs), and the updater's steps with a stand-in for electron-updater: found, downloaded,
// the backup of the games, installed only after it, as the app quits (the test writes the command instead of running
// it); the portable .exe; the student's settings; "updated" after an update, and the installer it ran removed once it
// has quit (it is still finishing as the new version starts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFile, hashFile, isNewer, portableName, readRelease, setupName, signRelease } from '../../desktop/update-manifest.js';
import { Updates, testSource } from '../../desktop/updates.js';
import { RELEASE_KEYS } from '../../desktop/update-key.js';

const tmp = mkdtempSync(join(tmpdir(), 'cc-updates-'));
const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
};
const KEY = keyPair();
const OTHER = keyPair();
const NEXT = '3.9.1';

/** Two "release files" (a few kB of bytes standing in for the installer and the portable .exe). */
function releaseFiles(dir, version, seed = 1) {
  mkdirSync(dir, { recursive: true });
  const bytes = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 255));
  const setup = join(dir, setupName(version));
  const portable = join(dir, portableName(version));
  writeFileSync(setup, bytes(5000));
  writeFileSync(portable, bytes(7000));
  return { setup, portable };
}

/** latest.yml as the release script writes it (parsed), signed with key. */
async function latestYml(version, files, key = KEY.pem, notes = '- Better things.') {
  const setup = await hashFile(files.setup);
  const portable = await hashFile(files.portable);
  return {
    version,
    files: [{ url: setupName(version), sha512: setup.sha512, size: setup.size }],
    path: setupName(version),
    sha512: setup.sha512,
    releaseDate: '2026-10-23T10:00:00.000Z',
    plymentor: signRelease({ version, date: '2026-10-23', notes: `${version} — 2026-10-23 — test\n\n${notes}`, setup, portable }, key),
  };
}

let files;
before(async () => {
  files = releaseFiles(join(tmp, 'release'), NEXT);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a signed release is read back; versions compare', async () => {
  const info = await latestYml(NEXT, files);
  const r = readRelease(info, [KEY.spki]);
  assert.equal(r.version, NEXT);
  assert.equal(r.files.setup.name, 'Plymentor-3.9.1-setup.exe');
  assert.equal(r.files.portable.size, 7000);
  assert.match(r.notes, /Better things/);
  // the key the app has built in is a real Ed25519 key, and another one does not verify
  assert.equal(RELEASE_KEYS.length >= 1, true);
  assert.throws(() => readRelease(info, RELEASE_KEYS), /not signed with Studio Nox’s key/);
  assert.ok(isNewer('3.10.0', '3.9.9') && isNewer('4.0.0', '3.99.99') && isNewer('3.4.1', '3.4.0'));
  assert.ok(!isNewer('3.4.0', '3.4.0') && !isNewer('3.3.9', '3.4.0'));
});

test('refused: no signature, another key, a changed description, latest.yml that does not match it', async () => {
  const info = await latestYml(NEXT, files);
  const refused = (i, re) => assert.throws(() => readRelease(i, [KEY.spki]), re);
  refused({ ...info, plymentor: undefined }, /not signed by Studio Nox/);
  refused(await latestYml(NEXT, files, OTHER.pem), /not signed with Studio Nox’s key/);
  // one character of the notes changed after signing
  refused({ ...info, plymentor: { ...info.plymentor, payload: info.plymentor.payload.replace('Better', 'Bitter') } }, /not signed with Studio Nox’s key/);
  // a different installer offered in latest.yml (electron-updater downloads what files[] says)
  refused({ ...info, files: [{ ...info.files[0], url: 'Evil-setup.exe' }] }, /do not match/);
  refused({ ...info, files: [{ ...info.files[0], sha512: info.files[1]?.sha512 || 'x'.repeat(86) + '==' }] }, /do not match/);
  refused({ ...info, files: [...info.files, { url: 'Plymentor-3.9.1-setup.exe.blockmap', sha512: 'x', size: 1 }] }, /do not match/);
  refused({ ...info, version: '3.9.2' }, /do not match/);
  // the release script refuses to sign a description the app would not read
  assert.throws(() => signRelease({ version: '3.9', date: 'x', notes: '', setup: { size: 1, sha512: 'x' }, portable: { size: 1, sha512: 'x' } }, KEY.pem), /not one of a Plymentor release/);
});

test('a downloaded file must be the signed one', async () => {
  const r = readRelease(await latestYml(NEXT, files), [KEY.spki]);
  await checkFile(files.setup, r.files.setup);
  const copy = join(tmp, 'tampered.exe');
  const bytes = readFileSync(files.setup);
  bytes[100] ^= 1;
  writeFileSync(copy, bytes);
  await assert.rejects(checkFile(copy, r.files.setup), /checksum differs/);
});

test('only a stand-in for GitHub on this computer is accepted for tests', () => {
  assert.equal(testSource({ PLYMENTOR_UPDATE_URL: 'http://127.0.0.1:4567' })?.port, '4567');
  assert.ok(testSource({ PLYMENTOR_UPDATE_URL: 'http://localhost:1' }));
  assert.equal(testSource({ PLYMENTOR_UPDATE_URL: 'https://example.com' }), null);
  assert.equal(testSource({ PLYMENTOR_UPDATE_URL: 'file:///C:/x' }), null);
  assert.equal(testSource({}), null);
});

// ---------------------------------------------------------------------------------------------
// The updater's steps, with a stand-in for electron-updater

/** What electron-updater does for Updates, on the test's files: the check answers info, downloads copy the files. */
function fakeUpdater(info, source) {
  return ({ cacheBase, verifyFile }) => {
    const u = new EventEmitter();
    u.checks = 0;
    u.checkForUpdates = async () => {
      u.checks++;
      const i = typeof info === 'function' ? info() : info;
      return i ? { isUpdateAvailable: isNewer(i.version, '3.4.0'), updateInfo: { ...i, tag: `v${i.version}` } } : { isUpdateAvailable: false };
    };
    u.downloadUpdate = async () => {
      const file = join(cacheBase, 'plymentor-updater', 'pending', setupName(NEXT));
      mkdirSync(join(file, '..'), { recursive: true });
      u.emit('download-progress', { transferred: 2500, total: 5000 });
      writeFileSync(file, readFileSync(source.setup));
      await verifyFile(file); // electron-updater's verifySignature
      return [file];
    };
    u.httpExecutor = {
      download: async (url, dest) => {
        u.portableUrl = url.href;
        writeFileSync(dest, readFileSync(source.portable));
        return dest;
      },
    };
    return u;
  };
}

function updates(home, { info, source = files, mode = 'installed', env = {}, ...more } = {}) {
  const quits = [];
  const u = new Updates({
    home,
    version: '3.4.0',
    isPackaged: true,
    execPath: join(home, 'Plymentor.exe'),
    log: () => {},
    quit: () => quits.push(Date.now()),
    showItem: () => {},
    downloadsDir: () => join(home, 'Downloads'),
    createUpdater: fakeUpdater(info, source),
    env: { PLYMENTOR_UPDATE_URL: 'http://127.0.0.1:9', PLYMENTOR_UPDATE_KEY: KEY.spki, PLYMENTOR_UPDATE_MODE: mode, ...env },
    ...more,
  });
  u.quits = quits;
  return u;
}

const SQLITE = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(4096, 1)]);
const wait = ms => new Promise(r => setTimeout(r, ms));

test('installed: found, downloaded, backed up, then installed as the app quits', async () => {
  const home = join(tmp, 'home-installed');
  const info = await latestYml(NEXT, files);
  const statuses = [];
  const u = updates(home, { info, onStatus: s => statuses.push(s.state) });
  assert.equal(u.mode, 'installed');
  let s = await u.check({ manual: true });
  assert.equal(s.state, 'available');
  assert.equal(s.release.version, NEXT);
  assert.equal(s.release.size, 5000);
  assert.deepEqual(s.checked && [s.checked.manual, s.checked.found], [true, true]);
  // nothing is downloaded or installed without the student
  assert.equal(existsSync(join(home, 'update-cache')), false);
  await assert.rejects(u.install(), /No update is ready/);
  s = await u.download();
  assert.equal(s.state, 'ready');
  assert.ok(statuses.includes('downloading'));
  // the games are backed up first
  await assert.rejects(u.install(), /backs up your games/);
  assert.throws(() => u.saveBackup(new Uint8Array(1000)), /could not be made/);
  const { file } = u.saveBackup(new Uint8Array(SQLITE));
  assert.match(file, /backups[\\/]plymentor-3\.4\.0-before-3\.9\.1-\d{4}-\d{2}-\d{2}\.sqlite$/);
  assert.deepEqual(readFileSync(file), SQLITE);
  s = await u.install();
  assert.equal(s.state, 'installing');
  await wait(400);
  assert.equal(u.quits.length, 1, 'the app quits');
  u.runPending();
  u.runPending(); // once
  const run = JSON.parse(readFileSync(join(home, 'update-test-install.json'), 'utf8'));
  assert.deepEqual(run.args, ['--updated', '/S', '--force-run']);
  assert.match(run.file, /update-cache[\\/]plymentor-updater[\\/]pending[\\/]Plymentor-3\.9\.1-setup\.exe$/);
  assert.equal(run.version, NEXT);
});

test('installed: a downloaded file that is not the signed one is not used; one downloaded earlier is ready again', async () => {
  const home = join(tmp, 'home-tampered');
  const info = await latestYml(NEXT, files);
  const evil = releaseFiles(join(tmp, 'evil'), NEXT, 2);
  const u = updates(home, { info, source: evil });
  await u.check({ manual: false });
  const s = await u.download();
  assert.equal(s.state, 'available');
  assert.match(s.error, /checksum differs/);
  // the right file, downloaded by an earlier start, is found again without downloading
  const good = updates(home, { info });
  writeFileSync(join(home, 'update-cache', 'plymentor-updater', 'pending', setupName(NEXT)), readFileSync(files.setup));
  assert.equal((await good.check({ manual: false })).state, 'ready');
});

test('refused: an unsigned release or one that is not newer is not offered', async () => {
  const home = join(tmp, 'home-refused');
  const info = await latestYml(NEXT, files);
  let s = await updates(home, { info: { ...info, plymentor: undefined } }).check({ manual: true });
  assert.equal(s.state, 'idle');
  assert.equal(s.release, null);
  assert.match(s.checked.error, /not signed by Studio Nox/);
  s = await updates(home, { info: await latestYml(NEXT, files, OTHER.pem) }).check({ manual: true });
  assert.match(s.checked.error, /Studio Nox’s key/);
  s = await updates(home, { info: null }).check({ manual: true });
  assert.deepEqual([s.state, s.checked.found, s.checked.error], ['idle', false, undefined]);
});

test('portable: the new .exe is downloaded and started after the backup', async () => {
  const home = join(tmp, 'home-portable');
  const u = updates(home, { info: await latestYml(NEXT, files), mode: 'portable' });
  assert.equal(u.mode, 'portable');
  let s = await u.check({ manual: false });
  assert.equal(s.release.size, 7000, 'the portable .exe’s size');
  s = await u.download();
  assert.equal(s.state, 'ready');
  assert.equal(s.file, join(home, 'update-downloads', portableName(NEXT)));
  assert.equal(u.updater.portableUrl, `http://127.0.0.1:9/zomBeeone/plymentor/releases/download/v${NEXT}/${portableName(NEXT)}`);
  u.saveBackup(new Uint8Array(SQLITE));
  await u.install();
  u.runPending();
  const run = JSON.parse(readFileSync(join(home, 'update-test-install.json'), 'utf8'));
  assert.equal(run.file, s.file);
  assert.deepEqual(run.args, [`--replacing=${process.pid}`]);
});

test('a release with only the installer (as Plymentor’s are): the installed app updates, a portable .exe shows the release’s page', async () => {
  const setup = await hashFile(files.setup);
  const info = {
    version: NEXT,
    files: [{ url: setupName(NEXT), sha512: setup.sha512, size: setup.size }],
    path: setupName(NEXT),
    sha512: setup.sha512,
    plymentor: signRelease({ version: NEXT, date: '2026-10-23', notes: `${NEXT} — 2026-10-23 — test\n\n- Only the installer.`, setup }, KEY.pem),
  };
  assert.equal(readRelease(info, [KEY.spki]).files.portable, undefined);
  const installed = updates(join(tmp, 'home-setup-only'), { info });
  let s = await installed.check({ manual: false });
  assert.deepEqual([s.state, s.release.download], ['available', true]);
  assert.equal((await installed.download()).state, 'ready');
  const opened = [];
  const portable = updates(join(tmp, 'home-setup-only-portable'), { info, mode: 'portable', openExternal: url => opened.push(url) });
  s = await portable.check({ manual: false });
  assert.deepEqual([s.state, s.release.download, s.release.size], ['available', false, setup.size]);
  await assert.rejects(portable.download(), /only the installer/);
  portable.openPage();
  assert.deepEqual(opened, [`http://127.0.0.1:9/zomBeeone/plymentor/releases/tag/v${NEXT}`]);
});

test('the student’s settings, "updated" once, older backups go, and no updates for a copy that is neither installed nor portable', async () => {
  const home = join(tmp, 'home-prefs');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'update.json'), JSON.stringify({ auto: true, lastVersion: '3.3.0' }));
  const u = updates(home, { info: await latestYml(NEXT, files) });
  assert.equal(u.status().updatedFrom, '3.3.0');
  assert.equal(updates(home).status().updatedFrom, null, 'only once');
  u.setAuto(false);
  assert.equal(updates(home).status().auto, false);
  assert.equal(JSON.parse(readFileSync(join(home, 'update.json'), 'utf8')).lastVersion, '3.4.0');
  // backups: the newest three stay
  const dir = join(home, 'backups');
  mkdirSync(dir, { recursive: true });
  for (const [i, name] of ['plymentor-3.1.0-before-3.2.0-2026-01-01.sqlite', 'plymentor-3.2.0-before-3.3.0-2026-02-01.sqlite', 'plymentor-3.3.0-before-3.3.1-2026-03-01.sqlite'].entries()) {
    writeFileSync(join(dir, name), SQLITE);
    utimesSync(join(dir, name), new Date(2026, i, 1), new Date(2026, i, 1));
  }
  writeFileSync(join(dir, 'my-own.sqlite'), SQLITE);
  await u.check({ manual: false });
  u.saveBackup(new Uint8Array(SQLITE));
  assert.deepEqual(readdirSync(dir).sort(), ['my-own.sqlite', 'plymentor-3.2.0-before-3.3.0-2026-02-01.sqlite', 'plymentor-3.3.0-before-3.3.1-2026-03-01.sqlite', `plymentor-3.4.0-before-3.9.1-${new Date().toLocaleDateString('sv')}.sqlite`].sort());
  // a copy from build/ or win-unpacked/ (no test hook): no updates
  const none = new Updates({ home: join(tmp, 'home-none'), version: '3.4.0', isPackaged: false, execPath: 'x', log: () => {}, quit: () => {}, createUpdater: () => assert.fail('no updater'), env: {} });
  assert.equal(none.mode, 'none');
  assert.match((await none.check({ manual: true })).checked.error, /installed Plymentor and in the portable/);
});

test('after an update, the installer it ran goes once it has quit, and never stops the start', async () => {
  // (removing it as the app starts, while the installer is still finishing, Windows refuses: the start must not stop
  // there and leave no window)
  const home = join(tmp, 'home-after-update');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'update.json'), JSON.stringify({ auto: false, lastVersion: '3.3.0' }));
  // the installer as it starts the new version: a program running from electron-updater's pending\ folder
  const pending = join(home, 'update-cache', 'plymentor-updater', 'pending');
  mkdirSync(pending, { recursive: true });
  const installer = join(pending, setupName('3.4.0'));
  copyFileSync(join(process.env.SystemRoot, 'System32', 'PING.EXE'), installer);
  writeFileSync(join(pending, 'update-info.json'), '{}');
  const running = spawn(installer, ['-n', '3', '127.0.0.1'], { stdio: 'ignore' });
  await once(running, 'spawn');
  const exited = once(running, 'exit');
  try {
    const u = updates(home);
    assert.equal(u.status().updatedFrom, '3.3.0');
    u.start();
    await wait(500);
    assert.ok(existsSync(installer), 'not while it runs');
    await u.cleaning;
    assert.equal(existsSync(pending), false, 'gone once it has quit');
    u.stop();
  } finally {
    running.kill();
    await exited;
  }
});
