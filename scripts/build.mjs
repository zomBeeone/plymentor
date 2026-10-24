// Builds the desktop app into build/:
//   build/app/        the window: index.html, about.html, licenses.html, LICENSE.txt, css, assets (with the Studio Nox logo, cut out
//                     of branding/), data/openings, js/ (bundled screens and workers), engine/ (Stockfish WebAssembly),
//                     voice/ (onnxruntime for the natural voice)
//   build/desktop/    the main process (main.mjs), the window's preload (preload.cjs), the coaches' MCP server (mcp.cjs),
//                     the game database's processes (gigabase-job.mjs: unpacking and indexing; gigabase-query.mjs)
//   build/resources/  the icon electron-builder puts on the .exe, the portable .exe's splash
// `npm start` runs it with Electron; `npm run dist` packages it into release/ (portable .exe and installer).
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { APP_VERSION } from '../shared/protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const web = join(out, 'app');
const nm = join(root, 'node_modules');
const SOURCE_URL = 'https://github.com/zomBeeone/plymentor';

const t0 = Date.now();
rmSync(out, { recursive: true, force: true });
mkdirSync(web, { recursive: true });

// ---------------------------------------------------------------------------------------------
// The window's static files

const copy = (from, to) => cpSync(join(root, from), join(web, to), { recursive: true });
copy('app/index.html', 'index.html');
copy('app/licenses.html', 'licenses.html');
copy('app/css', 'css');
copy('app/assets', 'assets');
mkdirSync(join(web, 'vendor'), { recursive: true });
copy('app/vendor/chessground.base.css', 'vendor/chessground.base.css');
copy('app/vendor/xterm.css', 'vendor/xterm.css');
mkdirSync(join(web, 'data', 'openings'), { recursive: true });
for (const f of ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv', 'COPYING.txt']) copy(`data/openings/${f}`, `data/openings/${f}`);

// Stockfish 19 (WebAssembly, lite network): multi-threaded and single-threaded builds.
mkdirSync(join(web, 'engine'), { recursive: true });
for (const f of ['stockfish-19-lite.js', 'stockfish-19-lite.wasm', 'stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm'])
  cpSync(join(nm, 'stockfish', 'bin', f), join(web, 'engine', f));
cpSync(join(nm, 'stockfish', 'Copying.txt'), join(web, 'engine', 'COPYING.txt'));

// SQLite (WebAssembly) for the games database.
mkdirSync(join(web, 'js'), { recursive: true });
cpSync(join(nm, '@sqlite.org', 'sqlite-wasm', 'dist', 'sqlite3.wasm'), join(web, 'js', 'sqlite3.wasm'));

// onnxruntime-web (used by the natural voice), served by the app itself.
mkdirSync(join(web, 'voice'), { recursive: true });
const ortDir = join(nm, '@huggingface', 'transformers', 'dist');
for (const f of readdirSync(ortDir).filter(f => /^ort-wasm-simd-threaded\.jsep\.(wasm|mjs)$/.test(f))) cpSync(join(ortDir, f), join(web, 'voice', f));

// The about page, with the version, and Plymentor's licence (shown from the about and licences pages).
writeFileSync(join(web, 'about.html'), readFileSync(join(root, 'app', 'about.html'), 'utf8').replaceAll('{{version}}', APP_VERSION));
cpSync(join(root, 'LICENSE'), join(web, 'LICENSE.txt'));

// Plymentor's icon: the window's (PNG) and the one electron-builder turns into the .exe's icon.
const svg = join(root, 'app', 'assets', 'icon.svg');
mkdirSync(join(out, 'resources'), { recursive: true });
await sharp(svg, { density: 1200 }).resize(256, 256).png().toFile(join(web, 'assets', 'icon.png'));
await sharp(svg, { density: 2400 }).resize(512, 512).png().toFile(join(out, 'resources', 'icon.png'));

// The studio's logo (Studio Nox, branding/): cut out of the white-on-black original — brightness becomes opacity —
// in the app's text colour, for the dark window, the about page and the splash.
const studioLogo = await cutOut(join(root, 'branding', 'studio-nox-dark.png'), [232, 228, 220], 720);
mkdirSync(join(web, 'assets', 'brand'), { recursive: true });
writeFileSync(join(web, 'assets', 'brand', 'studio-nox.png'), studioLogo);

async function cutOut(file, [r, g, b], width) {
  const { data, info } = await sharp(file).trim({ threshold: 30 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(((data[i * info.channels] - 10) * 255) / 235))); // near-black = clear
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).resize(width).png().toBuffer();
}

// The splash the portable .exe shows while it unpacks itself (a few seconds at every start): a 24-bit BMP.
const iconShapes = readFileSync(svg, 'utf8').replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, '');
const splash = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
  <rect width="480" height="270" fill="#161512"/>
  <g transform="translate(208 26)">${iconShapes}</g>
  <text x="240" y="130" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="700" fill="#e8e4dc">Plymentor</text>
  <text x="240" y="156" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="#9a958e">Starting…</text>
