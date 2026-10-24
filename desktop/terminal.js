// The coach session of one Plymentor profile: Claude Code / Codex / Antigravity CLI in a pseudo-terminal, started
// when the app is opened. A headless xterm mirrors the screen so a reloaded window shows exactly the same terminal.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { release } from 'node:os';
// (CommonJS packages: imported whole, so that the build bundles them into the app)
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
import { PROVIDERS, isProvider, launchCommand, signedIn, windowsCommandLine } from './cli.js';
import { readSettings } from './store.js';
import { VOICE_NOTICE, DEFAULT_INITIAL_PROMPT, buildCliInstructions } from '../shared/prompts.js';
import { stripHidden } from '../shared/untrusted.js';

// node-pty is native: it is loaded from node_modules at run time (unpacked from app.asar in the packaged app).
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

if (process.platform === 'win32') {
  // node-pty's kill() asks a helper process for the console's process list after it has already closed the
  // console, so the helper dies with a noisy "AttachConsole failed" trace. Closing the pseudoconsole ends every
  // process attached to it anyway, and kill() below also ends the process tree.
  try {
    require('node-pty/lib/windowsPtyAgent').WindowsPtyAgent.prototype._getConsoleProcessList = function () {
      return Promise.resolve([this._innerPid]);
    };
  } catch {
    /* other node-pty layout: keep its default */
  }
}

