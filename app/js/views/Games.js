// Games library: import many PGNs, download from Lichess / Chess.com, filter, analyse in batch, create reports.
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { api, get, post, qs } from '../api.js';
import { state, setState, toast, useStore } from '../store.js';
import { cls, stored, store, formatDate, formatDuration, resultFor } from '../util.js';
import { navigate } from '../router.js';

const PAGE = 50;

export function Games() {
  const s = useStore();
  const names = s.settings?.profile?.usernames || [];
  const [filters, setFilters] = useState(() => stored('games.filters', { player: names.join(','), color: '', result: '', opening: '', analyzed: '', collection: '', text: '', sort: 'date', dir: 'desc' }));
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [preset, setPreset] = useState(s.settings?.engine?.batchPreset || 'standard');
  const reloadKey = useRef(0);

  const load = async () => {
    setLoading(true);
    try {
      const d = await get('/api/games' + qs({ ...filters, limit: PAGE, offset: page * PAGE }));
      setData(d);
      setCollections(await get('/api/collections'));
    } catch (e) {
      toast(e.message, 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    store('games.filters', filters);
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [JSON.stringify(filters), page, reloadKey.current]);

  useEffect(() => {
    const f = () => load();
    window.addEventListener('cc:game-analyzed', f);
    window.addEventListener('cc:games-changed', f);
    return () => {
      window.removeEventListener('cc:game-analyzed', f);
      window.removeEventListener('cc:games-changed', f);
    };
  }, [JSON.stringify(filters), page]);

  const setF = patch => {
    setPage(0);
    setFilters(f => ({ ...f, ...patch }));
  };
  const refresh = () => {
    reloadKey.current++;
    load();
  };
  const toggle = id =>
    setSel(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const pageIds = data?.games.map(g => g.id) || [];
  const allOnPage = pageIds.length && pageIds.every(id => sel.has(id));
  const selectAllMatching = async () => {
    const { ids } = await get('/api/games/ids' + qs(filters));
    setSel(new Set(ids));
    if (ids.length >= 1000) toast('Selected the first 1000 matching games.');
  };

  const analyse = async () => {
    try {
      const job = await post('/api/jobs/analyze', { gameIds: [...sel], preset });
      setState(st => ({ jobs: [...st.jobs.filter(j => j.id !== job.id), { id: job.id, status: 'running', params: job, progress: { gamesDone: 0, gamesTotal: job.gameIds.length, positionsDone: 0, positionsTotal: 0 } }] }));
      toast(`Analysing ${job.gameIds.length} games with Stockfish (${preset}). You can keep using the app.`);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const report = async () => {
    try {
      const r = await post('/api/reports', { gameIds: [...sel], player: filters.player || undefined });
      navigate(`#/reports/${r.id}`);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${sel.size} games? Their analyses go too. This cannot be undone.`)) return;
    try {
      await post('/api/games/delete', { ids: [...sel] });
    } catch (e) {
      toast(e.message, 'error');
    }
    setSel(new Set());
    refresh();
  };

  const myNames = names.map(n => n.toLowerCase());
  const empty = data && data.total === 0 && !Object.entries(filters).some(([k, v]) => v && !['sort', 'dir', 'player'].includes(k));
  const running = s.jobs.filter(j => j.status === 'running');

  return html`<div class="page">
    <div class="row" style="margin-bottom:14px">
      <h1 class="grow" style="margin:0">Games</h1>
      <button class=${cls('btn', showImport || empty ? 'active' : 'primary')} onClick=${() => setShowImport(v => !v)}>${showImport ? 'Hide import' : '+ Import games'}</button>
    </div>
    ${(showImport || empty) && html`<${ImportPanel} names=${names} onDone=${() => {
      refresh();
      setShowImport(false);
    }} />`}
    ${running.map(j => html`<${JobCard} job=${j} />`)}
    <div class="toolbar">
      <input type="search" placeholder="Player(s), comma separated" value=${filters.player} onInput=${e => setF({ player: e.currentTarget.value })} style="width:210px" title="Leave empty for all games" />
      <select value=${filters.color} onChange=${e => setF({ color: e.currentTarget.value })} disabled=${!filters.player}><option value="">Any colour</option><option value="white">As White</option><option value="black">As Black</option></select>
      <select value=${filters.result} onChange=${e => setF({ result: e.currentTarget.value })}>
        <option value="">Any result</option>
        ${filters.player ? html`<option value="win">Wins</option><option value="loss">Losses</option><option value="draw">Draws</option>` : html`<option value="1-0">1-0</option><option value="0-1">0-1</option><option value="1/2-1/2">½-½</option>`}
      </select>
      <input type="search" placeholder="Opening or ECO" value=${filters.opening} onInput=${e => setF({ opening: e.currentTarget.value })} style="width:170px" />
      <select value=${filters.analyzed} onChange=${e => setF({ analyzed: e.currentTarget.value })}><option value="">Analysed or not</option><option value="1">Analysed</option><option value="0">Not analysed</option></select>
      <select value=${filters.collection} onChange=${e => setF({ collection: e.currentTarget.value })} style="max-width:220px">
        <option value="">All collections</option>
        ${collections.map(c => html`<option value=${c.id}>${c.name} (${c.games})</option>`)}
      </select>
      <input type="search" placeholder="Search text" value=${filters.text} onInput=${e => setF({ text: e.currentTarget.value })} style="width:140px" />
      ${loading && html`<span class="spinner"></span>`}
    </div>
    ${(() => {
      // always shown: the analysis (and the other actions) of the selected games
      const none = sel.size === 0;
      const busy = running.length > 0;
      return html`<div class="job games-actions">
        ${none
          ? html`<span class="muted">Select games to analyse — tick them in the list${data?.total ? ', or' : '.'}</span>
              ${data?.total > 0 && html`<button class="btn small ghost" onClick=${selectAllMatching}>Select all ${Math.min(data.total, 1000).toLocaleString()} shown</button>`}`
          : html`<b>${sel.size} selected</b><button class="btn small ghost" onClick=${() => setSel(new Set())}>Clear</button>`}
        <span class="spacer"></span>
        <select value=${preset} onChange=${e => setPreset(e.currentTarget.value)} title="Stockfish effort per position">
          ${Object.entries(s.settings?.batchPresets || {}).map(([id, p]) => html`<option value=${id}>${p.label} (${(p.nodes / 1e6).toLocaleString()}M nodes)</option>`)}
        </select>
        <button class="btn primary" disabled=${none || busy} title=${busy ? 'An analysis is running: one at a time' : none ? 'Select the games to analyse first' : ''} onClick=${analyse}>Analyse with Stockfish</button>
        <button class="btn blue" disabled=${none} onClick=${report} title="Statistics + coach report from the analysed games among the selection">Create report</button>
        <button class="btn danger" disabled=${none} onClick=${remove}>Delete</button>
      </div>`;
    })()}
    ${data &&
    html`<div class="table-wrap">
      <table class="data">
        <thead><tr>
          <th style="width:30px"><input type="checkbox" checked=${allOnPage} onChange=${() =>
            setSel(prev => {
              const n = new Set(prev);
              if (allOnPage) pageIds.forEach(id => n.delete(id));
              else pageIds.forEach(id => n.add(id));
              return n;
            })} /></th>
          ${[['white', 'Players'], ['', 'Result'], ['date', 'Date'], ['opening', 'Opening'], ['', 'Time'], ['moves', 'Moves'], ['', 'Accuracy W / B']].map(
            ([key, label]) => html`<th class=${cls(key && 'sort')} onClick=${() => key && setF({ sort: key, dir: filters.sort === key && filters.dir === 'desc' ? 'asc' : 'desc' })}>${label}${filters.sort === key ? (filters.dir === 'desc' ? ' ↓' : ' ↑') : ''}</th>`,
          )}
        </tr></thead>
        <tbody>
          ${data.games.map(g => {
            const me = myNames.includes(String(g.white).toLowerCase()) ? 'white' : myNames.includes(String(g.black).toLowerCase()) ? 'black' : null;
            const res = me ? resultFor(g.result, me) : null;
            return html`<tr class=${cls(sel.has(g.id) && 'sel')}>
              <td><input type="checkbox" checked=${sel.has(g.id)} onChange=${() => toggle(g.id)} /></td>
              <td class="players"><a href=${`#/analysis?game=${g.id}`}>
                <span style=${me === 'white' ? 'font-weight:700' : ''}>${g.white}</span>${g.white_elo ? html` <small class="muted">${g.white_elo}</small>` : ''} – <span style=${me === 'black' ? 'font-weight:700' : ''}>${g.black}</span>${g.black_elo ? html` <small class="muted">${g.black_elo}</small>` : ''}
              </a></td>
              <td><span class=${cls('res', res)}>${g.result === '1/2-1/2' ? '½-½' : g.result}</span></td>
              <td>${formatDate(g.date)}</td>
              <td class="ellipsis" style="max-width:280px" title=${g.opening || ''}><small class="muted">${g.eco || ''}</small> ${g.opening || ''}</td>
              <td>${g.time_control || ''}</td>
              <td>${Math.ceil(g.ply_count / 2)}</td>
              <td class="acc">${g.analyzed ? html`${g.white_acc ?? '–'} / ${g.black_acc ?? '–'}` : html`<span class="muted">—</span>`}</td>
            </tr>`;
          })}
        </tbody>
      </table>
      ${!data.games.length && html`<div class="empty">${data.total === 0 ? 'No games match these filters.' : ''}</div>`}
    </div>
    <div class="row" style="margin-top:10px">
      <span class="muted">${data.total.toLocaleString()} games</span>
      ${data.total > pageIds.length && html`<button class="btn small ghost" onClick=${selectAllMatching}>Select all ${Math.min(data.total, 1000).toLocaleString()} matching</button>`}
      <span class="spacer"></span>
      <button class="btn small" disabled=${page === 0} onClick=${() => setPage(p => p - 1)}>◀ Prev</button>
      <span class="muted">Page ${page + 1} / ${Math.max(1, Math.ceil(data.total / PAGE))}</span>
      <button class="btn small" disabled=${(page + 1) * PAGE >= data.total} onClick=${() => setPage(p => p + 1)}>Next ▶</button>
    </div>`}
  </div>`;
}

function JobCard({ job }) {
  const p = job.progress || {};
  const pct = p.positionsTotal ? Math.round((p.positionsDone / p.positionsTotal) * 100) : 0;
  return html`<div class="job">
    <div class="row">
      <span class="spinner"></span>
      <b>Analysing ${p.gamesTotal} games</b>
      <span class="muted">${p.gamesDone}/${p.gamesTotal} games · ${p.positionsDone || 0}/${p.positionsTotal || '?'} positions${p.eta !== null && p.eta !== undefined ? ` · about ${formatDuration(p.eta)} left` : ''}</span>
      <span class="spacer"></span>
      <button class="btn small danger" onClick=${() => post(`/api/jobs/${job.id}/cancel`).catch(e => toast(e.message, 'error'))}>Cancel</button>
    </div>
    <div class="progressbar"><div style=${{ width: `${pct}%` }}></div></div>
  </div>`;
}

function ImportPanel({ names, onDone }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(null);
  const [paste, setPaste] = useState('');
  const [site, setSite] = useState('lichess');
  const [user, setUser] = useState(names[0] || '');
  const [max, setMax] = useState(100);
  const [months, setMonths] = useState(3);
  const fileRef = useRef();

  const summary = r => `${r.imported} imported${r.duplicates ? `, ${r.duplicates} already in your library` : ''}${r.errors ? `, ${r.errors} unreadable` : ''}${r.skipped ? `, ${r.skipped} skipped (variants or empty)` : ''}`;

  const uploadFiles = async files => {
    const list = [...files].filter(f => /\.(pgn|txt)$/i.test(f.name) || f.type === 'application/x-chess-pgn' || !f.type);
    if (!list.length) return toast('Choose .pgn files', 'error');
    let total = { imported: 0, duplicates: 0, errors: 0, skipped: 0 };
    for (const [i, f] of list.entries()) {
      setBusy(`Importing ${f.name} (${i + 1}/${list.length})…`);
      try {
        const r = await api(`/api/games/import${qs({ name: f.name.replace(/\.(pgn|txt)$/i, '') })}`, { method: 'POST', body: f, raw: true });
        for (const k of Object.keys(total)) total[k] += r[k] || 0;
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 'error');
      }
    }
    setBusy(null);
    toast(summary(total), 'success', 7000);
    onDone();
  };

  const importPaste = async () => {
    if (!paste.trim()) return;
    setBusy('Importing…');
    try {
      const r = await api('/api/games/import?name=Pasted%20games', { method: 'POST', body: paste, raw: true });
      toast(summary(r), 'success', 7000);
      setPaste('');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(null);
  };

  const download = async () => {
    if (!user.trim()) return toast('Enter a username', 'error');
    setBusy(`Downloading from ${site === 'lichess' ? 'Lichess' : 'Chess.com'}…`);
    try {
      const r = await post('/api/games/import-online', { site, username: user.trim(), max, months });
      toast(summary(r), 'success', 7000);
      onDone();
    } catch (e) {
      toast(e.message, 'error', 8000);
    }
    setBusy(null);
  };

  return html`<div class="card" style="margin-bottom:16px">
    <h2>Import games</h2>
    ${busy && html`<div class="feedback info row"><span class="spinner"></span>${busy}</div>`}
    <div class="grid2" style="margin-top:10px">
      <div class="col">
        <div
          class=${cls('dropzone', over && 'over')}
          onDragOver=${e => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave=${() => setOver(false)}
          onDrop=${e => {
            e.preventDefault();
            setOver(false);
            uploadFiles(e.dataTransfer.files);
          }}
        >
          <p><b>Drop PGN files here</b> — as many as you like, any size.</p>
          <button class="btn" onClick=${() => fileRef.current.click()}>Choose files…</button>
          <input type="file" multiple accept=".pgn,.txt" ref=${fileRef} style="display:none" onChange=${e => uploadFiles(e.currentTarget.files)} />
          <p class="muted" style="margin:8px 0 0;font-size:12px">Duplicates are skipped. Each file becomes a collection.</p>
        </div>
        <textarea rows="4" placeholder="…or paste PGN text here" value=${paste} onInput=${e => setPaste(e.currentTarget.value)}></textarea>
        <div><button class="btn" disabled=${!paste.trim() || !!busy} onClick=${importPaste}>Import pasted PGN</button></div>
      </div>
      <div class="col">
        <h3 style="margin:0">Download your games</h3>
        <div class="row wrap">
          <select value=${site} onChange=${e => setSite(e.currentTarget.value)}><option value="lichess">Lichess</option><option value="chesscom">Chess.com</option></select>
          <input type="text" placeholder="Username" value=${user} onInput=${e => setUser(e.currentTarget.value)} style="width:170px" />
          ${site === 'lichess'
            ? html`<label class="row muted">last <input type="number" min="1" max="1000" value=${max} onInput=${e => setMax(Number(e.currentTarget.value))} style="width:76px" /> games</label>`
            : html`<label class="row muted">last <input type="number" min="1" max="24" value=${months} onInput=${e => setMonths(Number(e.currentTarget.value))} style="width:60px" /> months</label>`}
          <button class="btn primary" disabled=${!!busy} onClick=${download}>Download</button>
        </div>
        <p class="muted" style="font-size:12.5px">Games come with clock times, so reports can show time-trouble mistakes. Add your usernames in <a href="#/settings">Settings</a> so the coach knows which side you played.</p>
      </div>
    </div>
  </div>`;
}
