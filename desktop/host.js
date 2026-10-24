// The coach host of the Plymentor desktop app (it runs in Electron's main process, see main.js): runs the coach —
// Claude Code, Codex or Antigravity CLI, with the student's own subscription — in a pseudo-terminal and connects it to
// the app's window.
//
// The window talks to the host over a message port (main.js hands one to every page load and wraps it in a small
// socket-like object, see connectPage). The coach's MCP server (mcp.cjs, started by the CLI) calls /agent/tools on
// 127.0.0.1 with a secret that is new for every coach session; the host passes each call to the window (Stockfish, the
// games, the board) or answers it itself (the coach's notes about the student).
//
// Per profile (the page says which one), the host keeps the coach's settings and its notes about the student in
// %LOCALAPPDATA%\Plymentor\users\<profile id>\ — on the student's computer.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CoachSession, WINDOWS_PTY } from './terminal.js';
import { PROVIDERS, isProvider, cliStatus, installCli } from './cli.js';
import { HOME_DIR, isAccountId, readSettings, updateSettings, readMemory, writeMemory, appendMemory, memoryPath, MEMORY_SOFT_LIMIT } from './store.js';
import { legacyInfo, legacyRows, legacyConfig, closeLegacy } from './legacy.js';
import { MCP_TOOLS, HOST_TOOLS, toolDef, validate, toolLabel } from '../shared/tools.js';
import { DEFAULT_INITIAL_PROMPT } from '../shared/prompts.js';
import { untrustedText } from '../shared/untrusted.js';
import { COACH_PROTOCOL, APP_VERSION } from '../shared/protocol.js';

const TOOL_TIMEOUT = 280_000; // the coaches give up on a tool after 300 s
const OPEN = 1; // socket.readyState of a connected page (as in WebSocket)

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

const pct = (x, n) => `${Math.round((100 * x) / (n || 1))}%`;
const gameLine = g =>
  `#${g.id} ${g.white}${g.whiteElo ? ` (${g.whiteElo})` : ''} – ${g.black}${g.blackElo ? ` (${g.blackElo})` : ''} ${g.result}${g.event ? `, ${g.event}` : ''}${g.year ? `, ${g.year}` : ''}`;

/** An explorer answer as text for the coach. */
export function formatExplorer(db, r) {
  const total = r.white + r.draws + r.black;
  if (r.source === 'none' || !total) return `${db}: no game reached this position${r.source === 'none' ? ' (or it is beyond the opening index and no line from the start was given)' : ''}.`;
  const lines = [
    `${db}: ${total.toLocaleString('en-US')} games reached this position${r.source === 'games' ? ' (beyond the opening index: counted from the games that took this line)' : ''} — White won ${pct(r.white, total)}, draws ${pct(r.draws, total)}, Black won ${pct(r.black, total)}.`,
    '',
    'Moves played here:',
  ];
  for (const m of r.moves.slice(0, 12)) {
    const n = m.white + m.draws + m.black;
    lines.push(`- ${m.san || m.uci}: ${n.toLocaleString('en-US')} games, White ${pct(m.white, n)} / draw ${pct(m.draws, n)} / Black ${pct(m.black, n)}${m.averageRating ? `, average rating ${m.averageRating}` : ''}${m.lastYear ? `, last played ${m.lastYear}` : ''}`);
  }
  if (r.moves.length > 12) lines.push(`- … and ${r.moves.length - 12} more moves`);
  if (r.topGames?.length) {
    lines.push('', r.source === 'games' ? 'Games (strongest first):' : 'Strongest games from here:');
    for (const g of r.topGames.slice(0, 8)) lines.push(`- ${gameLine(g)}`);
  }
  return lines.join('\n');
}

