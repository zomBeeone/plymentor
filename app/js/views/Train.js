// Training: exercises from your own mistakes (spaced repetition) and interactive lessons with the coach.
import { html, useEffect, useState } from '../../vendor/preact.js';
import { get, post, del } from '../api.js';
import { setState, toast, useStore, coachReady } from '../store.js';
import { BoardCtrl, useCtrl, useBoardKeys, useForce } from '../ctrl.js';
import { Tree, placeCoachPosition } from '../tree.js';
import { Board } from '../components/Board.js';
import { MoveList } from '../components/MoveList.js';
import { useCoachHandle } from '../components/coachHandle.js';
import { CoachPanel } from '../components/CoachPanel.js';
import { useCoachScreen } from '../coachTerm.js';
import { posFromFen, playUci, repKey, tryPos, fenOf } from '../chess.js';
import { cls, stored, store, formatTime } from '../util.js';
import { moveSound, sound } from '../sound.js';
import { clearParams } from '../router.js';

const ex = { list: null, current: null, fen: null, lastMove: null, feedback: null, attempts: 0, solved: false, shapes: [], tab: stored('train.tab', 'exercises') };
const lctrl = new BoardCtrl();
const lesson = { question: null, caption: null, shapes: null, started: false, topic: null };

const TOPICS = [
  'Rook endgames: the Lucena and Philidor positions',
  'King and pawn endgames: opposition and key squares',
  'The isolated queen pawn: playing with and against it',
  'The minority attack',
  'Good bishop vs bad bishop',
  'Knight outposts',
  'Calculation: checks, captures and threats',
  'Attacking the castled king',
  'Pins, forks and skewers',
  'Prophylaxis: stopping the opponent’s plan',
  'Converting a winning advantage',
  'Defending worse positions',
];

