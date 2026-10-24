// Describes what the student currently sees in the app, as reported by the window. Terminal coaches
// (Claude Code, Codex, Antigravity) read it through the get_board_state tool instead of receiving it with every message.
import { buildBoardContext } from './context.js';

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
};

/** state: { view, context } from the window, or null when no app window is open. */
export function describeAppState(state) {
  if (!state?.view) return 'The Plymentor window is not showing a screen right now, so there is no board to look at.';
  const ctx = state.context || {};
  const lines = [`Active screen: ${VIEW_NAMES[state.view] || state.view}`];
  if (ctx.report) lines.push(`Open report: #${ctx.report.id} "${ctx.report.title}"${ctx.report.hasNarrative ? ' (your written report is saved)' : ' (no written report yet)'}. Read it with get_report.`);
  if (ctx.lessonTopic) lines.push(`Lesson in progress: ${ctx.lessonTopic}`);
  if (ctx.question) lines.push(`You asked the student to find a move in this position (set_board with ask_move); they have not answered yet.`);
  if (ctx.ucis || ctx.fen || ctx.startFen) lines.push(buildBoardContext(ctx));
  else lines.push('There is no chess position on this screen.');
  return lines.join('\n');
}
