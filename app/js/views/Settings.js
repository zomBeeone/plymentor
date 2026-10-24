// Settings: the coach (run by the app's coach host), its voice and notes, profile, engine, board, the game database, your
// data (folder, backup, restore) and updates.
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { get, post } from '../api.js';
import { setState, toast, useStore } from '../store.js';
import { applyBoardTheme, BOARD_THEMES, boardImage, PIECE_SETS, pieceUrl } from '../board-theme.js';
import { cls } from '../util.js';
import { hostRequest, installCoachCli, restartCoach, coachProfileChanged } from '../coachTerm.js';
import { browserVoices, installNaturalVoice, langOf, sayTest, setVoiceEnabled, stopSpeaking, voiceEngine } from '../voice.js';
import { APP_VERSION } from '../../../shared/protocol.js';
import { gigabase, useGigabase, GigabaseJob, addGigabase, reindexGigabase } from '../gigabase.js';
import { UpdateSettings } from '../update.js';

const SOURCE_URL = typeof __SOURCE_URL__ === 'string' ? __SOURCE_URL__ : '';
const desktop = () => window.plymentor;

async function save(patch, quiet) {
  try {
    const settings = await post('/api/settings', patch);
    setState({ settings });
    applyBoardTheme(settings.board);
    if (patch.profile || patch.language) coachProfileChanged(settings);
    if (!quiet) toast('Saved', 'success', 1500);
    return settings;
  } catch (e) {
    toast(e.message, 'error');
  }
}

function TextField({ label, value, onSave, type = 'text', placeholder, hint, width, autocomplete }) {
  const [v, setV] = useState(value ?? '');
  // Follow the saved value when it changes — not right after mounting (effects run after the first frame, and would
  // wipe what was typed before it).
  const shown = useRef(value);
  useEffect(() => {
    if (shown.current === value) return;
    shown.current = value;
    setV(value ?? '');
  }, [value]);
  const commit = () => {
    if (String(v) !== String(value ?? '')) onSave(type === 'number' ? Number(v) : v);
  };
  return html`<label class="field"><span>${label}</span>
    <input type=${type} value=${v} placeholder=${placeholder || ''} autocomplete=${autocomplete || 'off'} style=${width ? { width } : null} onInput=${e => setV(e.currentTarget.value)} onBlur=${commit} onKeyDown=${e => e.key === 'Enter' && commit()} />
    ${hint && html`<small class="muted">${hint}</small>`}
  </label>`;
}

const connected = s => !!s.host && !['offline', 'outdated', 'connecting'].includes(s.coachStatus?.state);

// ---------------------------------------------------------------------------------------------
// The coach (its settings are kept by the coach host, on this computer)

const PROVIDER_ORDER = ['claude-code', 'codex', 'gemini'];
const PROVIDER_TEXT = {
  'claude-code': { name: 'Claude Code', how: 'with your Claude Pro or Max subscription', model: 'e.g. opus, sonnet', maker: 'Anthropic' },
  codex: { name: 'ChatGPT', how: 'OpenAI Codex CLI with your ChatGPT Plus or Pro subscription', model: 'e.g. gpt-5.5', maker: 'OpenAI' },
  gemini: { name: 'Gemini', how: "Google's Antigravity CLI with your Google account", model: 'e.g. Gemini 3.5 Flash', maker: 'Google' },
};
const SIGN_IN = {
  'claude-code': 'Sign-in: if Claude Code is not signed in yet, it shows the sign-in steps in the coach panel the first time.',
  codex: 'Sign-in: the first time, Codex asks you to sign in with your ChatGPT account in the coach panel (it opens your web browser).',
  gemini:
    'Sign-in: the first time, the Antigravity CLI asks a few set-up questions in the coach panel (colours, layout, trusting the coach’s folder) and how to sign in — choose Google OAuth; your web browser opens to sign in with Google.',
};

