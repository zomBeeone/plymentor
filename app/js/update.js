// Updates in the window: a thin client of the app's main process (window.plymentor.update, see desktop/updates.js).
// A bar under the top bar offers a new version; nothing is downloaded or installed until the student says so, and
// before installing, the window saves a backup of the games (backups\ in the data folder).
import { html, useEffect, useState } from '../vendor/preact.js';
import { get } from './api.js';
import { toast } from './store.js';
import { cls } from './util.js';
import { Markdown } from './components/Markdown.js';

let status = null;
const listeners = new Set();
let subscribed = false;
let toasted = 0;

function setStatus(s) {
  status = s;
  // a check the student asked for (Help → Check for updates, or Settings) answers here
  if (s.checked?.manual && s.checked.at > toasted && s.state !== 'checking') {
    toasted = s.checked.at;
    if (s.checked.error) toast(`Plymentor could not look for updates: ${s.checked.error}`, 'error', 8000);
    else if (!s.checked.found) toast(`Plymentor ${s.version} is the newest version.`, 'success', 5000);
  }
  if (s.updatedFrom && !seen('updated')) toast(`Plymentor was updated to ${s.version}.`, 'success', 8000);
  for (const l of [...listeners]) l(s);
}

function seen(key) {
  try {
    if (sessionStorage.getItem(`plymentor-${key}`)) return true;
    sessionStorage.setItem(`plymentor-${key}`, '1');
  } catch {
    /* no storage: say it again after a reload */
  }
  return false;
}

/** Asks the main process; its answers are the updates' state. */
export async function update(method, args) {
  const d = window.plymentor;
  if (!d?.update) throw new Error('Updates need the Plymentor desktop app.');
  try {
    const r = await d.update(method, args);
    if (r && typeof r === 'object' && 'state' in r && 'mode' in r) setStatus(r);
    return r;
  } catch (e) {
    throw new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  }
}

function subscribe() {
  if (subscribed || !window.plymentor?.onUpdate) return;
  subscribed = true;
  window.plymentor.onUpdate(setStatus);
  update('status').catch(() => {});
}

/** The updates' state, kept up to date (null until known). */
export function useUpdates() {
  const [s, set] = useState(status);
  useEffect(() => {
    subscribe();
    listeners.add(set);
    if (status) set(status);
    return () => listeners.delete(set);
  }, []);
  return s;
}

const mb = bytes => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const fail = e => toast(e.message, 'error', 9000);

/** The bar under the top bar: a new version, its download, and installing it. */
export function UpdateBanner() {
  const u = useUpdates();
  const [busy, setBusy] = useState(null);
  const [notes, setNotes] = useState(false);
  if (!u?.release || u.mode === 'none') return null;
  if (u.dismissed && !busy && (u.state === 'available' || u.state === 'ready')) return null;
  return html`<div class="update-bar">
    <div class="banner info update">
      <${UpdateNow} u=${u} busy=${busy} setBusy=${setBusy} />
      ${u.state !== 'installing' && !busy && html`<button class="btn small ghost" onClick=${() => setNotes(!notes)}>${notes ? 'Hide what’s new' : 'What’s new'}</button>`}
      ${(u.state === 'available' || u.state === 'ready') && !busy && html`<button class="btn small ghost" title="Settings → Updates has it too" onClick=${() => update('later').catch(fail)}>Later</button>`}
    </div>
    ${notes && html`<div class="update-notes"><${Markdown} text=${notesOf(u.release)} /></div>`}
  </div>`;
}

// the release notes without their title line ("1.0.0 — 2026-10-23 — …")
const notesOf = r => r.notes.replace(/^[^\n]*\n/, '').trim() || r.notes;

