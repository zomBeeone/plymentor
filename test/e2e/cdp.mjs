// A small Chrome DevTools Protocol client for the end-to-end tests: starts the Plymentor desktop app (Electron, from
// the build or the packaged .exe) with a DevTools port and drives its window.
import { spawn, execFileSync } from 'node:child_process';
import WebSocket from 'ws';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export class App {
  /**
   * Starts the app. exe + args: how to run it (electron.exe with the project folder, or Plymentor.exe); env: extra
   * environment (PLYMENTOR_HOME must point to a test folder). Resolves once the window shows the app.
   */
  static async launch({ exe, args = [], env = {}, port = 9333 + Math.floor(Math.random() * 500), timeout = 90_000 } = {}) {
    const base = { ...process.env };
    delete base.ELECTRON_RUN_AS_NODE; // set in VS Code's terminals and tasks: the app would start as plain Node.js
    const proc = spawn(exe, [...args, `--remote-debugging-port=${port}`], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const app = new App(proc, port);
    proc.stdout.on('data', d => (app.output += d));
    proc.stderr.on('data', d => (app.output += d));
    proc.on('exit', code => (app.exitCode = code ?? -1));
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (app.exitCode !== null) throw new Error(`The app exited (${app.exitCode}):\n${app.output.slice(-3000)}`);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const t = targets.find(x => x.type === 'page' && x.url.startsWith('app://plymentor/index.html'));
        if (t) {
          app.page = new Page(t.webSocketDebuggerUrl, t.id, app);
          await app.page.open();
          return app;
        }
      } catch {
        /* not up yet */
      }
      await sleep(300);
    }
    await app.kill();
    throw new Error(`The app's window did not appear:\n${app.output.slice(-3000)}`);
  }

  constructor(proc, port) {
    this.proc = proc;
    this.port = port;
    this.output = '';
    this.exitCode = null;
    this.page = null;
  }

  /** Another window of the app (the about or licences page): waits until one shows `url` and connects to it. */
  async window(url, timeout = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const t = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).find(x => x.type === 'page' && x.url.startsWith(url));
        if (t) {
          const page = new Page(t.webSocketDebuggerUrl, t.id, this);
          await page.open();
          return page;
        }
      } catch {
        /* not there yet */
      }
      await sleep(250);
    }
    throw new Error(`No window shows ${url}`);
  }

  /** Waits for the process to end by itself (e.g. after its window was closed). Resolves with the exit code. */
  async waitForExit(timeout = 20_000) {
    const t0 = Date.now();
    while (this.exitCode === null && Date.now() - t0 < timeout) await sleep(100);
    return this.exitCode;
  }

  /** Ends the app and everything it started (the coach CLI, Stockfish…). */
  async kill() {
    this.page?.ws?.close();
    if (this.exitCode !== null) return;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else this.proc.kill();
    } catch {
      /* gone */
    }
    await this.waitForExit(10_000);
  }
}

export class Page {
  constructor(wsUrl, id, browser) {
    this.wsUrl = wsUrl;
    this.id = id;
    this.browser = browser;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.console = [];
    this.errors = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', async () => {
        await this.send('Page.enable');
        await this.send('Runtime.enable');
        await this.send('Log.enable');
        // the page keeps keyboard focus (and gets typed text) even while another window is in front
        await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        this.on('Runtime.consoleAPICalled', p => this.console.push({ type: p.type, text: p.args.map(a => a.value ?? a.description ?? '').join(' ') }));
        this.on('Runtime.exceptionThrown', p => this.errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
        this.on('Log.entryAdded', p => {
          if (p.entry.level === 'error') this.console.push({ type: 'log-error', text: `${p.entry.text} ${p.entry.url || ''}` });
        });
        // Headless browsers say "HeadlessChrome" in their User-Agent, which some sites (Lichess) treat as a bot.
        const ua = (await this.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result.value;
        await this.send('Network.enable');
        await this.send('Network.setUserAgentOverride', { userAgent: ua.replace(/HeadlessChrome/g, 'Chrome') });
        resolve();
      });
      this.ws.on('error', reject);
      this.ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        if (m.id && this.pending.has(m.id)) {
          const { resolve: res, reject: rej } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) rej(new Error(`${m.error.message} ${m.error.data || ''}`));
          else res(m.result);
        } else if (m.method) for (const h of this.handlers.get(m.method) || []) h(m.params);
      });
    });
  }

  /** One DevTools call; gives up after `timeout` ms (a closed or crashed page never answers). */
  send(method, params = {}, timeout = 60000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer from the browser`));
      }, timeout);
      this.pending.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v)),
        reject: e => (clearTimeout(timer), reject(e)),
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  async goto(url) {
    const loaded = new Promise(r => this.on('Page.loadEventFired', r));
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(15000)]);
  }

  /** Evaluates an expression (or an async function body with `return`) in the page and returns its value. */
  async eval(expression, { timeout = 30000 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n${expression.slice(0, 300)}`);
    return r.result.value;
  }

  /** Waits until the expression is truthy; returns its value. */
  async waitFor(expression, { timeout = 30000, interval = 200, what } = {}) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${what || expression} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
  }

  /** Sets an input/textarea value the way typing does (Preact listens to input events). */
  type(selector, value) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('no element ${selector.replace(/'/g, '')}');
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }

  /** Clicks the first element matching the selector whose text includes `text` (when given). */
  click(selector, text) {
    return this.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});
      if (!els.length) throw new Error('nothing to click: ${selector.replace(/'/g, '')} ${String(text || '').replace(/'/g, '')}');
      els[0].click();
      return true;
    })()`);
  }

  /** A real mouse click at the centre of a chessground square (for moves on the board). */
  async clickSquare(boardSelector, square, orientation = 'white') {
    const rect = await this.eval(`(() => { const r = document.querySelector(${JSON.stringify(boardSelector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    const col = orientation === 'white' ? file : 7 - file;
    const row = orientation === 'white' ? 7 - rank : rank;
    const x = rect.x + (col + 0.5) * (rect.w / 8);
    const y = rect.y + (row + 0.5) * (rect.h / 8);
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  }

  /** Types into the focused element with real keyboard input (text, then optionally Enter). */
  async keyboard(text, { enter = false } = {}) {
    if (text) await this.send('Input.insertText', { text });
    if (enter)
      for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  }

  /** A real key press, no text typed: 'ArrowLeft', 'ArrowRight', … or a letter ('g'); with Shift held when `shift`. */
  async press(key, { shift = false } = {}) {
    const vk = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key] ?? key.toUpperCase().charCodeAt(0);
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    for (const type of ['rawKeyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 });
  }

  /** Puts files into a file input (as if chosen in the file dialog); the page gets its change event. */
  async setFiles(selector, files) {
    const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no element ${selector}`);
    await this.send('DOM.setFileInputFiles', { nodeId, files });
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, 10000);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, Buffer.from(data, 'base64'));
  }

  async close() {
    try {
      await fetch(`http://127.0.0.1:${this.browser.port}/json/close/${this.id}`);
    } catch {
      /* already closed */
    }
    this.ws?.close();
  }
}
