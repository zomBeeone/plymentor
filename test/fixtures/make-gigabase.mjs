// Makes the archives in test/fixtures/gigabase/ with Windows' tar (bsdtar 3.7+, which writes 7z): small files packed
// with LZMA2, LZMA and without compression (for the 7z reader), and a test game database packed the way big Scid 5
// databases are published, in a folder of its own (for the end-to-end test). Run it again only when the generator or
// the writer change:
//   node test/fixtures/make-gigabase.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { archiveFiles, makeGames, writeScid5 } from '../unit/scid-fixtures.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), 'gigabase');
mkdirSync(out, { recursive: true });
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const work = mkdtempSync(join(tmpdir(), 'plymentor-fixtures-'));
try {
  const files = archiveFiles();
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(dirname(join(work, 'files', name)), { recursive: true });
    writeFileSync(join(work, 'files', name), data);
  }
  for (const method of ['lzma2', 'lzma1', 'store'])
    execFileSync(tar, ['--format', '7zip', '--options', `7zip:compression=${method}`, '-cf', join(out, `files-${method}.7z`), ...Object.keys(files)], { cwd: join(work, 'files') });
  mkdirSync(join(work, 'db', 'Test_Base_si5'), { recursive: true });
  writeScid5(join(work, 'db', 'Test_Base_si5', 'Test_Base'), makeGames(1));
  execFileSync(tar, ['--format', '7zip', '--options', '7zip:compression=lzma2', '-cf', join(out, 'test-db.7z'), 'Test_Base_si5'], { cwd: join(work, 'db') });
  console.log(`Made the archives in ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
