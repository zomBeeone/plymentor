// MCP server (stdio) that gives the coach — Claude Code, Codex, Antigravity CLI — the Plymentor tools.
// It is started by the CLI (the Plymentor app itself runs it as Node.js, built into mcp.cjs) and only forwards: the
// app's coach host passes each call on to the Plymentor window (Stockfish, the games, the board) or answers it
// itself (the coach's notes about the student).
//
// Environment: PLYMENTOR_URL (http://127.0.0.1:<port>) and PLYMENTOR_TOKEN (new for every coach session), both set by
// the app in the coach's MCP configuration.
import { createInterface } from 'node:readline';
import { APP_VERSION } from '../shared/protocol.js';

const BASE = process.env.PLYMENTOR_URL || '';
const TOKEN = process.env.PLYMENTOR_TOKEN || '';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS =
  "Tools of the Plymentor chess app, running on the student's computer: Stockfish analysis, the student's board (get_board_state to see it, set_board to show positions, switch_screen to take them to another screen, set_engine to switch their live Stockfish on or off), their games, statistics and reports, training material, and your long-term notes about the student.";

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const log = (...a) => process.stderr.write(`[plymentor mcp] ${a.join(' ')}\n`);

async function app(path, body) {
  if (!BASE) throw new Error('PLYMENTOR_URL is not set: this server is started by Plymentor');
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(310_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `the Plymentor app answered ${res.status}`);
  return data;
}

async function handle({ method, params }) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'plymentor', title: 'Plymentor', version: APP_VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: (await app('/agent/tools')).tools };
    case 'tools/call':
      try {
        const r = await app(`/agent/tools/${encodeURIComponent(params?.name || '')}`, { arguments: params?.arguments || {} });
        return { content: [{ type: 'text', text: String(r.content) }], isError: !!r.isError };
      } catch (e) {
        return { content: [{ type: 'text', text: `The Plymentor app could not run this tool: ${e.message}` }], isError: true };
      }
    case 'resources/list':
      return { resources: [] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'prompts/list':
      return { prompts: [] };
    default: {
      const err = new Error(`Method not found: ${method}`);
      err.code = -32601;
      throw err;
    }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (msg.id === undefined || msg.id === null || !msg.method) return; // notifications and responses need no answer
  try {
    send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) });
  } catch (e) {
    log(`${msg.method} failed: ${e.message}`);
    send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
});
rl.on('close', () => process.exit(0));
