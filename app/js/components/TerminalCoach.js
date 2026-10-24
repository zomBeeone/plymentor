// The coach panel: the live terminal of the coach session (Claude Code, Codex or Antigravity CLI, run by the app on
// the student's computer), with the app's quick-request buttons underneath. The student can also type straight into
// the terminal.
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { useStore, toast } from '../store.js';
import { cls } from '../util.js';
import { attachTerminal, detachTerminal, coachRequest, interruptCoach, restartCoach, compactMoveEval, focusTerminal, installCoachCli, reconnectNow, startTraining } from '../coachTerm.js';
import { setVoiceEnabled, stopSpeaking } from '../voice.js';

/** Fills the handle the views use (send, note, stop…) with terminal versions. */
function fillHandle(handle, busy) {
  Object.assign(handle, {
    busy,
    // task: a request template (shared/prompts.js); otherwise the text is typed as is (e.g. "My answer: 12. Nf3").
    send: (text, { task, taskArgs } = {}) => coachRequest(task ? { task, taskArgs } : { text }),
    // automatic move comment: only when the coach is free, so it never piles up
    note: ({ moveEval, mode }) => coachRequest({ task: 'moveComment', taskArgs: { moveEval: compactMoveEval(moveEval), mode }, ifIdle: true }).then(() => null),
    run: () => null,
    stop: interruptCoach,
    newThread: () => {},
    ensureThread: async () => null,
    lastNote: () => null,
    threadId: null,
  });
}

const STATE_TEXT = {
  connecting: 'Connecting…',
  offline: 'Not connected',
  outdated: 'Restart the app',
  running: 'Ready',
  exited: 'Ended',
  missing: 'Not installed',
  error: 'Error',
  idle: 'Not started',
};

export function TerminalCoach(props) {
  const s = useStore();
  const st = s.coachStatus || { state: 'connecting' };
  const box = useRef(null);
  const [installLog, setInstallLog] = useState(null);
  if (props.handle) fillHandle(props.handle, !!st.busy);

  useEffect(() => {
    const el = box.current;
    attachTerminal(el);
    return () => detachTerminal(el);
  }, []);

  const label = st.label || s.host?.providers?.[s.host?.settings?.provider]?.label || 'Coach';
  const name = st.name || s.host?.providers?.[st.provider]?.name || label;
  const pill = st.state === 'running' ? (st.signIn ? 'Sign in' : st.starting ? 'Starting…' : st.busy ? 'Working…' : 'Ready') : STATE_TEXT[st.state] || st.state;
  const pillKind = st.state === 'running' ? (st.signIn ? 'warn' : st.busy || st.starting ? 'busy' : 'ok') : st.state === 'connecting' ? 'busy' : 'warn';
  // The coach has not started working yet: signing in for the first time, or its start-up prompt went astray.
  const offerStart = st.state === 'running' && (st.signIn || st.offerStart) && !st.busy;

  const install = async () => {
    setInstallLog('');
    try {
      await installCoachCli(st.provider, text => setInstallLog(l => ((l || '') + text).slice(-4000)));
      setInstallLog(null);
      restartCoach();
    } catch (e) {
      setInstallLog(null);
      toast(e.message, 'error', 8000);
    }
  };

  const quick = (props.quick || []).filter(Boolean);
  const blocked = st.state !== 'running';
  const cantAsk = ['missing', 'connecting', 'offline', 'outdated'].includes(st.state); // otherwise a request (re)starts the session
  const voiceOn = !!s.settings?.voice?.enabled;

  let overlay = null;
  if (st.state === 'offline')
    overlay = html`<div class="card"><h3>The coach is not connected</h3><p class="muted">${st.message || ''}</p><button class="btn" onClick=${reconnectNow}>Connect again</button></div>`;
  else if (st.state === 'outdated') overlay = html`<div class="card"><h3>Restart Plymentor</h3><p>${st.message}</p></div>`;
  else if (st.state === 'missing')
    overlay = html`<div class="card">
      <h3>${label} is not installed</h3>
      <p class="muted">Plymentor can install it for you with its maker's official installer. You can also pick another coach in <a href="#/settings">Settings</a>.</p>
      ${installLog !== null ? html`<pre class="install-log">${installLog || 'Starting the installer…'}</pre>` : html`<button class="btn primary" onClick=${install}>Install ${label}</button>`}
    </div>`;
  else if (st.state === 'connecting') overlay = null;
  else if (blocked)
    overlay = html`<div class="card">
      <p>${st.message || 'The coach session is not running.'}</p>
      <button class="btn primary" onClick=${restartCoach}>Start the coach</button>
    </div>`;

  return html`
    <div class="panel coach term-coach">
      <div class="panel-head">
        <span class="coach-title grow ellipsis">${props.title || 'Coach'} <span class="muted">· ${label}</span></span>
        <span class=${cls('pill', pillKind)}>${pill}</span>
        ${s.coachSpeaking && html`<button class="btn small ghost" title="Stop talking (the coach keeps working)" onClick=${stopSpeaking}>Quiet</button>`}
        <button
          class=${cls('btn small voice-toggle', voiceOn ? 'on' : 'ghost', s.coachSpeaking && 'speaking')}
          title=${voiceOn ? 'Coach voice is on — click to mute' : 'Coach voice is off — click to hear your coach talk'}
          aria-pressed=${voiceOn}
          onClick=${() => setVoiceEnabled(!voiceOn)}
        >${voiceOn ? '🔊' : '🔇'}</button>
        ${st.busy && html`<button class="btn small" title="Interrupt the coach (Esc)" onClick=${interruptCoach}>Stop</button>`}
        <button class="btn small ghost" disabled=${cantAsk} title="Start a fresh coaching session (the coach keeps its notes about you)" onClick=${() => confirm('Start a new coaching session? The conversation in the terminal is closed; the coach keeps its notes about you.') && restartCoach()}>
          Restart
        </button>
      </div>
      <div class="term-wrap">
        <div class="term-box" ref=${box} onClick=${focusTerminal}></div>
        ${overlay && html`<div class="term-overlay">${overlay}</div>`}
      </div>
      <div class="coach-input">
        ${offerStart &&
        html`<div class="start-training">
          <button class="btn primary" title="Your coach greets you, recalls what it knows about you and looks at your board" onClick=${startTraining}>▶ Start training with ${name}</button>
          ${st.signIn && html`<span>Sign in to ${name} in the terminal above — it opens your browser. Training then starts by itself.</span>`}
        </div>`}
        ${quick.length
          ? html`<div class="quick">${quick.map(
              q => html`<button class="btn" disabled=${cantAsk} onClick=${() => coachRequest(q.task ? { task: q.task, taskArgs: q.taskArgs?.() } : { text: `[App] ${q.text || q.label}` })}>${q.label}</button>`,
            )}</div>`
          : null}
        <div class="coach-foot" title=${s.host?.providers?.[st.provider]?.account ? `Runs on ${s.host.providers[st.provider].account}` : ''}>
          <span>Click the terminal to type · Ctrl+C copies a selection</span>
        </div>
        <div class="coach-disclaimer">Your coach uses your AI account's tokens or credits. Studio Nox takes no responsibility for any costs.</div>
      </div>
    </div>
  `;
}
