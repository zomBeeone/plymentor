// A stand-in for Claude Code in the end-to-end test (no subscription used): it reads the MCP configuration the app
// wrote, starts the plymentor MCP server, lists the tools, and calls some of them whenever the app types a request.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// FAKE_COACH_SIGNIN: a file that exists once the student has "signed in" — the tests of a first start (the app keeps
// its own PLYMENTOR_* variables from the coach programs)
const SIGN_IN = process.env.FAKE_COACH_SIGNIN;
const signedIn = () => !SIGN_IN || existsSync(SIGN_IN);

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify(signedIn() ? { loggedIn: true, email: 'fake@example.com', subscriptionType: 'max' } : { loggedIn: false }));
  process.exit(0);
}

const cfgPath = argv[argv.indexOf('--mcp-config') + 1];
const server = JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers.plymentor;
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
let seq = 0;
const waiting = new Map();
createInterface({ input: mcp.stdout }).on('line', line => {
  const m = JSON.parse(line);
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
});
const rpc = (method, params) =>
  new Promise(resolve => {
    const id = ++seq;
    waiting.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  return { text, isError: !!r.result?.isError };
};
const say = text => process.stdout.write(`${text}\r\n`);

say('Fake coach 9.9.9 — no subscription is used in this test.');
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
say(`server: ${init.result.serverInfo.name}`);
const tools = await rpc('tools/list', {});
say(`tools: ${tools.result.tools.length}`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
let busy = Promise.resolve();
rl.on('line', line => {
  const text = line.trim();
  if (!text) return;
  busy = busy.then(() => handle(text)).catch(e => say(`error: ${e.message}`));
});

// Claude Code's sign-in screen (its tools are listed already, as they can be) until the student has signed in
if (!signedIn()) {
  say("Browser didn't open? Use the url below to sign in:");
  say('https://claude.ai/oauth/authorize?fake');
  say('Paste code here if prompted >');
  while (!signedIn()) await new Promise(r => setTimeout(r, 200));
  say('\x1b[2J\x1b[HSigned in.');
}

async function handle(text) {
  if (!signedIn()) return say(`sign-in field got: ${text.slice(0, 40)}`); // (what the app must never do)
  say(`> ${text.slice(0, 120)}`);
  if (/just opened Plymentor/.test(text)) {
    const mem = await call('get_player_memory', {});
    say(`memory: ${mem.text.split('\n')[0]}`);
    const board = await call('get_board_state', {});
    say(`board: ${board.text.split('\n')[0]}`);
    const ana = await call('analyze_position', { fen: 'startpos', depth: 10, multipv: 1 });
    say(`analysis: ${ana.isError ? 'ERROR ' : ''}${ana.text.split('\n')[1] || ana.text}`);
    const upd = await call('update_player_memory', { text: 'Plays the Najdorf as Black.' });
    say(`memory saved: ${upd.text}`);
    const set = await call('set_board', { fen: 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6', caption: 'The Najdorf', arrows: ['f1e2 g'] });
    say(`set_board: ${set.text}`);
    const speak = await call('speak', { text: 'Hello from your test coach.' });
    say(`speak: ${speak.text}`);
    say('Greeting done.');
    return;
  }
  const report = /report #(\d+)/.exec(text);
  if (report) {
    const r = await call('get_report', { report_id: Number(report[1]) });
    say(`report: ${r.text.split('\n')[0]}`);
    const saved = await call('save_report', { report_id: Number(report[1]), markdown: '## Overview\nA test report written by the fake coach.\n\n```board\nfen: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1\ncaption: After 1. e4\n```' });
    say(`save_report: ${saved.text}`);
    return;
  }
  if (/make me a report/i.test(text)) {
    // adds a report of its own to the Reports screen, written at once
    const r = await call('create_report', { title: 'Report by the coach', markdown: '## Overview\nA report the fake coach added by itself.' });
    say(`create_report: ${r.isError ? `ERROR ${r.text.slice(0, 60)}` : /^Added report #\d+/.exec(r.text)?.[0]}`);
    return;
  }
  if (/make me two exercises/i.test(text)) {
    // two mates in one for the training deck
    const a = await call('create_exercise', { fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', solution: ['Rd8#'], prompt: 'Back rank: mate in one' });
    const b = await call('create_exercise', { fen: '6k1/5ppp/8/8/8/8/5PPP/2Q3K1 w - - 0 1', solution: ['Qc8#'], prompt: 'Queen: mate in one' });
    say(`create_exercise: ${[a, b].map(r => (r.isError ? 'ERROR' : 'ok')).join(' ')}`);
    return;
  }
  const engine = /switch stockfish (on|off)/i.exec(text);
  if (engine) {
    // switches the student's live Stockfish, then looks whether it is so
    const r = await call('set_engine', { on: engine[1].toLowerCase() === 'on' });
    say(`set_engine: ${r.isError ? `ERROR ${r.text.slice(0, 60)}` : 'ok'}`);
    const b = await call('get_board_state', {});
    say(`engine here: ${/^Live Stockfish analysis on this screen: (\w+)/m.exec(b.text)?.[1] ?? '?'}`);
    return;
  }
  if (/analyse my games/i.test(text)) {
    // (short lines: the terminal wraps long ones)
    const state = r => (r.isError ? `ERROR ${r.text}` : /^Analysis #\d+ .*\) is finished\./.test(r.text) ? 'finished' : r.text.split('\n')[0]);
    const a = await call('analyze_games', { depth: 'fast', wait_seconds: 120 });
    say(`analyze_games: ${state(a)}, ${(a.text.match(/^- #\d+ .* — [\d.]+% \/ [\d.]+%$/gm) || []).length} games`);
    say(`get_analysis_status: ${state(await call('get_analysis_status', {}))}`);
    return;
  }
  if (/\[App\] What is the right plan/.test(text)) {
    // takes the student to the Openings screen and plays an opening out there from the initial position
    const sw = await call('switch_screen', { screen: 'openings' });
    say(`switched: ${sw.isError ? `ERROR ${sw.text}` : 'ok'}`);
    const moves = 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7 g4 b5 g5 b4'.split(' ');
    const set = await call('set_board', { moves_from_start: moves, caption: 'The English Attack' });
    say(`opening shown: ${set.isError ? `ERROR ${set.text}` : 'ok'}`);
    return;
  }
  if (/\[App\] Explain/.test(text)) {
    const b = await call('get_board_state', {});
    say(`explain: ${b.text.split('\n').find(l => l.startsWith('Current position')) || b.text.split('\n')[0]}`);
    return;
  }
  say('ok');
}
