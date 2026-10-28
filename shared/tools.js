// The tools the coach (Claude Code, Codex or Antigravity CLI) can call through the "plymentor" MCP server.
// Definitions live here because both sides need them: the coach host (desktop/host.js) lists them to the coach, the
// window runs them.
// - Most tools run in the window (Stockfish, chess logic, the student's games — app/js/backend/coach/tools.js).
// - HOST_TOOLS run in the coach host itself: the coach's notes about the student (a file on the student's computer) and
//   the game database the student added (a Scid 5 database, kept by the main process).
// `readOnly` becomes the MCP readOnlyHint annotation.
import { MOTIF_LABELS } from './motifs.js';

const fenProp = { type: 'string', description: 'Full FEN of the position (6 fields).' };

/**
 * The app's screens (the tabs at the top) for switch_screen: the window's route (view), the tabs inside a screen, and
 * whether the coach panel is on it (where the student reads the coach).
 */
export const SCREENS = {
  board: { view: 'analysis', label: 'Board', tabs: ['moves', 'explorer', 'game'], coach: true },
  openings: { view: 'openings', label: 'Openings', tabs: ['coach', 'repertoire'], defaultTab: 'coach', coach: true },
  games: { view: 'games', label: 'Games', tabs: [], coach: false },
  reports: { view: 'reports', label: 'Reports', tabs: [], coach: true },
  train: { view: 'train', label: 'Train', tabs: ['exercises', 'lessons'], coach: true },
  settings: { view: 'settings', label: 'Settings', tabs: [], coach: false },
};

/** The student's live Stockfish switches (engine.js), each a screen's, as the coach's tools name them. */
export const ENGINE_LABELS = { board: 'Board', openings: 'Openings', books: 'Book reader' };

