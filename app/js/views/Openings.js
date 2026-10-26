// Openings: explorer (book / your games / Lichess), opening search, Stockfish's evaluation, repertoire trees,
// spaced-repetition drill, and opening lessons from the coach (who plays the openings it shows out from the start).
import { html, useEffect, useState } from '../../vendor/preact.js';
import { get, post, qs } from '../api.js';
import { toast, useStore } from '../store.js';
import { BoardCtrl, useCtrl, useBoardKeys, useForce, useMedia } from '../ctrl.js';
import { Tree, placeCoachPosition } from '../tree.js';
import { engine, useLiveEval, engineSwitches, setEngineSwitch, useEngineSwitch } from '../engine.js';
import { Board } from '../components/Board.js';
import { EvalBar } from '../components/EvalBar.js';
import { EnginePanel } from '../components/EnginePanel.js';
import { MoveList } from '../components/MoveList.js';
import { Explorer } from '../components/Explorer.js';
import { useCoachHandle } from '../components/coachHandle.js';
import { CoachPanel } from '../components/CoachPanel.js';
import { useCoachScreen, coachRequest } from '../coachTerm.js';
import { repKey, turnOf, playUci, INITIAL_FEN, tryPos } from '../chess.js';
import { cls, stored, store } from '../util.js';
import { clearParams } from '../router.js';

const ctrl = new BoardCtrl();
export { ctrl as openingsCtrl };
const os = {
  repColor: stored('openings.repColor', 'white'),
  entries: { white: null, black: null },
  side: stored('openings.side', 'repertoire'), // next to the board: the repertoire or the coach
  compactTab: stored('openings.side', 'repertoire'), // a narrow window's one column: coach, repertoire, moves or explorer
  multipv: stored('openings.multipv', 3),
  drill: null,
  query: '',
  results: [],
  // what the coach drew, captioned or asked about the position it showed
  coachShapes: null,
  caption: null,
  question: null,
};

// The coach's line being played out on the board, one move at a time: { timer, at (the node on the board), target }.
let anim = null;

function stopAnim() {
  clearTimeout(anim?.timer);
  anim = null;
}

/** Leaving the screen in the middle of a line: the board goes straight to where it was heading. */
function finishAnim() {
  const end = anim?.target;
  stopAnim();
  if (end) ctrl.goto(end);
}

async function loadRep(color) {
  const r = await get('/api/repertoire' + qs({ color }));
  os.entries[color] = r.entries;
  os.stats = { ...(os.stats || {}), [color]: r.stats };
  return r.entries;
}

function byKey(entries) {
  const m = new Map();
  for (const e of entries || []) {
    if (!m.has(e.key)) m.set(e.key, []);
    m.get(e.key).push(e);
  }
  return m;
}

