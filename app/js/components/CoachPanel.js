// The coach panel of a screen: the coach's terminal (Claude Code, Codex or Antigravity CLI, run by the app on the
// student's computer) with the app's quick-request buttons. It fills the screen's handle (send, note, stop…).
import { html } from '../../vendor/preact.js';
import { TerminalCoach } from './TerminalCoach.js';

export function CoachPanel(props) {
  return html`<${TerminalCoach} ...${props} />`;
}
