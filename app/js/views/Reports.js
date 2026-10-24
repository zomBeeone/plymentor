// Reports: statistics over analysed games + the coach's written report and follow-up chat.
import { html, useEffect, useState } from '../../vendor/preact.js';
import { get, post, del } from '../api.js';
import { setState, toast, useStore, coachReady } from '../store.js';
import { cls, formatDate, formatTime } from '../util.js';
import { navigate } from '../router.js';
import { StatTile, BarList, ResultBars } from '../components/Charts.js';
import { Board } from '../components/Board.js';
import { useCoachHandle, defaultLinkHandler } from '../components/coachHandle.js';
import { CoachPanel } from '../components/CoachPanel.js';
import { Markdown } from '../components/Markdown.js';
import { useCoachScreen } from '../coachTerm.js';
import { sanToUci } from '../chess.js';

export function Reports({ route }) {
  const s = useStore();
  const [list, setList] = useState(null);
  const [creating, setCreating] = useState(false);

  const loadList = () =>
    get('/api/reports')
      .then(setList)
      .catch(e => toast(e.message, 'error'));
  useEffect(() => {
    loadList();
  }, [route.id]);

  useEffect(() => {
    if (!route.id && list?.length) navigate(`#/reports/${list[0].id}`);
  }, [list, route.id]);

  const createAll = async () => {
    setCreating(true);
    try {
      const r = await post('/api/reports', {});
      await loadList();
      navigate(`#/reports/${r.id}`);
    } catch (e) {
      toast(e.message, 'error', 8000);
    }
    setCreating(false);
  };

  return html`<div class="reports">
    <div class="list">
      <button class="btn primary" style="width:100%;justify-content:center;margin-bottom:12px" disabled=${creating} onClick=${createAll}>
        ${creating ? html`<span class="spinner"></span>` : '+'} Report from all my analysed games
      </button>
      ${list?.map(
        r => html`<div class=${cls('report-item', String(r.id) === route.id && 'active')} onClick=${() => navigate(`#/reports/${r.id}`)}>
          <div class="t">${r.title}</div>
          <div class="muted" style="font-size:12px">${formatTime(r.createdAt)}${r.summary ? ` · ${r.summary.games} games · ${r.summary.accuracy ?? '–'}%` : ''}</div>
          <div style="font-size:12px">${r.narrative ? html`<span class="badge green">coach report</span>` : html`<span class="badge">stats only</span>`}</div>
        </div>`,
      )}
      ${list && !list.length && html`<div class="muted" style="font-size:13px;padding:6px">No reports yet.</div>`}
    </div>
    <div class="detail">
      ${route.id ? html`<${ReportDetail} key=${route.id} id=${route.id} onDeleted=${() => (loadList(), navigate('#/reports'))} onChanged=${loadList} />` : html`<${ReportsIntro} settings=${s.settings} />`}
    </div>
  </div>`;
}

function ReportsIntro({ settings }) {
  const names = settings?.profile?.usernames || [];
  return html`<div class="page-narrow">
    <h1>Reports</h1>
    <div class="card">
      <h2>How it works</h2>
      <ol>
        <li>${names.length ? html`Your usernames: <b>${names.join(', ')}</b>.` : html`Add your usernames in <a href="#/settings">Settings</a> so the app knows which side you played.`}</li>
        <li>Import games on the <a href="#/games">Games</a> page (files, Lichess or Chess.com) and analyse them with Stockfish.</li>
        <li>Create a report: you get statistics right away, and the coach writes a personal report with examples from your own games, the concepts to study, and a training plan.</li>
      </ol>
    </div>
  </div>`;
}