/** What the student can do now with the update (the bar and Settings show the same). */
function UpdateNow({ u, busy, setBusy }) {
  const r = u.release;
  const portable = u.mode === 'portable';
  const install = async () => {
    setBusy('backup');
    try {
      const { bytes } = await get('/api/backup');
      await update('backup', { bytes });
      setBusy('install');
      await update('install');
    } catch (e) {
      fail(e);
      setBusy(null);
    }
  };
  if (busy === 'backup') return html`<span class="spinner"></span><span>Backing up your games before the update…</span><span class="spacer"></span>`;
  if (busy === 'install' || u.state === 'installing')
    return html`<span class="spinner"></span><span>${portable ? `Starting Plymentor ${r.version}…` : `Plymentor closes to install ${r.version}, then starts again…`}</span><span class="spacer"></span>`;
  if (u.state === 'downloading') {
    const p = u.progress || {};
    const pct = p.total ? Math.min(100, (100 * p.transferred) / p.total) : 0;
    return html`<span class="spinner"></span><span>Downloading Plymentor ${r.version}${p.total ? ` — ${mb(p.transferred)} of ${mb(p.total)}` : '…'}</span>
      <div class="progressbar update-progress"><div style=${{ width: `${pct}%` }}></div></div><span class="spacer"></span>
      <button class="btn small ghost" onClick=${() => update('cancel').catch(fail)}>Cancel</button>`;
  }
  if (u.state === 'ready')
    return portable
      ? html`<span><b>Plymentor ${r.version}</b> is downloaded, next to this one: ${u.file}. The old .exe stays; you can delete it afterwards.</span><span class="spacer"></span>
          <button class="btn small primary" onClick=${install}>Start it now</button>
          <button class="btn small ghost" onClick=${() => update('show-file').catch(fail)}>Show in folder</button>`
      : html`<span><b>Plymentor ${r.version}</b> is ready. Plymentor closes, installs it and starts again — your games and settings stay as they are.</span><span class="spacer"></span>
          <button class="btn small primary" onClick=${install}>Restart and update</button>`;
  if (u.state === 'checking') return html`<span class="spinner"></span><span>Looking for updates…</span><span class="spacer"></span>`;
  if (!r.download)
    return html`<span><b>Plymentor ${r.version}</b> is available. It comes as an installer: install it once, and the next updates come by themselves — your games and settings stay.</span><span class="spacer"></span>
      <button class="btn small primary" onClick=${() => update('open-page').catch(fail)}>Get the installer</button>`;
  return html`<span><b>Plymentor ${r.version}</b> is available${portable ? ` (${mb(r.size)})` : ''}.${u.error ? html` <span class="update-error">${u.error}</span>` : ''}</span><span class="spacer"></span>
    <button class="btn small primary" onClick=${() => update('download').catch(fail)}>${portable ? 'Download' : 'Update'}</button>`;
}

/** Settings → Updates. */
export function UpdateSettings() {
  const u = useUpdates();
  const [busy, setBusy] = useState(null);
  if (!u) return null;
  const c = u.checked;
  const when = c && new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return html`<div class="card">
    <h2>Updates</h2>
    <p class="muted" style="margin-top:0">This is Plymentor ${u.version}${u.mode === 'portable' ? ' (portable)' : u.mode === 'installed' ? '' : ' (neither installed nor the portable .exe: it is not updated)'}. Plymentor looks for new versions on its <a href="https://github.com/zomBeeone/plymentor/releases" target="_blank" rel="noopener noreferrer">releases page</a> and asks you before it updates. It installs only updates signed by Studio Nox, Plymentor’s maker. Your games, analyses, settings, the coach’s notes and your game database stay as they are; before installing, Plymentor saves a backup of your games in the data folder (backups).</p>
    ${u.release && u.mode !== 'none'
      ? html`<div class=${cls('banner info update', 'in-card')}><${UpdateNow} u=${u} busy=${busy} setBusy=${setBusy} /></div>`
      : u.state === 'checking'
        ? html`<div class="row"><span class="spinner"></span> Looking for updates…</div>`
        : c && html`<div class="muted small">${c.error ? html`<span class="update-error">${c.error}</span>` : `No newer version (looked at ${when}).`}</div>`}
    <div class="row wrap" style="margin-top:10px">
      <button class="btn" disabled=${u.state === 'checking' || u.state === 'downloading' || u.state === 'installing'} onClick=${() => update('check').catch(fail)}>Check for updates</button>
      <label class="check"><input type="checkbox" checked=${u.auto} onChange=${e => update('auto', { on: e.currentTarget.checked }).catch(fail)} /> Look for updates when Plymentor starts</label>
    </div>
    <small class="muted">${u.mode === 'portable'
      ? 'This is a portable .exe: Plymentor’s releases come as an installer. Install it once — your games and settings stay — and the next updates come by themselves.'
      : 'The installed Plymentor downloads only the parts of the new version that changed (usually a few MB).'}</small>
  </div>`;
}
