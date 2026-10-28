// Describes what the student currently sees in the app, as reported by the window. Terminal coaches
// (Claude Code, Codex, Antigravity) read it through the get_board_state tool instead of receiving it with every message.
import { buildBoardContext } from './context.js';
import { ENGINE_LABELS } from '../../../../shared/tools.js';

const VIEW_NAMES = {
  analysis: 'Board (analysis board)',
  play: 'Board (training game against Stockfish)',
  openings: 'Openings (explorer and repertoire)',
  drill: 'Openings (repertoire drill)',
  games: 'Games library',
  reports: 'Reports',
  exercises: 'Train → Exercises',
  lesson: 'Train → Lessons',
  settings: 'Settings',
  books: 'Book reader',
};

/** The screens with live Stockfish analysis (each with its own switch, the student's), by the view the window reports. */
export const ENGINE_SCREENS = { analysis: 'board', play: 'board', openings: 'openings', drill: 'openings', books: 'books' };

/** What the student sees of Stockfish's live analysis on this screen, and the other screens' switches. */
function describeEngines(view, engines) {
  const sw = s => (engines[s] ? 'on' : 'off');
  const here = ENGINE_SCREENS[view];
  if (!here) return `Live Stockfish analysis (the student's switches): Board screen ${sw('board')}, Openings screen ${sw('openings')} (none on this screen).`;
  if (here === 'books')
    return `Live Stockfish analysis on the Book reader's board: ${engines.books ? 'on — the student sees its evaluation bar, engine lines and best-move arrow' : 'off — the student sees no evaluation bar, engine lines or best-move arrow'}; on the Board screen: ${sw('board')}, on the Openings screen: ${sw('openings')}.`;
  const other = here === 'board' ? 'openings' : 'board';
  const now =
    view === 'play'
      ? `hidden while the training game is on the board (the Board screen's switch is ${sw('board')})`
      : view === 'drill'
        ? `hidden during the repertoire drill (the Openings screen's switch is ${sw('openings')})`
        : engines[here]
          ? 'on — the student sees its evaluation bar, engine lines and best-move arrow'
          : 'off — the student sees no evaluation bar, engine lines or best-move arrow';
  return `Live Stockfish analysis on this screen: ${now}; on the ${ENGINE_LABELS[other]} screen: ${sw(other)}.`;
}

/** state: { view, context, engines: { board, openings, books } (the Stockfish switches) } from the window, or null when no app window is open. */
export function describeAppState(state) {
  if (!state?.view) return 'The Plymentor window is not showing a screen right now, so there is no board to look at.';
  const ctx = state.context || {};
  const lines = [`Active screen: ${VIEW_NAMES[state.view] || state.view}`];
  if (state.engines) lines.push(describeEngines(state.view, state.engines));
  if (ctx.report) lines.push(`Open report: #${ctx.report.id} "${ctx.report.title}"${ctx.report.hasNarrative ? ' (your written report is saved)' : ' (no written report yet)'}. Read it with get_report.`);
  if (ctx.lessonTopic) lines.push(`Lesson in progress: ${ctx.lessonTopic}`);
  if (ctx.question) lines.push(`You asked the student to find a move in this position (set_board with ask_move); they have not answered yet.`);
  if (ctx.ucis || ctx.fen || ctx.startFen) lines.push(buildBoardContext(ctx));
  else lines.push('There is no chess position on this screen.');
  return lines.join('\n');
}
