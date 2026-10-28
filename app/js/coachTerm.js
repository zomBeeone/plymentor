// The coach in the window: one xterm.js terminal for the whole app, connected to the app's coach host (in the main
// process, desktop/host.js), which runs the coach (Claude Code, Codex or Antigravity CLI) with the student's own
// subscription. Coach panels borrow the terminal's element while they are on screen.
//
// The connection is an Electron message port (asked for through the preload's window.plymentor). The host
// forwards the coach's tool calls to this page: they run here (Stockfish, the student's games, the board) and the
// result goes back to the coach. The coach's own settings and its notes about the student are kept by the host, per
// profile, on the student's computer.
import { useEffect, useRef } from '../vendor/preact.js';
import { Terminal, FitAddon, WebLinksAddon } from '../vendor/xterm.js';
import { post } from './api.js';
import { setState, state, toast } from './store.js';
import { navigate, parseHash } from './router.js';
import { coachSays, stopSpeaking } from './voice.js';
import { engineSwitches, setEngineSwitch } from './engine.js';
import { COACH_PROTOCOL, APP_VERSION } from '../../shared/protocol.js';
import { CLI_TASKS } from '../../shared/prompts.js';
import { SCREENS, ENGINE_LABELS } from '../../shared/tools.js';

const THEME = {
  background: '#161512',
  foreground: '#d8d6d3',
  cursor: '#e6e3df',
  cursorAccent: '#161512',
  selectionBackground: '#3d5f88',
  black: '#2a2926',
  red: '#e0605b',
  green: '#7cb342',
  yellow: '#e6b450',
  blue: '#5a9ee6',
  magenta: '#c27ad6',
  cyan: '#4fb8b3',
  white: '#d8d6d3',
  brightBlack: '#77736d',
  brightRed: '#f07a74',
  brightGreen: '#9ccc65',
  brightYellow: '#f2c76b',
  brightBlue: '#7db4f0',
  brightMagenta: '#d69be6',
  brightCyan: '#6fd0cb',
  brightWhite: '#ffffff',
};

let term = null;
let fit = null;
let ws = null; // the connection to the coach host: { readyState, send, close }
let connectGen = 0;
let holder = null;
let retry = 0;
let retryTimer = 0;
let host = null; // the panel element currently showing the terminal
let observer = null;
let resizeTimer = 0;
let pendingUi = null;
let follow = true; // the terminal shows the newest output, unless the student scrolled up to read
let reqSeq = 0;
const replies = new Map(); // request id -> { resolve, reject, timer, onEvent }
const screens = []; // registered views, most recent last

const send = msg => {
  if (ws?.readyState !== 1) return false;
  ws.send(JSON.stringify(msg));
  return true;
};

function setStatus(patch) {
  setState(s => ({ coachStatus: { ...(s.coachStatus || {}), ...patch } }));
}

/** Creates the terminal and connects to the coach host (once, at start-up). */
export function initCoach() {
  if (term) return;
  holder = document.createElement('div');
  holder.className = 'term-holder';
  document.body.appendChild(holder);
  term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    lineHeight: 1.12,
    cursorBlink: true,
    scrollback: 5000,
    theme: THEME,
    allowProposedApi: true,
    rescaleOverlappingGlyphs: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => {
      // sign-in links of the CLIs and the like open in the student's web browser
      if (/^https?:\/\//i.test(uri)) window.plymentor?.openExternal(uri);
    }),
  );
  term.open(holder);
  // Moving the terminal between panels and resizing it make the browser scroll it by itself, which xterm.js takes for
  // the student's scrolling (and then stops following the output): only the student's own scrolling up counts.
  term.element.addEventListener('wheel', e => e.deltaY < 0 && (follow = false), { passive: true });
  term.element.addEventListener('mousedown', e => e.target.closest?.('.xterm-scrollable-element > .scrollbar') && (follow = false));
  term.onScroll(() => {
    const b = term.buffer.active;
    if (b.viewportY >= b.baseY) follow = true;
  });
  term.onData(d => send({ t: 'in', d }));
  term.attachCustomKeyEventHandler(e => {
    if (e.type === 'keydown' && e.shiftKey && e.key === 'PageUp') follow = false;
    if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey)) return true;
    const k = e.key.toLowerCase();
    // Ctrl+C copies selected text instead of interrupting the coach; Ctrl+V is left to the window's paste.
    if (k === 'c' && term.hasSelection()) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      return false;
    }
    if (k === 'v') return false;
    return true;
  });
  setStatus({ state: 'connecting' });
  connect();
  document.addEventListener('visibilitychange', () => send({ t: 'visible', visible: !document.hidden }));
}