export function Openings({ route }) {
  useCtrl(ctrl);
  const s = useStore();
  const rerender = useForce();
  const coach = useCoachHandle();
  const compact = useMedia('(max-width: 1280px)');
  const node = ctrl.node;
  const [opening, setOpening] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const color = os.repColor;
  const d = os.drill;
  const switchOn = useEngineSwitch('openings');
  const engineOn = switchOn && !d; // a drill is a test: no engine
  const live = useLiveEval(engineOn ? node.fen : '__off__');

  const setSide = id => {
    os.compactTab = id;
    if (id === 'coach' || id === 'repertoire') {
      os.side = id;
      store('openings.side', id);
    }
    rerender();
  };
  const toggleEngine = () => setEngineSwitch('openings', !engineSwitches().openings);

  useEffect(() => {
    if (!os.entries.white) loadRep('white').then(rerender);
    if (!os.entries.black) loadRep('black').then(rerender);
    return () => {
      finishAnim();
      engine.stop();
    };
  }, []);
  const playing = !!anim;
  useEffect(() => {
    if (playing) return; // (while a line is played out: the coach's buttons would change with every move)
    let alive = true;
    get('/api/openings/lookup' + qs({ fen: node.fen }))
      .then(o => alive && setOpening(o))
      .catch(() => {});
    return () => (alive = false);
  }, [node.fen, playing]);
  useEffect(() => {
    if (engineOn) engine.analyze(node.fen, os.multipv);
    else engine.stop();
  }, [node.fen, engineOn, os.multipv]);
  // the coach switched to this screen and chose the tab next to the board (switch_screen)
  useEffect(() => {
    const t = route?.params?.tab;
    if (!t) return;
    clearParams();
    if (t === 'coach' || t === 'repertoire') setSide(t);
  }, [route]);
  useBoardKeys(ctrl, e => {
    if (e.key === ' ' && !os.drill) {
      toggleEngine();
      return true;
    }
  });

  const coachContext = () => {
    const at = anim ? anim.target : ctrl.node; // while a line is being played out: where it stops
    const ev = engine.data && engine.data.fen === at.fen ? engine.data : null;
    return {
      mode: os.drill ? 'drill' : 'openings',
      startFen: ctrl.tree.isStandardStart ? undefined : ctrl.tree.startFen,
      ucis: ctrl.tree.ucis(at),
      drill: os.drill ? { color: os.drill.color } : undefined,
      engine: !os.drill && engineSwitches().openings && ev?.lines?.length ? { depth: ev.depth, lines: ev.lines.map(l => ({ score: l.score, pv: (l.pv || []).slice(0, 12) })) } : undefined,
      question: os.question && repKey(os.question.fen) === repKey(at.fen) ? true : undefined,
      note: os.drill ? undefined : `The ${os.repColor} repertoire is selected; next to the board: ${os.side === 'coach' ? 'your coach panel' : 'the repertoire'}.`,
    };
  };
  useCoachScreen(
    () => (os.drill ? 'drill' : 'openings'),
    coachContext,
    ev => {
      if (ev.action !== 'set_board') return false;
      if (os.drill) {
        if (!confirm('Your coach wants to show you a position. Stop the drill to look at it?')) return true;
        stopDrill();
      }
      setBoardFromCoach(ev);
      return true;
    },
  );
  useEffect(() => {
    const onCoachUi = e => e.detail.action === 'repertoire_updated' && loadRep(e.detail.color).then(rerender);
    window.addEventListener('cc:coach-ui', onCoachUi);
    return () => window.removeEventListener('cc:coach-ui', onCoachUi);
  }, []);

  const entries = os.entries[color] || [];
  const map = byKey(entries);
  const hereKey = repKey(node.fen);
  const repHere = map.get(hereKey) || [];
  const parentKey = node.parent ? repKey(node.parent.fen) : null;
  const inRep = node.parent && (map.get(parentKey) || []).find(e => e.uci === node.uci);

  const search = async q => {
    os.query = q;
    rerender();
    if (q.trim().length < 2) {
      os.results = [];
      return rerender();
    }
    os.results = await get('/api/openings/search' + qs({ q, limit: 30 }));
    rerender();
  };

  const loadLine = ucis => {
    stopAnim();
    const t = Tree.fromMoves(INITIAL_FEN, ucis);
    ctrl.setTree(t, t.mainline().at(-1));
  };

  const reset = () => {
    stopAnim();
    os.coachShapes = os.caption = os.question = null;
    ctrl.setTree(new Tree());
  };

  const addLine = async () => {
    const sans = ctrl.tree.path(node).slice(1).map(n => n.san);
    if (!sans.length) return toast('Play the moves of the line first.');
    try {
      const r = await post('/api/repertoire/add', { color, moves: sans });
      await loadRep(color);
      toast(`Added to your ${color} repertoire (${r.added} new moves).`, 'success');
      rerender();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const removeMove = async () => {
    if (!inRep) return;
    await post('/api/repertoire/remove', { color, key: inRep.key, uci: inRep.uci });
    await loadRep(color);
    rerender();
  };

  const setColor = c => {
    os.repColor = c;
    store('openings.repColor', c);
    rerender();
  };

  // ---- drill ----
  const startDrill = async () => {
    const list = await loadRep(color);
    if (!list.some(e => turnOf(e.fen) === color)) return toast(`Your ${color} repertoire has no moves for ${color} yet. Add some lines first.`, 'error');
    stopAnim();
    os.question = null;
    os.drill = { color, map: byKey(list), feedback: { kind: 'info', text: 'Play your repertoire moves.' }, correct: 0, wrong: 0, expected: null, firstTry: true, arrows: [] };
    ctrl.orientation = color;
    ctrl.setTree(new Tree());
    drillStep();
  };
  const stopDrill = () => {
    os.drill = null;
    loadRep(color).then(rerender);
    rerender();
  };

  function dueBelow(map, fen, depth = 0, seen = new Set()) {
    if (depth > 14) return 0;
    const k = repKey(fen);
    if (seen.has(k)) return 0;
    seen.add(k);
    let n = 0;
    for (const e of map.get(k) || []) {
      if (turnOf(e.fen) === os.drill.color && (!e.due || e.due <= Date.now())) n++;
      const r = playUci(e.fen, e.uci);
      if (r) n += dueBelow(map, r.fen, depth + 1, seen);
    }
    return n;
  }

  function drillStep() {
    const d = os.drill;
    if (!d) return;
    const n = ctrl.node;
    const list = d.map.get(repKey(n.fen)) || [];
    d.arrows = [];
    if (!list.length) {
      d.feedback = { kind: 'good', text: n.ply ? 'Line complete — next line…' : 'Nothing to drill here.' };
      rerender();
      if (n.ply)
        setTimeout(() => {
          if (os.drill !== d) return;
          ctrl.setTree(new Tree());
          drillStep();
        }, 1300);
      return;
    }
    if (turnOf(n.fen) !== d.color) {
      const weights = list.map(e => {
        const r = playUci(e.fen, e.uci);
        return 1 + 3 * (r ? dueBelow(d.map, r.fen) : 0);
      });
      let x = Math.random() * weights.reduce((a, b) => a + b, 0);
      let pick = list[0];
      for (let i = 0; i < list.length; i++) {
        x -= weights[i];
        if (x <= 0) {
          pick = list[i];
          break;
        }
      }
      setTimeout(() => {
        if (os.drill !== d) return;
        ctrl.play(pick.uci);
        drillStep();
      }, 450);
      d.expected = null;
    } else {
      d.expected = list;
      d.firstTry = true;
    }
    rerender();
  }

  async function onDrillMove(uci) {
    const d = os.drill;
    if (!d?.expected) return;
    const parent = ctrl.node;
    const r = ctrl.play(uci);
    if (!r) return;
    const hit = d.expected.find(e => e.uci === r.node.uci);
    if (hit) {
      d.correct++;
      d.feedback = { kind: 'good', text: `✓ ${r.node.label}${hit.comment ? ` — ${hit.comment}` : ''}` };
      post('/api/repertoire/review', { id: hit.id, grade: d.firstTry ? 2 : 1 }).catch(() => {});
      d.expected = null;
      drillStep();
    } else {
      d.wrong++;
      if (d.firstTry) post('/api/repertoire/review', { id: d.expected[0].id, grade: 0 }).catch(() => {});
      d.firstTry = false;
      d.feedback = { kind: 'bad', text: `${r.node.san} is not in your repertoire. Play ${d.expected.map(e => e.san).join(' or ')}.` };
      d.arrows = d.expected.map(e => ({ orig: e.uci.slice(0, 2), dest: e.uci.slice(2, 4), brush: 'green' }));
      rerender();
      setTimeout(() => {
        ctrl.tree.remove(r.node);
        ctrl.goto(parent);
      }, 650);
    }
  }

  /** A move on the board: the drill's, an answer to the coach's question, or a move to explore. */
  const onMove = uci => {
    if (d) return onDrillMove(uci);
    const parent = ctrl.node;
    const r = ctrl.play(uci);
    if (!r || !os.question || repKey(os.question.fen) !== repKey(parent.fen)) return;
    os.question = null;
    coachRequest({ text: `My answer: ${r.node.label}` });
  };
  const studentMove = n => turnOf(n.fen) === color;
  const movable = d ? (d.expected ? d.color : false) : 'both';
  const best = live?.lines?.[0]?.pv?.[0];
  const shapes = d ? d.arrows : repHere.map(e => ({ orig: e.uci.slice(0, 2), dest: e.uci.slice(2, 4), brush: studentMove(node) ? 'paleGreen' : 'paleGrey' }));
  if (!d && engineOn && best && s.settings?.board?.bestArrow !== false) shapes.push({ orig: best.slice(0, 2), dest: best.slice(2, 4), brush: 'paleBlue' });
  if (!d && os.coachShapes && repKey(os.coachShapes.fen) === hereKey) shapes.push(...os.coachShapes.shapes);
  const caption = !d && os.caption && repKey(os.caption.fen) === hereKey ? os.caption.text : null;
  const asking = !d && os.question && repKey(os.question.fen) === hereKey;

  const enginePanel = html`<div class="panel" style="flex:none"><${EnginePanel}
    fen=${node.fen}
    data=${live}
    enabled=${switchOn}
    onToggle=${toggleEngine}
    multipv=${os.multipv}
    onMultipv=${n => {
      os.multipv = n;
      store('openings.multipv', n);
      rerender();
    }}
    onPlay=${onMove}
  /></div>`;
  const moves = html`<${MoveList} tree=${ctrl.tree} current=${node} onSelect=${n => ctrl.goto(n)} />`;
  const find = html`<div class="panel" style="flex:none">
    <div class="panel-head"><span class="title">Find an opening</span></div>
    <div style="padding:8px"><input type="search" style="width:100%" placeholder="Name or ECO, e.g. Najdorf, Caro-Kann Advance, D37" value=${os.query} onInput=${e => search(e.currentTarget.value)} /></div>
    ${os.results.length
      ? html`<div class="search-results">${os.results.map(
          r => html`<div class="item" onClick=${() => {
            os.results = [];
            os.query = '';
            loadLine(r.ucis);
          }}><span class="muted">${r.eco}</span> <span class="n">${r.name}</span><div class="muted" style="font-size:12px">${r.pgn}</div></div>`,
        )}</div>`
      : null}
  </div>`;
  const explorer = html`<div class="panel grow"><div class="panel-body"><${Explorer} fen=${node.fen} line=${ctrl.tree.isStandardStart ? ctrl.tree.ucis(node) : null} onPlay=${onMove} /></div></div>`;
  const repertoire = html`<div class="panel grow">
    <div class="panel-head">
      <div class="btn-group">${['white', 'black'].map(c => html`<button class=${cls('btn small', color === c && 'active')} onClick=${() => setColor(c)}>${c === 'white' ? 'White' : 'Black'} repertoire</button>`)}</div>
      <span class="spacer"></span>
      <span class="muted" style="font-size:12px">${os.stats?.[color] ? `${os.stats[color].studentMoves} moves · ${os.stats[color].due} due` : ''}</span>
    </div>
    <div class="row wrap" style="padding:8px">
      <button class="btn small primary" disabled=${!!d || !node.ply} onClick=${addLine} title="Adds every move from the start to the current position">Add current line</button>
      ${inRep && !d && html`<button class="btn small danger" onClick=${removeMove}>Remove ${node.san}</button>`}
      <button class="btn small" disabled=${!!d} onClick=${() => setImportOpen(true)}>Import PGN</button>
      <button class="btn small blue" disabled=${!!d} onClick=${startDrill}>Drill (${os.stats?.[color]?.due ?? 0} due)</button>
    </div>
    <div class="panel-body">
      ${entries.length
        ? html`<div class="rep-tree"><${RepNode} fen=${INITIAL_FEN} map=${map} color=${color} current=${hereKey} onPick=${loadLine} path=${[]} depth=${0} /></div>`
        : html`<div class="empty"><p>Your ${color} repertoire is empty.</p><p class="muted">Play a line on the board (or pick one from the explorer) and press <b>Add current line</b>, import a PGN, or ask the coach to propose a repertoire.</p></div>`}
    </div>
  </div>`;
  const coachPanel = html`<div class="grow" style="min-height:0"><${CoachPanel}
    handle=${coach}
    kind="opening"
    storageKey="openings"
    title="Opening coach"
    getContext=${coachContext}
    quick=${[
      opening ? { label: `Teach me the ${opening.name.split(':')[0]}`, task: 'openingLesson', taskArgs: () => ({ name: opening.name, pgn: opening.pgn }) } : null,
      { label: 'Ideas in this position', task: 'ideas' },
      { label: 'Suggest a repertoire for me', text: `Suggest a practical ${color} repertoire for my level, based on my games if possible. Add it to my repertoire only after I agree.` },
    ].filter(Boolean)}
    intro=${html`<div class="coach-empty"><h3>Learn openings with your coach</h3><p>Ask about any line on the board: the ideas behind the moves, typical plans and pawn structures, traps, and how your own games went. The coach can build your repertoire with you.</p></div>`}
  /></div>`;

  // Next to the board: the repertoire or the coach. A narrow window has no middle column: the moves and the explorer
  // become tabs there too (during a drill, without the move list).
  const sideTabs = compact
    ? [['coach', 'Coach'], ['repertoire', 'Repertoire'], ...(d ? [] : [['moves', 'Moves']]), ['explorer', 'Explorer']]
    : [['repertoire', 'Repertoire'], ['coach', 'Coach']];
  const side = !compact ? os.side : d && os.compactTab === 'moves' ? 'repertoire' : os.compactTab;
  const sidePanel = { repertoire, coach: coachPanel, moves: html`${enginePanel}<div class="panel grow"><div class="panel-body">${moves}</div></div>`, explorer: html`${find}${explorer}` }[side] || coachPanel;

  return html`<div class="workspace">
    <div class="board-col">
      <div class="board-area">
        ${!d && s.settings?.board?.evalBar !== false && html`<${EvalBar} score=${engineOn ? live?.lines?.[0]?.score || null : null} orientation=${ctrl.orientation} />`}
        <${Board} fen=${node.fen} orientation=${ctrl.orientation} lastMove=${ctrl.lastMove} movable=${movable} onMove=${onMove} shapes=${shapes} banner=${asking ? 'Your turn — play your answer on the board' : null} />
      </div>
      ${caption && html`<div class="board-caption">${caption}</div>`}
      ${d && d.feedback && html`<div class=${cls('feedback', d.feedback.kind)}>${d.feedback.text}</div>`}
      <div class="board-controls">
        ${!d &&
        html`<button class="btn icon" title="First (↑)" onClick=${() => ctrl.first()}>⏮</button>
          <button class="btn icon" title="Back (←)" onClick=${() => ctrl.prev()}>◀</button>
          <button class="btn icon" title="Forward (→)" onClick=${() => ctrl.next()}>▶</button>
          <button class="btn icon" title="Last (↓)" onClick=${() => ctrl.last()}>⏭</button>`}
        <button class="btn icon" title="Flip (f)" onClick=${() => ctrl.flip()}>⇅</button>
        <span class="spacer"></span>
        ${d
          ? html`<span class="muted">✓ ${d.correct} · ✗ ${d.wrong}</span>
              ${node.uci && html`<button class="btn small" onClick=${() => coach.send?.(`Why is ${node.san} played here?`, { task: 'repertoireWhy', taskArgs: { san: node.san }, label: `Why ${node.label}?` })}>Why this move?</button>`}
              <button class="btn small danger" onClick=${stopDrill}>Stop drill</button>`
          : html`<button class="btn small ghost" title="A new board at the starting position" onClick=${reset}>Reset</button>`}
      </div>
    </div>
    ${!compact &&
    html`<div class="side-col middle">
      ${find}
      ${!d && enginePanel}
      ${!d && html`<div class="panel moves"><div class="panel-body">${moves}</div></div>`}
      ${explorer}
    </div>`}
    <div class="side-col">
      <div class="panel" style="flex:none"><div class="panel-head"><div class="tabs">
        ${sideTabs.map(([id, label]) => html`<button class=${cls('tab', side === id && 'active')} onClick=${() => setSide(id)}>${label}</button>`)}
      </div></div></div>
      ${sidePanel}
    </div>
    ${importOpen && html`<${ImportRep} color=${color} onClose=${() => setImportOpen(false)} onDone=${() => loadRep(color).then(rerender)} />`}
  </div>`;
}

/**
 * The coach shows a position (set_board). Its moves from the initial position (the coach's own, after the line on the
 * board, or from the opening book) join the board's tree, and the board plays them out one move at a time — from the
 * position on the board when that is on the way, otherwise from the initial position — so the student sees the
 * opening unfold and can go back through it and into other lines.
 */
function setBoardFromCoach(ev) {
  if (!tryPos(ev.fen)) return;
  stopAnim();
  const before = ctrl.tree;
  const from = ctrl.node;
  const { tree, node: target } = placeCoachPosition(before, ev, { merge: true });
  if (ev.line?.length) tree.addLine(target, ev.line.map(m => m.uci));
  os.coachShapes = ev.shapes?.length ? { fen: target.fen, shapes: ev.shapes } : null;
  os.caption = ev.caption ? { fen: target.fen, text: ev.caption } : null;
  os.question = ev.askMove ? { fen: target.fen } : null;
  if (ev.orientation) ctrl.orientation = ev.orientation;
  if (tree !== before) ctrl.setTree(tree);
  const way = tree.path(target);
  for (const n of way.slice(1)) if (n.parent.children[0] !== n) tree.promote(n); // the line shown becomes the main line
  let at = tree === before ? way.indexOf(from) : -1;
  if (at < 0 && tree === before && tree.path(from).includes(target)) at = way.length - 1; // already past it: back
  playOut(way, Math.max(at, 0));
}

/** Shows way[i], then plays the rest of `way` one move at a time. Any move or step of the student's stops it. */
function playOut(way, i) {
  const target = way.at(-1);
  const first = Math.max(i, way.length - 41); // a long line: its last 40 moves
  const steps = way.length - 1 - first;
  ctrl.goto(way[first]);
  ctrl.emit();
  if (!steps) return;
  const a = { at: way[first], target, timer: 0 };
  anim = a;
  const delay = Math.max(150, Math.min(600, 6000 / steps));
  const tick = () => {
    if (anim !== a) return;
    if (ctrl.node !== a.at) {
      stopAnim(); // the student took over
      return ctrl.emit();
    }
    a.at = way[way.indexOf(a.at) + 1];
    ctrl.goto(a.at, { sound: true });
    if (a.at === target) anim = null;
    else a.timer = setTimeout(tick, delay);
  };
  a.timer = setTimeout(tick, first === 0 ? 700 : delay); // a moment on the initial position first
}

function RepNode({ fen, map, color, current, onPick, path, depth, seen = new Set() }) {
  const k = repKey(fen);
  if (depth > 40 || seen.has(k)) return null;
  const next = new Set(seen).add(k);
  const list = map.get(k) || [];
  if (!list.length) return null;
  const parts = list.map(e => {
    const r = playUci(e.fen, e.uci);
    if (!r) return null;
    const p = [...path, e.uci];
    const white = turnOf(e.fen) === 'white';
    const n = Number(e.fen.split(' ')[5]) || 1;
    const label = white ? `${n}. ${e.san}` : `${n}… ${e.san}`;
    return { e, r, p, label };
  }).filter(Boolean);
  const single = parts.length === 1;
  return html`${parts.map(
    ({ e, r, p, label }) => html`<span>
      <span class=${cls('vm', turnOf(e.fen) === color && 'mine', repKey(r.fen) === current && 'active')} title=${e.comment || ''} onClick=${() => onPick(p)}>${label}</span>
      ${single
        ? html` <${RepNode} fen=${r.fen} map=${map} color=${color} current=${current} onPick=${onPick} path=${p} depth=${depth + 1} seen=${next} />`
        : html`<div class="branch"><${RepNode} fen=${r.fen} map=${map} color=${color} current=${current} onPick=${onPick} path=${p} depth=${depth + 1} seen=${next} /></div>`}
    </span>`,
  )}`;
}

function ImportRep({ color, onClose, onDone }) {
  const [text, setText] = useState('');
  const go = async () => {
    try {
      const r = await post('/api/repertoire/import', { color, pgn: text });
      toast(`Imported ${r.added} moves into your ${color} repertoire.`, 'success');
      onDone();
      onClose();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return html`<div class="modal-backdrop" onClick=${onClose}><div class="modal" onClick=${e => e.stopPropagation()}>
    <h2>Import a PGN into your ${color} repertoire</h2>
    <p class="muted">All variations are imported. Comments become notes on the moves.</p>
    <textarea rows="12" style="width:100%" value=${text} onInput=${e => setText(e.currentTarget.value)} placeholder="1. e4 e5 2. Nf3 (2. Bc4) Nc6 3. Bb5 …"></textarea>
    <div class="actions"><button class="btn ghost" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!text.trim()} onClick=${go}>Import</button></div>
  </div></div>`;
}
