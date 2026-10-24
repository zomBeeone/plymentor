// The coaches: Claude Code, OpenAI Codex (ChatGPT) and Google's Antigravity CLI (Gemini). Finds or installs them,
// prepares the session workspace (standing instructions + the plymentor MCP server) and builds the launch command.
// They run with the student's own login (subscription), exactly as when started in a terminal.
//
// Each one is installed with its vendor's own installer (a PowerShell script on Windows that downloads the program and
// checks its checksum), so the app needs no Node.js or npm. A copy that is a JavaScript file (an older npm install)
// is only used when a Node.js is on this computer: inside a terminal it cannot run on the app's own runtime (Electron
// as Node.js is a windowed program on Windows and gets no console). The coach's MCP server does run on the app's
// runtime: the CLIs talk to it over pipes.
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, extname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { HOME_DIR, LEGACY_DIR, isAccountId } from './store.js';

export const CLI_DIR = join(LEGACY_DIR, 'cli'); // CLIs that Chess Coach 1.x installed with npm
const WORKSPACES = join(HOME_DIR, 'coach-workspace');
const WIN = process.platform === 'win32';
const MCP_NAME = 'plymentor';
// Inside Electron, process.execPath is the app itself: it runs a JavaScript file as Node.js with this variable.
const NODE_ENV = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};

// `installer`: the vendor's own installer (the CLI then updates itself or with `update`). `npm`: the package, to find
// copies installed with npm. `env`: an environment variable that points to the program (unusual installations, tests).
export const PROVIDERS = {
  'claude-code': {
    label: 'Claude Code',
    name: 'Claude Code', // what the app calls the coach ("Start training with …")
    product: 'Claude',
    npm: '@anthropic-ai/claude-code',
    bin: 'claude',
    env: 'PLYMENTOR_CLAUDE_PATH',
    account: 'your Claude Pro or Max subscription',
    installer: { win: 'irm https://claude.ai/install.ps1 | iex', unix: 'curl -fsSL https://claude.ai/install.sh | bash' },
  },
  codex: {
    label: 'Codex CLI',
    name: 'ChatGPT',
    product: 'ChatGPT',
    npm: '@openai/codex',
    bin: 'codex',
    env: 'PLYMENTOR_CODEX_PATH',
    account: 'your ChatGPT Plus or Pro subscription',
    installer: { win: 'irm https://chatgpt.com/codex/install.ps1 | iex', unix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
    installerEnv: { CODEX_NON_INTERACTIVE: '1' }, // no "Start Codex now?" question
  },
  // Google stopped serving personal accounts in the Gemini CLI on 18 June 2026; Antigravity CLI replaces it.
  gemini: {
    label: 'Antigravity CLI',
    name: 'Gemini',
    product: 'Gemini',
    bin: 'agy',
    env: 'PLYMENTOR_AGY_PATH',
    account: 'your Google account',
    workspace: 'antigravity',
    installer: { win: 'irm https://antigravity.google/cli/install.ps1 | iex', unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    update: ['update'],
  },
};

export const isProvider = id => Object.hasOwn(PROVIDERS, id);

// ---------------------------------------------------------------------------------------------
// Finding the CLI

function packageScript(pkgDir, bin) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[bin];
    const file = rel && join(pkgDir, rel);
    return file && existsSync(file) ? { file, version: pkg.version } : null;
  } catch {
    return null;
  }
}

/** An npm install under `prefix` (local `npm i --prefix`, or the global prefix next to the .cmd shims on Windows). */
function fromNpmPrefix(prefix, p) {
  if (!p.npm) return null;
  const s = packageScript(join(prefix, 'node_modules', ...p.npm.split('/')), p.bin);
  return s ? { kind: 'node', file: s.file, version: s.version } : null;
}

function launcherFor(file, p) {
  const ext = extname(file).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(ext)) return { kind: 'node', file };
  if (['.cmd', '.bat', '.ps1'].includes(ext)) return fromNpmPrefix(dirname(file), p); // npm shim: run the package's script
  if (!WIN) {
    try {
      const real = realpathSync(file);
      if (/\.(c|m)?js$/.test(real)) return { kind: 'node', file: real };
    } catch {
      /* use as is */
    }
  }
  return { kind: 'exe', file };
}