/** Asks the main process for a message port to the coach host. */
function openPort() {
  return new Promise((resolve, reject) => {
    const desktop = window.plymentor;
    if (!desktop) return reject(new Error('Plymentor is not running as the desktop app.'));
    const onMessage = e => {
      if (e.source !== window || e.data?.plymentor !== 'coach-port' || !e.ports?.[0]) return;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(e.ports[0]);
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('The coach host did not answer.'));
    }, 10_000);
    window.addEventListener('message', onMessage);
    desktop.connectCoach();
  });
}

export function reconnectNow() {
  clearTimeout(retryTimer);
  retry = 0;
  if (!ws) connect();
}

async function connect() {
  clearTimeout(retryTimer);
  const gen = ++connectGen;
  let port;
  try {
    port = await openPort();
  } catch (e) {
    if (gen !== connectGen) return;
    setStatus({ state: 'offline', busy: false, starting: false, message: e.message });
    scheduleReconnect();
    return;
  }
  if (gen !== connectGen) return port.close();
  const socket = {
    readyState: 1,
    send: data => port.postMessage(data),
    close: () => {
      if (socket.readyState !== 1) return;
      socket.readyState = 3;
      port.close();
      closed(socket);
    },
  };
  ws = socket;
  port.onmessage = ev => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(m);
  };
  port.onclose = () => socket.close(); // the host went away (the app is closing)
  // The host answers at once with the coach's status; a connection without an answer is useless: start a new one.
  setTimeout(() => !socket.ready && socket.close(), 10_000);
  retry = 0;
  const s = state.settings || {};
  send({
    t: 'hello',
    protocol: COACH_PROTOCOL,
    appVersion: APP_VERSION,
    user: { id: state.user?.id },
    profile: s.profile || {},
    language: s.language || 'English',
    voice: { enabled: !!s.voice?.enabled },
    cols: term.cols,
    rows: term.rows,
    visible: !document.hidden,
  });
}

function closed(socket) {
  if (ws === socket) ws = null;
  for (const [id, r] of replies) {
    clearTimeout(r.timer);
    r.reject(new Error('The connection to the coach was lost.'));
    replies.delete(id);
  }
  if (state.coachStatus?.state !== 'outdated') setStatus({ state: 'connecting', busy: false, starting: false, message: 'Connecting to the coach…' });
  scheduleReconnect();
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  if (state.coachStatus?.state === 'outdated') return;
  retryTimer = setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(retry++, 4)));
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      if (m.protocol !== COACH_PROTOCOL) {
        setStatus({ state: 'outdated', message: `The coach host (${m.version || 'another version'}) does not match this window. Restart Plymentor.` });
        ws?.close();
        return;
      }
      setState({ host: { version: m.version, providers: m.providers || {}, settings: m.settings || {}, defaultInitialPrompt: m.defaultInitialPrompt || '', home: m.home || '' } });
      if (m.windowsPty && !term.options.windowsPty) term.options.windowsPty = m.windowsPty;
      if (host) refit();
      return;
    case 'status':
      if (ws) ws.ready = true;
      setStatus({ state: m.state, starting: m.starting, busy: m.busy, provider: m.provider, label: m.label, name: m.name, signIn: m.signIn, offerStart: m.offerStart, message: m.message });
      return;
    case 'settings':
      setState(s => ({ host: { ...(s.host || {}), settings: m.settings } }));
      return;
    case 'out':
      term.write(m.d, keepAtBottom);
      return;
    case 'snapshot':
      term.reset();
      term.write(m.d, keepAtBottom);
      return;
    case 'reset':
      term.reset();
      return;
    case 'tool':
      runTool(m);
      return;
    case 'reply': {
      const r = replies.get(m.id);
      if (!r) return;
      if (m.event) {
        r.onEvent?.(m.event);
        return;
      }
      replies.delete(m.id);
      clearTimeout(r.timer);
      if (m.error) r.reject(new Error(m.error));
      else r.resolve(m.data);
      return;
    }
    case 'error':
      toast(m.message, 'error', 7000);
      return;
  }
}

/** A request to the coach host that gets an answer (settings, notes, installation…). */
export function hostRequest(type, data = {}, { timeout = 30_000, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++reqSeq;
    if (!send({ t: 'req', id, type, ...data })) return reject(new Error('The coach is not connected yet. Try again in a moment.'));
    const timer = timeout
      ? setTimeout(() => {
          replies.delete(id);
          reject(new Error('The coach host did not answer in time.'));
        }, timeout)
      : 0;
    replies.set(id, { resolve, reject, timer, onEvent });
  });
}

