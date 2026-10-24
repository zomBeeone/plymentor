// Opening explorer: the game database you added (a Scid 5 database on this computer — see gigabase.js) and your own
// games, under the opening's name (lichess chess-openings, CC0). The backend also answers for the named book lines, all
// imported games and the Lichess Masters / Lichess databases (the coach uses the book and Lichess Masters); the window
// does not show them.
import { html, useEffect, useState } from '../../vendor/preact.js';
import { get, qs } from '../api.js';
import { navigate } from '../router.js';
import { cls, stored, store } from '../util.js';
import { sanOf } from '../chess.js';
import { gigabase, useGigabase, GigabaseSetup, GigabaseJob } from '../gigabase.js';

const TABS = [
  ['database', 'Database', 'Your game database (Scid 5, .si5)'],
  ['mine', 'My games'],
];

export function WdlBar({ white, draws, black }) {
  const total = white + draws + black || 1;
  const p = x => Math.round((x / total) * 100);
  const seg = (k, v) => html`<div class=${k} style=${{ width: `${(v / total) * 100}%` }} title=${`${p(v)}%`}>${p(v) >= 14 ? `${p(v)}%` : ''}</div>`;
  return html`<div class="wdl">${seg('w', white)}${seg('d', draws)}${seg('b', black)}</div>`;
}

export function OpeningName({ fen }) {
  const [op, setOp] = useState(null);
  useEffect(() => {
    let alive = true;
    get('/api/openings/lookup' + qs({ fen }))
      .then(o => alive && setOp(o))
      .catch(() => alive && setOp(null));
    return () => (alive = false);
  }, [fen]);
  const start = String(fen).split(' ')[0] === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  return html`<div class="opening-name">${op ? html`<span class="eco">${op.eco}</span>${op.name}` : html`<span class="muted">${start ? 'Starting position' : 'Unnamed position'}</span>`}</div>`;
}

/** line: the moves (UCI) from the initial position to `fen`, when known — the Database tab follows rare lines with it. */
export function Explorer({ fen, line = null, onPlay }) {
  // (any other tab that was saved opens on the Database tab)
  const [tab, setTab] = useState(() => (stored('explorer.tab', 'database') === 'mine' ? 'mine' : 'database'));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (tab !== 'mine') return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const d = await get('/api/explorer' + qs({ fen, player: 'me' }));
        if (alive) setData(d);
      } catch (e) {
        if (alive) setData({ error: e.message });
      }
      if (alive) setLoading(false);
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [fen, tab]);

  const pick = t => {
    setTab(t);
    store('explorer.tab', t);
  };

  return html`
    <div class="explorer">
      <${OpeningName} fen=${fen} />
      <div class="panel-head"><div class="tabs">${TABS.map(([id, label, title]) => html`<button class=${cls('tab', tab === id && 'active')} title=${title || ''} onClick=${() => pick(id)}>${label}</button>`)}</div>
      ${loading && tab === 'mine' && html`<span class="spinner" style="margin-left:auto"></span>`}</div>
      ${tab === 'database'
        ? html`<${DatabaseExplorer} fen=${fen} line=${line} onPlay=${onPlay} />`
        : html`<div style=${{ opacity: loading ? 0.55 : 1 }}>${myGames(data, onPlay)}</div>`}
    </div>
  `;
}

// ---------------------------------------------------------------------------------------------
// The My games tab: the student's own games (the games database's positions index)

function myGames(d, onPlay) {
  if (!d) return null;
  if (d.error) return html`<div class="empty">Explorer unavailable: ${d.error}</div>`;
  if (!d.moves.length)
    return html`<div class="empty">None of your games reached this position.<br /><small>Your usernames are set in <a href="#/settings">Settings</a>; positions are indexed for the first 30 plies.</small></div>`;
  return html`<table class="ex-table">
      <thead><tr><th>Move</th><th>Games</th><th>White / Draw / Black</th></tr></thead>
      <tbody>${d.moves.map(m => html`<tr class="click" onClick=${() => onPlay(m.uci)}><td class="san">${m.san}</td><td>${m.games}</td><td><${WdlBar} white=${m.white} draws=${m.draws} black=${m.black} /></td></tr>`)}</tbody>
    </table>
    ${d.games?.length
      ? html`<div style="padding:8px 10px" class="muted">Recent games: ${d.games.slice(0, 5).map(
          g => html`<a href=${`#/analysis?game=${g.id}`} style="margin-right:8px">${g.white} – ${g.black} ${g.result}</a>`,
        )}</div>`
      : null}`;
}

