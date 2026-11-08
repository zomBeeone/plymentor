// Openings: explorer (book / your games / Lichess), opening search, Stockfish's evaluation, repertoire trees in the
// student's groups ("French"…), spaced-repetition drill of a group or of everything, the notes of the repertoire's
// moves, and opening lessons from the coach (who plays the openings it shows out from the start).
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { get, post, del, qs } from '../api.js';
import { toast, useStore } from '../store.js';
import { BoardCtrl, useCtrl, useBoardKeys, useForce, useMedia } from '../ctrl.js';
import { Tree, placeCoachPosition, commentsOf } from '../tree.js';
import { engine, useLiveEval, engineSwitches, setEngineSwitch, useEngineSwitch } from '../engine.js';
import { Board } from '../components/Board.js';
import { EvalBar } from '../components/EvalBar.js';
import { EnginePanel } from '../components/EnginePanel.js';
import { MoveList, MoveComment, commentMark } from '../components/MoveList.js';
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
  entries: { white: null, black: null }, // the repertoire's moves, each with the ids of its groups
  groups: { white: [], black: [] }, // { id, name, moves, studentMoves, due }
  target: stored('openings.groupTarget', { white: 0, black: 0 }), // the group "Add current line" puts the line into (0: none)
  folded: stored('openings.groupsFolded', []), // the groups shown without their lines, as "color:id" (other lines: id 0)
  newGroup: null, // the name typed for a new group (null: none being made)
  renaming: null, // { id, name } of the group being renamed
  deleting: null, // the group whose deletion is being asked
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