function ReportDetail({ id, onDeleted, onChanged }) {
  const [r, setR] = useState(null);
  const [making, setMaking] = useState(false);
  const [writing, setWriting] = useState(false);
  const coach = useCoachHandle();

  const load = () =>
    get(`/api/reports/${id}`)
      .then(setR)
      .catch(e => toast(e.message, 'error'));
  useEffect(() => {
    load();
  }, [id]);

  // The terminal coach saves its report with save_report: show it as soon as it arrives.
  useEffect(() => {
    const onCoachUi = e => {
      if (e.detail.action === 'report_saved' && String(e.detail.id) === String(id)) {
        setWriting(false);
        load();
        onChanged?.();
        toast('Your coach saved the report.', 'success');
      }
    };
    window.addEventListener('cc:coach-ui', onCoachUi);
    return () => window.removeEventListener('cc:coach-ui', onCoachUi);
  }, [id]);
  useCoachScreen('reports', () => (r ? { report: { id: r.id, title: r.title, hasNarrative: !!r.narrative } } : null));

  if (!r) return html`<div class="empty"><span class="spinner"></span></div>`;
  const st = r.stats;
  const generate = async () => {
    setWriting(true);
    const res = await coach.send?.('Write my training report.', { task: 'report', taskArgs: { id: r.id, title: r.title } });
    if (!res?.sent) setWriting(false);
  };
  const exercises = async () => {
    setMaking(true);
    try {
      const res = await post('/api/exercises/generate', { gameIds: r.gameIds });
      toast(`Created ${res.created} new exercises from your mistakes (checked ${res.checked} positions).`, 'success', 7000);
      const ex = await get('/api/exercises?due=1');
      setState({ exercisesDue: ex.due });
    } catch (e) {
      toast(e.message, 'error');
    }
    setMaking(false);
  };
  const remove = async () => {
    if (!confirm('Delete this report and its coach conversation?')) return;
    await del(`/api/reports/${id}`);
    onDeleted();
  };

  const pct = v => (v === null || v === undefined ? null : `${v}%`);
  const phases = ['opening', 'middlegame', 'endgame'];
  const motifs = st.motifs.filter(m => m.count > 0);

  return html`<div>
    <div class="row">
      <h1 class="grow" style="margin:0">${r.title}</h1>
      <button class="btn" disabled=${making} onClick=${exercises} title="Turn your clearest mistakes into puzzles">${making ? html`<span class="spinner"></span>` : null} Make exercises from my mistakes</button>
      <button class="btn danger" onClick=${remove}>Delete</button>
    </div>
    <div class="muted">${st.player} · ${st.games} analysed games${st.period ? ` · ${formatDate(st.period.from)} – ${formatDate(st.period.to)}` : ''}${st.rating ? ` · average rating ${st.rating}` : ''}${st.skipped ? ` · ${st.skipped} games without this player skipped` : ''}${st.notAnalyzed ? ` · ${st.notAnalyzed} not analysed` : ''}</div>

    <div class="stat-cards">
      <${StatTile} label="Score" value=${pct(st.results.score)} sub=${`+${st.results.win} =${st.results.draw} −${st.results.loss}`} />
      <${StatTile} label="Accuracy" value=${pct(st.accuracy)} sub="lichess formula" />
      <${StatTile} label="Average centipawn loss" value=${st.acpl} />
      <${StatTile} label="Blunders per game" value=${st.errorsPerGame.blunder} sub=${`${st.errorsPerGame.mistake} mistakes, ${st.errorsPerGame.inaccuracy} inaccuracies`} />
      <${StatTile} label="Tactical awareness" value=${pct(st.awareness.percent)} sub=${`punished ${st.awareness.taken} of ${st.awareness.chances} opponent errors`} title="How often you keep the advantage after your opponent errs" />
      <${StatTile} label="Conversion" value=${pct(st.conversion.percent)} sub=${`won ${st.conversion.won} of ${st.conversion.games} winning positions`} title="Games won after reaching ≥66.6% winning chances" />
      <${StatTile} label="Resourcefulness" value=${pct(st.resourcefulness.percent)} sub=${`saved ${st.resourcefulness.saved} of ${st.resourcefulness.games} bad positions`} title="Games not lost after falling to ≤33.3% winning chances" />
      ${st.time.gamesWithClock
        ? html`<${StatTile} label="Errors in time trouble" value=${st.time.timeTroubleErrors} sub=${`of ${st.time.errorsWithClock}; ${st.time.fastErrors} played in under 5 s`} />`
        : null}
    </div>

    <div class="grid2">
      <div class="chart-card">
        <h3>Accuracy by game phase</h3>
        <${BarList} max=${100} labelWidth=${100} items=${phases.map(p => ({ label: cap(p), value: st.phases[p].accuracy || 0, display: st.phases[p].accuracy !== null ? `${st.phases[p].accuracy}%` : '–' }))} />
      </div>
      <div class="chart-card">
        <h3>Mistakes and blunders per 100 moves</h3>
        <${BarList} labelWidth=${100} items=${phases.map(p => ({ label: cap(p), value: st.phases[p].errorsPer100Moves || 0, display: st.phases[p].errorsPer100Moves ?? '–', title: `${st.phases[p].mistake} mistakes, ${st.phases[p].blunder} blunders in ${st.phases[p].moves} moves` }))} />
      </div>
      <div class="chart-card">
        <h3>Results by colour</h3>
        <${ResultBars} rows=${[
          { label: 'As White', win: st.byColor.white.win, draw: st.byColor.white.draw, loss: st.byColor.white.loss },
          { label: 'As Black', win: st.byColor.black.win, draw: st.byColor.black.draw, loss: st.byColor.black.loss },
        ]} />
      </div>
      <div class="chart-card">
        <h3>What went wrong (mistakes and blunders)</h3>
        ${motifs.length ? html`<${BarList} labelWidth=${200} items=${motifs.map(m => ({ label: m.label, value: m.count }))} />` : html`<div class="muted">No mistakes or blunders — impressive.</div>`}
      </div>
      <div class="chart-card">
        <h3>Accuracy by piece moved</h3>
        <${BarList} max=${100} labelWidth=${100} items=${['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'].filter(p => st.pieces[p]).map(p => ({ label: cap(p), value: st.pieces[p].accuracy || 0, display: `${st.pieces[p].accuracy}%`, title: `${st.pieces[p].moves} moves` }))} />
      </div>
      ${st.time.gamesWithClock
        ? html`<div class="chart-card">
            <h3>Average seconds per move</h3>
            <${BarList} labelWidth=${100} items=${phases.map(p => ({ label: cap(p), value: st.time.avgSecondsPerMove[p] || 0, display: st.time.avgSecondsPerMove[p] !== null ? `${st.time.avgSecondsPerMove[p]} s` : '–' }))} />
          </div>`
        : null}
    </div>

    <div class="chart-card" style="margin-top:14px">
      <h3>Openings</h3>
      <table class="data">
        <thead><tr><th>Colour</th><th>Opening</th><th>Games</th><th>Score</th><th>Accuracy</th><th>Opening-phase accuracy</th><th>Opening mistakes</th></tr></thead>
        <tbody>${st.openings.slice(0, 16).map(
          o => html`<tr><td>${cap(o.color)}</td><td><small class="muted">${o.eco || ''}</small> ${o.family}</td><td>${o.games}</td><td>${o.score}%</td><td>${o.accuracy ?? '–'}%</td><td>${o.openingAccuracy ?? '–'}%</td><td>${o.openingErrors}</td></tr>`,
        )}</tbody>
      </table>
    </div>

    <div class="chart-card" style="margin-top:14px">
      <h3>Your costliest moments <span class="muted" style="font-weight:400">— click to open the position</span></h3>
      <div class="moments">
        ${st.critical.slice(0, 12).map(c => {
          const played = sanToUci(c.fen, c.san);
          const better = c.best ? sanToUci(c.fen, c.best) : null;
          const shapes = [played && { orig: played.slice(0, 2), dest: played.slice(2, 4), brush: 'red' }, better && { orig: better.slice(0, 2), dest: better.slice(2, 4), brush: 'green' }].filter(Boolean);
          return html`<div class="diagram" title=${c.game} onClick=${() => navigate(`#/analysis?game=${c.gameId}&ply=${c.ply - 1}`)}>
            <div class="mini"><${Board} fen=${c.fen} orientation=${c.color} viewOnly=${true} shapes=${shapes} /></div>
            <div class="cap"><b style="color:var(--strong)">${c.move}</b> <span class=${cls('glyph', c.judgement)}>${{ inaccuracy: '?!', mistake: '?', blunder: '??' }[c.judgement]}</span> ${c.judgement}, better ${c.best || '?'} · ${c.phase}${c.motifs.length && c.motifs[0] !== 'positional' ? ` · ${c.motifs.map(m => m.replace(/_/g, ' ')).join(', ')}` : ''}</div>
          </div>`;
        })}
      </div>
    </div>

    <h2 style="margin-top:22px">Coach report</h2>
    ${r.narrative
      ? html`<div class="card report-text"><${Markdown} text=${r.narrative} onPosition=${d => navigate(`#/analysis?fen=${encodeURIComponent(d.fen)}`)} onLink=${href => defaultLinkHandler(href)} /></div>`
      : null}
    <div class="card row wrap">
      <div class="grow">
        <b>${r.narrative ? 'Ask your coach for a new version, or ask follow-up questions below.' : 'Get a personal report from your coach.'}</b>
        <div class="muted">The coach studies these statistics and your worst moments with Stockfish, explains the patterns with examples from your games, makes exercises and builds a training plan. You can watch it work in the terminal below; the finished report is saved here. Takes a few minutes.</div>
      </div>
      <button class="btn primary" disabled=${writing || !coachReady()} onClick=${generate}>${writing ? html`<span class="spinner"></span> Writing…` : r.narrative ? 'Rewrite my report' : 'Write my report'}</button>
    </div>
    <div class="report-chat">
      <${CoachPanel}
        handle=${coach}
        kind="report"
        title="Coach"
        quick=${[
          { label: 'Make me a 2-week plan', text: `Using report #${r.id}, turn it into a concrete day-by-day plan for the next two weeks.` },
          { label: 'Explain my #1 weakness', text: `Using report #${r.id}, explain my biggest weakness in more depth, with another example from my games and an exercise.` },
        ]}
      />
    </div>
  </div>`;
}

const cap = s => s[0].toUpperCase() + s.slice(1);