// ---------------------------------------------------------------------------------------------
// The Database tab: the Scid 5 database the student added (see gigabase.js)

function DatabaseExplorer({ fen, line, onPlay }) {
  const gb = useGigabase();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const ready = !!gb?.installed && !gb.installed.needsIndex && !gb.installed.missing;
  const lineKey = line ? line.join(' ') : '';

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await gigabase('explore', { fen, moves: line || [] });
        if (alive) setData({ ...r, fen });
      } catch (e) {
        if (alive) setData({ error: e.message, fen });
      }
      if (alive) setLoading(false);
    }, 100);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [fen, lineKey, ready, gb?.installed?.addedAt]);

  if (!gb) return html`<div class="empty"><span class="spinner"></span></div>`;
  if (!ready) return html`<${GigabaseSetup} gb=${gb} />`;
  const d = data;
  const inst = gb.installed;
  const total = d && !d.error ? d.white + d.draws + d.black : 0;
  const open = g => navigate(`#/analysis?dbgame=${g.id}&fen=${encodeURIComponent(fen)}`);
  return html`<div class="gdb" style=${{ opacity: loading ? 0.6 : 1 }}>
    ${gb.job && html`<div style="padding:8px 10px"><${GigabaseJob} job=${gb.job} /></div>`}
    ${!d
      ? html`<div class="empty"><span class="spinner"></span></div>`
      : d.error
        ? html`<div class="empty">The game database could not answer: ${d.error}</div>`
        : !total
          ? html`<div class="empty">No game of the database reached this position.<br /><small class="muted">The opening index holds the positions of at least 10 games in the first 20 moves; rarer lines are followed through their games when you play them from the start.</small></div>`
          : html`
            <div class="gdb-total"><span>${total.toLocaleString()} game${total === 1 ? '' : 's'}${d.source === 'games' ? html` <small class="muted" title="Beyond the opening index: counted from the games that took this line">(from the games)</small>` : ''}</span><${WdlBar} white=${d.white} draws=${d.draws} black=${d.black} /></div>
            <table class="ex-table">
              <thead><tr><th>Move</th><th>Games</th><th title="Average rating of the players">⌀</th><th>White / Draw / Black</th></tr></thead>
              <tbody>${d.moves.map(m => {
                const n = m.white + m.draws + m.black;
                return html`<tr class="click" onClick=${() => onPlay(m.uci)} title=${m.lastYear ? `Last played ${m.lastYear}` : ''}><td class="san">${m.san || sanOf(fen, m.uci)}</td><td>${n.toLocaleString()}</td><td class="muted">${m.averageRating || ''}</td><td><${WdlBar} white=${m.white} draws=${m.draws} black=${m.black} /></td></tr>`;
              })}</tbody>
            </table>
            ${d.topGames?.length
              ? html`<div class="gdb-games"><div class="muted">${d.source === 'games' ? 'Games' : 'Top games'}</div>${d.topGames.map(
                  g => html`<div class="gdb-game" onClick=${() => open(g)} title="Open on the board">
                    <span class=${cls('res', g.result === '1-0' ? 'w' : g.result === '0-1' ? 'b' : 'd')}>${g.result === '1/2-1/2' ? '½-½' : g.result}</span>
                    <span class="players">${g.white}${g.whiteElo ? html` <small>${g.whiteElo}</small>` : ''} – ${g.black}${g.blackElo ? html` <small>${g.blackElo}</small>` : ''}</span>
                    <small class="muted">${[g.event, g.year].filter(Boolean).join(', ')}</small>
                  </div>`,
                )}</div>`
              : null}`}
    <div class="gdb-foot muted"><span>${inst.title} · ${inst.games.toLocaleString()} games</span><span class="spacer"></span><a href="#/settings">Manage</a></div>
  </div>`;
}