/** The note the repertoire of `color` has on the move that led to `node`. */
function repNote(node, color) {
  if (!node.parent) return '';
  const key = repKey(node.parent.fen);
  return (os.entries[color] || []).find(e => e.key === key && e.uci === node.uci)?.comment || '';
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
  os.groups[color] = r.groups || [];
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

function setTarget(color, id) {
  os.target = { ...os.target, [color]: id };
  store('openings.groupTarget', os.target);
}

/** The moves of the lines in no group: those, and the moves (of any group) that lead to them from the start. */
function otherLines(entries) {
  const map = byKey(entries);
  const known = new Map(); // position -> whether a move in no group follows
  const ids = new Set();
  const visit = (fen, way) => {
    const k = repKey(fen);
    if (known.has(k)) return known.get(k);
    if (way.has(k)) return false; // (a repetition)
    way.add(k);
    let any = false;
    for (const e of map.get(k) || []) {
      const r = playUci(e.fen, e.uci);
      if (r && (visit(r.fen, way) || !e.groups.length)) {
        ids.add(e.id);
        any = true;
      }
    }
    way.delete(k);
    known.set(k, any);
    return any;
  };
  visit(INITIAL_FEN, new Set());
  return entries.filter(e => ids.has(e.id));
}

/** Numbers of a group's moves (or of the lines in no group): { moves, studentMoves, due }. */
function countsOf(entries, color) {
  const mine = entries.filter(e => turnOf(e.fen) === color);
  return { moves: entries.length, studentMoves: mine.length, due: mine.filter(e => !e.due || e.due <= Date.now()).length };
}

/** A name for a new group from a PGN's headers: its opening, study or event. */
function nameFromPgn(text) {
  for (const tag of ['Opening', 'StudyName', 'Event']) {
    const v = new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`).exec(text)?.[1]?.trim();
    if (v && v !== '?' && !/^(casual|rated|live)\b/i.test(v)) return v.split(':')[0].slice(0, 60);
  }
  return '';
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
    const names = os.groups[os.repColor].map(g => `"${g.name}"`);
    return {
      mode: os.drill ? 'drill' : 'openings',
      startFen: ctrl.tree.isStandardStart ? undefined : ctrl.tree.startFen,
      ucis: ctrl.tree.ucis(at),
      drill: os.drill ? { color: os.drill.color, group: os.drill.group?.name } : undefined,
      engine: !os.drill && engineSwitches().openings && ev?.lines?.length ? { depth: ev.depth, lines: ev.lines.map(l => ({ score: l.score, pv: (l.pv || []).slice(0, 12) })) } : undefined,
      question: os.question && repKey(os.question.fen) === repKey(at.fen) ? true : undefined,
      comment: os.drill ? undefined : repNote(at, os.repColor) || undefined,
      commentFrom: 'repertoire',
      note: os.drill
        ? undefined
        : `The ${os.repColor} repertoire is selected${names.length ? ` (its groups: ${names.join(', ')})` : ''}; next to the board: ${os.side === 'coach' ? 'your coach panel' : 'the repertoire'}.`,
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
  const groups = os.groups[color];
  const target = groups.find(g => g.id === os.target[color]) || null;
  // a move's notes: the line's own (from a PGN), and the repertoire's
  const notes = n => {
    const note = n.parent && (map.get(repKey(n.parent.fen)) || []).find(e => e.uci === n.uci)?.comment;
    return note ? [...commentsOf(n), note] : commentsOf(n);
  };

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
      const r = await post('/api/repertoire/add', { color, moves: sans, group: target?.id });
      await loadRep(color);
      const fresh = `${r.added} new move${r.added === 1 ? '' : 's'}`;
      if (!r.group) toast(`Added to your ${color} repertoire (${fresh}).`, 'success');
      else toast(r.added ? `Added to ${r.group.name} (${fresh}).` : `The line is in ${r.group.name} now.`, 'success');
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

  /** Takes the line on the board out of a group: its moves stay in the repertoire. */
  const ungroup = async g => {
    try {
      await post(`/api/repertoire/groups/${g.id}/remove`, { key: inRep.key, uci: inRep.uci });
      await loadRep(color);
      toast(`The line is out of ${g.name}; its moves stay in your repertoire.`);
      rerender();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const setColor = c => {
    os.repColor = c;
    store('openings.repColor', c);
    rerender();
  };

  // ---- groups ----
  const groupAction = async (fn, done) => {
    try {
      const r = await fn();
      await loadRep(color);
      done?.(r);
    } catch (e) {
      toast(e.message, 'error');
    }
    rerender();
  };
  /** A new group: its name suggested from the opening on the board. */
  const newGroup = () => {
    os.newGroup = node.ply && opening?.name ? opening.name.split(':')[0] : '';
    rerender();
  };
  const createGroup = () =>
    groupAction(
      () => post('/api/repertoire/groups', { color, name: os.newGroup }),
      g => {
        os.newGroup = null;
        setTarget(color, g.id);
        toast(`The group ${g.name} is ready: the lines you add now go into it.`, 'success');
      },
    );
  const renameGroup = () => {
    const r = os.renaming;
    os.renaming = null;
    const g = r && groups.find(x => x.id === r.id);
    if (!g || !r.name.trim() || r.name.trim() === g.name) return rerender(); // (Escape, or nothing changed)
    groupAction(() => post(`/api/repertoire/groups/${g.id}`, { name: r.name }));
  };
  const deleteGroup = (g, keep) =>
    groupAction(
      () => del(`/api/repertoire/groups/${g.id}${keep ? '?keep=1' : ''}`),
      r => {
        os.deleting = null;
        toast(keep ? `The group ${g.name} is deleted; its lines are still in your repertoire.` : `The group ${g.name} is deleted, with its lines (${r.removed} moves).`, 'success');
      },
    );
  const toggleFolder = id => {
    const k = `${color}:${id}`;
    os.folded = os.folded.includes(k) ? os.folded.filter(x => x !== k) : [...os.folded, k];
    store('openings.groupsFolded', os.folded);
    rerender();
  };

  // ---- drill ----
  /** Drills the whole repertoire (no argument), one group's lines (its id), or the lines in no group (0). */
  const startDrill = async which => {
    const list = await loadRep(color);
    const g = which === 0 ? { id: 0, name: 'Other lines' } : (which && os.groups[color].find(x => x.id === which)) || null;
    const lines = !g ? list : g.id ? list.filter(e => e.groups.includes(g.id)) : otherLines(list);
    if (!lines.some(e => turnOf(e.fen) === color))
      return toast(g ? `${g.name} has no moves for ${color} yet. Add lines to it first.` : `Your ${color} repertoire has no moves for ${color} yet. Add some lines first.`, 'error');
    stopAnim();
    os.question = null;
    os.drill = {
      color,
      group: g ? { id: g.id, name: g.name } : null,
      map: byKey(lines),
      feedback: { kind: 'info', text: g ? `Play your repertoire moves: ${g.name}.` : 'Play your repertoire moves.' },
      correct: 0,
      wrong: 0,
      expected: null,
      firstTry: true,
      arrows: [],
    };
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
      d.feedback = { kind: 'bad', text: `${r.node.san} is not in ${d.group ? d.group.name : 'your repertoire'}. Play ${d.expected.map(e => e.san).join(' or ')}.` };
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
  const moves = html`<${MoveList} tree=${ctrl.tree} current=${node} onSelect=${n => ctrl.goto(n)} comments=${notes} />`;
  const comment = html`<${MoveComment} node=${node} comments=${notes} />`; // (under the moves: the note of the move on the board)
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
  // The repertoire's groups as folders (each with its lines from the start), then the lines in no group. Without
  // groups, the one tree.
  const loose = groups.length ? otherLines(entries) : [];
  const folders = [
    ...groups.map(g => ({ ...g, entries: entries.filter(e => e.groups.includes(g.id)) })),
    ...(loose.length ? [{ id: 0, name: 'Other lines', entries: loose, ...countsOf(entries.filter(e => !e.groups.length), color) }] : []),
  ];
  const inGroups = inRep ? inRep.groups.map(id => groups.find(g => g.id === id)).filter(Boolean) : [];
  const repertoire = html`<div class="panel grow">
    <div class="panel-head">
      <div class="btn-group">${['white', 'black'].map(c => html`<button class=${cls('btn small', color === c && 'active')} onClick=${() => setColor(c)}>${c === 'white' ? 'White' : 'Black'} repertoire</button>`)}</div>
      <span class="spacer"></span>
      <span class="muted" style="font-size:12px">${os.stats?.[color] ? `${os.stats[color].studentMoves} moves · ${os.stats[color].due} due` : ''}</span>
    </div>
    <div class="row wrap rep-actions">
      <button
        class="btn small primary"
        disabled=${!!d || !node.ply}
        onClick=${addLine}
        title=${target ? `Adds the moves from the start to here — and your repertoire's moves after them — to ${target.name}` : 'Adds every move from the start to the current position'}
      >
        Add current line
      </button>
      ${groups.length
        ? html`<label class="rep-target" title="The group the line goes into"><span class="muted">to</span>
            <select disabled=${!!d} value=${target?.id || 0} onChange=${e => (setTarget(color, Number(e.currentTarget.value)), rerender())}>
              <option value="0">no group</option>
              ${groups.map(g => html`<option value=${g.id}>${g.name}</option>`)}
            </select></label>`
        : null}
      <button class="btn small" disabled=${!!d} onClick=${() => setImportOpen(true)}>Import PGN</button>
      <button class="btn small blue" disabled=${!!d} title=${groups.length ? 'Drill every line of your repertoire; each group has its own Drill too' : ''} onClick=${() => startDrill()}>
        ${groups.length ? 'Drill all' : 'Drill'} (${os.stats?.[color]?.due ?? 0} due)
      </button>
      <button class="btn small ghost" disabled=${!!d} title="A group (folder) for an opening's lines, e.g. French — drill it on its own" onClick=${newGroup}>＋ Group</button>
    </div>
    ${inRep &&
    !d &&
    html`<div class="rep-here">
      <span class="ellipsis"><b>${node.label}</b> ${inGroups.length ? 'is in' : 'is in your repertoire'}</span>
      ${inGroups.map(
        g => html`<span class="chip">${g.name}<button title=${`Take this line out of ${g.name} (its moves stay in your repertoire)`} onClick=${() => ungroup(g)}>✕</button></span>`,
      )}
      <span class="spacer"></span>
      <button class="btn small danger" onClick=${removeMove} title="Removes the move from your repertoire, with what follows it">Remove ${node.san}</button>
    </div>`}
    <div class="panel-body">
      ${os.newGroup !== null &&
      html`<form class="rep-new" onSubmit=${e => (e.preventDefault(), os.newGroup.trim() && createGroup())}>
        <${AutoFocus}><input type="text" maxlength="60" placeholder="The group's name, e.g. French" value=${os.newGroup} onInput=${e => ((os.newGroup = e.currentTarget.value), rerender())} onKeyDown=${e => e.key === 'Escape' && ((os.newGroup = null), rerender())} /><//>
        <button class="btn small primary" disabled=${!os.newGroup.trim()}>Make the group</button>
        <button type="button" class="btn small ghost" onClick=${() => ((os.newGroup = null), rerender())}>Cancel</button>
      </form>`}
      ${folders.length
        ? html`<div class="rep-groups">${folders.map(
            f => html`<${RepFolder}
              key=${f.id}
              folder=${f}
              color=${color}
              open=${!os.folded.includes(`${color}:${f.id}`)}
              current=${hereKey}
              busy=${!!d}
              renaming=${os.renaming?.id === f.id ? os.renaming.name : null}
              onToggle=${() => toggleFolder(f.id)}
              onPick=${p => (f.id && setTarget(color, f.id), loadLine(p))}
              onDrill=${() => startDrill(f.id)}
              onRename=${f.id ? name => ((os.renaming = name === null ? null : { id: f.id, name }), rerender()) : null}
              onRenamed=${renameGroup}
              onDelete=${f.id ? () => ((os.deleting = f), rerender()) : null}
            />`,
          )}</div>`
        : entries.length
          ? html`<div class="rep-tree"><${RepNode} fen=${INITIAL_FEN} map=${map} color=${color} current=${hereKey} onPick=${loadLine} path=${[]} depth=${0} /></div>`
          : html`<div class="empty"><p>Your ${color} repertoire is empty.</p><p class="muted">Play a line on the board (or pick one from the explorer) and press <b>Add current line</b>, import a PGN, or ask the coach to propose a repertoire. Keep each opening's lines in a group of its own with <b>＋ Group</b>.</p></div>`}
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
  const sidePanel = { repertoire, coach: coachPanel, moves: html`${enginePanel}<div class="panel grow"><div class="panel-body">${moves}</div>${comment}</div>`, explorer: html`${find}${explorer}` }[side] || coachPanel;

  return html`<div class="workspace">
    <div class="board-col">
      <div class="board-area">
        ${!d && s.settings?.board?.evalBar !== false && html`<${EvalBar} score=${engineOn ? live?.lines?.[0]?.score || null : null} fen=${node.fen} off=${!engineOn} orientation=${ctrl.orientation} />`}
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
          ? html`<span class="muted ellipsis">${d.group ? `${d.group.name} · ` : ''}✓ ${d.correct} · ✗ ${d.wrong}</span>
              ${node.uci && html`<button class="btn small" onClick=${() => coach.send?.(`Why is ${node.san} played here?`, { task: 'repertoireWhy', taskArgs: { san: node.san }, label: `Why ${node.label}?` })}>Why this move?</button>`}
              <button class="btn small danger" onClick=${stopDrill}>Stop drill</button>`
          : html`<button class="btn small ghost" title="A new board at the starting position" onClick=${reset}>Reset</button>`}
      </div>
    </div>
    ${!compact &&
    html`<div class="side-col middle">
      ${find}
      ${!d && enginePanel}
      ${!d && html`<div class="panel moves"><div class="panel-body">${moves}</div>${comment}</div>`}
      ${explorer}
    </div>`}
    <div class="side-col">
      <div class="panel" style="flex:none"><div class="panel-head"><div class="tabs">
        ${sideTabs.map(([id, label]) => html`<button class=${cls('tab', side === id && 'active')} onClick=${() => setSide(id)}>${label}</button>`)}
      </div></div></div>
      ${sidePanel}
    </div>
    ${importOpen &&
    html`<${ImportRep}
      color=${color}
      groups=${groups}
      target=${target}
      onClose=${() => setImportOpen(false)}
      onDone=${g => {
        if (g) setTarget(color, g.id); // (its lines are where the next ones go, too)
        loadRep(color).then(rerender);
      }}
    />`}
    ${os.deleting && html`<${DeleteGroup} group=${os.deleting} onClose=${() => ((os.deleting = null), rerender())} onDelete=${keep => deleteGroup(os.deleting, keep)} />`}
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
  const { tree, node: target } = placeCoachPosition(before, ev, { merge: true, current: from });
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
      <span class=${cls('vm', turnOf(e.fen) === color && 'mine', repKey(r.fen) === current && 'active')} title=${e.comment || ''} onClick=${() => onPick(p)}>${label}${e.comment ? commentMark() : null}</span>
      ${single
        ? html` <${RepNode} fen=${r.fen} map=${map} color=${color} current=${current} onPick=${onPick} path=${p} depth=${depth + 1} seen=${next} />`
        : html`<div class="branch"><${RepNode} fen=${r.fen} map=${map} color=${color} current=${current} onPick=${onPick} path=${p} depth=${depth + 1} seen=${next} /></div>`}
    </span>`,
  )}`;
}

/** Focuses the field inside when it appears. */
function AutoFocus({ children }) {
  const ref = useRef();
  useEffect(() => ref.current?.querySelector('input')?.focus(), []);
  return html`<span class="grow" ref=${ref}>${children}</span>`;
}

/**
 * A group of the repertoire (or, id 0, the lines in no group): its name, numbers and buttons — its own drill, renaming,
 * deleting —, and unfolded its lines from the initial position.
 */
function RepFolder({ folder: f, color, open, current, busy, renaming, onToggle, onPick, onDrill, onRename, onRenamed, onDelete }) {
  const done = e => {
    e.preventDefault();
    onRenamed();
  };
  return html`<div class=${cls('rep-group', !f.id && 'other')}>
    <div class="rep-group-head">
      ${renaming !== null
        ? html`<form class="rep-rename" onSubmit=${done}>
            <${AutoFocus}><input type="text" maxlength="60" value=${renaming} onInput=${e => onRename(e.currentTarget.value)} onKeyDown=${e => e.key === 'Escape' && onRename(null)} onBlur=${done} /><//>
          </form>`
        : html`<button class="rep-group-name" title=${open ? 'Fold its lines up' : 'Show its lines'} onClick=${onToggle}>
            <span class="chev">${open ? '▾' : '▸'}</span><span class="ellipsis">${f.name}</span>
          </button>`}
      <span class="rep-group-count" title=${`${f.studentMoves} of them yours`}>${f.moves} move${f.moves === 1 ? '' : 's'}${f.due ? ` · ${f.due} due` : ''}</span>
      <span class="spacer"></span>
      <button class="btn small ghost" disabled=${busy || !f.studentMoves} title=${`Drill only ${f.id ? `the lines of ${f.name}` : 'the lines in no group'}`} onClick=${onDrill}>Drill</button>
      ${onRename && renaming === null && html`<button class="btn small ghost tool" title="Rename the group" onClick=${() => onRename(f.name)}>✎</button>`}
      ${onDelete && html`<button class="btn small ghost tool" title="Delete the group" onClick=${onDelete}>✕</button>`}
    </div>
    ${open &&
    (f.entries.length
      ? html`<div class="rep-tree"><${RepNode} fen=${INITIAL_FEN} map=${byKey(f.entries)} color=${color} current=${current} onPick=${onPick} path=${[]} depth=${0} /></div>`
      : html`<div class="rep-group-empty">No lines yet: choose <b>${f.name}</b> next to <b>Add current line</b> and add lines from the board, or import a PGN into it.</div>`)}
  </div>`;
}

/** Deleting a group: with its lines, or keeping them in the repertoire. */
function DeleteGroup({ group: g, onClose, onDelete }) {
  return html`<div class="modal-backdrop" onClick=${onClose}><div class="modal" onClick=${e => e.stopPropagation()}>
    <h2>Delete the group ${g.name}?</h2>
    <p>It has ${g.moves} move${g.moves === 1 ? '' : 's'}. You can delete its lines with it — moves that your other lines need stay — or keep them in your repertoire, outside any group.</p>
    <div class="actions">
      <button class="btn ghost" onClick=${onClose}>Cancel</button>
      <button class="btn" onClick=${() => onDelete(true)}>Keep its lines</button>
      <button class="btn danger" onClick=${() => onDelete(false)}>Delete it and its lines</button>
    </div>
  </div></div>`;
}

/** A PGN into the repertoire: all its variations, its comments as the moves' notes, into a group if the student wants. */
function ImportRep({ color, groups, target, onClose, onDone }) {
  const [text, setText] = useState('');
  const [into, setInto] = useState(target ? String(target.id) : '0'); // a group's id, '0' (none) or 'new'
  const [name, setName] = useState('');
  const suggested = nameFromPgn(text);
  const go = async () => {
    try {
      const r = await post('/api/repertoire/import', { color, pgn: text, ...(into === 'new' ? { groupName: name.trim() || suggested } : { group: Number(into) || undefined }) });
      toast(`Imported ${r.added} new moves into your ${color} repertoire${r.group ? `, in ${r.group.name}` : ''}.`, 'success');
      onDone(r.group);
      onClose();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const open = async e => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (file) setText(await file.text());
  };
  return html`<div class="modal-backdrop" onClick=${onClose}><div class="modal" onClick=${e => e.stopPropagation()}>
    <h2>Import a PGN into your ${color} repertoire</h2>
    <p class="muted">All variations are imported. Comments become notes on the moves: you read them under the moves as you go through a line.</p>
    <textarea rows="11" style="width:100%" value=${text} onInput=${e => setText(e.currentTarget.value)} placeholder="1. e4 e5 2. Nf3 (2. Bc4) Nc6 3. Bb5 …"></textarea>
    <div class="row wrap" style="margin-top:10px">
      <label class="btn small">Open a PGN file…<input type="file" accept=".pgn,.txt" hidden onChange=${open} /></label>
      <span class="spacer"></span>
      <label class="rep-target"><span class="muted">into</span>
        <select value=${into} onChange=${e => setInto(e.currentTarget.value)}>
          <option value="0">no group</option>
          ${groups.map(g => html`<option value=${String(g.id)}>${g.name}</option>`)}
          <option value="new">a new group…</option>
        </select></label>
      ${into === 'new' && html`<input type="text" maxlength="60" placeholder=${suggested || "The group's name, e.g. French"} value=${name} onInput=${e => setName(e.currentTarget.value)} />`}
    </div>
    <div class="actions">
      <button class="btn ghost" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${!text.trim() || (into === 'new' && !(name.trim() || suggested))} onClick=${go}>Import</button>
    </div>
  </div></div>`;
}
