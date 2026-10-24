// Signs a release for Plymentor's updates, after `npm run dist`:
//   npm run release:sign
// Takes release/Plymentor-<version>-setup.exe (the releases have only the installer) and the notes of <version> in
// CHANGELOG.md, signs them with the release key (scripts/release-key.mjs), and writes release/latest.yml — the file the
// app's updater reads from the newest GitHub release — with the signed entry (desktop/update-manifest.js). It then reads
// that file the way the app does, with the key the app has built in (desktop/update-key.js), and lists the files to
// upload.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { APP_VERSION } from '../shared/protocol.js';
import { hashFile, readRelease, setupName, signRelease } from '../desktop/update-manifest.js';
import { RELEASE_KEYS } from '../desktop/update-key.js';
import { KEY_FILE, publicHalf } from './release-key.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'release');
const version = APP_VERSION;
const fail = msg => {
  console.error(msg);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) fail(`package.json says ${pkg.version}, shared/protocol.js ${version}.`);
const setupFile = join(dir, setupName(version));
for (const f of [setupFile, `${setupFile}.blockmap`]) if (!existsSync(f)) fail(`Missing ${f}: run npm run dist first.`);
if (!existsSync(KEY_FILE)) fail(`No release key at ${KEY_FILE} (scripts/release-key.mjs).`);
const key = readFileSync(KEY_FILE, 'utf8');
if (!RELEASE_KEYS.includes(publicHalf(key))) fail(`The release key ${KEY_FILE} is not the one the app trusts (desktop/update-key.js).`);

// the notes and the date of this version: its section of CHANGELOG.md ("## 1.0.0 — 2026-10-23 — title")
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const at = changelog.indexOf(`\n## ${version} `);
if (at < 0) fail(`CHANGELOG.md has no section for ${version}.`);
const section = changelog.slice(at + 1, changelog.indexOf('\n## ', at + 1) >>> 0);
const heading = section.slice(0, section.indexOf('\n'));
const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(heading)?.[1];
if (!date) fail(`The CHANGELOG.md heading of ${version} has no date: ${heading}`);
const notes = `${heading.replace(/^##\s*/, '')}\n\n${section.slice(heading.length).trim()}`;

const setup = await hashFile(setupFile);
// electron-builder's own latest.yml must describe the same installer (its blockmap belongs to it)
const built = yaml.load(readFileSync(join(dir, 'latest.yml'), 'utf8'));
if (built.plymentor) console.log('(latest.yml was signed before: signing it again)');
else if (built.version !== version || built.sha512 !== setup.sha512) fail(`release/latest.yml is not the one electron-builder wrote for this installer.`);

const signed = signRelease({ version, date, notes, setup }, key);
const latest = {
  version,
  files: [{ url: setupName(version), sha512: setup.sha512, size: setup.size }],
  path: setupName(version),
  sha512: setup.sha512,
  releaseDate: new Date().toISOString(),
  plymentor: signed,
};
// (JSON is YAML: electron-updater reads it as it is)
writeFileSync(join(dir, 'latest.yml'), `${JSON.stringify(latest, null, 2)}\n`);

// read back as the app will
const check = readRelease(yaml.load(readFileSync(join(dir, 'latest.yml'), 'utf8')), RELEASE_KEYS);
if (check.version !== version) fail('The signed latest.yml could not be read back.');

const sha256 = f => createHash('sha256').update(readFileSync(f)).digest('hex');
console.log(`Signed Plymentor ${version} (${date}). Upload these three files to the GitHub release v${version}:`);
for (const f of [setupFile, `${setupFile}.blockmap`, join(dir, 'latest.yml')]) console.log(`  ${f}`);
console.log(`\nSHA-256:\n${sha256(setupFile)}  ${setupName(version)}`);