const versionOrder = name => (name.match(/\d+/g) || []).map(Number);
function newestFirst(a, b) {
  const x = versionOrder(a);
  const y = versionOrder(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
}

/** Where the vendors' installers (and editor extensions) put the programs. */
function knownLocations(id) {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const out = [];
  if (id === 'claude-code') {
    out.push(join(home, '.local', 'bin', WIN ? 'claude.exe' : 'claude')); // native installer
    // the Claude Code extension for VS Code (and forks) ships the same CLI
    for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
      const dir = join(home, editor, 'extensions');
      try {
        for (const ext of readdirSync(dir).filter(n => n.startsWith('anthropic.claude-code-')).sort(newestFirst))
          out.push(join(dir, ext, 'resources', 'native-binary', WIN ? 'claude.exe' : 'claude'));
      } catch {
        /* not installed */
      }
    }
  }
  if (id === 'codex') {
    if (WIN) out.push(join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')); // standalone installer
    else out.push(join(home, '.local', 'bin', 'codex'));
  }
  if (id === 'gemini') {
    // Antigravity CLI installer locations
    if (WIN) {
      out.push(join(local, 'agy', 'bin', 'agy.exe'));
      out.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'antigravity-cli', 'agy.exe'));
    } else out.push(join(home, '.local', 'bin', 'agy'));
  }
  return out;
}

// (only absolute folders: a relative entry such as "." would mean whatever folder the app happens to run in)
const pathDirs = () =>
  (process.env.PATH || '')
    .split(WIN ? ';' : ':')
    .map(d => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(d => d && isAbsolute(d));

/**
 * A Node.js for CLIs that are JavaScript files: the one running this code when it is Node.js (tests), node on the PATH,
 * or the portable one of Chess Coach 1.x / 2.x (%LOCALAPPDATA%\ChessCoach\runtime). Null when there is none.
 */
export function findNode() {
  if (!process.versions.electron) return process.execPath;
  for (const dir of pathDirs()) {
    const f = join(dir, WIN ? 'node.exe' : 'node');
    if (existsSync(f)) return f;
  }
  try {
    const runtime = join(LEGACY_DIR, 'runtime');
    for (const d of readdirSync(runtime).filter(n => n.startsWith('node-')).sort(newestFirst)) {
      const f = WIN ? join(runtime, d, 'node.exe') : join(runtime, d, 'bin', 'node');
      if (existsSync(f)) return f;
    }
  } catch {
    /* no portable Node.js */
  }
  return null;
}

/**
 * Where the CLI is: { kind: 'exe'|'node', file, source } or null. Programs (on the PATH, where the vendors' installers
 * put them) come before JavaScript copies installed with npm, which are only used when Node.js is there to run them.
 */
export function findCli(id) {
  const p = PROVIDERS[id];
  if (!p) return null;
  const runnable = l => l && (l.kind === 'exe' || !!findNode());
  const custom = process.env[p.env]?.trim();
  if (custom) {
    const l = existsSync(custom) ? launcherFor(custom, p) : null;
    return runnable(l) ? { ...l, source: 'environment' } : null;
  }
  for (const dir of pathDirs()) {
    const exe = join(dir, WIN ? `${p.bin}.exe` : p.bin);
    if (!existsSync(exe)) continue;
    const l = launcherFor(exe, p);
    if (runnable(l)) return { ...l, source: 'path' };
  }
  for (const f of knownLocations(id)) {
    const l = existsSync(f) ? launcherFor(f, p) : null;
    if (runnable(l)) return { ...l, source: 'known' };
  }
  if (WIN)
    for (const dir of [...pathDirs(), ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : [])]) {
      if (!existsSync(join(dir, `${p.bin}.cmd`))) continue;
      const l = fromNpmPrefix(dir, p);
      if (runnable(l)) return { ...l, source: 'npm' };
    }
  const old = fromNpmPrefix(CLI_DIR, p);
  if (runnable(old)) return { ...old, source: 'app' };
  return null;
}

/** Command line for the CLI with these arguments. JavaScript programs run on Node.js (findNode). */
export function commandFor(cli, args) {
  return cli.kind === 'node' ? { file: findNode(), args: [cli.file, ...args], env: {} } : { file: cli.file, args, env: {} };
}

// ---------------------------------------------------------------------------------------------
// Status (installed, version, login) for Settings

function runCapture(cli, args, timeout = 20000) {
  const { file, args: argv, env } = commandFor(cli, args);
  return new Promise(resolve => {
    execFile(file, argv, { timeout, windowsHide: true, env: { ...cliEnv(), ...env }, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || '').trim(), err: String(stderr || '').trim() }),
    );
  });
}

const statusCache = new Map();

