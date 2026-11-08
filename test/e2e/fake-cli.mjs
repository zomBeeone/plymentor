// A stand-in for Claude Code in the end-to-end test (no subscription used): it reads the MCP configuration the app
// wrote, starts the plymentor MCP server, lists the tools, and calls some of them whenever the app types a request.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
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
  if (/play the opposition with me/i.test(text)) {
    // a lesson position the student plays out with the coach: White to move, their answer comes as a move
    const set = await call('set_board', { fen: '8/8/4k3/8/8/4K3/4P3/8 w - - 0 1', caption: 'The opposition', ask_move: true });
    say(`lesson shown: ${set.isError ? `ERROR ${set.text.slice(0, 60)}` : 'ok'}`);
    return;
  }
  if (/^I play 1\. Ke4/.test(text)) {
    // the reply written as a FEN with the wrong side to move (refused), then played on the board with make_move
    const slip = await call('set_board', { fen: '8/8/3k4/8/4K3/8/4P3/8 b - - 2 2' });
    say(`slip refused: ${slip.isError && /White to move there/.test(slip.text) ? 'yes' : 'no'}`);
    const made = await call('make_move', { moves: ['Kd6'], ask_move: true });
    say(`make_move: ${made.isError ? `ERROR ${made.text.slice(0, 60)}` : 'ok'}`);
    return;
  }
  if (/look in my books/i.test(text)) {
    // list_books, then read_book and search_books on what it lists (short lines: the terminal wraps long ones)
    const list = await call('list_books', {});
    const idOf = re => new RegExp(`^- ([0-9a-f]{20}): .*${re}`, 'm').exec(list.text)?.[1];
    const epub = idOf('— EPUB');
    const pdf = idOf('“Test Chess Book.*— PDF');
    const scan = idOf('“Scanned Test Book');
    const fresh = idOf('“Second Scan');
    // (each check on a short line, and one line at the end: the terminal shows its last rows only; FAKE_COACH_DUMP: a file
    // for what a check that failed got)
    const failed = [];
    const check = (what, ok, r) => {
      say(`${what}: ${ok ? 'ok' : `NO ${String(r?.text).slice(0, 50)}`}`);
      if (ok) return;
      failed.push(what);
      if (process.env.FAKE_COACH_DUMP) appendFileSync(process.env.FAKE_COACH_DUMP, `--- ${what}\n${r?.text}\n`);
    };
    check('books', (list.text.match(/^- [0-9a-f]{20}: /gm) || []).length === 4, list);
    const contents = await call('list_books', { book: epub });
    check('contents', /\n- 2: A Queen's Gambit/.test(contents.text), contents);
    const chapter = await call('read_book', { book: epub, page: 1 });
    check('epub', /\[Diagram: r1b1kb1r\/2q2p1p\/p2ppP2\/1pn5\/3NP3\/2N2Q2\/PPP4P\/2KR1B1R w kq - 1 16\]/.test(chapter.text) && /--- Chapter 1: The Najdorf ---/.test(chapter.text) && /\(chapter 2 comes next\.\)/.test(chapter.text), chapter);
    const old = await call('read_book', { book: pdf, page: 3 });
    check('notation', /1\. e4 e5 2\. Nf3 Nc6/.test(old.text) && /\(The end of the book\.\)/.test(old.text), old);
    const two = await call('read_book', { book: pdf, page: 1, pages: 2 });
    check('two pages', /--- Page 1 ---[^]*--- Page 2 ---/.test(two.text), two);
    const none = await call('read_book', { book: pdf, page: 99 });
    check('no such page', none.isError && /has 3 pages/.test(none.text), none);
    const both = await call('read_book', { book: 'test chess' });
    check('two books fit', both.isError && /More than one/.test(both.text), both);
    const unknown = await call('read_book', { book: 'no such book' });
    check('no such book', unknown.isError, unknown);
    const found = await call('search_books', { query: 'developed quickly' });
    check('search all', /found in 2 places/.test(found.text) && found.text.includes(`(${epub})`) && found.text.includes(`(${pdf})`), found);
    // (a scanned book opened before: what the reader kept of it; one never opened: nothing to search yet)
    const ruy = await call('search_books', { query: 'Ruy Lopez' });
    check('search scan', /Scanned Test Book/.test(ruy.text) && new RegExp(`Second Scan.*\\(${fresh}\\): the app has not read it yet`).test(ruy.text), ruy);
    const page = await call('read_book', { book: scan, page: 1 });
    check('kept scan', /Ruy Lopez/.test(page.text) && (page.text.match(/\[Diagram/g) || []).length === 2, page);
    // a scanned book never opened: its page read by OCR now, for the coach, and its diagram shown on the board
    const read = await call('read_book', { book: fresh, page: 1 });
    const fen = /\[Diagram[^\]]*: (r1bqkbnr\/1ppp1ppp\/p1n5\/1B2p3\/4P3\/5N2\/PPPP1PPP\/RNBQK2R w KQkq - \d+ \d+)\]/.exec(read.text);
    check('read now', /Ruy Lopez/.test(read.text) && !!fen, read);
    const shown = fen && (await call('set_board', { fen: fen[1], caption: 'From your book' }));
    check('shown', !!shown && !shown.isError, shown);
    const now = await call('search_books', { query: 'Ruy Lopez', book: fresh });
    check('search now', /found in 1 place/.test(now.text) && !/Not searched/.test(now.text), now);
    say(`Books done: ${failed.length ? failed.join(', ') : 'all ok'}.`);
    return;
  }
  if (/what am i reading/i.test(text)) {
    // the book the student has open: its copy shared with the Book reader
    const r = await call('read_book', {});
    say(`reading: ${/“Test Chess Book”.*page 2 of 3/.test(r.text) && /The position the book had reached before this page \(after 15\.\.\.Bf8\)/.test(r.text) ? 'ok' : r.text.slice(0, 60)}`);
    if (process.env.FAKE_COACH_DUMP) appendFileSync(process.env.FAKE_COACH_DUMP, `--- reading\n${r.text}\n`);
    return;
  }
  if (/give me an endgame/i.test(text)) {
    // makes the student play a rook endgame out against Stockfish (from whatever screen they are on), then looks
    const r = await call('start_training_game', { fen: '8/8/8/4k3/8/8/8/R3K3 w - - 0 1', level: 1, comments: 'off', goal: 'Mate with the rook' });
    say(`training game: ${r.isError ? `ERROR ${r.text.slice(0, 60)}` : 'ok'}`);
    const b = await call('get_board_state', {});
    say(`game seen: ${/You started it/.test(b.text) ? 'started by me' : '?'}`);
    return;
  }
  const end = /My training game just ended \(([^,)]*)[^)]*\)\.(?: The goal you gave me: ([^.]*)\.)?/.exec(text);
  if (end) {
    // (short: "game end: 0-1 + goal" when the goal it gave came back with the result)
    say(`game end: ${end[1]}${end[2] === 'Mate with the rook' ? ' + goal' : end[2] ? ' + ?' : ''}`);
    return;
  }
  say('ok');
}