export function Train({ route }) {
  const s = useStore();
  const rerender = useForce();
  const setTab = t => {
    ex.tab = t;
    store('train.tab', t);
    rerender();
  };
  useEffect(() => {
    if (route.params.lesson) setTab('lessons');
  }, [route.params.lesson]);
  // the coach switched to one of the tabs (switch_screen)
  useEffect(() => {
    const t = route.params.tab;
    if (t !== 'exercises' && t !== 'lessons') return;
    clearParams();
    setTab(t);
  }, [route]);
  return html`<div class="train-page" style="height:100%;display:flex;flex-direction:column">
    <div class="topbar" style="height:42px;background:var(--bg);border-bottom:1px solid var(--border)">
      <div class="tabs">${[['exercises', `Exercises${s.exercisesDue ? ` (${s.exercisesDue} due)` : ''}`], ['lessons', 'Lessons']].map(
        ([id, label]) => html`<button class=${cls('tab', ex.tab === id && 'active')} onClick=${() => setTab(id)}>${label}</button>`,
      )}</div>
    </div>
    <div class="grow" style="min-height:0">${ex.tab === 'exercises' ? html`<${Exercises} />` : html`<${Lessons} route=${route} />`}</div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------

function Exercises() {
  const s = useStore();
  const rerender = useForce();
  const coach = useCoachHandle();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await get('/api/exercises');
    ex.list = r.exercises;
    setState({ exercisesDue: r.due });
    if (!ex.current) next();
    rerender();
  };
  useEffect(() => {
    load().catch(e => toast(e.message, 'error'));
    const onCoachUi = e => e.detail.action === 'exercise_created' && load().catch(() => {});
    window.addEventListener('cc:coach-ui', onCoachUi);
    return () => window.removeEventListener('cc:coach-ui', onCoachUi);
  }, []);

  useCoachScreen('exercises', () => {
    const cur = ex.current;
    if (!cur) return null;
    const sol = (cur.solution?.sans || []).join(' ');
    return {
      mode: 'exercise',
      fen: ex.fen,
      exercise: { prompt: cur.prompt || 'Find the best move' },
      note: ex.solved
        ? `The exercise is finished (${ex.feedback?.kind === 'good' ? 'the student solved it' : 'the solution was shown'}). Solution: ${sol}.`
        : `The student is still solving it (${ex.attempts} wrong tries so far). The solution is ${sol} — don't reveal it unless they ask for it.`,
    };
  });

  function next() {
    const due = (ex.list || []).filter(e => !e.due || e.due <= Date.now());
    const pick = due[0] || null;
    ex.current = pick;
    ex.fen = pick?.fen || null;
    ex.lastMove = null;
    ex.lastSan = null;
    ex.feedback = pick ? { kind: 'info', text: pick.prompt || 'Find the best move.' } : null;
    ex.attempts = 0;
    ex.solved = false;
    ex.shapes = [];
    rerender();
  }

  async function onMove(uci) {
    const cur = ex.current;
    if (!cur || ex.solved) return;
    const r = playUci(ex.fen, uci);
    if (!r) return;
    ex.fen = r.fen;
    ex.lastMove = [r.uci.slice(0, 2), r.uci.slice(2, 4)];
    ex.lastSan = r.san;
    moveSound(r);
    ex.feedback = { kind: 'info', text: 'Checking…' };
    rerender();
    try {
      const res = await post(`/api/exercises/${cur.id}/check`, { uci: r.uci });
      ex.attempts++;
      if (res.correct) {
        ex.solved = true;
        sound('Confirmation');
        ex.feedback = { kind: 'good', text: res.exact ? `Correct — ${res.san}!` : `Good — ${res.san} works too (the engine's line was ${res.solution.sans?.[0]}).` };
        await post(`/api/exercises/${cur.id}/review`, { grade: ex.attempts === 1 ? 2 : 1 });
        if (res.solution?.ucis?.length > 1 && res.exact) {
          // show the rest of the solution
          let fen = ex.fen;
          for (const u of res.solution.ucis.slice(1, 4)) {
            await new Promise(r2 => setTimeout(r2, 600));
            if (ex.current !== cur) return;
            const step = playUci(fen, u);
            if (!step) break;
            fen = step.fen;
            ex.fen = fen;
            ex.lastMove = [u.slice(0, 2), u.slice(2, 4)];
            moveSound(step);
            rerender();
          }
        }
      } else {
        sound('Error');
        const reply = res.evaluation?.reply?.line;
        ex.feedback = { kind: 'bad', text: `${res.san} is not it${res.evaluation ? ` (${res.evaluation.classification})` : ''}.${reply ? ` After it: ${reply}.` : ''} ${ex.attempts < 2 ? 'Try again.' : ''}` };
        setTimeout(() => {
          if (ex.current !== cur) return;
          ex.fen = cur.fen;
          ex.lastMove = null;
          rerender();
        }, 900);
        if (ex.attempts >= 2) showSolution(true);
      }
    } catch (e) {
      ex.feedback = { kind: 'bad', text: e.message };
    }
    rerender();
  }

  async function showSolution(failed) {
    const cur = ex.current;
    if (!cur) return;
    const sol = cur.solution || {};
    const first = sol.ucis?.[0];
    ex.solved = true;
    ex.shapes = first ? [{ orig: first.slice(0, 2), dest: first.slice(2, 4), brush: 'green' }] : [];
    ex.feedback = { kind: 'info', text: `Solution: ${(sol.sans || []).join(' ')}` };
    if (failed !== false) await post(`/api/exercises/${cur.id}/review`, { grade: 0 }).catch(() => {});
    rerender();
  }

  async function finish() {
    await load();
    next();
  }

  async function generate() {
    setBusy(true);
    try {
      const r = await post('/api/exercises/generate', {});
      toast(`Created ${r.created} exercises from your analysed games.`, 'success');
      await load();
      if (!ex.current) next();
    } catch (e) {
      toast(e.message, 'error', 7000);
    }
    setBusy(false);
  }

  const cur = ex.current;
  const orientation = cur ? posFromFen(cur.fen).turn : 'white';
  const total = ex.list?.length || 0;
  const due = (ex.list || []).filter(e => !e.due || e.due <= Date.now()).length;

  return html`<div class="workspace two">
    <div class="board-col">
      <div class="board-area">
        ${cur
          ? html`<${Board} fen=${ex.fen} orientation=${orientation} lastMove=${ex.lastMove} movable=${ex.solved ? false : orientation} onMove=${onMove} shapes=${ex.shapes} />`
          : html`<div class="board-wrap"><div class="empty card" style="height:100%;display:flex;flex-direction:column;justify-content:center">
              ${ex.list === null ? html`<span class="spinner"></span>` : total ? html`<h3>All done for now 🎉</h3><p>${total} exercises in your deck; the next ones come back when they are due.</p>` : html`<h3>No exercises yet</h3><p>Analyse some of your games, then generate exercises from your mistakes.</p>`}
            </div></div>`}
      </div>
      ${ex.feedback && html`<div class=${cls('feedback', ex.feedback.kind)}>${ex.feedback.text}</div>`}
      <div class="board-controls">
        ${cur &&
        html`${!ex.solved ? html`<button class="btn small" onClick=${() => showSolution(true)}>Show solution</button>` : html`<button class="btn small primary" onClick=${finish}>Next exercise →</button>`}
          ${coachReady() &&
          html`<button class="btn small" onClick=${() =>
            coach.send?.('Explain this exercise.', {
              task: 'exerciseFeedback',
              taskArgs: { correct: ex.solved && ex.feedback?.kind === 'good', played: ex.lastSan || 'nothing yet', solution: (cur.solution?.sans || []).join(' ') },
              label: 'Explain this exercise.',
            })}>Explain</button>`}`}
        <span class="spacer"></span>
        <span class="muted">${due} due · ${total} total</span>
        <button class="btn small" disabled=${busy} onClick=${generate}>${busy ? html`<span class="spinner"></span>` : null} Generate from my games</button>
      </div>
      ${cur?.data?.game && html`<div class="muted" style="font-size:12.5px">From your game: ${cur.data.game}${cur.game_id ? html` · <a href=${`#/analysis?game=${cur.game_id}&ply=${(cur.ply || 1) - 1}`}>open</a>` : ''}</div>`}
    </div>
    <div class="side-col">
      <div class="panel" style="flex:0 0 34%;min-height:140px">
        <div class="panel-head"><span class="title">Your deck</span></div>
        <div class="panel-body ex-list">
          ${(ex.list || []).map(
            e => html`<div class="item">
              <span class="grow ellipsis">${e.prompt || 'Find the best move'} ${(e.themes || []).length ? html`<small class="muted">· ${e.themes.join(', ').replace(/_/g, ' ')}</small>` : ''}</span>
              <small class="muted nowrap">${!e.due || e.due <= Date.now() ? 'due' : `next ${formatTime(e.due)}`}</small>
              <button class="btn small ghost" title="Practise now" onClick=${() => {
                ex.current = e;
                ex.fen = e.fen;
                ex.lastMove = null;
                ex.lastSan = null;
                ex.attempts = 0;
                ex.solved = false;
                ex.shapes = [];
                ex.feedback = { kind: 'info', text: e.prompt || 'Find the best move.' };
                rerender();
              }}>▶</button>
              <button class="btn small ghost" title="Delete" onClick=${async () => {
                await del(`/api/exercises/${e.id}`);
                if (ex.current?.id === e.id) ex.current = null;
                load();
              }}>✕</button>
            </div>`,
          )}
        </div>
      </div>
      <div class="grow" style="min-height:0">
        <${CoachPanel}
          handle=${coach}
          kind="exercise"
          storageKey="exercises"
          title="Coach"
          getContext=${() => ({ mode: 'exercise', fen: cur?.fen, exercise: { prompt: cur?.prompt } })}
          intro=${html`<div class="coach-empty"><p>Stuck or curious? Ask why the solution works — the coach checks it with Stockfish.</p></div>`}
        />
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------

function Lessons({ route }) {
  useCtrl(lctrl);
  const s = useStore();
  const rerender = useForce();
  const coach = useCoachHandle();
  const [topic, setTopic] = useState('');
  const [reportTopics, setReportTopics] = useState([]);
  useBoardKeys(lctrl);

  useEffect(() => {
    get('/api/reports')
      .then(async list => {
        if (!list.length) return;
        const r = await get(`/api/reports/${list[0].id}`);
        const labels = (r.stats?.motifs || []).filter(m => m.id !== 'positional' && m.count > 0).slice(0, 3).map(m => `How to stop: ${m.label}`);
        setReportTopics(labels);
      })
      .catch(() => {});
  }, []);

  // A lesson link (lesson:topic) was followed. Keyed on the route object: once per navigation, even for the
  // same topic again (the coach handle is filled by the panel before startLesson's send runs).
  useEffect(() => {
    const t = route.params.lesson;
    if (!t) return;
    clearParams();
    startLesson(t);
  }, [route]);

  useCoachScreen(
    'lesson',
    () => ({
      mode: 'lesson',
      startFen: lctrl.tree.isStandardStart ? undefined : lctrl.tree.startFen,
      ucis: lctrl.tree.ucis(lctrl.node),
      lessonTopic: lesson.topic || undefined,
      question: lesson.question && repKey(lesson.question.fen) === repKey(lctrl.node.fen) ? true : undefined,
    }),
    ev => {
      if (ev.action !== 'set_board') return false;
      onUi(ev);
      return true;
    },
  );

  function startLesson(t) {
    if (!coachReady()) return toast('Set up your coach in Settings to take lessons.', 'error');
    coach.newThread?.();
    lesson.started = true;
    lesson.topic = t;
    lesson.question = null;
    lesson.caption = null;
    lesson.shapes = null;
    lctrl.setTree(new Tree());
    setTimeout(() => coach.send?.(t, { task: 'lesson', taskArgs: { topic: t }, label: `Lesson: ${t}` }), 50);
    rerender();
  }

  function onUi(ev) {
    if (ev.action !== 'set_board') return;
    const pos = tryPos(ev.fen);
    if (!pos) return;
    const fen = fenOf(pos);
    const { tree, node: target } = placeCoachPosition(lctrl.tree, ev);
    if (tree !== lctrl.tree) lctrl.setTree(tree);
    if (ev.line?.length) tree.addLine(target, ev.line.map(m => m.uci));
    lctrl.orientation = ev.orientation || pos.turn;
    lesson.shapes = ev.shapes?.length ? { fen, shapes: ev.shapes } : null;
    lesson.caption = ev.caption ? { fen, text: ev.caption } : null;
    lesson.question = ev.askMove ? { fen } : null;
    lctrl.goto(target);
    lctrl.emit();
  }

  function onMove(uci) {
    const parent = lctrl.node;
    const r = lctrl.play(uci);
    if (!r) return;
    if (lesson.question && repKey(lesson.question.fen) === repKey(parent.fen)) {
      lesson.question = null;
      coach.send?.(`I play ${r.node.label}`, { label: `My answer: ${r.node.label}` });
    }
  }

  const node = lctrl.node;
  const shapes = lesson.shapes && repKey(lesson.shapes.fen) === repKey(node.fen) ? lesson.shapes.shapes : [];
  const caption = lesson.caption && repKey(lesson.caption.fen) === repKey(node.fen) ? lesson.caption.text : null;
  const asking = lesson.question && repKey(lesson.question.fen) === repKey(node.fen);

  return html`<div class="workspace two">
    <div class="board-col">
      <div class="board-area">
        <${Board} fen=${node.fen} orientation=${lctrl.orientation} lastMove=${lctrl.lastMove} movable="both" onMove=${onMove} shapes=${shapes} banner=${asking ? 'Your move — what would you play?' : null} />
      </div>
      ${caption && html`<div class="board-caption">${caption}</div>`}
      <div class="board-controls">
        <button class="btn icon" onClick=${() => lctrl.first()}>⏮</button>
        <button class="btn icon" onClick=${() => lctrl.prev()}>◀</button>
        <button class="btn icon" onClick=${() => lctrl.next()}>▶</button>
        <button class="btn icon" onClick=${() => lctrl.last()}>⏭</button>
        <button class="btn icon" onClick=${() => lctrl.flip()}>⇅</button>
      </div>
      <div class="panel fill"><div class="panel-body"><${MoveList} tree=${lctrl.tree} current=${node} onSelect=${n => lctrl.goto(n)} /></div></div>
    </div>
    <div class="side-col">
      <div class="card" style="flex:none">
        <div class="row">
          <input type="text" class="grow" placeholder="What do you want to learn? e.g. “How to play against the London System”" value=${topic} onInput=${e => setTopic(e.currentTarget.value)} onKeyDown=${e => e.key === 'Enter' && topic.trim() && startLesson(topic.trim())} />
          <button class="btn primary" disabled=${!topic.trim()} onClick=${() => startLesson(topic.trim())}>Start lesson</button>
        </div>
        <div class="suggestions" style="margin-top:8px">
          ${[...reportTopics, ...TOPICS].slice(0, 12).map(t => html`<button class="btn small" onClick=${() => startLesson(t)}>${t}</button>`)}
        </div>
      </div>
      <div class="grow" style="min-height:0">
        <${CoachPanel}
          handle=${coach}
          kind="lesson"
          storageKey="lesson"
          title="Lesson"
          getContext=${() => ({ mode: 'lesson', startFen: lctrl.tree.isStandardStart ? undefined : lctrl.tree.startFen, ucis: lctrl.tree.ucis(lctrl.node) })}
          onUi=${onUi}
          onPosition=${d => onUi({ action: 'set_board', fen: d.fen, shapes: d.shapes, caption: d.caption, orientation: d.orientation, line: [] })}
          intro=${html`<div class="coach-empty"><h3>Interactive lessons</h3><p>Pick a topic above or type your own. The coach explains the ideas, puts positions on the board, and asks you to find moves — answer by playing on the board.</p></div>`}
        />
      </div>
    </div>
  </div>`;
}