const SCROLLBACK = 5000;
// What the CLIs show while they work: Claude Code's spinner line "✻ Pondering… (12s · ↓ 1.2k tokens)" and
// "esc to interrupt" in its status line (cut to "esc to in…" in a narrow panel), Codex's "Working (5s • esc to
// interrupt)"; the Antigravity CLI stops a running turn with Esc as well.
const BUSY_RE = /\besc to (interrupt|in…|cancel|stop|halt)|\(esc to ca|^\s*\S\s+\S+…\s+\((\d+m )?\d+s\b|\bWorking \(\d+[sm]\b/i;
const FRESH_SESSION_AFTER = 2 * 3600_000; // opening the app after a longer break starts a new session
// Claude Code asks once whether to trust a new folder, with "No, exit" preselected. The coach's folder is created
// by the app, holds only the coach's instructions and the MCP config, and the coach runs without file or shell
// tools — so the app picks "Yes" for it.
const TRUST_YES = /Yes, I trust this folder|Yes, proceed/;
const MENU_CURSOR = /^\s*[❯›>▶]\s/;
// Start-up screens that need the student (sign-in, folder trust, onboarding): the first prompt waits for them.
const SETUP_SCREEN =
  /Do you trust|trust this (folder|directory|workspace)|Select login method|Sign in with ChatGPT|How would you like to authenticate|(Sign in|Login) with Google|Waiting for auth|Press Enter to continue|Choose the text style|Use Gemini API Key|Google OAuth|Google Cloud Project|authori[sz]ation (URL|code)|colou?r scheme|rendering mode|alt-?screen mode|Paste code here|Browser didn't open|url below to sign in|Opening browser|Security notes|Finish signing in/i;
const FIRST_PROMPT_FALLBACK = 30_000; // type the first prompt even if the coach never listed the chess tools
const SIGN_IN_CHECK = 3000; // while the student signs in (the first time), how often the app asks the CLI
const OFFER_START_AFTER = 12_000; // "Start training with …" when the coach has not started working by then

/** On Windows the CLI runs in ConPTY, which redraws the screen itself on resize: terminals must not reflow. */
export const WINDOWS_PTY = process.platform === 'win32' ? { backend: 'conpty', buildNumber: Number(release().split('.')[2]) || 0 } : undefined;

const clampSize = (n, lo, hi, dflt) => (Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt);
// U+2028 / U+2029 (line and paragraph separators) count as line breaks too
const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');
/** One line of text without control or invisible characters (what the app types into the coach). */
export const oneLine = text =>
  stripHidden(
    String(text)
      .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
      .replace(SEPARATORS, ' '),
  )
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 8000);

export class CoachSession {
  constructor({ userId, port, mcpScript, log = () => {} }) {
    this.userId = userId;
    this.port = port;
    this.mcpScript = mcpScript;
    this.log = log;
    this.pages = new Set();
    this.proc = null;
    this.mirror = null;
    this.serializer = null;
    this.cols = 100;
    this.rows = 30;
    this.state = 'idle'; // idle | running | exited | missing | error
    this.provider = null;
    this.message = '';
    this.busy = false;
    this.busyTimer = null;
    this.trustKeys = 0;
    this.pending = null; // the first prompt, typed once the coach has its tools
    this.pendingTimer = null;
    this.firstPrompt = ''; // the start-up prompt of this session ("Start training with …" types it again)
    this.signIn = false; // the CLI says the student is not signed in yet: the first prompt waits
    this.signInChecked = false; // (the first prompt also waits for that answer)
    this.signInTimer = null;
    this.engaged = false; // the coach has called one of its tools in this session (it has started working)
    this.offerStart = false; // the window offers "Start training with …"
    this.offerTimer = null;
    this.generation = 0;
    this.lastSeen = Date.now(); // last moment a page was connected
    this.voiceOn = false; // what the student set
    this.voiceTold = false; // whether this session's coach believes its voice is on
    this.voiceTimer = null;
    this.profile = {};
    this.language = 'English';
    this.token = null; // the MCP bridge's secret for the running session
  }

  status() {
    const provider = this.provider || readSettings(this.userId).provider;
    return {
      t: 'status',
      provider,
      label: PROVIDERS[provider]?.label || 'Coach',
      name: PROVIDERS[provider]?.name || 'your coach',
      state: this.state,
      starting: !!this.pending,
      busy: this.busy,
      signIn: this.signIn,
      offerStart: this.offerStart && !this.engaged,
      message: this.message,
    };
  }

  setState(state, message = '') {
    this.state = state;
    this.message = message;
    if (state !== 'running') this.busy = false;
    this.broadcast(this.status());
  }

  // ---- pages --------------------------------------------------------------------------------

  sendTo(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.pages) {
      if (ws.ccQueue) ws.ccQueue.push(data);
      else if (ws.readyState === 1) ws.send(data);
    }
  }

  /** A page of this profile connected. Starts the session the first time (or after a long break). */
  connect(ws, { cols, rows } = {}) {
    ws.ccQueue = []; // messages wait until the page has the screen snapshot
    this.pages.add(ws);
    this.resize(cols, rows);
    const provider = readSettings(this.userId).provider;
    const stale = this.state === 'running' && this.pages.size === 1 && Date.now() - this.lastSeen > FRESH_SESSION_AFTER;
    if (this.state === 'idle' || stale || (this.provider && this.provider !== provider)) this.start();
    this.lastSeen = Date.now();
    const mirror = this.mirror;
    // The page gets its status, the screen and the messages queued meanwhile exactly once — also when copying the
    // screen fails or never finishes (then with an empty screen): a page without its status would wait forever.
    let timer = 0;
    const finish = data => {
      if (!ws.ccQueue) return;
      clearTimeout(timer);
      this.sendTo(ws, this.status());
      this.sendTo(ws, { t: 'snapshot', d: data || '' });
      const q = ws.ccQueue;
      ws.ccQueue = null;
      for (const d of q) if (ws.readyState === 1) ws.send(d);
    };
    if (!mirror) return finish('');
    timer = setTimeout(() => {
      this.log('copying the screen for a page took too long');
      finish('');
    }, 5000);
    mirror.write('', () => {
      let data = '';
      try {
        if (mirror === this.mirror) data = this.serializer.serialize({ scrollback: SCROLLBACK });
      } catch (e) {
        this.log(`copying the screen for a page failed: ${e.message}`);
      }
      finish(data);
    });
  }

  disconnect(ws) {
    this.pages.delete(ws);
    this.lastSeen = Date.now();
  }

  /** The page that runs the coach's tools: the visible one used most recently. */
  toolPage() {
    let best = null;
    for (const ws of this.pages) {
      if (ws.readyState !== 1 || ws.ccQueue) continue;
      if (!best || (ws.ccVisible && !best.ccVisible) || (ws.ccVisible === best.ccVisible && ws.ccActive > best.ccActive)) best = ws;
    }
    return best;
  }

  // ---- the CLI ------------------------------------------------------------------------------

  /** Starts (or restarts) the session. `request` follows the first prompt (a button pressed while no session ran). */
  start({ request } = {}) {
    this.kill();
    const settings = readSettings(this.userId);
    const provider = settings.provider;
    this.provider = provider;
    if (!isProvider(provider)) return this.setState('error', 'Unknown coach.');
    this.token = randomBytes(24).toString('hex');
    let cmd;
    try {
      cmd = launchCommand(provider, {
        userId: this.userId,
        port: this.port,
        token: this.token,
        mcpScript: this.mcpScript,
        model: settings.models[provider],
        instructions: buildCliInstructions({ language: this.language, profile: this.profile, voiceOn: this.voiceOn }),
      });
    } catch (e) {
      return this.setState('error', `Could not prepare ${PROVIDERS[provider].label}: ${e.message}`);
    }
    if (!cmd) return this.setState('missing', `${PROVIDERS[provider].label} is not installed yet.`);
    const gen = ++this.generation;
    const mirror = new Terminal({ cols: this.cols, rows: this.rows, scrollback: SCROLLBACK, allowProposedApi: true, windowsPty: WINDOWS_PTY });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer);
    let proc;
    try {
      proc = pty.spawn(cmd.file, process.platform === 'win32' ? windowsCommandLine(cmd.args) : cmd.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: cmd.cwd,
        env: cmd.env,
      });
    } catch (e) {
      mirror.dispose();
      return this.setState('error', `Could not start ${PROVIDERS[provider].label}: ${e.message}`);
    }
    this.mirror = mirror;
    this.serializer = serializer;
    this.proc = proc;
    this.trustKeys = 0;
    this.voiceTold = this.voiceOn; // the standing instructions written at launch say so
    const initial = settings.initialPrompt.trim() || DEFAULT_INITIAL_PROMPT;
    this.firstPrompt = oneLine(initial);
    this.pending = oneLine(request ? `${initial} After that, my first request: ${request}` : initial);
    this.pendingTimer = setTimeout(() => this.typePending(), FIRST_PROMPT_FALLBACK);
    this.engaged = false;
    this.offerStart = false;
    this.signIn = false;
    this.signInChecked = false;
    this.scheduleOffer();
    this.watchSignIn(gen);
    this.broadcast({ t: 'reset' });
    this.setState('running');
    this.log(`${PROVIDERS[provider].label} started`);
    proc.onData(d => {
      if (gen !== this.generation) return;
      mirror.write(d);
      this.broadcast({ t: 'out', d });
      this.scheduleScreenCheck();
    });
    proc.onExit(({ exitCode }) => {
      if (gen !== this.generation) return;
      this.proc = null;
      this.token = null;
      this.clearPending();
      this.setState('exited', `${PROVIDERS[provider].label} has ended${exitCode ? ` (exit code ${exitCode})` : ''}.`);
    });
  }

  kill() {
    this.generation++;
    clearTimeout(this.busyTimer);
    this.busyTimer = null;
    clearTimeout(this.voiceTimer);
    this.voiceTimer = null;
    clearTimeout(this.signInTimer);
    this.signInTimer = null;
    clearTimeout(this.offerTimer);
    this.offerTimer = null;
    this.signIn = false;
    this.offerStart = false;
    this.clearPending();
    this.token = null;
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    this.mirror?.dispose();
    this.mirror = null;
    this.serializer = null;
    this.busy = false;
  }

  stop() {
    this.kill();
    this.setState('exited', 'The coach session was stopped.');
  }

  /** The coach chosen in Settings changed: switch sessions right away when the app is open. */
  providerChanged() {
    if (this.pages.size) this.start();
    else {
      this.kill();
      this.provider = null;
      this.setState('idle');
    }
  }

  // ---- first prompt -------------------------------------------------------------------------

  clearPending() {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
  }

  /** The coach's MCP client listed the chess tools: it is ready, so the first prompt can go in. */
  toolsListed() {
    if (!this.pending) return;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.typePending(), 1500); // let the input box settle
  }

  typePending() {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (!this.pending || !this.proc) return;
    if (!this.signInChecked || this.signIn || SETUP_SCREEN.test(this.screen().join('\n'))) {
      this.pendingTimer = setTimeout(() => this.typePending(), 2000); // signing in or another set-up step: wait
      return;
    }
    const text = this.pending;
    this.pending = null;
    this.type(text);
    this.broadcast(this.status());
  }

  /**
   * The first start of a coach program asks the student to sign in (in the terminal, with their browser). Claude Code
   * and Codex can say whether that is done; until it is, the first prompt waits — typed into a sign-in screen, it was
   * lost, and the coach never greeted the student.
   */
  async watchSignIn(gen) {
    clearTimeout(this.signInTimer);
    this.signInTimer = null;
    const ok = await signedIn(this.provider).catch(() => null);
    if (gen !== this.generation) return;
    this.signInChecked = true;
    const waiting = ok === false && !!this.pending;
    if (waiting !== this.signIn) {
      this.signIn = waiting;
      this.log(waiting ? 'waiting for the student to sign in' : 'signed in');
      if (!waiting && this.pending) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = setTimeout(() => this.typePending(), 2500); // (the CLI's own screens come first)
      }
      this.broadcast(this.status());
    }
    if (waiting) this.signInTimer = setTimeout(() => this.watchSignIn(gen), SIGN_IN_CHECK);
  }

  /** The window offers "Start training with …" if the coach has not started working a while after (re)starting. */
  scheduleOffer() {
    clearTimeout(this.offerTimer);
    const gen = this.generation;
    this.offerTimer = setTimeout(() => {
      this.offerTimer = null;
      if (gen !== this.generation || this.engaged || this.offerStart) return;
      this.offerStart = true;
      this.broadcast(this.status());
    }, OFFER_START_AFTER);
  }

  /** The coach called one of its tools: it has started working (on the start-up prompt, or on the student's words). */
  engage() {
    if (this.engaged) return;
    this.engaged = true;
    clearTimeout(this.offerTimer);
    this.offerTimer = null;
    this.broadcast(this.status());
  }

  /**
   * "Start training with …": the start-up prompt now — the waiting one, or again (the first may have gone into a
   * sign-in screen). Not while the student still has to sign in. Returns { sent, started?, reason? }.
   */
  async startTraining() {
    if (this.state !== 'running' || !this.proc) {
      this.start();
      return { sent: this.state === 'running', started: true };
    }
    if (this.signIn) {
      const gen = this.generation;
      const ok = await signedIn(this.provider).catch(() => null);
      if (gen !== this.generation) return { sent: false, reason: 'restarted' };
      if (ok === false) return { sent: false, reason: 'sign-in' };
      clearTimeout(this.signInTimer);
      this.signInTimer = null;
      this.signIn = false;
    }
    const text = this.pending || this.firstPrompt;
    this.clearPending();
    this.offerStart = false;
    const sent = this.type(text);
    this.scheduleOffer();
    this.broadcast(this.status());
    return { sent };
  }

  // ---- screen watching ----------------------------------------------------------------------

  screen() {
    const b = this.mirror?.buffer.active;
    if (!b) return [];
    const lines = [];
    for (let y = b.baseY; y < b.baseY + this.rows; y++) lines.push(b.getLine(y)?.translateToString(true) || '');
    return lines;
  }

  scheduleScreenCheck() {
    if (this.busyTimer) return;
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      const mirror = this.mirror;
      mirror?.write('', () => {
        if (mirror !== this.mirror) return;
        const screen = this.screen();
        const busy = screen.some(l => BUSY_RE.test(l));
        if (busy !== this.busy) {
          this.busy = busy;
          this.broadcast(this.status());
        }
        if (this.provider === 'claude-code' && this.trustKeys < 8) this.answerTrust(screen);
      });
    }, 250);
  }

  /** Moves the menu cursor to "Yes, I trust this folder" and confirms (each key press redraws, which re-runs this). */
  answerTrust(screen) {
    const yes = screen.findIndex(l => TRUST_YES.test(l));
    const cursor = screen.findIndex(l => MENU_CURSOR.test(l));
    if (yes < 0 || cursor < 0 || !screen.some(l => /trust/i.test(l.replace(TRUST_YES, '')))) return;
    this.trustKeys++;
    this.proc?.write(cursor === yes ? '\r' : cursor < yes ? '\x1b[B' : '\x1b[A');
  }

  // ---- input --------------------------------------------------------------------------------

  input(data) {
    this.proc?.write(data);
  }

  /** Types a line into the coach and presses Enter (no control characters). */
  type(text) {
    const line = oneLine(text);
    if (!this.proc || !line) return false;
    const proc = this.proc;
    proc.write(line);
    setTimeout(() => this.proc === proc && proc.write('\r'), 250); // separately, so it is not taken as part of a paste
    return true;
  }

  /**
   * A request from an app button. ifIdle: only when the coach is free (automatic move comments).
   * Returns { sent, started?, queued?, reason? }.
   */
  request(line, { ifIdle = false } = {}) {
    line = oneLine(line);
    if (!line) return { sent: false, reason: 'empty' };
    if (this.state !== 'running') {
      if (ifIdle) return { sent: false, reason: 'not_running' };
      this.start({ request: line });
      return { sent: this.state === 'running', started: true };
    }
    if (this.pending) {
      if (ifIdle) return { sent: false, reason: 'starting' };
      this.pending = oneLine(`${this.pending} After that: ${line}`);
      return { sent: true, queued: true };
    }
    if (ifIdle && this.busy) return { sent: false, reason: 'busy' };
    return { sent: this.type(line) };
  }

  /**
   * The student switched the coach's voice on or off: tell the running coach (its standing instructions only know
   * the state at launch). Quick toggles are coalesced; while the coach works, the note waits until it is free.
   */
  setVoice(on) {
    this.voiceOn = !!on;
    clearTimeout(this.voiceTimer);
    this.voiceTimer = setTimeout(() => this.tellVoice(), 1200);
  }

  tellVoice(tries = 0) {
    this.voiceTimer = null;
    const on = this.voiceOn;
    if (this.state !== 'running' || !this.proc || on === this.voiceTold) return;
    if (this.pending) {
      this.pending = oneLine(`${this.pending} ${VOICE_NOTICE(on)}`);
      this.voiceTold = on;
      return;
    }
    if (this.busy) {
      if (tries < 300) this.voiceTimer = setTimeout(() => this.tellVoice(tries + 1), 1000);
      return;
    }
    if (this.type(VOICE_NOTICE(on))) this.voiceTold = on;
  }

  interrupt() {
    this.proc?.write('\x1b');
  }

  resize(cols, rows) {
    cols = clampSize(cols, 20, 400, this.cols);
    rows = clampSize(rows, 5, 200, this.rows);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.proc?.resize(cols, rows);
    } catch {
      /* exited */
    }
    this.mirror?.resize(cols, rows);
  }
}