export class CoachHost {
  /**
   * mcpScript: the MCP server the coach CLIs start (mcp.cjs); port: where the MCP bridge listens (0 = any free port);
   * log(text): where the host writes what happens.
   */
  constructor({ mcpScript, port = 0, log = () => {}, databases = null }) {
    this.mcpScript = mcpScript;
    this.wantedPort = port;
    this.port = 0;
    this.log = log;
    this.databases = databases; // the game database (gigabase/manager.js), for database_explorer and get_database_game
    this.sessions = new Map(); // profile id -> CoachSession
    this.toolCalls = new Map(); // call id -> { resolve, ws, timer }
    this.callSeq = 0;
    this.installing = new Set();
    this.server = createServer((req, res) => this.onHttp(req, res));
  }

  /** Starts the MCP bridge on 127.0.0.1. Resolves with the port. */
  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.wantedPort, '127.0.0.1', () => {
        this.server.off('error', reject);
        this.port = this.server.address().port;
        this.allowedHosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);
        resolve(this.port);
      });
    });
  }

  /** Ends every coach session and the bridge (the app is closing). */
  close() {
    for (const s of this.sessions.values()) s.kill();
    for (const [id, call] of this.toolCalls) {
      clearTimeout(call.timer);
      call.resolve({ content: 'Plymentor was closed.', isError: true });
      this.toolCalls.delete(id);
    }
    closeLegacy();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  sessionFor(userId) {
    let s = this.sessions.get(userId);
    if (!s) {
      s = new CoachSession({ userId, port: this.port, mcpScript: this.mcpScript, log: m => this.log(`[coach] ${m}`) });
      this.sessions.set(userId, s);
    }
    return s;
  }

  // -------------------------------------------------------------------------------------------
  // The coach's tools: the host answers the notes itself; everything else runs in the app's window.

  async callTool(session, name, args) {
    session.engage?.(); // the coach is working (the window stops offering "Start training with …")
    const def = toolDef(name);
    if (!def) return { content: `Unknown tool ${name}`, isError: true };
    const errs = validate(def.input_schema, args);
    if (errs.length) return { content: `Invalid input for ${name}: ${errs.join('; ')}`, isError: true };
    this.log(`[tool] ${toolLabel(name, args)}`);
    if (name === 'database_explorer' || name === 'get_database_game') return this.databaseTool(name, args);
    if (HOST_TOOLS.has(name)) {
      if (name === 'get_player_memory') return { content: readMemory(session.userId).trim() || '(No notes yet — this is a new student.)', isError: false };
      const text = String(args.text || '').trim();
      if (!text) return { content: 'Nothing to save.', isError: true };
      const doc = args.mode === 'replace' ? writeMemory(session.userId, `${text}\n`, { keepPrevious: true }) : appendMemory(session.userId, text);
      this.broadcastToUser(session, { t: 'memory', length: doc.length });
      return { content: `Saved. Your notes are ${doc.length} characters long${doc.length > MEMORY_SOFT_LIMIT ? ' — getting long: condense them soon with mode "replace"' : ''}.`, isError: false };
    }
    const ws = session.toolPage();
    if (!ws) return { content: 'The Plymentor window is not ready right now, so this tool cannot run. Try again in a moment.', isError: true };
    const id = ++this.callSeq;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.toolCalls.delete(id);
        resolve({ content: 'The Plymentor window did not answer in time.', isError: true });
      }, TOOL_TIMEOUT);
      this.toolCalls.set(id, { resolve, ws, timer });
      ws.send(JSON.stringify({ t: 'tool', id, name, arguments: args }));
    });
  }

  /** database_explorer and get_database_game, answered from the game database the student added. */
  async databaseTool(name, args) {
    const status = this.databases?.status();
    if (!status?.installed)
      return { content: 'The student has not added a game database yet. They can add a Scid 5 database (.si5, or a .7z archive with one) in Openings → Explorer → Database.', isError: true };
    const db = `${status.installed.title} (${status.installed.games.toLocaleString('en-US')} games)`;
    try {
      if (name === 'get_database_game') {
        const g = await this.databases.request('game', { id: args.game_id });
        return { content: `${db}, game #${g.id}:\n\n${g.pgn}`, isError: false };
      }
      const r = await this.databases.request('explore', { fen: args.fen, moves: args.moves || [] });
      return { content: formatExplorer(db, r), isError: false };
    } catch (e) {
      return { content: `The game database could not answer: ${e.message}`, isError: true };
    }
  }

  toolResult(ws, m) {
    const call = this.toolCalls.get(m.id);
    if (!call || call.ws !== ws) return; // only the page that was asked can answer
    this.toolCalls.delete(m.id);
    clearTimeout(call.timer);
    call.resolve({ content: String(m.content ?? '').slice(0, 1_000_000), isError: !!m.isError });
  }

  pageGone(ws) {
    for (const [id, call] of this.toolCalls)
      if (call.ws === ws) {
        this.toolCalls.delete(id);
        clearTimeout(call.timer);
        call.resolve({ content: 'The Plymentor window was closed or reloaded before the tool finished.', isError: true });
      }
  }

  broadcastToUser(session, msg) {
    const data = JSON.stringify(msg);
    for (const ws of session.pages) if (ws.readyState === OPEN && !ws.ccQueue) ws.send(data);
  }

  // -------------------------------------------------------------------------------------------
  // Requests from the page ({ t: 'req', id, type, ... } -> { t: 'reply', id, data | error | event })

  requests() {
    return {
      prompt: (s, m) => s.request(String(m.line || ''), { ifIdle: !!m.ifIdle }),
      'start-training': s => s.startTraining(),
      restart: s => (s.start(), s.status()),
      stop: s => (s.stop(), s.status()),
      interrupt: s => (s.interrupt(), { ok: true }),
      'settings-get': s => readSettings(s.userId),
      'settings-set': (s, m) => {
        const before = readSettings(s.userId);
        const next = updateSettings(s.userId, m.patch && typeof m.patch === 'object' ? m.patch : {});
        this.broadcastToUser(s, { t: 'settings', settings: next });
        if (next.provider !== before.provider) s.providerChanged();
        return next;
      },
      'memory-get': s => ({ text: readMemory(s.userId), file: memoryPath(s.userId) }),
      'memory-set': (s, m) => ({ text: writeMemory(s.userId, String(m.text ?? '')) }),
      clis: (s, m) => Promise.all(Object.keys(PROVIDERS).map(id => cliStatus(id, { fresh: !!m.fresh }))),
      install: async (s, m, event) => {
        const id = String(m.provider || '');
        if (!isProvider(id)) throw new Error('Unknown coach');
        if (this.installing.has(id)) throw new Error('Already installing');
        this.installing.add(id);
        try {
          this.log(`[install] ${PROVIDERS[id].label}`);
          const status = await installCli(id, text => event({ log: text }));
          if (readSettings(s.userId).provider === id && s.pages.size && s.state !== 'running') s.start();
          return status;
        } finally {
          this.installing.delete(id);
        }
      },
      'legacy-info': () => legacyInfo(),
      'legacy-rows': (s, m) => legacyRows(String(m.table || ''), m.offset, m.limit),
      'legacy-config': () => legacyConfig(),
    };
  }

  async onRequest(ws, s, m) {
    const reply = msg => ws.readyState === OPEN && ws.send(JSON.stringify({ t: 'reply', id: m.id, ...msg }));
    const requests = (this.requestTable ||= this.requests());
    const fn = Object.hasOwn(requests, m.type) ? requests[m.type] : null;
    if (!fn) return reply({ error: `Unknown request ${m.type}` });
    try {
      reply({ data: await fn(s, m, event => reply({ event })) });
    } catch (e) {
      reply({ error: e.message || String(e) });
    }
  }

  // -------------------------------------------------------------------------------------------
  // HTTP on 127.0.0.1: only the MCP bridge (bearer token of a running coach session), never a web page

  tokenSession(req) {
    const m = /^Bearer ([0-9a-f]{48})$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    for (const s of this.sessions.values()) {
      if (!s.token) continue;
      const a = Buffer.from(s.token);
      const b = Buffer.from(m[1]);
      if (a.length === b.length && timingSafeEqual(a, b)) return s;
    }
    return null;
  }

  async onHttp(req, res) {
    if (!this.allowedHosts?.has(req.headers.host || '')) {
      res.writeHead(403);
      res.end('Forbidden host');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === '/agent/tools' || url.pathname.startsWith('/agent/tools/')) {
        if (req.headers.origin) return sendJson(res, 403, { error: 'Forbidden' });
        const s = this.tokenSession(req);
        if (!s) return sendJson(res, 401, { error: 'Unauthorized' });
        if (req.method === 'GET' && url.pathname === '/agent/tools') {
          s.toolsListed();
          return sendJson(res, 200, { tools: MCP_TOOLS });
        }
        if (req.method === 'POST') {
          const name = decodeURIComponent(url.pathname.slice('/agent/tools/'.length));
          const body = await readJson(req);
          const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {};
          // every answer carries text from games, databases, backups or notes: the coach gets it without hidden
          // characters and without anything that looks like the app's own requests (shared/untrusted.js)
          const r = await this.callTool(s, name, args);
          return sendJson(res, 200, { ...r, content: untrustedText(r.content) });
        }
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end(`Plymentor ${APP_VERSION} coach host.\n`);
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Pages

  /**
   * A page of the app connected. ws: { readyState, send(text), close(code, reason), on('message' | 'close', fn) } —
   * main.js makes one from an Electron message port (tests pass their own). The page says hello first.
   */
  connectPage(ws) {
    let session = null;
    const hello = setTimeout(() => !session && ws.close(1008, 'hello expected'), 10_000);
    ws.on('message', raw => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (!session) {
        if (m.t !== 'hello') return;
        clearTimeout(hello);
        const userId = m.user?.id;
        if (!isAccountId(userId)) return ws.close(1008, 'invalid profile');
        ws.send(
          JSON.stringify({
            t: 'welcome',
            protocol: COACH_PROTOCOL,
            version: APP_VERSION,
            windowsPty: WINDOWS_PTY,
            providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { label: p.label, name: p.name, product: p.product, account: p.account }])),
            settings: readSettings(userId),
            defaultInitialPrompt: DEFAULT_INITIAL_PROMPT,
            home: HOME_DIR,
          }),
        );
        if (m.protocol !== COACH_PROTOCOL) return; // a page of another version (the page shows it)
        session = this.sessionFor(userId);
        ws.ccVisible = m.visible !== false;
        ws.ccActive = Date.now();
        if (m.profile && typeof m.profile === 'object') session.profile = m.profile;
        if (typeof m.language === 'string') session.language = m.language.slice(0, 40);
        if (session.state !== 'running') session.voiceOn = !!m.voice?.enabled;
        else if (!!m.voice?.enabled !== session.voiceOn) session.setVoice(!!m.voice?.enabled);
        this.log('[page] connected');
        session.connect(ws, { cols: Number(m.cols), rows: Number(m.rows) });
        return;
      }
      ws.ccActive = Date.now();
      switch (m.t) {
        case 'in':
          if (typeof m.d === 'string' && m.d.length <= 64 * 1024) session.input(m.d);
          return;
        case 'resize':
          session.resize(Number(m.cols), Number(m.rows));
          return;
        case 'visible':
          ws.ccVisible = !!m.visible;
          return;
        case 'profile':
          if (m.profile && typeof m.profile === 'object') session.profile = m.profile;
          if (typeof m.language === 'string') session.language = m.language.slice(0, 40);
          return;
        case 'voice':
          session.setVoice(!!m.enabled);
          return;
        case 'tool-result':
          this.toolResult(ws, m);
          return;
        case 'req':
          if (Number.isInteger(m.id)) this.onRequest(ws, session, m);
          return;
      }
    });
    ws.on('close', () => {
      clearTimeout(hello);
      this.pageGone(ws);
      session?.disconnect(ws);
    });
  }
}
