// The coach in the website's screenshot (scripts/site-screenshot.mjs): a stand-in for Claude Code in the coach panel,
// drawn the way Claude Code draws a conversation. Its tool calls are real (the plymentor MCP server reads the board and
// runs Stockfish); what it says about the position, the end of Morphy's Opera Game, is written here. No subscription is
// used. It answers only the question the screenshot types; the start-up prompt and the app's requests get no answer.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('2.1.0 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, email: 'student@example.com', subscriptionType: 'max' }));
  process.exit(0);
}

// the plymentor MCP server, as the app configured it
const server = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.plymentor;
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
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'site-coach', version: '1' } });

// What the coach says. **…** is bold; a block starting with "- " is a list item.
const ANSWER = [
  "It's mate in two, the famous finish of Morphy's Opera Game:",
  '  **16. Qb8+!! Nxb8 17. Rd8#**',
  "- Black's last move, **15...Nxd7**, took the knight off f6. That opened the g5 bishop's diagonal: it now covers e7 and d8.",
  '- The knight is also the only piece between the d1 rook and d8. **Qb8+** drags it away (Nxb8 is the only legal reply), and the rook mates on d8, protected by the bishop.',
  "- Black's king never castled: the f7 pawn and the f8 bishop wall it in, and the h8 rook hasn't moved all game.",
  '**15...Qxd7** would have kept the knight on f6 and stopped the mate, though White would still be winning.',
  'The lesson: when the enemy king is stuck in the centre, look at every check, even one that gives up your queen.',
];
const OPTIONAL = [4, 6]; // left out, last first, when the panel is too short for everything

const ESC = '\x1b[';
const dim = s => `${ESC}90m${s}${ESC}39m`;
const green = s => `${ESC}32m${s}${ESC}39m`;
const bold = s => `${ESC}1m${s}${ESC}22m`;
const visible = s => s.replace(/\*\*/g, '').length;

/** Words to lines of at most `width` visible characters: the first starts with `first`, the others with `rest`. */
function wrap(text, width, first, rest) {
  const lines = [];
  let line = first;
  let empty = true;
  for (const word of text.split(' ')) {
    if (!empty && visible(line) + 1 + visible(word) > width) {
      lines.push(line);
      line = rest;
      empty = true;
    }
    line += (empty ? '' : ' ') + word;
    empty = false;
  }
  lines.push(line);
  return lines;
}
const clip = (s, width) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);

let shown = null; // { question, board, fen, analysis }: drawn again when the panel's size changes

function draw() {
  if (!shown) return;
  const width = (process.stdout.columns || 48) - 1;
  const rows = process.stdout.rows || 40;
  const { question, board, fen, analysis } = shown;
  const toolCall = (name, args, result, keep) => {
    const head = wrap(`plymentor - ${name} (MCP)${args ? `(${args})` : ''}`, width, '● ', '  ');
    head[0] = head[0].replace(/^● (plymentor - \S+)/, (_, tool) => `${green('●')} ${bold(tool)}`);
    const lines = result.split('\n').filter(Boolean);
    const out = [...head, ...lines.slice(0, keep).map((l, i) => `${i ? '     ' : `  ${dim('⎿')}  `}${clip(l, width - 5)}`)];
    if (lines.length > keep) out.push(`     ${dim(`… +${lines.length - keep} line${lines.length - keep > 1 ? 's' : ''} (ctrl+o to expand)`)}`);
    return [...out, ''];
  };
  const answer = skip =>
    ANSWER.flatMap((block, i) => {
      if (skip.includes(i)) return [];
      const lines = block.startsWith('- ') ? wrap(block.slice(2), width, '  - ', '    ') : block.startsWith('  ') ? [block] : wrap(block, width, i ? '  ' : '● ', '  ');
      const next = ANSWER.findIndex((_, j) => j > i && !skip.includes(j));
      const listGoesOn = block.startsWith('- ') && ANSWER[next]?.startsWith('- ');
      return listGoesOn || next < 0 ? lines : [...lines, ''];
    });
  const top = [`${dim('>')} ${question}`, '', ...toolCall('get_board_state', '', board, 1), ...toolCall('analyze_position', `fen: "${fen}", depth: 22`, analysis, 2)];
  const box = [dim(`╭${'─'.repeat(width - 2)}╮`), `${dim('│')} > ${ESC}7m ${ESC}27m${' '.repeat(Math.max(0, width - 6))}${dim('│')}`, dim(`╰${'─'.repeat(width - 2)}╯`), dim('  ? for shortcuts')];
  let skip = [];
  let body = answer(skip);
  for (const i of OPTIONAL) {
    if (top.length + body.length + 1 + box.length <= rows) break;
    skip = [...skip, i];
    body = answer(skip);
  }
  const text = [...top, ...body, '', ...box].join('\r\n').replace(/\*\*(.+?)\*\*/g, (_, s) => bold(s));
  process.stdout.write(`${ESC}?25l${ESC}2J${ESC}3J${ESC}H${text}`);
}
process.stdout.on('resize', draw);

async function answerQuestion(question) {
  await ready;
  const board = await call('get_board_state', {});
  const fen = /[1-8pnbrqkPNBRQK]+(?:\/[1-8pnbrqkPNBRQK]+){7} [wb] [KQkq-]+ [a-h1-8-]+ \d+ \d+/.exec(board)?.[0] ?? '';
  const analysis = (await call('analyze_position', { fen, depth: 22 })).split('\n').slice(1).join('\n');
  shown = { question, board, fen, analysis };
  draw();
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
let busy = Promise.resolve();
rl.on('line', line => {
  const text = line.trim();
  if (!text || text.startsWith('[App]')) return; // the start-up prompt and the app's own requests
  busy = busy.then(() => answerQuestion(text)).catch(e => process.stdout.write(`error: ${e.message}\r\n`));
});