// ---------------------------------------------------------------------------------------------
// The coach's tools

// The tools that change the screen run one after the other, in the order they came: a set_board (or set_engine) right
// after (or together with) a switch_screen goes to the new screen.
const SCREEN_TOOLS = new Set(['switch_screen', 'set_board', 'open_game', 'set_engine']);
let screenTools = Promise.resolve();

function runTool(m) {
  if (!SCREEN_TOOLS.has(m.name)) return execTool(m);
  const run = screenTools.then(() => execTool(m));
  screenTools = run.catch(() => {});
  return run;
}

async function execTool({ id, name, arguments: args }) {
  let result;
  try {
    const body = { arguments: args && typeof args === 'object' ? args : {} };
    // what the student sees; set_board uses the line on their board to play a position out from it, set_engine the
    // screen they are on
    if (name === 'get_board_state' || name === 'set_board' || name === 'set_engine') body.screen = currentScreen();
    result = await post(`/api/agent/tools/${encodeURIComponent(String(name))}`, body);
    if (name === 'switch_screen' && !result?.isError) await screenShown(SCREENS[body.arguments.screen]?.view, body.arguments.tab);
  } catch (e) {
    result = { content: `The Plymentor app could not run this tool: ${e.message}`, isError: true };
  }
  send({ t: 'tool-result', id, content: String(result?.content ?? ''), isError: !!result?.isError });
}

// ---------------------------------------------------------------------------------------------
// Panels

/** Back to the newest output, unless the student scrolled up to read. */
function keepAtBottom() {
  const b = term.buffer.active;
  if (follow && b.viewportY < b.baseY) term.scrollToBottom();
}

function refit() {
  if (!host || !host.isConnected || !host.offsetWidth || !host.offsetHeight) return;
  try {
    fit.fit();
  } catch {
    return;
  }
  keepAtBottom();
  send({ t: 'resize', cols: term.cols, rows: term.rows });
}

/** Shows the terminal inside `el` (a coach panel). */
export function attachTerminal(el) {
  if (!el) return;
  initCoach();
  host = el;
  el.appendChild(term.element);
  observer?.disconnect();
  observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refit, 60);
  });
  observer.observe(el);
  follow = true; // a panel that appears shows the newest output
  refit();
  term.scrollToBottom();
  term.refresh(0, term.rows - 1);
  requestAnimationFrame(() => requestAnimationFrame(keepAtBottom)); // (after the browser has scrolled the moved element)
}

/** The panel is going away: park the terminal off-screen (it keeps receiving output). */
export function detachTerminal(el) {
  if (!term || host !== el) return;
  observer?.disconnect();
  observer = null;
  host = null;
  holder.appendChild(term.element);
}

export const focusTerminal = () => term?.focus();

// ---------------------------------------------------------------------------------------------
// Requests from the app's buttons

/** Asks the coach something on the student's behalf. task: a request template (shared/prompts.js); text: typed as is. */
export async function coachRequest({ task, taskArgs, text, ifIdle = false } = {}) {
  let line;
  if (task) {
    if (!Object.hasOwn(CLI_TASKS, task)) return { sent: false };
    line = CLI_TASKS[task](taskArgs || {});
  } else line = String(text || '').trim();
  if (!line) return { sent: false };
  try {
    const r = await hostRequest('prompt', { line, ifIdle }, { timeout: 15_000 });
    if (!r.sent && !ifIdle) toast('The coach could not take the request right now.', 'error');
    return r;
  } catch (e) {
    if (!ifIdle) toast(e.message, 'error');
    return { sent: false };
  }
}