async function saveCoach(patch) {
  try {
    const settings = await hostRequest('settings-set', { patch });
    setState(st => ({ host: { ...(st.host || {}), settings } }));
    toast('Saved', 'success', 1500);
    return settings;
  } catch (e) {
    toast(e.message, 'error');
  }
}

function CoachSettings({ st }) {
  const s = useStore();
  const online = connected(s);
  const hs = s.host?.settings || {};
  const provider = hs.provider || 'claude-code';
  const [clis, setClis] = useState(null);
  const [log, setLog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState(hs.initialPrompt || '');
  const refresh = fresh =>
    hostRequest('clis', { fresh: !!fresh })
      .then(setClis)
      .catch(() => {});
  useEffect(() => {
    if (online) refresh();
  }, [online]);
  const shownPrompt = useRef(hs.initialPrompt);
  useEffect(() => {
    if (shownPrompt.current === hs.initialPrompt) return; // (see TextField)
    shownPrompt.current = hs.initialPrompt;
    setPrompt(hs.initialPrompt || '');
  }, [hs.initialPrompt]);

  const choose = async id => {
    if (await saveCoach({ provider: id })) toast(`Your coach is now ${PROVIDER_TEXT[id].name}. The session starts in the coach panel.`, 'success');
  };
  const install = async id => {
    setBusy(true);
    setLog('');
    try {
      await installCoachCli(id, text => setLog(l => ((l || '') + text).slice(-6000)));
      toast(`${PROVIDER_TEXT[id].name} is installed.`, 'success');
      setLog(null);
      await refresh(true);
    } catch (e) {
      toast(e.message, 'error', 9000);
    }
    setBusy(false);
  };

  const cli = clis?.find(c => c.id === provider);
  return html`<div class="card">
    <h2>Your coach</h2>
    <p class="muted" style="margin-top:0">Your coach runs on your computer with your own subscription — no API key needed. It sees your board, runs Stockfish through the app, and keeps notes about you between sessions. Its settings and notes stay on this computer.</p>
    ${!online
      ? html`<div class="row"><span class="spinner"></span> <span class="muted">${s.coachStatus?.message || 'Connecting to the coach…'}</span></div>`
      : html`<div class="provider-list">
            ${PROVIDER_ORDER.map(id => {
              const c = clis?.find(x => x.id === id);
              const t = PROVIDER_TEXT[id];
              return html`<label class=${cls('provider', provider === id && 'active')}>
                <input type="radio" name="coach-provider" checked=${provider === id} onChange=${() => choose(id)} />
                <div class="grow">
                  <div><b>${t.name}</b> <span class="muted">— ${t.how}</span>${id === 'claude-code' ? html` <span class="badge green">recommended</span>` : null}</div>
                  <div class="muted" style="font-size:12.5px">
                    ${!clis
                      ? 'Checking…'
                      : c?.installed
                        ? html`${c.version ? `Installed (${c.version})` : 'Installed'}${c.login ? html` · <span class=${c.login.ok ? 'ok-text' : 'warn-text'}>${c.login.text}</span>` : ''}`
                        : `Not installed — Plymentor can install ${c?.label || 'it'} with ${t.maker}'s official installer`}
                  </div>
                </div>
              </label>`;
            })}
          </div>
          <div class="col" style="margin-top:12px">
            <div class="row wrap">
              ${cli && !cli.installed
                ? html`<button class="btn primary" disabled=${busy} onClick=${() => install(provider)}>${busy ? html`<span class="spinner"></span> Installing…` : `Install ${PROVIDER_TEXT[provider].name}`}</button>`
                : html`<button class="btn" disabled=${busy || !cli} onClick=${() => install(provider)} title="Install the latest version with the official installer">${busy ? html`<span class="spinner"></span> Updating…` : 'Update'}</button>`}
              <button class="btn" onClick=${() => confirm('Start a new coaching session? The coach keeps its notes about you.') && restartCoach()}>Restart the coach session</button>
              <button class="btn ghost" onClick=${() => refresh(true)}>Check again</button>
            </div>
            ${log !== null && html`<pre class="install-log">${log || 'Starting…'}</pre>`}
            ${cli?.path && html`<small class="muted">Program: ${cli.path}</small>`}
            <small class="muted">${SIGN_IN[provider]}</small>
            <div class="settings-grid">
              <${TextField} label="Model (optional)" value=${hs.models?.[provider]} onSave=${v => saveCoach({ models: { [provider]: v.trim() } })} placeholder=${PROVIDER_TEXT[provider].model} hint="Empty = the program's default. Applies when the session restarts." />
            </div>
          </div>
          <label class="field" style="margin-top:12px"><span>Start-up prompt — sent to the coach each time you open the app</span>
            <textarea rows="4" value=${prompt} placeholder=${s.host?.defaultInitialPrompt || ''} onInput=${ev => setPrompt(ev.currentTarget.value)} onBlur=${() => prompt !== (hs.initialPrompt || '') && saveCoach({ initialPrompt: prompt })}></textarea>
            <small class="muted">Empty = the default shown above in grey. Applies from the next session.</small>
          </label>`}
    <div class="settings-grid" style="margin-top:10px">
      <${TextField} label="Coach language" value=${st.language} onSave=${v => save({ language: v || 'English' })} placeholder="English" hint="e.g. English, Türkçe, Deutsch" />
      <label class="field"><span>Automatic move comments</span>
        <select value=${st.autoComment} onChange=${ev => save({ autoComment: ev.currentTarget.value })}>
          <option value="off">Off</option><option value="mistakes">On inaccuracies, mistakes and blunders</option><option value="all">On every move I play</option>
        </select>
        <small class="muted">When you play moves on the analysis board. The coach only comments when it is not busy.</small>
      </label>
    </div>
  </div>`;
}

function VoiceSettings({ st }) {
  const v = st.voice || {};
  const [progress, setProgress] = useState(null);
  const [, setVoicesLoaded] = useState(0);
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const f = () => setVoicesLoaded(n => n + 1);
    synth.addEventListener?.('voiceschanged', f);
    return () => synth.removeEventListener?.('voiceschanged', f);
  }, []);

  const lang = langOf(st.language);
  const english = lang === 'en';
  const downloaded = !!v.naturalDownloaded;
  const engine = voiceEngine();
  const voices = browserVoices(lang);

  const install = async () => {
    setProgress(0);
    try {
      await installNaturalVoice(p => setProgress(p));
      toast('The natural voice is ready.', 'success');
    } catch (e) {
      toast(`The natural voice could not be downloaded: ${e.message}`, 'error', 9000);
    }
    setProgress(null);
  };

  return html`<div class="card">
    <h2>Coach voice</h2>
    <p class="muted" style="margin-top:0">Your coach can talk to you in a natural, human-sounding voice while it coaches — it says each reply the way a coach next to you would. Switch it on or off any time with the 🔊 button in the coach panel.</p>
    <label class="check"><input type="checkbox" checked=${!!v.enabled} onChange=${ev => setVoiceEnabled(ev.currentTarget.checked)} /> Let my coach talk to me</label>
    <div class="provider-list" style="margin-top:10px">
      <label class=${cls('provider', v.engine === 'natural' && 'active')}>
        <input type="radio" name="voice-engine" checked=${v.engine === 'natural'} onChange=${() => save({ voice: { engine: 'natural' } }, true)} />
        <div class="grow">
          <div><b>Natural voice</b> <span class="muted">— Kokoro, a neural voice that runs on your computer: free, private and very human-sounding. English.</span> <span class="badge green">recommended</span></div>
          <div class="muted" style="font-size:12.5px">${downloaded ? html`<span class="ok-text">Downloaded</span>` : 'A one-time download of about 90 MB; after that it works offline.'}${!english ? ` Your coach speaks ${st.language}, so the system voice is used instead.` : ''}</div>
        </div>
      </label>
      <label class=${cls('provider', v.engine === 'browser' && 'active')}>
        <input type="radio" name="voice-engine" checked=${v.engine === 'browser'} onChange=${() => save({ voice: { engine: 'browser' } }, true)} />
        <div class="grow">
          <div><b>System voice</b> <span class="muted">— the voices installed in Windows, in every language (Windows Settings → Time & language → Speech adds more). They sound more robotic than the natural voice.</span></div>
        </div>
      </label>
    </div>
    ${v.engine === 'natural' &&
    !downloaded &&
    html`<div class="row wrap" style="margin-top:10px">
      <button class="btn primary" disabled=${progress !== null} onClick=${install}>${progress !== null ? html`<span class="spinner"></span> Downloading… ${progress}%` : 'Download the natural voice'}</button>
      <small class="muted">Until then the system voice is used.</small>
    </div>`}
    <div class="settings-grid" style="margin-top:12px">
      ${engine === 'natural'
        ? html`<label class="field"><span>Voice</span>
            <select value=${v.naturalVoice} onChange=${ev => save({ voice: { naturalVoice: ev.currentTarget.value } }, true)}>
              ${Object.entries(st.naturalVoices || {}).map(([id, label]) => html`<option value=${id}>${label}</option>`)}
            </select></label>`
        : html`<label class="field"><span>Voice</span>
            <select value=${v.browserVoice} onChange=${ev => save({ voice: { browserVoice: ev.currentTarget.value } }, true)}>
              <option value="">Best available for ${st.language || 'English'}${voices[0] ? ` (${voices[0].name})` : ''}</option>
              ${voices.map(x => html`<option value=${x.name}>${x.name}</option>`)}
            </select>
            ${!voices.length && html`<small class="warn-text">Windows has no voice for ${st.language} installed.</small>`}</label>`}
      <label class="field"><span>Speed</span>
        <select value=${String(v.rate || 1)} onChange=${ev => save({ voice: { rate: Number(ev.currentTarget.value) } }, true)}>
          ${[0.85, 0.95, 1, 1.1, 1.2].map(r => html`<option value=${String(r)}>${r === 1 ? 'Normal' : `${r}×`}</option>`)}
        </select></label>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn" onClick=${sayTest}>▶ Test the voice</button>
      <button class="btn ghost" onClick=${stopSpeaking}>Stop</button>
      <small class="muted">${engine === 'natural' ? 'Natural voice' : 'System voice'}</small>
    </div>
  </div>`;
}

function MemorySettings() {
  const s = useStore();
  const online = connected(s);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState('');
  const load = () =>
    hostRequest('memory-get')
      .then(m => {
        setSaved(m.text);
        setDraft(m.text);
        setFile(m.file || '');
      })
      .catch(() => {});
  useEffect(() => {
    if (online) load();
  }, [online]);
  const write = async text => {
    try {
      const m = await hostRequest('memory-set', { text });
      setSaved(m.text);
      setDraft(m.text);
      toast('Saved', 'success', 1500);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return html`<div class="card">
    <h2>What your coach remembers about you</h2>
    <p class="muted" style="margin-top:0">Your coach writes these notes itself — your level, goals, openings, recurring mistakes, what you worked on — and reads them at the start of every session. All coaches share them. They are stored on this computer. You can correct or add anything.</p>
    ${!online
      ? html`<p class="muted">Connecting to the coach…</p>`
      : html`<textarea rows="12" style="width:100%;font-family:var(--mono, monospace);font-size:13px" value=${draft} placeholder="Nothing yet — your coach starts taking notes in your first session." onInput=${ev => setDraft(ev.currentTarget.value)}></textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn primary" disabled=${saved === null || draft === saved} onClick=${() => write(draft)}>Save notes</button>
            <button class="btn ghost" onClick=${load}>Reload</button>
            <span class="spacer"></span>
            <button class="btn ghost danger" disabled=${!saved} onClick=${() => confirm('Delete everything your coach remembers about you?') && write('')}>Forget everything</button>
          </div>
          ${file && html`<small class="muted">Stored on this computer: ${file} · <a href="#" onClick=${e => (e.preventDefault(), desktop()?.openFolder('notes'))}>open the folder</a></small>`}`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Your data: where it is, backups

function DataSettings() {
  const s = useStore();
  const d = s.desktop || {};
  const [busy, setBusy] = useState(null);

  const backup = async () => {
    setBusy('backup');
    try {
      const { bytes } = await get('/api/backup');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.sqlite3' }));
      a.download = `plymentor-backup-${new Date().toLocaleDateString('sv')}.sqlite`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    } catch (e) {
      toast(e.message, 'error', 8000);
    }
    setBusy(null);
  };

  const restore = async ev => {
    const file = ev.currentTarget.files?.[0];
    ev.currentTarget.value = '';
    if (!file) return;
    if (!confirm(`Replace all your games, analyses, reports, training data and app settings with the backup “${file.name}”? What is in Plymentor now is lost — back it up first if you may want it again.`)) return;
    setBusy('restore');
    try {
      await post('/api/backup/restore', file);
      location.reload();
    } catch (e) {
      toast(e.message, 'error', 9000);
      setBusy(null);
    }
  };

  return html`<div class="card">
    <h2>Your data</h2>
    <p class="muted" style="margin-top:0">Everything stays on this computer: your games, analyses, reports, training and settings in Plymentor's own storage, and the coach's notes and settings next to it${d.home ? html` — in <b>${d.home}</b>` : ''}. Nothing is uploaded to a Plymentor server (there is none).</p>
    <div class="row wrap">
      <button class="btn primary" disabled=${!!busy} onClick=${backup}>${busy === 'backup' ? html`<span class="spinner"></span> Saving…` : 'Back up my games'}</button>
      <label class=${cls('btn', busy && 'disabled')}>${busy === 'restore' ? html`<span class="spinner"></span> Restoring…` : 'Restore a backup…'}<input type="file" accept=".sqlite,.db" style="display:none" disabled=${!!busy} onChange=${restore} /></label>
      <button class="btn ghost" onClick=${() => desktop()?.openFolder('data')}>Open the data folder</button>
    </div>
    <small class="muted">A backup is one file with your games, analyses, reports, exercises, repertoire and app settings. The coach's notes are a text file in the data folder (users\\…\\coach-memory.md).</small>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// The game database the student added (a Scid 5 database, kept by the main process — see gigabase.js)

function GameDatabaseSettings() {
  const gb = useGigabase();
  if (!gb || !desktop()?.gigabase) return null;
  const inst = gb.installed;
  const own = inst?.source === 'file';
  const remove = async () => {
    if (!confirm(`Remove ${inst.title} from Plymentor?${own ? ' Your database files stay where they are; only Plymentor’s opening index of it is deleted.' : ` This deletes the copy Plymentor unpacked (${gbSize(inst.bytes)}).`}`)) return;
    await gigabase('remove').catch(e => toast(e.message, 'error'));
  };
  return html`<div class="card">
    <h2>Game database</h2>
    ${inst
      ? html`<p class="muted" style="margin-top:0"><b>${inst.title}</b>: ${inst.games.toLocaleString()} games (${gbSize(inst.bytes)}), ${own ? html`read from <b>${inst.path}</b>` : 'unpacked into Plymentor’s folder'}. Its opening index covers ${(inst.positions || 0).toLocaleString()} positions. It answers in <a href="#/openings">Openings</a> → Explorer → Database, and the coach can look positions and games up in it. It stays added until you remove it.</p>`
      : html`<p class="muted" style="margin-top:0">Add a database of games in Scid 5 format (.si5, or a .7z archive with one) for the opening explorer and the coach. Plymentor remembers it: you add it once.</p>`}
    ${inst?.missing && html`<div class="gb-error">Its files are not there any more (${inst.path}). Connect the drive they are on, or add the database again.</div>`}
    ${gb.job && html`<${GigabaseJob} job=${gb.job} />`}
    ${gb.error && html`<div class="gb-error">${gb.error}</div>`}
    ${!gb.job &&
    html`<div class="row wrap">
      ${inst?.needsIndex && !inst.missing && html`<button class="btn primary" onClick=${reindexGigabase}>Build the opening index again</button>`}
      <button class=${cls('btn', !inst && 'primary')} onClick=${addGigabase}>${inst ? 'Add another database…' : 'Add a database…'}</button>
      ${inst && !inst.missing && html`<button class="btn ghost" onClick=${() => gigabase('open-folder')}>Open its folder</button>`}
      ${inst && html`<button class="btn ghost danger" onClick=${remove}>Remove</button>`}
    </div>`}
    ${inst && !gb.job && html`<small class="muted">Another database replaces this one once it is ready.</small>`}
  </div>`;
}

const gbSize = bytes => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`);

// ---------------------------------------------------------------------------------------------
// (The coach host and the backend can also bring over the data of Chess Coach 1.x and keep a Lichess token — legacy-*
// requests, /api/legacy/import, settings.lichessToken — but no screen shows them.)

export function Settings() {
  const s = useStore();
  const st = s.settings;
  if (!st) return null;
  const e = st.engine;
  const b = st.board;
  const eng = s.status?.engine;
  const external = url => ev => {
    ev.preventDefault();
    desktop()?.openExternal(url);
  };

  return html`<div class="page"><div class="page-narrow">
    <h1>Settings</h1>

    <${CoachSettings} st=${st} />
    <${VoiceSettings} st=${st} />
    <${MemorySettings} />

    <div class="card">
      <h2>About you</h2>
      <div class="settings-grid">
        <${TextField} label="Name" value=${st.profile.name} onSave=${v => save({ profile: { name: v } })} />
        <${TextField} label="Your usernames" value=${(st.profile.usernames || []).join(', ')} onSave=${v => save({ profile: { usernames: v } })} placeholder="lichess / chess.com names, comma separated" hint="Identifies your side in imported games." />
        <${TextField} label="Rating (approximate)" value=${st.profile.rating} onSave=${v => save({ profile: { rating: v } })} placeholder="e.g. 1500 lichess blitz" />
      </div>
      <label class="field" style="margin-top:10px"><span>Goals</span>
        <textarea rows="2" value=${st.profile.goals} onBlur=${ev => ev.currentTarget.value !== st.profile.goals && save({ profile: { goals: ev.currentTarget.value } })} placeholder="e.g. Reach 1800, stop blundering in time trouble, learn the Caro-Kann"></textarea>
      </label>
      <small class="muted">The coach adapts its explanations to this. Changes apply to new coaching sessions. Stored on this computer.</small>
    </div>

    <div class="card">
      <h2>Engine (Stockfish)</h2>
      <div class="muted" style="margin-bottom:10px">${eng?.ok
        ? html`<span class="badge green">${eng.name}</span> ${eng.threaded ? 'multi-threaded' : 'single-threaded'}, on this computer`
        : html`<span class="badge red">Not running</span> ${eng?.error || ''}`}</div>
      <div class="settings-grid">
        <${TextField} label="Live analysis threads" type="number" value=${e.liveThreads} onSave=${v => save({ engine: { liveThreads: v } })} />
        <${TextField} label="Live analysis memory (MB)" type="number" value=${e.liveHash} onSave=${v => save({ engine: { liveHash: v } })} />
        <${TextField} label="Live analysis time limit (s)" type="number" value=${e.liveMaxSeconds} onSave=${v => save({ engine: { liveMaxSeconds: v } })} />
        <${TextField} label="Coach & move-check threads" type="number" value=${e.agentThreads} onSave=${v => save({ engine: { agentThreads: v } })} />
        <${TextField} label="Batch workers" type="number" value=${e.batchWorkers} onSave=${v => save({ engine: { batchWorkers: v } })} hint="Parallel Stockfish engines for game analysis" />
        <${TextField} label="Threads per batch worker" type="number" value=${e.batchThreads} onSave=${v => save({ engine: { batchThreads: v } })} />
        <label class="field"><span>Default analysis depth</span>
          <select value=${e.batchPreset} onChange=${ev => save({ engine: { batchPreset: ev.currentTarget.value } })}>
            ${Object.entries(st.batchPresets).map(([id, p]) => html`<option value=${id}>${p.label} — ${(p.nodes / 1e6).toLocaleString()}M nodes per position</option>`)}
          </select></label>
      </div>
      <small class="muted">Your computer has ${st.cpuThreads || navigator.hardwareConcurrency || '?'} threads. Keep live + coach + batch threads at or below that.</small>
    </div>

    <div class="card">
      <h2>Board</h2>
      <div class="col">
        <div class="swatches">${BOARD_THEMES.map(
          t => html`<div class=${cls('theme-swatch', b.theme === t[0] && 'active')} title=${t[0]} style=${{ backgroundImage: `url(${boardImage(t)})` }} onClick=${() => save({ board: { theme: t[0] } }, true)}></div>`,
        )}</div>
        <div class="row wrap">
          <label class="field"><span>Pieces</span>
            <select value=${b.pieces} onChange=${ev => save({ board: { pieces: ev.currentTarget.value } }, true)}>${PIECE_SETS.map(p => html`<option value=${p}>${p}</option>`)}</select>
          </label>
          <div class="piece-preview">${['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'].map(r => html`<img src=${pieceUrl(b.pieces, 'white', r)} alt="" />`)}${['king', 'knight'].map(r => html`<img src=${pieceUrl(b.pieces, 'black', r)} alt="" />`)}</div>
        </div>
        <div class="row wrap" style="gap:18px">
          <label class="check"><input type="checkbox" checked=${b.sound !== false} onChange=${ev => save({ board: { sound: ev.currentTarget.checked } }, true)} /> Move sounds</label>
          <label class="check"><input type="checkbox" checked=${b.coords !== false} onChange=${ev => save({ board: { coords: ev.currentTarget.checked } }, true)} /> Coordinates</label>
          <label class="check"><input type="checkbox" checked=${b.bestArrow !== false} onChange=${ev => save({ board: { bestArrow: ev.currentTarget.checked } }, true)} /> Best-move arrow</label>
          <label class="check"><input type="checkbox" checked=${b.evalBar !== false} onChange=${ev => save({ board: { evalBar: ev.currentTarget.checked } }, true)} /> Evaluation bar</label>
        </div>
      </div>
    </div>

    <${GameDatabaseSettings} />
    <${DataSettings} />
    <${UpdateSettings} />

    <div class="studio-credit">
      <div class="made-by">made by</div>
      <img src="/assets/brand/studio-nox.png" alt="Studio Nox" />
      <p class="muted">Plymentor ${APP_VERSION}${s.desktop?.portable ? ' (portable)' : ''} · <a href="/about" target="_blank">About</a> · <a href="/licenses" target="_blank">Licences</a>${SOURCE_URL && html` · <a href=${SOURCE_URL} onClick=${external(SOURCE_URL)}>Source code</a>`}</p>
      <p class="muted">Board, pieces, chess logic and opening names come from lichess (AGPL/GPL/CC0).</p>
      <p class="muted disclaimer"><b>Disclaimer:</b> connecting an AI coach (Claude Code, ChatGPT or Gemini) and using it uses your own account with that provider — its tokens, credits or usage limits — and may cost you money. Studio Nox takes no responsibility for any costs, charges or other monetary matters arising from connecting or using a coach.</p>
    </div>
  </div></div>`;
}