</svg>`;
const splashLogo = await sharp(studioLogo).resize(130).toBuffer();
const splashLogoHeight = (await sharp(splashLogo).metadata()).height;
const { data: rgb, info } = await sharp(Buffer.from(splash))
  .composite([{ input: splashLogo, left: 175, top: 270 - 24 - splashLogoHeight }])
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
writeFileSync(join(out, 'resources', 'splash.bmp'), bmp24(rgb, info.width, info.height));

/** A 24-bit Windows bitmap from RGB pixels (rows bottom-up, in BGR order, padded to 4 bytes). */
function bmp24(pixels, width, height) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const b = Buffer.alloc(54 + row * height);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10); // where the pixels start
  b.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26); // planes
  b.writeUInt16LE(24, 28); // bits per pixel
  b.writeUInt32LE(row * height, 34);
  b.writeInt32LE(2835, 38); // 72 dpi
  b.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = ((height - 1 - y) * width + x) * 3;
      const o = 54 + y * row + x * 3;
      b[o] = pixels[i + 2];
      b[o + 1] = pixels[i + 1];
      b[o + 2] = pixels[i];
    }
  return b;
}

// ---------------------------------------------------------------------------------------------
// Bundles

const define = {
  __SOURCE_URL__: JSON.stringify(SOURCE_URL),
  __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
};
const common = { bundle: true, minify: true, sourcemap: 'linked', legalComments: 'linked', logLevel: 'warning', define };
const browser = { ...common, format: 'esm', target: 'es2022', platform: 'browser', outdir: join(web, 'js') };
// The main process: bundled CommonJS packages (ws, xterm) may call require(), and node-pty (native) is loaded from
// node_modules at run time.
const node = { ...common, platform: 'node', target: 'node22', minify: false, sourcemap: false, legalComments: 'inline' };
const requireShim = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
// Packages that bundled code only tries to load, in a try/catch (debug, in electron-updater, asks for supports-color):
// nothing, in the app.
const optionalPackages = {
  name: 'optional-packages',
  setup(b) {
    b.onResolve({ filter: /^supports-color$/ }, a => ({ path: a.path, namespace: 'optional' }));
    b.onLoad({ filter: /.*/, namespace: 'optional' }, () => ({ contents: 'module.exports = null;', loader: 'js' }));
  },
};
await Promise.all([
  build({ ...browser, entryPoints: { main: join(root, 'app/js/main.js') } }),
  build({ ...browser, entryPoints: { backend: join(root, 'app/js/backend/worker.js') } }),
  // the ONNX runtime's wasm files are copied to /voice/ above
  build({ ...browser, entryPoints: { voice: join(root, 'app/js/voice/worker.js') }, external: ['onnxruntime-node', 'sharp'] }),
  build({ ...node, format: 'esm', entryPoints: [join(root, 'desktop/main.js')], outfile: join(out, 'desktop', 'main.mjs'), external: ['electron', 'node-pty'], banner: { js: requireShim }, plugins: [optionalPackages] }),
  build({ ...node, format: 'cjs', entryPoints: [join(root, 'desktop/mcp.js')], outfile: join(out, 'desktop', 'mcp.cjs') }),
  // the game database's utility processes: unpacking and indexing, and reading it
  build({ ...node, format: 'esm', entryPoints: [join(root, 'desktop/gigabase/job.js')], outfile: join(out, 'desktop', 'gigabase-job.mjs'), banner: { js: requireShim } }),
  build({ ...node, format: 'esm', entryPoints: [join(root, 'desktop/gigabase/query.js')], outfile: join(out, 'desktop', 'gigabase-query.mjs'), banner: { js: requireShim } }),
]);
cpSync(join(root, 'desktop', 'preload.cjs'), join(out, 'desktop', 'preload.cjs'));

// The packaged app has only node-pty in node_modules: everything else the main process and the MCP server load must
// be in their bundles. (A require() that esbuild could not follow — e.g. through createRequire — would only fail in
// the packaged app.)
const shipped = name => name === 'electron' || name === 'node-pty' || name.startsWith('node-pty/') || builtinModules.includes(name.replace(/^node:/, ''));
for (const file of ['main.mjs', 'mcp.cjs', 'gigabase-job.mjs', 'gigabase-query.mjs']) {
  const code = readFileSync(join(out, 'desktop', file), 'utf8');
  const missing = [...code.matchAll(/\b(?:__)?require\d*\(\s*["']([^"'./][^"']*)["']\s*\)/g)].map(m => m[1]).filter(n => !shipped(n));
  const imports = [...code.matchAll(/^import\s.*?from\s+["']([^"'./][^"']*)["'];?$/gm)].map(m => m[1]).filter(n => !shipped(n));
  if (missing.length || imports.length) throw new Error(`build/desktop/${file} loads packages that are not in the packaged app: ${[...new Set([...missing, ...imports])].join(', ')}`);
}

const walk = dir => readdirSync(dir).flatMap(n => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const files = walk(out);
const size = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`Built ${relative(root, out)}/ in ${((Date.now() - t0) / 1000).toFixed(1)} s — ${files.length} files, ${(size / 1048576).toFixed(1)} MB.`);