/** "Start training with …": the coach session's start-up prompt, now (not while the student still has to sign in). */
export async function startTraining() {
  const name = state.coachStatus?.name || 'your coach';
  try {
    const r = await hostRequest('start-training', {}, { timeout: 20_000 });
    if (!r.sent) toast(r.reason === 'sign-in' ? `Sign in to ${name} in the terminal first — it opens your browser for it.` : 'The coach could not take the request right now.', 'error', 6000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function interruptCoach() {
  stopSpeaking();
  return hostRequest('interrupt').catch(() => {});
}

export function restartCoach() {
  stopSpeaking();
  return hostRequest('restart').catch(e => toast(e.message, 'error'));
}

/** Installs or updates a coach CLI; onLog receives the installer's output. Resolves with the CLI's status. */
export function installCoachCli(provider, onLog) {
  return hostRequest('install', { provider }, { timeout: 0, onEvent: ev => ev.log && onLog?.(ev.log) });
}

/** Tells the coach host about changes the coach should know (the profile and language are in its instructions). */
export function coachProfileChanged(settings) {
  send({ t: 'profile', profile: settings.profile || {}, language: settings.language || 'English' });
}

export function coachVoiceChanged(on) {
  send({ t: 'voice', enabled: !!on });
}

/** The parts of a move judgement the coach needs for a comment. */
export function compactMoveEval(m) {
  return {
    san: m.san,
    uci: m.uci,
    moveNumber: m.moveNumber,
    color: m.color,
    classification: m.classification,
    winBefore: m.winBefore,
    winAfter: m.winAfter,
    best: m.best ? { san: m.best.san, uci: m.best.uci, line: m.best.line } : null,
    reply: m.reply ? { line: m.reply.line } : null,
    gameOver: m.gameOver || null,
  };
}

// ---------------------------------------------------------------------------------------------
// What the coach sees, and what it can do on the screen

/**
 * Registers the current screen: what the coach gets from get_board_state (getContext) and how the screen
 * handles the coach's UI actions (onUi returns true when it handled one).
 */
export function useCoachScreen(view, getContext, onUi) {
  const ref = useRef(null);
  ref.current = { view, getContext, onUi };
  useEffect(() => {
    const entry = ref;
    screens.push(entry);
    return () => {
      const i = screens.indexOf(entry);
      if (i >= 0) screens.splice(i, 1);
    };
  }, []);
}

// The route of each screen a view registers (Games and Settings register none).
const ROUTE_OF = { analysis: 'analysis', play: 'analysis', openings: 'openings', drill: 'openings', exercises: 'train', lesson: 'train', reports: 'reports' };
const REGISTERING = new Set(Object.values(ROUTE_OF));

/** Resolves once the window shows the screen of the route `view` (and Train's tab), ready for the coach — at most 3 s. */
function screenShown(view, tab) {
  const t0 = Date.now();
  return new Promise(resolve => {
    const check = () => {
      const top = screens.at(-1)?.current;
      const name = top && (typeof top.view === 'function' ? top.view() : top.view);
      let ready = REGISTERING.has(view) ? ROUTE_OF[name] === view : !top && parseHash().view === view;
      if (ready && view === 'train' && tab) ready = name === (tab === 'lessons' ? 'lesson' : 'exercises');
      if (ready || !view || Date.now() - t0 > 3000) resolve();
      else setTimeout(check, 25);
    };
    check();
  });
}

function currentScreen() {
  const engines = engineSwitches(); // the student's Stockfish switches
  const top = screens.at(-1)?.current;
  if (!top) return { view: parseHash().view || 'analysis', context: null, engines };
  let context = null;
  try {
    context = top.getContext?.() || null;
  } catch (e) {
    console.error('coach context failed', e);
  }
  return { view: typeof top.view === 'function' ? top.view() : top.view, context, engines };
}

/** UI actions of the coach's tools (pushed by the backend worker on the 'coach-ui' topic). */
export function onCoachUi(ev) {
  if (!ev || ev.type !== 'ui') return;
  if (ev.action === 'speak') return coachSays(ev);
  if (ev.action === 'exercise_created') setState(s => ({ exercisesDue: (s.exercisesDue || 0) + 1 }));
  if (ev.action === 'report_created') toast(`Your coach added the report “${ev.title}” to the Reports screen.`, 'success', 6000);
  if (ev.action === 'set_engine') {
    const changed = (Array.isArray(ev.screens) ? ev.screens : []).filter(s => setEngineSwitch(s, !!ev.on));
    if (changed.length) toast(`Your coach turned ${ev.on ? 'on' : 'off'} Stockfish on the ${changed.map(s => ENGINE_LABELS[s]).join(' and ')} screen${changed.length > 1 ? 's' : ''}.`);
  }
  window.dispatchEvent(new CustomEvent('cc:coach-ui', { detail: ev }));
  // switch_screen: the screen takes its tab from the route (and drops it from the address once it has it)
  if (ev.action === 'switch_screen') return navigate(`#/${encodeURIComponent(ev.view)}${ev.tab ? `?tab=${encodeURIComponent(ev.tab)}` : ''}`);
  if (ev.action !== 'set_board' && ev.action !== 'open_game') return;
  const top = screens.at(-1)?.current;
  if (top?.onUi?.(ev) === true) return;
  if (ev.action === 'open_game') navigate(`#/analysis?game=${Number(ev.gameId)}&ply=${Number(ev.ply) || 0}`);
  else {
    pendingUi = ev; // the analysis board picks it up when it opens
    navigate('#/analysis');
  }
}

/** A set_board action that arrived while no screen could show it. */
export function takePendingUi() {
  const ev = pendingUi;
  pendingUi = null;
  return ev;
}