export const TOOL_DEFS = [
  {
    name: 'get_board_state',
    readOnly: true,
    description:
      "What the student sees in the app right now: the active screen, the loaded game, the moves played, the current position (FEN, ASCII board, pieces), whether their live Stockfish analysis is on (with its lines when it is) and the judgement of the last move. Call it before talking about \"this position\" or \"my move\" — the student may have moved since you last looked.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'analyze_position',
    readOnly: true,
    description:
      "Run Stockfish on a position and return the evaluation (White's point of view) and the best lines in SAN with move numbers. Call this before stating any concrete line or evaluation that is not already in the board context, to find the best moves, or to compare candidate plans.",
    input_schema: {
      type: 'object',
      properties: {
        fen: fenProp,
        multipv: { type: 'integer', minimum: 1, maximum: 5, description: 'Number of best lines (default 3).' },
        depth: { type: 'integer', minimum: 8, maximum: 28, description: 'Search depth (default 20). Higher is slower.' },
      },
      required: ['fen'],
      additionalProperties: false,
    },
  },
  {
    name: 'evaluate_move',
    readOnly: true,
    description:
      "Judge one move in a position: classification (great/best/excellent/good/inaccuracy/mistake/blunder, lichess thresholds), evaluation before and after, the engine's better move with its line, and the best reply (refutation) after the move. Use it to explain why a move is good or bad.",
    input_schema: {
      type: 'object',
      properties: { fen: fenProp, move: { type: 'string', description: 'The move in SAN (e.g. "Nf3", "O-O") or UCI (e.g. "g1f3").' } },
      required: ['fen', 'move'],
      additionalProperties: false,
    },
  },
  {
    name: 'play_moves',
    readOnly: true,
    description:
      'Play a sequence of moves from a position and get the FEN after each move (with check/mate flags). Use it to verify that a line is legal before you show it, and to obtain exact FENs for diagrams. Stops at the first illegal move and lists the legal moves there.',
    input_schema: {
      type: 'object',
      properties: {
        fen: { type: 'string', description: 'Starting FEN; use "startpos" for the initial position.' },
        moves: { type: 'array', items: { type: 'string' }, maxItems: 60, description: 'Moves in SAN or UCI, in order.' },
      },
      required: ['fen', 'moves'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_position_features',
    readOnly: true,
    description:
      'Static description of a position: ASCII board, piece lists, material balance, pawn structure (isolated/doubled/backward/passed pawns, islands), open files, king safety, development, rook activity, mobility, centre, pieces en prise (static exchange evaluation), pins, multi-target attacks, available checks and captures. Use it to ground strategic explanations.',
    input_schema: { type: 'object', properties: { fen: fenProp }, required: ['fen'], additionalProperties: false },
  },
  {
    name: 'opening_info',
    readOnly: true,
    description:
      "Opening information for a position: its name and ECO code (lichess open database, transpositions recognised), named book continuations, how the student's own games went from here, and — if the student configured a Lichess token — Masters database statistics with top games.",
    input_schema: { type: 'object', properties: { fen: fenProp }, required: ['fen'], additionalProperties: false },
  },
  {
    name: 'database_explorer',
    readOnly: true,
    description:
      "Practice from the student's game database (a Scid 5 database they added in Openings → Explorer → Database, often millions of master and over-the-board games): for a position, the moves played there with the number of games, the results (White/draw/Black), the average rating and the year last played, and the strongest games that reached it (with ids for get_database_game). Its opening index covers positions reached in at least 10 games within the first 20 moves; give `moves` (the line from the initial position) to follow a rarer or deeper line through the games themselves.",
    input_schema: {
      type: 'object',
      properties: {
        fen: fenProp,
        moves: { type: 'array', items: { type: 'string' }, maxItems: 200, description: 'Optional: the moves from the initial position to this one, in SAN or UCI.' },
      },
      required: ['fen'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_database_game',
    readOnly: true,
    description: "One game of the student's game database by its id (from database_explorer): players, ratings, event, date, result and all the moves as PGN.",
    input_schema: { type: 'object', properties: { game_id: { type: 'integer', minimum: 0 } }, required: ['game_id'], additionalProperties: false },
  },
  {
    name: 'search_openings',
    readOnly: true,
    description: 'Find openings by name or ECO code (e.g. "Caro-Kann Advance", "B90", "Queen\'s Gambit Declined"). Returns name, ECO, moves and the final FEN.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_games',
    readOnly: true,
    description:
      "Search the student's imported games. By default only games played by the student (their configured usernames) are returned. Each result shows the game id, players, result, date, opening and engine accuracy if analysed.",
    input_schema: {
      type: 'object',
      properties: {
        player: { type: 'string', description: 'Player name to filter by (default: the student).' },
        color: { type: 'string', enum: ['white', 'black', 'any'] },
        result: { type: 'string', enum: ['win', 'loss', 'draw', 'any'], description: "Result from the player's point of view." },
        opening: { type: 'string', description: 'Opening name or ECO prefix.' },
        analyzed_only: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_game',
    readOnly: true,
    description:
      'Full moves of one imported game with engine evaluations and judgements (if analysed), the critical moments with FENs, phase boundaries and clock times. Use it to review a game or to cite a moment precisely.',
    input_schema: {
      type: 'object',
      properties: { game_id: { type: 'integer' }, from_ply: { type: 'integer', minimum: 0 }, to_ply: { type: 'integer', minimum: 1 } },
      required: ['game_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_mistakes',
    readOnly: true,
    description:
      "List the student's errors from their analysed games, worst first, with the position (FEN before the move), the move played, the better move and line, the phase and pattern tags (" +
      Object.keys(MOTIF_LABELS).join(', ') +
      '). Filter to find examples for a theme.',
    input_schema: {
      type: 'object',
      properties: {
        game_ids: { type: 'array', items: { type: 'integer' }, maxItems: 500, description: 'Restrict to these games (default: all analysed games of the student).' },
        phase: { type: 'string', enum: ['opening', 'middlegame', 'endgame', 'any'] },
        motif: { type: 'string', description: 'Pattern tag to filter by.' },
        min_judgement: { type: 'string', enum: ['inaccuracy', 'mistake', 'blunder'] },
        include_missed_punishments: { type: 'boolean', description: 'Also list moments where the opponent erred and the student failed to punish it.' },
        limit: { type: 'integer', minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_player_stats',
    readOnly: true,
    description:
      'Aggregate statistics of the student over analysed games: results, accuracy, errors per phase, tactical awareness, conversion, resourcefulness, clock usage, openings by colour, error patterns, accuracy by piece, and the worst moments.',
    input_schema: {
      type: 'object',
      properties: { game_ids: { type: 'array', items: { type: 'integer' }, maxItems: 1000 } },
      additionalProperties: false,
    },
  },
  {
    name: 'analyze_games',
    description:
      "Runs Stockfish over the student's imported games — the same batch analysis as the Games screen: an evaluation of every position, the judgement of every move and each side's accuracy, which get_game, find_mistakes, get_player_stats and reports use. Without game_ids it takes the student's newest games that are not analysed yet. Waits up to wait_seconds for the result (the student sees the progress in the app) and then lists the analysed games; a bigger batch keeps running after that — check it with get_analysis_status. One analysis runs at a time; it takes a few seconds per game and keeps the computer's processor busy, so tell the student before analysing more than about 20 games.",
    input_schema: {
      type: 'object',
      properties: {
        game_ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 200, description: 'The games to analyse (ids from search_games).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: "Without game_ids: how many of the student's newest unanalysed games (default 10)." },
        depth: { type: 'string', enum: ['fast', 'standard', 'deep'], description: "Stockfish's effort per position: fast 150k, standard 400k, deep 1.2M nodes (default: the student's setting)." },
        reanalyse: { type: 'boolean', description: 'Analyse games again that are already analysed at this depth (default false: they are skipped).' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 240, description: 'How long to wait for the result (default 240; 0 starts it and returns at once).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_analysis_status',
    readOnly: true,
    description:
      'Progress or result of a Stockfish analysis of games (started with analyze_games, or by the student on the Games screen): games done, time left, and once finished the analysed games with their accuracy. Can wait for it to finish.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'integer', description: 'The analysis (default: the latest one).' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 240, description: 'Wait up to this long for it to finish (default 0).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_board',
    description:
      "Show a position on the student's board (on the screen they are on: the analysis board, the Openings board or a lesson), optionally with a line they can step through, arrows and highlighted squares. To show an opening or a position from one, give moves_from_start — the moves from the initial position — instead of (or with) fen: the board plays them out move by move, so the student sees the opening unfold and can step back through it and branch off into other lines. Set ask_move to true to ask the student to find a move there: their move will arrive as their next message, so end your turn after asking.",
    input_schema: {
      type: 'object',
      properties: {
        fen: { type: 'string', description: 'Full FEN of the position (6 fields). Can be left out when moves_from_start is given.' },
        moves_from_start: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 200,
          description: "The moves from the initial position that lead to the position (SAN or UCI), e.g. an opening's move order.",
        },
        moves: { type: 'array', items: { type: 'string' }, maxItems: 40, description: 'Optional line from the position (SAN) the student can step through.' },
        arrows: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Arrows like "e2e4 g" (colour g/r/b/y, optional).' },
        highlights: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Squares to highlight, e.g. "d5".' },
        caption: { type: 'string' },
        orientation: { type: 'string', enum: ['white', 'black'] },
        ask_move: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'switch_screen',
    description:
      "Switch the app to another screen — the tabs at the top: board (the analysis board), openings (the opening explorer, the repertoire and the opening coach), games (the student's games), reports, train (exercises and lessons) or settings — and optionally to a tab inside it: on board moves, explorer or game; on openings coach (the default: your panel next to the board) or repertoire; on train exercises or lessons. Use it to take the student where you want to work with them, e.g. to the Openings screen before you show an opening there with set_board. The student reads your messages only on screens with the coach panel: board, openings (coach tab), reports and train.",
    input_schema: {
      type: 'object',
      properties: {
        screen: { type: 'string', enum: Object.keys(SCREENS) },
        tab: { type: 'string', enum: [...new Set(Object.values(SCREENS).flatMap(s => s.tabs))] },
      },
      required: ['screen'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_engine',
    description:
      "Switch the student's live Stockfish analysis on or off: the evaluation bar, the engine lines and the best-move arrow they see on the Board, on the Openings screen and on the Book reader's board (each screen has its own switch; get_board_state says whether it is on). Without screen: the screen the student is on — on a screen without live analysis, the Board's and the Openings screen's. Its lines and arrow give the best move away: when you ask the student to find a move (set_board with ask_move, a quiz) while it is on, switch it off first and back on once they have answered. Switch it when they ask, too. It only changes what the student sees: your own Stockfish tools always work.",
    input_schema: {
      type: 'object',
      properties: {
        on: { type: 'boolean', description: 'true switches it on, false off.' },
        screen: {
          type: 'string',
          enum: ['board', 'openings', 'books', 'both'],
          description: "Which switch: the Board screen's, the Openings screen's, the Book reader's, or both the Board's and the Openings screen's (default: the screen the student is on).",
        },
      },
      required: ['on'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_exercise',
    description:
      'Save a "find the best move" exercise to the student\'s training deck (spaced repetition). Use positions from their own games where they went wrong, with the engine\'s best move as the solution. Verify the solution with evaluate_move or analyze_position first.',
    input_schema: {
      type: 'object',
      properties: {
        fen: fenProp,
        solution: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 9, description: 'Solution line in SAN, starting with the move the student must find.' },
        prompt: { type: 'string', description: 'Short task text, e.g. "White to move and win material".' },
        themes: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        game_id: { type: 'integer' },
        ply: { type: 'integer' },
      },
      required: ['fen', 'solution', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repertoire',
    readOnly: true,
    description:
      "The student's White or Black opening repertoire (the tree they drill in Openings → Repertoire): every line from the initial position, with the notes on its moves, and how many of their moves are due for review. Read it before you suggest changes to it.",
    input_schema: {
      type: 'object',
      properties: { color: { type: 'string', enum: ['white', 'black'], description: 'Which repertoire (the side the student plays).' } },
      required: ['color'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_to_repertoire',
    description:
      "Add an opening line to the student's repertoire (their White or Black repertoire tree) so they can drill it. The line is given in SAN from the initial position. Only use it when the student wants the line.",
    input_schema: {
      type: 'object',
      properties: {
        color: { type: 'string', enum: ['white', 'black'], description: 'Which repertoire (the side the student plays).' },
        moves: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 },
        comment: { type: 'string' },
      },
      required: ['color', 'moves'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_from_repertoire',
    description:
      'Remove a move from the student\'s White or Black repertoire, with everything that follows it (the moves no other line leads to). Give the line from the initial position up to and including the move to remove, in SAN: ["e4", "e5", "f4"] removes 2. f4 and its continuations, ["e4"] the whole 1. e4 part. Only use it when the student wants it.',
    input_schema: {
      type: 'object',
      properties: {
        color: { type: 'string', enum: ['white', 'black'], description: 'Which repertoire.' },
        moves: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40, description: 'The line from the initial position; its last move is removed.' },
      },
      required: ['color', 'moves'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_game',
    description: "Open one of the student's imported games on the analysis board at a given moment, so you can go through it together.",
    input_schema: {
      type: 'object',
      properties: {
        game_id: { type: 'integer' },
        ply: { type: 'integer', minimum: 0, description: 'Half-moves played before the position to show (0 = the start).' },
      },
      required: ['game_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_report',
    description:
      "Add a new report to the Reports screen, where the student can read it any time: the statistics over the student's analysed games — results, accuracy, phases, tactical awareness, conversion, clock use, openings, error patterns and their costliest moments — over all of them, or over the games you choose (e.g. their last 20, one opening or one time control; analyse games that are not analysed yet with analyze_games first). Give it a title that says what it covers, and your written report as markdown (as in save_report) — or save that later with save_report. Returns the report's id and its statistics; the Reports screen shows the new report (switch_screen takes the student there).",
    input_schema: {
      type: 'object',
      properties: {
        game_ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 1000, description: "The games it covers (ids from search_games); only the student's analysed games count. Default: all of them." },
        title: { type: 'string', description: 'Its title on the Reports screen, e.g. "My last 20 blitz games" (default: the username and the number of games).' },
        markdown: { type: 'string', description: 'Your written report (Markdown, as in save_report), when it is ready.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_report',
    readOnly: true,
    description:
      "Read a report from the Reports screen: the statistics computed over the student's analysed games (results, accuracy, phases, tactical awareness, conversion, clock use, openings, error patterns), their costliest moments with FENs, and your saved written report if there is one. Without report_id: the newest report.",
    input_schema: { type: 'object', properties: { report_id: { type: 'integer' } }, additionalProperties: false },
  },
  {
    name: 'save_report',
    description:
      'Save your written training report (Markdown) to a report on the Reports screen — one the student made there or one you added with create_report —, where the student can read it any time; replaces the earlier text. There, fenced code blocks with the language `board` (lines "fen: …", optional "arrows: e2e4 g, g8f6 r", "caption: …") are drawn as boards, and [text](game:ID@PLY) links open a game at a moment.',
    input_schema: {
      type: 'object',
      properties: { report_id: { type: 'integer' }, markdown: { type: 'string' } },
      required: ['report_id', 'markdown'],
      additionalProperties: false,
    },
  },
  {
    name: 'speak',
    readOnly: true,
    description:
      "Say something out loud to the student in the app's natural voice. Only while the student has your voice switched on: end each reply with one speak call that says the reply the way you would say it to them in person.",
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'What to say, written for the ear: plain conversational sentences, moves in words ("knight to f3", "bishop takes e5, check"), no Markdown, lists or symbols, at most about 80 words.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_player_memory',
    readOnly: true,
    description: 'Your long-term notes about the student (Markdown), kept on their computer across sessions and shared by every coach they use in the app.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_player_memory',
    description:
      'Save to your long-term notes about the student. mode "append" (default) adds a dated note; mode "replace" rewrites the whole document — use it to reorganise or condense, keeping everything that is still relevant.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note (append) or the complete new document (replace), in Markdown.' },
        mode: { type: 'string', enum: ['append', 'replace'] },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

/** Tools the coach host answers itself: the coach's notes and the game database (both kept by the main process). */
export const HOST_TOOLS = new Set(['get_player_memory', 'update_player_memory', 'database_explorer', 'get_database_game']);

/** Tool definitions in MCP form. */
export const MCP_TOOLS = TOOL_DEFS.map(t => ({
  name: t.name,
  description: t.description,
  inputSchema: t.input_schema,
  annotations: t.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: ['save_report', 'update_player_memory', 'remove_from_repertoire'].includes(t.name) },
}));

export const toolDef = name => TOOL_DEFS.find(t => t.name === name) || null;

/**
 * Minimal JSON-schema validation for the subset used above. Returns a list of problems (empty when valid).
 * Strings are additionally capped at 200k characters so a runaway tool call cannot flood the app.
 */
export function validate(schema, value, path = 'input') {
  const errs = [];
  const check = (s, v, p) => {
    if (s.type === 'object') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return errs.push(`${p} must be an object`);
      for (const r of s.required || []) if (v[r] === undefined) errs.push(`${p}.${r} is required`);
      for (const [k, val] of Object.entries(v)) {
        if (!Object.hasOwn(s.properties || {}, k)) {
          if (s.additionalProperties === false) errs.push(`${p}.${k} is not allowed`);
          continue;
        }
        check(s.properties[k], val, `${p}.${k}`);
      }
    } else if (s.type === 'array') {
      if (!Array.isArray(v)) return errs.push(`${p} must be an array`);
      if (s.minItems !== undefined && v.length < s.minItems) errs.push(`${p} needs at least ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${p} has more than ${s.maxItems} items`);
      v.forEach((x, i) => check(s.items, x, `${p}[${i}]`));
    } else if (s.type === 'string') {
      if (typeof v !== 'string') return errs.push(`${p} must be a string`);
      if (v.length > 200_000) errs.push(`${p} is too long`);
      if (s.enum && !s.enum.includes(v)) errs.push(`${p} must be one of ${s.enum.join(', ')}`);
    } else if (s.type === 'integer' || s.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v)))
        return errs.push(`${p} must be ${s.type === 'integer' ? 'an integer' : 'a number'}`);
      if (s.minimum !== undefined && v < s.minimum) errs.push(`${p} must be ≥ ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errs.push(`${p} must be ≤ ${s.maximum}`);
    } else if (s.type === 'boolean') {
      if (typeof v !== 'boolean') errs.push(`${p} must be a boolean`);
    }
  };
  check(schema, value, path);
  return errs;
}

/** Short human label for a tool call (written to the app's log). */
export function toolLabel(name, input) {
  switch (name) {
    case 'analyze_position':
      return 'Analysing the position with Stockfish';
    case 'evaluate_move':
      return `Checking the move ${input?.move ?? ''}`;
    case 'play_moves':
      return `Verifying a line (${(input?.moves || []).slice(0, 4).join(' ')}${(input?.moves || []).length > 4 ? ' …' : ''})`;
    case 'get_position_features':
      return 'Reading the position’s features';
    case 'opening_info':
      return 'Looking up the opening';
    case 'search_openings':
      return `Searching openings: ${input?.query ?? ''}`;
    case 'database_explorer':
      return 'Looking in your game database';
    case 'get_database_game':
      return `Reading game #${input?.game_id ?? ''} of your database`;
    case 'search_games':
      return 'Searching your games';
    case 'get_game':
      return `Reading game #${input?.game_id ?? ''}`;
    case 'find_mistakes':
      return 'Collecting your mistakes';
    case 'get_player_stats':
      return 'Computing your statistics';
    case 'analyze_games':
      return input?.game_ids?.length ? `Analysing ${input.game_ids.length} game${input.game_ids.length === 1 ? '' : 's'} with Stockfish` : 'Analysing your newest games with Stockfish';
    case 'get_analysis_status':
      return 'Checking the analysis of your games';
    case 'set_board':
      return input?.ask_move ? 'Setting up a question on the board' : 'Showing a position on the board';
    case 'switch_screen':
      return SCREENS[input?.screen] ? `Switching to the ${SCREENS[input.screen].label} screen` : 'Switching screens';
    case 'set_engine':
      return `Switching Stockfish ${input?.on ? 'on' : 'off'}`;
    case 'create_exercise':
      return 'Saving an exercise';
    case 'get_repertoire':
      return `Reading your ${input?.color === 'black' ? 'Black' : 'White'} repertoire`;
    case 'add_to_repertoire':
    case 'remove_from_repertoire':
      return 'Updating your repertoire';
    case 'get_player_memory':
      return 'Reading my notes about you';
    case 'update_player_memory':
      return 'Updating my notes about you';
    case 'speak':
      return 'Speaking';
    case 'get_board_state':
      return 'Looking at your board';
    case 'open_game':
      return 'Opening a game';
    case 'create_report':
      return 'Adding a report';
    case 'get_report':
      return 'Reading your report';
    case 'save_report':
      return 'Saving your report';
    default:
      return name;
  }
}
