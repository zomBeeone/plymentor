// The website's screenshot (docs/assets/screenshot.webp, screenshot-1x.webp and the link preview og.jpg): the packaged
// app (release/win-unpacked: npm run dist first) with a data folder of its own in test/.tmp. The Opera Game (Morphy,
// 1858), analysed with Stockfish at the deep setting (the faster ones can call Morphy's 15. Bxd7+ a blunder), is shown
// before 16. Qb8+ with the engine on, and the student asks the coach about it. The coach is site-coach.mjs: Claude
// Code's look, real tool calls, a written answer (no subscription is used). It opens the app's window for two minutes.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { App, sleep } from '../test/e2e/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(root, 'test', '.tmp', 'site-home');
const legacy = join(root, 'test', '.tmp', 'site-legacy');
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, 'app'), { recursive: true });
mkdirSync(legacy, { recursive: true });
writeFileSync(join(home, 'app', 'window-state.json'), JSON.stringify({ width: 1560, height: 940 }));

const PGN = `[Event "Paris"]
[Site "Paris FRA"]
[Date "1858.11.02"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0
`;

const app = await App.launch({
  exe: join(root, 'release', 'win-unpacked', 'Plymentor.exe'),
  env: { PLYMENTOR_HOME: home, PLYMENTOR_LEGACY_HOME: legacy, PLYMENTOR_CLAUDE_PATH: join(root, 'scripts', 'site-coach.mjs'), PATH: `${dirname(process.execPath)};${process.env.PATH}` },
});
const page = app.page;
let png;
try {
  await page.waitFor(`document.querySelector('.topbar .nav') ? true : false`, { timeout: 60000, what: 'the app' });
  await page.eval(`(location.hash = '#/games', true)`);
  await page.waitFor(`document.querySelector('.card .dropzone') || [...document.querySelectorAll('button')].some(b => b.textContent.includes('Import games'))`, { what: 'the games' });
  await page.eval(`(() => { if (!document.querySelector('.card .dropzone')) [...document.querySelectorAll('button')].find(b => b.textContent.includes('Import games')).click(); return true; })()`);
  await page.waitFor(`document.querySelector('.card .dropzone')`, { what: 'the import panel' });
  await page.type('.card .dropzone ~ textarea, .card .col textarea', PGN);
  await page.click('button', 'Import pasted PGN');
  await page.waitFor(`document.querySelectorAll('table.data tbody tr').length === 1`, { what: 'the game' });
  await page.eval(`document.querySelector('table.data thead input[type=checkbox]').click()`);
  await page.waitFor(`document.body.innerText.includes('1 selected')`, { what: 'the selection' });
  await page.eval(`(() => { const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'deep')); s.value = 'deep'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await page.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Analyse with Stockfish') && !b.disabled)`, { what: 'the Analyse button' });
  await page.click('button', 'Analyse with Stockfish');
  await page.waitFor(`[...document.querySelectorAll('td.acc')].some(td => /\\d/.test(td.innerText))`, { timeout: 600000, what: 'the analysis' });
  const id = await page.eval(`document.querySelector('table.data tbody td.players a').getAttribute('href').split('game=')[1]`);

  await page.eval(`(location.hash = '#/analysis?game=${id}', true)`);
  await page.waitFor(`document.querySelectorAll('.movelist .ml-move:not(.empty)').length >= 30`, { what: 'the moves' });
  await sleep(800);
  await page.eval(`[...document.querySelectorAll('.movelist .ml-move')].find(m => /Nxd7/.test(m.innerText)).click()`);
  await sleep(300);
  await page.eval(`(() => { const s = document.querySelector('.switch'); if (s && !s.classList.contains('on')) s.click(); return true; })()`);
  await page.waitFor(`/depth (2[0-9]|[3-9][0-9])/.test(document.querySelector('.engine')?.innerText || '')`, { timeout: 60000, what: 'depth 20' });
  // the student asks the coach, typed into its terminal (input events: key presses need the window's keyboard focus)
  await page.waitFor(`[...document.querySelectorAll('.xterm-helper-textarea')].some(t => t.offsetParent)`, { what: 'the coach panel' });
  await page.eval(`(t => { t.focus(); for (const data of ['What should White play here, and why?', '\\r']) t.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true })); return true; })([...document.querySelectorAll('.xterm-helper-textarea')].find(t => t.offsetParent))`);
  await page.waitFor(`/\\? for shortcuts/.test(document.querySelector('.xterm-rows')?.innerText || '')`, { timeout: 90000, what: 'the coach’s answer' });
  await sleep(1500);
  await page.eval(`(() => { const st = document.createElement('style'); st.textContent = '.toasts { display: none !important }'; document.head.append(st); document.activeElement?.blur(); return true; })()`);
  // the whole window at twice the pixels, with the mouse on the empty top bar (no button lit up)
  const size = await page.eval(`({ w: innerWidth, h: innerHeight })`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(size.w * 0.6), y: 20 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 2, mobile: false });
  await sleep(1500);
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } });
  png = Buffer.from(data, 'base64');
} finally {
  await page.eval('(window.close(), true)').catch(() => {});
  if ((await app.waitForExit(20000)) === null) await app.kill();
}

// the page shows it at most 1120 px wide: that and twice it
const assets = join(root, 'docs', 'assets');
const { width, height } = await sharp(png).metadata();
const [small, big] = [1120, Math.min(2240, width)];
await sharp(png).resize(big).webp({ quality: 82 }).toFile(join(assets, 'screenshot.webp'));
await sharp(png).resize(small).webp({ quality: 86 }).toFile(join(assets, 'screenshot-1x.webp'));
// the link preview (1200 × 630): the top of the screenshot
await sharp(png).extract({ left: 0, top: 0, width, height: Math.round((width * 630) / 1200) }).resize(1200, 630).jpeg({ quality: 84, mozjpeg: true }).toFile(join(assets, 'og.jpg'));
// the page reserves the screenshot's place
const index = join(root, 'docs', 'index.html');
const html = readFileSync(index, 'utf8').replace(/<img [^>]*data-screenshot[^>]*>/, tag =>
  tag
    .replace(/width="\d+" height="\d+"/, `width="${small}" height="${Math.round((small * height) / width)}"`)
    .replace(/screenshot-1x\.webp \d+w, assets\/screenshot\.webp \d+w/, `screenshot-1x.webp ${small}w, assets/screenshot.webp ${big}w`),
);
writeFileSync(index, html);
console.log(`docs/assets: screenshot ${width} × ${height} → ${big} and ${small} px wide, og.jpg`);
