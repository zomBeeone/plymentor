// App shell of the Plymentor window: the games database and engines (the backend worker), top bar, routing,
// background events, and closing cleanly when the window closes.
import { html, render } from '../vendor/preact.js';
import { get } from './api.js';
import { startBackend, stopBackend, subscribe } from './local.js';
import { setState, useStore, toast } from './store.js';
import { applyBoardTheme } from './board-theme.js';
import { useRoute } from './router.js';
import { cls } from './util.js';
import { initCoach, onCoachUi } from './coachTerm.js';
import { initVoice } from './voice.js';
import { UpdateBanner } from './update.js';
import { Analysis } from './views/Analysis.js';
import { Openings } from './views/Openings.js';
import { Games } from './views/Games.js';
import { Reports } from './views/Reports.js';
import { Train } from './views/Train.js';
import { Settings } from './views/Settings.js';
import { LOCAL_PROFILE_ID } from '../../shared/protocol.js';

// Training games against Stockfish are played on the Board (#/play opens its new-game dialog).
const VIEWS = [
  ['analysis', 'Board', Analysis],
  ['openings', 'Openings', Openings],
  ['games', 'Games', Games],
  ['reports', 'Reports', Reports],
  ['train', 'Train', Train],
  ['settings', 'Settings', Settings],
];

function App() {
  const s = useStore();
  const route = useRoute();
  const view = route.view === 'play' ? 'analysis' : route.view;
  const View = (VIEWS.find(v => v[0] === view) || VIEWS[0])[2];
  const running = s.jobs.filter(j => j.status === 'running');
  return html`
    <header class="topbar">
      <a class="brand" href="#/analysis"><img src="/assets/icon.svg" alt="" />Plymentor</a>
      <nav class="nav">
        ${VIEWS.map(
          ([id, label]) =>
            html`<a href=${`#/${id}`} class=${cls(view === id && 'active')}>${label}${id === 'train' && s.exercisesDue ? html`<span class="count">${s.exercisesDue}</span>` : null}</a>`,
        )}
      </nav>
      <div class="status-pills">
        ${running.map(
          j => html`<a class="pill busy link" href="#/games" title="Batch analysis in progress">Analysing ${j.progress?.gamesDone ?? 0}/${j.progress?.gamesTotal ?? '?'} games</a>`,
        )}
        <span class=${cls('pill', s.status?.engine?.ok ? 'ok' : 'warn')} title=${s.status?.engine?.ok ? `Stockfish runs on this computer${s.status.engine.threaded ? ' (multi-threaded)' : ' (single thread)'}` : s.status?.engine?.error || 'Starting Stockfish…'}>
          ${s.status?.engine?.ok ? s.status.engine.name : s.status ? 'Engine error' : 'Engine…'}
        </span>
        <${CoachPill} s=${s} />
      </div>
    </header>
    ${s.banner && html`<div class=${cls('banner', s.banner.kind)}>${s.banner.text} ${s.banner.action && html`<button class="btn small" onClick=${s.banner.action.run}>${s.banner.action.label}</button>`}</div>`}
    <${UpdateBanner} />
    <main><${View} route=${route} /></main>
    <div class="toasts">${s.toasts.map(t => html`<div class=${cls('toast', t.kind)}>${t.text}</div>`)}</div>
  `;
}

function CoachPill({ s }) {
  const st = s.coachStatus || {};
  const label = st.label || 'Coach';
  let text;
  let kind;
  if (st.state === 'offline') {
    text = 'not connected';
    kind = 'warn';
  } else if (st.state === 'running') {
    text = st.signIn ? 'sign in' : st.starting ? 'starting…' : st.busy ? 'working…' : 'ready';
    kind = st.signIn ? 'warn' : st.busy || st.starting ? 'busy' : 'ok';
  } else {
    text = st.state === 'missing' ? 'not installed' : st.state === 'exited' ? 'ended' : st.state || '…';
    kind = st.state === 'missing' || st.state === 'exited' || st.state === 'error' || st.state === 'outdated' ? 'warn' : 'busy';
  }
  return html`<a class=${cls('pill link', kind)} href="#/settings" title=${st.message || 'Coach settings'}>${label}: ${text}</a>`;
}

// ---------------------------------------------------------------------------------------------
// Start-up screens (before the app runs)

function screen(content) {
  document.body.classList.add('start-page');
  render(
    html`<div class="start">
      <div class="start-brand"><img src="/assets/icon.svg" alt="" />Plymentor</div>
      <div class="start-card card">${content}</div>
      <img class="studio-logo" src="/assets/brand/studio-nox.png" alt="Studio Nox" />
    </div>`,
    document.getElementById('app'),
  );
}

function failed(title, text) {
  screen(html`<h2>${title}</h2><p>${text}</p>
    <div class="row wrap"><button class="btn primary" onClick=${() => location.reload()}>Try again</button></div>
    <p class="muted">If this keeps happening, the log in File → Open the log folder (menu bar: press Alt) says more.</p>`);
}

// The games database can only be open once. A reloaded window waits until the previous page has let go of it.
function holdDatabase() {
  return new Promise(resolve => {
    navigator.locks.request(`plymentor-db:${LOCAL_PROFILE_ID}`, () => {
      resolve();
      return new Promise(() => {}); // held as long as this page lives
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openGames() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await startBackend(LOCAL_PROFILE_ID);
    } catch (e) {
      // the previous page's worker may still be closing the database files
      const locked = /NoModificationAllowed|locked|access handle/i.test(`${e.name} ${e.message}`);
      if (!locked || attempt >= 8) throw e;
      await stopBackend();
      await sleep(500);
    }
  }
}

// ---------------------------------------------------------------------------------------------

async function boot() {
  if (!window.plymentor) return failed('Plymentor could not start', 'This page only works inside the Plymentor app.');
  setState({ user: { id: LOCAL_PROFILE_ID } });
  window.plymentor.onClosing(() => stopBackend());

  await holdDatabase();
  screen(html`<div class="row"><span class="spinner"></span> Opening your games…</div>`);
  try {
    const { storage } = await openGames();
    if (!storage?.persistent) throw new Error('The app could not open its storage on this computer.');
  } catch (e) {
    return failed('Your games could not be opened', e.message);
  }
  document.body.classList.remove('start-page');

  subscribe('jobs', d => {
    if (d.type === 'job') {
      setState(s => ({ jobs: [...s.jobs.filter(j => j.id !== d.id), { id: d.id, status: d.status, progress: d.progress, params: d.params || s.jobs.find(j => j.id === d.id)?.params }] }));
      if (d.status === 'done') toast(`Analysis finished: ${d.progress?.gamesDone ?? ''} games`, 'success');
      if (d.status === 'failed') toast(`Analysis failed: ${d.error}`, 'error');
      if (d.status !== 'running') setTimeout(() => setState(s => ({ jobs: s.jobs.filter(j => j.id !== d.id) })), 4000);
    } else if (d.type === 'game-analyzed') window.dispatchEvent(new CustomEvent('cc:game-analyzed', { detail: d.gameId }));
  });
  subscribe('coach-ui', onCoachUi);

  try {
    const [settings, status, desktop] = await Promise.all([get('/api/settings'), get('/api/status'), window.plymentor.info()]);
    setState({ settings, status, desktop });
    applyBoardTheme(settings.board);
  } catch (e) {
    return failed('Plymentor could not start', e.message);
  }
  initVoice();
  initCoach();
  get('/api/exercises?due=1')
    .then(r => setState({ exercisesDue: r.due }))
    .catch(() => {});
  render(html`<${App} />`, document.getElementById('app'));
}

boot();