export async function cliStatus(id, { fresh = false } = {}) {
  const p = PROVIDERS[id];
  const cli = findCli(id);
  const cacheKey = `${id}:${cli?.file || ''}`;
  if (!fresh && statusCache.has(cacheKey) && Date.now() - statusCache.get(cacheKey).at < 60_000) return statusCache.get(cacheKey).value;
  const base = { id, label: p.label, product: p.product, account: p.account, installed: !!cli, path: cli?.file || null, source: cli?.source || null };
  if (!cli) return base;
  const v = await runCapture(cli, ['--version']);
  const version = (v.out || v.err).split('\n')[0].replace(/\s*\(Claude Code\)\s*$/, '').slice(0, 60) || cli.version || null;
  let login = null;
  if (id === 'claude-code') {
    const r = await runCapture(cli, ['auth', 'status']);
    try {
      const j = JSON.parse(r.out);
      login = j.loggedIn
        ? { ok: true, text: `Signed in${j.email ? ` as ${j.email}` : ''}${j.subscriptionType ? ` (Claude ${j.subscriptionType[0].toUpperCase()}${j.subscriptionType.slice(1)})` : j.authMethod ? ` (${j.authMethod})` : ''}` }
        : { ok: false, text: 'Not signed in — Claude Code asks you to sign in when the coach starts.' };
    } catch {
      login = null;
    }
  } else if (id === 'codex') {
    const r = await runCapture(cli, ['login', 'status']);
    const text = (r.out || r.err).split('\n').pop();
    login = r.code === 0 ? { ok: true, text: text || 'Signed in' } : { ok: false, text: 'Not signed in — Codex asks you to sign in with ChatGPT when the coach starts.' };
  } else if (id === 'gemini') {
    // agy keeps its Google sign-in in the system keychain (Windows Credential Manager), which the app does not read.
    login = process.env.GEMINI_API_KEY ? { ok: true, text: 'Using GEMINI_API_KEY' } : null;
  }
  const value = { ...base, version, login };
  statusCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/**
 * Whether the student is signed in to the coach program: true, false, or null when it cannot say (Antigravity, an
 * answer the app does not understand). The coach session waits for a sign-in before it types its first prompt.
 */
export async function signedIn(id) {
  const cli = findCli(id);
  if (!cli) return null;
  if (id === 'claude-code') {
    const r = await runCapture(cli, ['auth', 'status'], 10000);
    try {
      return !!JSON.parse(r.out).loggedIn;
    } catch {
      return null;
    }
  }
  if (id === 'codex') {
    const r = await runCapture(cli, ['login', 'status'], 10000);
    if (r.code === 0) return true;
    return /not (logged|signed) in|logged out/i.test(`${r.out}\n${r.err}`) ? false : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Installing (the vendor's own installer, or the CLI's own update command)

/** Installs or updates the CLI. onLine receives progress text. Resolves with cliStatus. */
export function installCli(id, onLine) {
  const p = PROVIDERS[id];
  return new Promise((resolve, reject) => {
    let file;
    let args;
    let env = { ...cliEnv(), ...(p.installerEnv || {}) };
    let title;
    const existing = findCli(id);
    if (p.update && existing) {
      // the CLI updates itself (its installer stops when the program is already there)
      const cmd = commandFor(existing, p.update);
      ({ file, args } = cmd);
      env = { ...env, ...cmd.env };
      title = `${p.label} update`;
    } else if (p.installer) {
      if (WIN) {
        file = 'powershell.exe';
        args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', p.installer.win];
      } else {
        file = 'bash';
        args = ['-c', p.installer.unix];
      }
      title = `${p.label} installer: ${WIN ? p.installer.win : p.installer.unix}`;
    } else return reject(new Error(`${p.label} has no installer.`));
    onLine(`> ${title}\n`);
    const child = spawn(file, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => onLine(String(d)));
    child.stderr.on('data', d => onLine(String(d)));
    child.on('error', reject);
    child.on('close', async code => {
      if (code !== 0) return reject(new Error(`The installer exited with code ${code}.`));
      const status = await cliStatus(id, { fresh: true });
      if (!status.installed) return reject(new Error(`The installer finished, but ${p.label} was not found where it is usually installed. Restart Plymentor and check again.`));
      resolve(status);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Session workspace and launch arguments

/** Environment for the CLIs: the user's own, minus variables that would change how they authenticate or behave. */
export function cliEnv(provider) {
  const env = { ...process.env };
  for (const k of Object.keys(env))
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('PLYMENTOR_') || k.startsWith('CHESS_COACH_') || k === 'ELECTRON_RUN_AS_NODE' || k === 'ELECTRON_NO_ATTACH_CONSOLE') delete env[k];
  if (provider === 'claude-code') delete env.ANTHROPIC_API_KEY; // use the subscription login, never bill the API key
  delete env.NO_COLOR;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

// Antigravity CLI permissions for the coach session (settings.json in its own home folder): the chess tools run
// without prompts; commands, file writes and the web are off — the coach only coaches. Deny wins over allow.
const AGY_PERMISSIONS = {
  allow: [`mcp(${MCP_NAME}/*)`],
  deny: ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'],
};

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Writes the workspace of a profile's session and returns the launch command. The first message is not passed on
 * the command line: the CLIs connect MCP servers in the background and would answer it before the chess tools are
 * there, so the terminal types it once the coach has listed the tools.
 * opts: { userId, port, token, instructions, model, mcpScript }
 */
export function launchCommand(id, { userId, port, token, instructions, model, mcpScript }) {
  const p = PROVIDERS[id];
  const cli = findCli(id);
  if (!cli) return null;
  if (!isAccountId(userId)) throw new Error('Invalid profile id');
  const base = join(WORKSPACES, userId);
  const dir = join(base, p.workspace || id);
  mkdirSync(dir, { recursive: true });
  // the MCP server is a script that the app itself runs as Node.js
  const mcp = { command: process.execPath, args: [mcpScript], env: { PLYMENTOR_URL: `http://127.0.0.1:${port}`, PLYMENTOR_TOKEN: token, ...NODE_ENV } };
  let args;
  let env = cliEnv(id);
  if (id === 'claude-code') {
    writeFileSync(join(dir, 'coach-instructions.md'), instructions);
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { [MCP_NAME]: { type: 'stdio', ...mcp } } }, null, 2));
    args = [
      '--mcp-config',
      join(dir, 'mcp.json'),
      '--strict-mcp-config', // only the coach's tools, not the user's other MCP servers
      '--allowedTools',
      `mcp__${MCP_NAME}`, // the chess tools run without permission prompts
      '--tools',
      '', // no file, shell or web tools: a chess coach does not need them
      '--append-system-prompt-file',
      join(dir, 'coach-instructions.md'),
      ...(model ? ['--model', model] : []),
      '--name',
      'Plymentor',
    ];
  } else if (id === 'codex') {
    writeFileSync(join(dir, 'AGENTS.md'), instructions);
    const key = `mcp_servers.${MCP_NAME.replace('-', '_')}`;
    const toml = v => JSON.stringify(v); // JSON strings and arrays of strings are valid TOML
    args = [
      '--no-alt-screen', // inline mode: the conversation stays in the scrollback
      '-s',
      'read-only',
      // Codex asks the student before any command but the simplest read-only ones ("on-request" let the model run
      // commands on its own; a crafted game could talk it into one). The chess tools need no approval (below).
      '-a',
      'untrusted',
      '-c',
      `${key}.command=${toml(mcp.command)}`,
      '-c',
      `${key}.args=${toml(mcp.args)}`,
      ...Object.entries(mcp.env).flatMap(([k, v]) => ['-c', `${key}.env.${k}=${toml(v)}`]),
      '-c',
      `${key}.startup_timeout_sec=30`,
      '-c',
      `${key}.tool_timeout_sec=300`,
      '-c',
      `${key}.default_tools_approval_mode="approve"`,
      ...(model ? ['-m', model] : []),
    ];
  } else {
    // Antigravity CLI: the instructions in the workspace (AGENTS.md); the MCP server, the permissions and display
    // settings in the session's own home folder (agy reads them from ~/.gemini only), one per profile.
    writeFileSync(join(dir, 'AGENTS.md'), instructions);
    const agyHome = join(base, 'antigravity-home');
    const configDir = join(agyHome, '.gemini', 'config');
    const cliDir = join(agyHome, '.gemini', 'antigravity-cli');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(configDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { [MCP_NAME]: { ...mcp, disabled: false } } }, null, 2));
    const settingsFile = join(cliDir, 'settings.json');
    // What the student picks inside agy (colours, model…) is kept. Inline rendering keeps the conversation in the
    // terminal's scrollback, like Codex's --no-alt-screen.
    const settings = { altScreenMode: 'never', showTips: false, showFeedbackSurvey: false, ...readJsonFile(settingsFile), permissions: AGY_PERMISSIONS };
    if (process.env.GEMINI_API_KEY) settings.modelProvider = 'gemini'; // agy only uses the key with this setting
    else if (settings.modelProvider === 'gemini') delete settings.modelProvider;
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    args = model ? ['--model', model] : [];
    env = { ...env, USERPROFILE: agyHome, HOME: agyHome };
  }
  const cmd = commandFor(cli, args);
  return { file: cmd.file, args: cmd.args, cwd: dir, env: { ...env, ...cmd.env } };
}

/** Windows command line from argv (MSVCRT rules, every argument quoted when needed). */
export function windowsCommandLine(args) {
  return args
    .map(a => {
      if (a !== '' && !/[\s"]/.test(a)) return a;
      let out = '"';
      let bs = 0;
      for (const ch of a) {
        if (ch === '\\') bs++;
        else if (ch === '"') {
          out += '\\'.repeat(bs * 2 + 1) + '"';
          bs = 0;
        } else {
          out += '\\'.repeat(bs) + ch;
          bs = 0;
        }
      }
      return out + '\\'.repeat(bs * 2) + '"';
    })
    .join(' ');
}
