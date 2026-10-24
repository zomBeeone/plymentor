// The website's download button (docs/index.html, served by GitHub Pages at plymentor.com): the version in
// package.json and the size of its installer in release/. Run it after publishing a release (the button links straight
// to the release's installer), then commit and push docs/.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupName } from '../desktop/update-manifest.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { size } = statSync(join(root, 'release', setupName(version))); // (fails when this version's installer is not built)
const fields = { version, size: `${Math.round(size / 1048576)} MB` };

const page = join(root, 'docs', 'index.html');
let html = readFileSync(page, 'utf8');
html = html.replace(/releases\/download\/v[\d.]+\/Plymentor-[\d.]+-setup\.exe/g, `releases/download/v${version}/${setupName(version)}`);
for (const [field, value] of Object.entries(fields)) html = html.replace(new RegExp(`(data-release="${field}"[^>]*>)[^<]*`, 'g'), `$1${value}`);
writeFileSync(page, html);
console.log(`docs/index.html: Plymentor ${version}, ${fields.size}`);
