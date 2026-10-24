// The game database the student added (a Scid 5 database) from the window: a thin client of the app's main process
// (window.plymentor.gigabase, see desktop/gigabase/manager.js), with its state shared by every screen that shows it.
import { html, useEffect, useState } from '../vendor/preact.js';
import { toast } from './store.js';

let status = null;
const listeners = new Set();
let subscribed = false;

function setStatus(s) {
  status = s;
  for (const l of [...listeners]) l(s);
}

/** Asks the main process; status-like answers update the shared state. */
export async function gigabase(method, args) {
  const d = window.plymentor;
  if (!d?.gigabase) throw new Error('The game database needs the Plymentor desktop app.');
  try {
    const r = await d.gigabase(method, args);
    if (r && typeof r === 'object' && 'installed' in r && 'job' in r) setStatus(r);
    return r;
  } catch (e) {
    throw new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  }
}

function subscribe() {
  if (subscribed || !window.plymentor?.onGigabase) return;
  subscribed = true;
  window.plymentor.onGigabase(setStatus);
  gigabase('status').catch(() => {});
}

/** The game database's state: { installed, job, error }, kept up to date (null until known). */
export function useGigabase() {
  const [s, set] = useState(status);
  useEffect(() => {
    subscribe();
    listeners.add(set);
    if (status) set(status);
    return () => listeners.delete(set);
  }, []);
  return s;
}

const STAGES = { unpack: 'Unpacking the archive', index: 'Building the opening index' };

/** The progress of adding a database, with Cancel. */
export function GigabaseJob({ job }) {
  const pct = Math.round((job.fraction || 0) * 1000) / 10;
  return html`<div class="gb-job">
    <div class="row"><span class="spinner"></span><b>${STAGES[job.stage] || job.label}</b><span class="muted">${pct.toFixed(pct < 10 ? 1 : 0)}%</span>
      <span class="spacer"></span><button class="btn small ghost" onClick=${() => gigabase('cancel').catch(e => toast(e.message, 'error'))}>Cancel</button></div>
    <div class="progressbar"><div style=${{ width: `${pct}%` }}></div></div>
    ${job.stage === 'index' && job.label && job.label !== 'Starting' && html`<div class="muted small">${job.label}</div>`}
  </div>`;
}

export const addGigabase = () => gigabase('add').catch(e => toast(e.message, 'error'));
export const reindexGigabase = () => gigabase('reindex').catch(e => toast(e.message, 'error'));

/** What the explorer shows while no database can answer: adding one, its progress, or what went wrong. */
export function GigabaseSetup({ gb }) {
  const inst = gb.installed;
  return html`<div class="gb-setup">
    <h3>${inst ? inst.title : 'Your game database'}</h3>
    ${inst?.missing
      ? html`<p>Its files are not where they were: <b>${inst.path}</b>. Connect the drive they are on, or add the database again from where it is now.</p>`
      : inst?.needsIndex
        ? html`<p>This version of Plymentor reads the database with a new opening index; building it takes a few minutes for a big database.</p>`
        : html`<p>Add a database of games in <b>Scid 5 format (.si5)</b> — for example one with millions of master and over-the-board games — and see, for any position, what was played there, how it scored and the strongest games, on your computer.</p>`}
    ${gb.job
      ? html`<${GigabaseJob} job=${gb.job} />`
      : inst?.needsIndex && !inst.missing
        ? html`<button class="btn primary" onClick=${reindexGigabase}>Build the opening index again</button>`
        : html`<button class="btn primary" onClick=${addGigabase}>Add a database…</button>`}
    ${gb.error && html`<div class="gb-error">${gb.error}</div>`}
    ${!inst &&
    html`<p class="muted small">Choose the database's <b>.si5</b> file — its <b>.sn5</b> and <b>.sg5</b> files must be in the same folder; they stay where they are — or the <b>.7z</b> archive you downloaded, which Plymentor unpacks into its own folder. Plymentor then builds an opening index (a few minutes for millions of games). You add it once: it is there every time you open the app.</p>`}
  </div>`;
}
