// Board: the analysis board (engine, move judgements, explorer, game review), training games against Stockfish,
// and the coach.
import { html, useEffect, useState } from '../../vendor/preact.js';
import { api, get, post, qs } from '../api.js';
import { state, toast, useStore, coachReady } from '../store.js';
import { BoardCtrl, useCtrl, useBoardKeys, useMedia, useForce } from '../ctrl.js';
import { Tree, placeCoachPosition } from '../tree.js';
import { engine, useLiveEval } from '../engine.js';
import { Board, glyphShape } from '../components/Board.js';
import { EvalBar } from '../components/EvalBar.js';
import { MoveList } from '../components/MoveList.js';
import { EnginePanel } from '../components/EnginePanel.js';
import { Explorer } from '../components/Explorer.js';
import { useCoachHandle } from '../components/coachHandle.js';
import { CoachPanel } from '../components/CoachPanel.js';
import { useCoachScreen, takePendingUi } from '../coachTerm.js';
import { EvalGraph } from '../components/EvalGraph.js';
import { repKey, tryPos, fenOf, posFromFen, turnOf, gameOver, INITIAL_FEN } from '../chess.js';
import { cls, stored, store, formatScore, JUDGEMENT_LABEL, download, formatDate, resultFor } from '../util.js';
import { navigate, clearParams } from '../router.js';
import { sound, moveSound } from '../sound.js';
import { openingsCtrl } from './Openings.js';
import { gigabase } from '../gigabase.js';

const ctrl = new BoardCtrl();
const ui = {
  gameId: null,
  game: null,
  engineOn: stored('analysis.engine', true),
  multipv: stored('analysis.multipv', 3),
  tab: stored('analysis.tab', 'moves'),
  compactTab: 'coach',
  question: null,
  caption: null,
  coachShapes: null,
  coachKey: stored('analysis.coachKey', 'analysis.free'),
  stashes: [], // what the board showed before, newest last ("↩ Back to …"): a game, your analysis, a paused training game
  judging: new Set(),
  loadedParams: null,
  // The training game against Stockfish, while one is on the board:
  // { color, level, levelLabel, coachMode, tree, tip (the game's latest move), result, thinking, stopped }
  play: null,
  coach: null, // the handle of the board's coach panel
};
let levels = null; // Stockfish strengths for training games (from the server)

const BAD = ['inaccuracy', 'mistake', 'blunder'];

export function attachAnalysis(tree, game) {
  const main = tree.mainline();
  const a = game.analysis;
  for (let i = 1; i < main.length; i++) {
    const node = main[i];
    if (node.clock === null && game.clocks?.[i - 1] !== undefined) node.clock = game.clocks[i - 1];
    const m = a?.moves?.[i - 1];
    if (!m || m.uci !== node.uci) continue;
    node.score = m.score;
    node.judge = {
      classification: m.judgement || null,
      best: m.bestSan ? { san: m.bestSan, line: m.bestLine } : null,
      scoreAfter: m.score,
      fromGame: true,
      motifs: m.motifs,
      reply: m.reply,
    };
  }
}

export function treeFromGame(game) {
  let tree;
  try {
    tree = Tree.fromPgn(game.pgn).tree;
    const main = tree.mainline();
    if (main.length - 1 !== game.moves.length) throw new Error('mismatch');
  } catch {
    tree = Tree.fromMoves(game.start_fen || INITIAL_FEN, game.moves);
  }
  attachAnalysis(tree, game);
  return tree;
}

/** Forgets what the coach drew, captioned or asked about the previous position. */
function resetOverlays() {
  ui.question = null;
  ui.caption = null;
  ui.coachShapes = null;
}

/** Keeps what is on the board now, so the student can come back to it ("↩ Back to …"). */
function pushStash(label) {
  ui.stashes.push({ label, tree: ctrl.tree, node: ctrl.node, game: ui.game, gameId: ui.gameId, play: ui.play, orientation: ctrl.orientation });
  if (ui.stashes.length > 4) ui.stashes.shift();
}

/** The student opens something else on the board: a training game in progress is kept to go back to. */
function leaveBoard() {
  if (ui.play && !ui.play.result) pushStash('your game');
  else ui.stashes = [];
  ui.play = null;
}

/** prepare: runs once the game is fetched, before it replaces the board (null when the same game is reloaded). */
async function loadGame(id, ply, prepare = leaveBoard) {
  const game = await get(`/api/games/${id}`);
  prepare?.();
  const tree = treeFromGame(game);
  ui.game = game;
  ui.gameId = game.id;
  resetOverlays();
  const names = (state.settings?.profile?.usernames || []).map(s => s.toLowerCase());
  ctrl.orientation = names.includes(String(game.black).toLowerCase()) ? 'black' : 'white';
  const main = tree.mainline();
  ctrl.setTree(tree, main[Math.min(Number(ply) || 0, main.length - 1)]);
  setCoachKey(`analysis.game.${game.id}`);
}

/** A game of the student's game database (Scid 5), opened at the position `fen` when it passes there. */
async function loadDatabaseGame(id, fen) {
  const g = await gigabase('game', { id: Number(id) });
  const { tree } = Tree.fromPgn(g.pgn);
  leaveBoard();
  ui.game = { dbGame: g.id, database: g.database, white: g.white, black: g.black, white_elo: g.whiteElo, black_elo: g.blackElo, result: g.result, date: g.date, event: g.event, site: g.site, round: g.round, eco: g.eco, pgn: g.pgn };
  ui.gameId = null;
  resetOverlays();
  ctrl.orientation = 'white';
  ctrl.setTree(tree, (fen && tree.findByFen(fen)) || tree.root);
  setCoachKey(`analysis.dbgame.${g.id}`);
}

function setCoachKey(key) {
  ui.coachKey = key;
  store('analysis.coachKey', key);
}

function loadTree(tree, node, orientation) {
  leaveBoard();
  ui.game = null;
  ui.gameId = null;
  resetOverlays();
  if (orientation) ctrl.orientation = orientation;
  ctrl.setTree(tree, node || tree.mainline().at(-1));
  setCoachKey(`analysis.free.${Date.now()}`);
}

function newBoard(fen = INITIAL_FEN) {
  leaveBoard();
  ui.game = null;
  ui.gameId = null;
  resetOverlays();
  ctrl.setTree(new Tree(fen));
  setCoachKey(`analysis.free.${Date.now()}`);
}

export function openFenInAnalysis(fen) {
  navigate(`#/analysis?fen=${encodeURIComponent(fen)}`);
}

function restoreStash() {
  const st = ui.stashes.pop();
  if (!st) return;
  if (ui.play && !ui.play.result) pushStash('your game'); // swap: the running game stays one click away
  ui.game = st.game;
  ui.gameId = st.gameId;
  ui.play = st.play || null;
  resetOverlays();
  if (st.orientation) ctrl.orientation = st.orientation;
  ctrl.setTree(st.tree, st.play ? st.play.tip : st.node);
  const p = ui.play;
  if (p && !p.result && !p.thinking && turnOf(p.tip.fen) !== p.color) setTimeout(() => engineMove(p), 300);
}

function contextFor(node, coach) {
  const live = engine.data && engine.data.fen === node.fen ? engine.data : null;
  return {
    mode: 'analysis',
    startFen: ctrl.tree.isStandardStart ? undefined : ctrl.tree.startFen,
    ucis: ctrl.tree.ucis(node),
    gameId: ui.gameId || undefined,
    note: ui.game?.dbGame !== undefined ? `On the board: game #${ui.game.dbGame} of the student's game database (${ui.game.database}), ${ui.game.white} – ${ui.game.black} ${ui.game.result}${ui.game.event ? `, ${ui.game.event}` : ''} (get_database_game reads it).` : undefined,
    engine: live?.lines?.length ? { depth: live.depth, lines: live.lines.map(l => ({ score: l.score, pv: (l.pv || []).slice(0, 12) })) } : undefined,
    lastMove: node.judge ? { san: node.san, classification: node.judge.classification, best: node.judge.best, scoreAfter: node.judge.scoreAfter } : undefined,
    lastComment: coach?.lastNote?.() || undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Training games against Stockfish

/** What the coach sees during a training game (no engine lines: the student is playing). */
function playContext(node, p) {
  return {
    mode: 'play',
    startFen: p.tree.isStandardStart ? undefined : p.tree.startFen,
    ucis: p.tree.ucis(node),
    play: { level: p.levelLabel, color: p.color },
    lastMove: node.judge ? { san: node.san, classification: node.judge.classification, best: node.judge.best, scoreAfter: node.judge.scoreAfter } : undefined,
    note: p.result
      ? `The training game is over: ${p.result.result} (${p.result.reason}).`
      : node !== p.tip
        ? 'The student is looking back at an earlier position of the game; the game itself continues from its latest move.'
        : undefined,
  };
}

const studentToMove = p => !!p && !p.result && !p.thinking && turnOf(p.tip.fen) === p.color;
const canTakeBack = p => !!p && !p.thinking && p.tree.path(p.tip).some(n => n.color === p.color);

function startGame({ color, level, levelLabel, coachMode, fen }) {
  if (!ui.play && (ui.gameId || ctrl.tree.root.children.length)) pushStash(ui.gameId ? 'the game' : 'your analysis');
  if (ui.play) ui.play.stopped = true; // a new game replaces the one on the board
  const tree = new Tree(fen);
  const p = { color, level, levelLabel, coachMode, tree, tip: tree.root, result: null, thinking: false, stopped: false };
  ui.play = p;
  ui.game = null;
  ui.gameId = null;
  resetOverlays();
  ctrl.orientation = color;
  ctrl.setTree(tree);
  setCoachKey(`analysis.play.${Date.now()}`);
  ui.coach?.newThread?.();
  if (!checkEnd(p) && turnOf(fen) !== color) setTimeout(() => engineMove(p), 400);
}

async function engineMove(p) {
  if (!p || p.result || p.stopped || p.thinking) return;
  p.thinking = true;
  ctrl.emit();
  const from = p.tip;
  try {
    const r = await post('/api/engine/play', { fen: from.fen, level: p.level });
    if (p.result || p.stopped || p.tip !== from || !r.uci) return;
    const added = p.tree.addMove(from, r.uci);
    if (!added) return;
    p.tip = added.node;
    if (ui.play === p && ctrl.node === from) ctrl.goto(added.node, { sound: true }); // the student follows the game
    else if (ui.play === p) moveSound(added.node);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    p.thinking = false;
    ctrl.emit();
  }
  checkEnd(p);
}

/** The student's move in the training game. */
function playGameMove(uci) {
  const p = ui.play;
  if (!studentToMove(p) || ctrl.node !== p.tip) return;
  const r = ctrl.play(uci);
  if (!r) return;
  p.tip = r.node;
  judgeGameMove(p, r.node);
  if (!checkEnd(p)) setTimeout(() => engineMove(p), 250);
}

async function judgeGameMove(p, node) {
  try {
    const m = await post('/api/engine/move', { fen: node.parent.fen, uci: node.uci, depth: 14 });
    node.judge = m;
    ctrl.emit();
    if (ui.play === p && coachReady() && (p.coachMode === 'all' || (p.coachMode === 'mistakes' && BAD.includes(m.classification))))
      ui.coach?.note?.({ moveEval: m, context: playContext(node, p), mode: 'play', title: node.label });
  } catch {
    /* the judgement is optional */
  }
}

function checkEnd(p) {
  if (!p || p.result) return !!p?.result;
  let over = gameOver(posFromFen(p.tip.fen));
  if (!over) {
    const k = repKey(p.tip.fen);
    if (p.tree.path(p.tip).filter(n => repKey(n.fen) === k).length >= 3) over = { result: '1/2-1/2', reason: 'threefold repetition' };
  }
  if (over) endGame(p, over);
  return !!over;
}

function endGame(p, over) {
  p.result = over;
  const won = (over.result === '1-0' && p.color === 'white') || (over.result === '0-1' && p.color === 'black');
  sound(over.result === '1/2-1/2' ? 'Draw' : won ? 'Victory' : 'Defeat');
  ctrl.emit();
  if (coachReady() && p.coachMode !== 'off')
    ui.coach?.send?.('The game is over.', { task: 'gameEnd', taskArgs: { result: `${over.result}, ${over.reason}` }, label: `Game over: ${over.result} (${over.reason})` });
}

/** Takes back the student's last move (and the engine's reply to it). */
function takeback() {
  const p = ui.play;
  if (!canTakeBack(p)) return;
  let n = p.tip;
  while (n.parent) {
    const parent = n.parent;
    const mine = n.color === p.color;
    p.tree.remove(n);
    n = parent;
    if (mine) break;
  }
  p.tip = n;
  p.result = null;
  resetOverlays();
  ctrl.goto(n);
  ctrl.emit();
}

function resign() {
  const p = ui.play;
  if (p && !p.result) endGame(p, { result: p.color === 'white' ? '0-1' : '1-0', reason: 'resignation' });
}

/** Leaves the training game; its moves stay on the board for analysis. */
function closeGame({ ask = true, engineOn = false } = {}) {
  const p = ui.play;
  if (!p) return;
  if (ask && !p.result && !confirm('Stop this training game? Its moves stay on the board so you can analyse them.')) return;
  p.stopped = true;
  ui.play = null;
  if (engineOn && !ui.engineOn) {
    ui.engineOn = true;
    store('analysis.engine', true);
  }
  ctrl.emit();
}

// ---------------------------------------------------------------------------------------------

export function Analysis({ route }) {
  useCtrl(ctrl);
  const s = useStore();
  const rerender = useForce();
  const coach = useCoachHandle();
  ui.coach = coach;
  const node = ctrl.node;
  const p = ui.play;
  const live = useLiveEval(ui.engineOn && !p ? node.fen : '__off__');
  const compact = useMedia('(max-width: 1280px)');
  const [modal, setModal] = useState(null);

  useEffect(() => {
    const prm = route.params;
    const key = JSON.stringify(prm);
    if (key === ui.loadedParams) return;
    ui.loadedParams = key;
    if (prm.game) loadGame(prm.game, prm.ply).catch(e => toast(e.message, 'error'));
    else if (prm.dbgame !== undefined) loadDatabaseGame(prm.dbgame, prm.fen).catch(e => toast(`The game could not be opened: ${e.message}`, 'error'));
    else if (prm.fen) {
      const pos = tryPos(prm.fen);
      if (!pos) toast('Invalid position', 'error');
      else {
        const found = ui.play ? null : ctrl.tree.findByFen(fenOf(pos));
        if (found) ctrl.goto(found);
        else newBoard(fenOf(pos));
      }
    }
  }, [route.params]);

  // the coach switched to the board and chose one of its tabs (switch_screen)
  useEffect(() => {
    const t = route.params.tab;
    if (!['moves', 'explorer', 'game'].includes(t)) return;
    clearParams();
    ui.tab = t;
    store('analysis.tab', t);
    rerender();
  }, [route]);

  // #/play (the former Play page) opens the new-game dialog
  useEffect(() => {
    if (route.view !== 'play') return;
    history.replaceState(null, '', '#/analysis');
    setModal('play');
  }, [route]);

  useEffect(() => {
    if (ui.engineOn && !ui.play) engine.analyze(node.fen, ui.multipv);
    else engine.stop();
  }, [node.fen, ui.engineOn, ui.multipv, !!p]);
  useEffect(
    () => () => {
      engine.stop();
      ui.loadedParams = null; // a link to the same game/move must work again after leaving the board
    },
    [],
  );

  // What the terminal coach sees (get_board_state) and what it can do here (set_board, open_game).
  useCoachScreen(
    () => (ui.play ? 'play' : 'analysis'),
    () =>
      ui.play
        ? playContext(ctrl.node, ui.play)
        : { ...contextFor(ctrl.node, coach), question: ui.question && repKey(ui.question.fen) === repKey(ctrl.node.fen) ? true : undefined },
    ev => {
      if (ev.action === 'set_board') onUi(ev);
      else if (ev.action === 'open_game') {
        if (ui.play && !ui.play.result && !confirm('Your coach wants to open one of your games. Pause your training game? You can go back to it afterwards.')) return true;
        loadGame(ev.gameId, ev.ply, () => {
          if (ui.play && !ui.play.result) pushStash('your game');
          ui.play = null;
        }).catch(e => toast(e.message, 'error'));
      } else return false;
      return true;
    },
  );
  useEffect(() => {
    const ev = takePendingUi(); // shown by the coach while another screen was open
    if (ev) onUi(ev);
  }, []);

  useEffect(() => {
    const onAnalyzed = e => {
      if (e.detail === ui.gameId) {
        const ply = ctrl.node.ply;
        loadGame(ui.gameId, ply, null).then(() => toast('Engine analysis is ready', 'success'));
      }
    };
    window.addEventListener('cc:game-analyzed', onAnalyzed);
    return () => window.removeEventListener('cc:game-analyzed', onAnalyzed);
  }, []);

  useBoardKeys(ctrl, e => {
    if (e.key === ' ' && !ui.play) {
      toggleEngine();
      return true;
    }
  });

  function toggleEngine() {
    ui.engineOn = !ui.engineOn;
    store('analysis.engine', ui.engineOn);
    rerender();
  }

  async function judge(parent, child) {
    if (ui.judging.has(child.id)) return;
    ui.judging.add(child.id);
    try {
      const m = await post('/api/engine/move', { fen: parent.fen, uci: child.uci, depth: 16 });
      child.judge = m;
      rerender();
      const mode = state.settings?.autoComment || 'off';
      if (coachReady() && (mode === 'all' || (mode === 'mistakes' && BAD.includes(m.classification))) && ctrl.node === child)
        coach.note?.({ moveEval: m, context: contextFor(child, coach), mode: 'analysis', title: child.label });
    } catch (e) {
      toast(`Move check failed: ${e.message}`, 'error');
    } finally {
      ui.judging.delete(child.id);
      rerender();
    }
  }

  function onMove(uci) {
    const parent = ctrl.node;
    const r = ctrl.play(uci);
    if (!r) return;
    if (ui.question && repKey(ui.question.fen) === repKey(parent.fen)) {
      ui.question = null;
      coach.send?.(`My answer: ${r.node.label}`, { label: `My answer: ${r.node.label}` });
      return;
    }
    if (!r.node.judge) judge(parent, r.node);
  }

  /** The coach shows a position (set_board). During a training game it draws on the game, or pauses the game. */
  function onUi(ev) {
    if (ev.action !== 'set_board') return;
    const g0 = ui.play;
    if (g0 && !g0.result) {
      if (repKey(ev.fen) === repKey(ctrl.node.fen) && !ev.line?.length) {
        ui.coachShapes = ev.shapes?.length ? { fen: ev.fen, shapes: ev.shapes } : null;
        ui.caption = ev.caption ? { fen: ev.fen, text: ev.caption } : null;
        ctrl.emit();
        return;
      }
      if (!confirm(`Your coach wants to show you ${ev.caption ? `“${ev.caption}”` : 'another position'}. Pause your game to look at it? You can go back to the game afterwards.`)) return;
      pushStash('your game');
      ui.play = null;
      ui.game = null;
      ui.gameId = null;
      const { tree, node } = placeCoachPosition(new Tree(), ev); // (the paused game's own tree stays as it is)
      ctrl.setTree(tree, node);
      showCoachPosition(ev, node);
      return;
    }
    if (g0) {
      // a finished game: the coach reviews it, so the board becomes the analysis board
      g0.stopped = true;
      ui.play = null;
    }
    // a position a move or two after the one on the board becomes a variation there; another one gets a board of its
    // own (with the moves that lead to it, when they are known)
    const { tree, node: target } = placeCoachPosition(ctrl.tree, ev);
    if (tree !== ctrl.tree) {
      if (ui.gameId) pushStash('the game');
      ui.game = null;
      ui.gameId = null;
      ctrl.setTree(tree, target);
    }
    showCoachPosition(ev, target);
  }

  function showCoachPosition(ev, target) {
    if (ev.line?.length) ctrl.tree.addLine(target, ev.line.map(m => m.uci));
    if (ev.orientation) ctrl.orientation = ev.orientation;
    ui.coachShapes = ev.shapes?.length ? { fen: ev.fen, shapes: ev.shapes } : null;
    ui.caption = ev.caption ? { fen: ev.fen, text: ev.caption } : null;
    ui.question = ev.askMove ? { fen: ev.fen } : null;
    ctrl.goto(target);
    ctrl.emit();
  }

  function onPosition(d) {
    onUi({ action: 'set_board', fen: d.fen, shapes: d.shapes, caption: d.caption, orientation: d.orientation, line: [] });
  }

  const yourMove = studentToMove(p) && node === p.tip;
  const shapes = [];
  const best = live?.lines?.[0]?.pv?.[0];
  if (!p && ui.engineOn && best && s.settings?.board?.bestArrow !== false) shapes.push({ orig: best.slice(0, 2), dest: best.slice(2, 4), brush: 'paleBlue' });
  if (ui.coachShapes && repKey(ui.coachShapes.fen) === repKey(node.fen)) shapes.push(...ui.coachShapes.shapes);
  if (node.judge?.classification && node.uci && (!p || node.color === p.color)) shapes.push(glyphShape(node.uci.slice(2, 4), node.judge.classification));
  const caption = ui.caption && repKey(ui.caption.fen) === repKey(node.fen) ? ui.caption.text : null;
  const asking = !p && ui.question && repKey(ui.question.fen) === repKey(node.fen);
  const scoreForBar = live?.lines?.[0]?.score || node.score || node.judge?.scoreAfter || null;
  const banner = p
    ? !p.result && node !== p.tip
      ? 'An earlier position — ⏭ takes you back to the game'
      : p.thinking
        ? 'Stockfish is thinking…'
        : null
    : asking
      ? 'Your turn — play your answer on the board'
      : null;
  const g = ui.game;
  const back = ui.stashes.at(-1);

  const quick = p
    ? [
        yourMove ? { label: 'Hint', task: 'hint' } : null,
        { label: 'What is my plan?', task: 'plan' },
        { label: 'Threats?', task: 'threats' },
        p.result ? { label: 'Review my game', task: 'gameEnd', taskArgs: () => ({ result: `${p.result.result}, ${p.result.reason}` }) } : null,
      ].filter(Boolean)
    : [
        { label: 'Explain position', task: 'explain' },
        { label: 'Best plan?', task: 'plan' },
        node.uci ? { label: 'Judge last move', task: 'lastMove' } : null,
        { label: 'Threats?', task: 'threats' },
        { label: 'Quiz me', task: 'quiz' },
        { label: 'Hint', task: 'hint' },
        g?.analysis ? { label: 'Review this game', task: 'review' } : null,
      ].filter(Boolean);

  const coachPanel = html`<${CoachPanel}
    key=${ui.coachKey}
    handle=${coach}
    kind="chat"
    storageKey=${ui.coachKey}
    title="Coach"
    quick=${quick}
    getContext=${() => (ui.play ? playContext(ctrl.node, ui.play) : contextFor(ctrl.node, coach))}
    onUi=${onUi}
    onPosition=${onPosition}
    threadTitle=${() => (g ? `${g.white} – ${g.black}` : p ? 'Training game' : 'Analysis')}
    intro=${html`<div class="coach-empty">
      <h3>Ask your coach about this position</h3>
      <p>Every answer is checked against Stockfish running on your computer. Try:</p>
      <ul><li>“Why is this move bad?”</li><li>“What should White aim for here?”</li><li>“Show me the key idea with a diagram.”</li></ul>
      <p class="muted">Play moves on the board — each one is judged instantly${s.settings?.autoComment !== 'off' ? ', and the coach comments on mistakes' : ''}.</p>
    </div>`}
  />`;

  const enginePanel = html`<${EnginePanel}
    fen=${node.fen}
    data=${live}
    enabled=${ui.engineOn}
    onToggle=${toggleEngine}
    multipv=${ui.multipv}
    onMultipv=${n => {
      ui.multipv = n;
      store('analysis.multipv', n);
      rerender();
    }}
    onPlay=${onMove}
  />`;

  const moves = html`<${MoveList} tree=${ctrl.tree} current=${node} onSelect=${n => ctrl.goto(n)} result=${p ? p.result?.result : g?.result} />`;
  const explorer = html`<${Explorer} fen=${node.fen} line=${ctrl.tree.isStandardStart ? ctrl.tree.ucis(node) : null} onPlay=${onMove} />`;
  const gameTab = html`<${GameTab} game=${g} node=${node} coach=${coach} />`;
  const tabs = [
    ['moves', 'Moves'],
    ['explorer', 'Explorer'],
    ['game', g ? 'Game' : 'Game info'],
  ];
  const setTab = t => {
    ui.tab = t;
    store('analysis.tab', t);
    rerender();
  };
  const compactTabs = p
    ? [['coach', 'Coach'], ['moves', 'Moves']]
    : [['coach', 'Coach'], ['moves', 'Moves'], ['engine', 'Engine'], ['explorer', 'Explorer'], ['game', 'Game']];
  const compactTab = compactTabs.some(([id]) => id === ui.compactTab) ? ui.compactTab : 'coach';

  return html`
    <div class="workspace">
      <div class="board-col">
        <div class="board-area">
          ${!p && s.settings?.board?.evalBar !== false && html`<${EvalBar} score=${ui.engineOn || node.score ? scoreForBar : null} orientation=${ctrl.orientation} />`}
          <${Board}
            fen=${node.fen}
            orientation=${ctrl.orientation}
            lastMove=${ctrl.lastMove}
            movable=${p ? (yourMove ? p.color : false) : 'both'}
            onMove=${p ? playGameMove : onMove}
            shapes=${shapes}
            banner=${banner}
          />
        </div>
        ${caption && html`<div class="board-caption">${caption}</div>`}
        <div class="board-controls">
          <button class="btn icon" title="First (↑)" onClick=${() => ctrl.first()}>⏮</button>
          <button class="btn icon" title="Back (←)" onClick=${() => ctrl.prev()}>◀</button>
          <button class="btn icon" title="Forward (→)" onClick=${() => ctrl.next()}>▶</button>
          <button class="btn icon" title="Last (↓)" onClick=${() => ctrl.last()}>⏭</button>
          <button class="btn icon" title="Flip board (f)" onClick=${() => ctrl.flip()}>⇅</button>
          ${back && html`<button class="btn small blue" onClick=${restoreStash}>↩ Back to ${back.label}</button>`}
          ${p
            ? html`<button class="btn small" disabled=${!yourMove || !coachReady()} onClick=${() => coach.send?.('Give me a hint.', { task: 'hint', label: 'Hint, please.' })}>💡 Hint</button>
                <button class="btn small" disabled=${!canTakeBack(p)} onClick=${takeback}>↶ Takeback</button>
                <button class="btn small" disabled=${!!p.result} onClick=${resign}>Resign</button>
                <span class="spacer"></span>
                <button class="btn small" onClick=${() => setModal('play')}>New game</button>
                <button class="btn small ghost" title="Leave the game; its moves stay on the board" onClick=${() => closeGame({ ask: !p.result })}>${p.result ? 'Close' : 'Stop'}</button>`
            : html`<span class="spacer"></span>
                <button class="btn small blue" title="Play a training game against Stockfish" onClick=${() => setModal('play')}>♟ Play vs Stockfish</button>
                <button class="btn small" onClick=${() => setModal('load')}>Load PGN / FEN</button>
                <button class="btn small" title="Download the current tree as PGN" onClick=${() =>
                  download(`${g ? `${g.white}-${g.black}` : 'analysis'}.pgn`, ctrl.tree.toPgn(g ? { White: g.white, Black: g.black, Result: g.result, Date: g.date || '????.??.??', Event: g.event || '?' } : {}))}>Save PGN</button>
                <button class="btn small ghost" title="New empty board" onClick=${() => newBoard()}>New</button>`}
        </div>
        ${p ? html`<${GameStatus} p=${p} node=${node} onAnalyse=${() => closeGame({ ask: false, engineOn: true })} onNew=${() => setModal('play')} />` : html`<${MoveVerdict} node=${node} />`}
      </div>
      ${!compact &&
      html`<div class="side-col middle">
        ${p
          ? html`<div class="panel grow">
              <div class="panel-head"><span class="title">Training game</span><span class="spacer"></span><span class="muted ellipsis" style="font-size:12px">vs ${p.levelLabel} · you play ${p.color}</span></div>
              <div class="panel-body">${moves}</div>
            </div>`
          : html`<div class="panel" style="flex:none">${enginePanel}</div>
            <div class="panel grow">
              <div class="panel-head"><div class="tabs">${tabs.map(([id, label]) => html`<button class=${cls('tab', ui.tab === id && 'active')} onClick=${() => setTab(id)}>${label}</button>`)}</div></div>
              <div class="panel-body">${ui.tab === 'moves' ? moves : ui.tab === 'explorer' ? explorer : gameTab}</div>
            </div>`}
      </div>`}
      <div class="side-col">
        ${compact &&
        html`<div class="panel" style="flex:none"><div class="panel-head"><div class="tabs">
          ${compactTabs.map(([id, label]) => html`<button class=${cls('tab', compactTab === id && 'active')} onClick=${() => ((ui.compactTab = id), rerender())}>${label}</button>`)}
        </div></div></div>`}
        ${!compact || compactTab === 'coach'
          ? html`<div class="grow" style="min-height:0">${coachPanel}</div>`
          : html`<div class="panel grow"><div class="panel-body">${compactTab === 'moves' ? moves : compactTab === 'engine' ? enginePanel : compactTab === 'explorer' ? explorer : gameTab}</div></div>`}
      </div>
      ${modal === 'load' && html`<${LoadModal} onClose=${() => setModal(null)} onLoadTree=${loadTree} />`}
      ${modal === 'play' && html`<${PlayModal} onClose=${() => setModal(null)} onStart=${startGame} />`}
    </div>
  `;
}

function MoveVerdict({ node }) {
  const j = node.judge;
  if (!node.uci) return null;
  if (!j) return ui.judging.has(node.id) ? html`<div class="judgement"><span class="spinner"></span><span class="muted">Checking ${node.label}…</span></div>` : null;
  const c = j.classification || 'good';
  const label = JUDGEMENT_LABEL[c] || 'Good';
  const bestText = j.best && j.best.san && j.best.san !== node.san && BAD.includes(c) ? html` · better was <b>${j.best.san}</b>` : null;
  const ev = j.scoreAfter ? html` <span class="muted">(${formatScore(j.scoreAfter)})</span>` : null;
  return html`<div class=${cls('judgement', c)} title=${j.best?.line || ''}>
    <span class="tag">${label}</span><span>${node.label}${ev}${bestText}</span>
    ${j.motifs?.length && !j.motifs.includes('positional') ? html`<span class="muted" style="margin-left:auto">${j.motifs.map(m => m.replace(/_/g, ' ')).join(', ')}</span>` : null}
  </div>`;
}

/** Under the board during a training game: the verdict on the student's last move, or the result. */
function GameStatus({ p, node, onAnalyse, onNew }) {
  if (p.result) {
    const r = p.result.result;
    const won = (r === '1-0' && p.color === 'white') || (r === '0-1' && p.color === 'black');
    return html`<div class="game-result">
      <span class="r">${r === '1/2-1/2' ? 'Draw' : won ? 'You won!' : 'You lost'}</span>
      <span class="muted ellipsis">${r} · ${p.result.reason} · vs ${p.levelLabel}</span>
      <span class="spacer"></span>
      <button class="btn small primary" onClick=${onAnalyse}>Analyse this game</button>
      <button class="btn small" onClick=${onNew}>New game</button>
    </div>`;
  }
  const last = node.color === p.color ? node : node.parent?.color === p.color ? node.parent : null;
  const j = last?.judge;
  if (!j)
    return html`<div class="judgement"><span class="muted">${p.tip.ply ? 'Your moves are judged by Stockfish as you play.' : `New game vs ${p.levelLabel} — you play ${p.color}.`}</span></div>`;
  const c = j.classification || 'good';
  return html`<div class=${cls('judgement', c)}><span class="tag">${JUDGEMENT_LABEL[c] || 'Good'}</span>
    <span>${last.label} <span class="muted">(${formatScore(j.scoreAfter)})</span>${BAD.includes(c) && j.best?.san && j.best.san !== last.san ? html` · better was <b>${j.best.san}</b>` : ''}</span></div>`;
}

function GameTab({ game, node, coach }) {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  if (!game)
    return html`<div class="empty"><p>No game loaded.</p><p>Open a game from <a href="#/games">your library</a>, paste a PGN with “Load PGN / FEN”, play a training game with “Play vs Stockfish”, or just play moves on the board.</p></div>`;
  if (game.dbGame !== undefined) return html`<${DatabaseGameTab} game=${game} node=${node} />`;
  const a = game.analysis;
  const job = s.jobs.find(j => j.status === 'running' && j.params?.gameIds?.includes(game.id));
  const analyse = async () => {
    setBusy(true);
    try {
      await post('/api/jobs/analyze', { gameIds: [game.id], preset: s.settings?.engine?.batchPreset });
      toast('Analysis started — it runs in the background.');
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  };
  const names = (s.settings?.profile?.usernames || []).map(x => x.toLowerCase());
  const me = names.includes(String(game.white).toLowerCase()) ? 'white' : names.includes(String(game.black).toLowerCase()) ? 'black' : null;
  return html`<div style="padding:10px 12px" class="col">
    <div>
      <div style="font-weight:600;color:var(--strong)">${game.white}${game.white_elo ? ` (${game.white_elo})` : ''} – ${game.black}${game.black_elo ? ` (${game.black_elo})` : ''}</div>
      <div class="muted">${game.result}${me ? ` · you ${resultFor(game.result, me) === 'win' ? 'won' : resultFor(game.result, me) === 'loss' ? 'lost' : 'drew'}` : ''} · ${formatDate(game.date)} ${game.time_control ? `· ${game.time_control}` : ''}</div>
      ${game.opening && html`<div class="muted">${game.eco} ${game.opening}</div>`}
    </div>
    ${a
      ? html`<div class="row wrap" style="gap:14px">
          ${['white', 'black'].map(
            c => html`<div><div class="muted" style="font-size:12px">${c === 'white' ? game.white : game.black}</div>
              <div><b style="color:var(--strong);font-size:18px">${a.summary[c].accuracy ?? '–'}%</b> <small class="muted">accuracy · ACPL ${a.summary[c].acpl}</small></div>
              <small><span class="glyph inaccuracy">?!</span> ${a.summary[c].inaccuracies} · <span class="glyph mistake">?</span> ${a.summary[c].mistakes} · <span class="glyph blunder">??</span> ${a.summary[c].blunders}</small></div>`,
          )}
        </div>
        <div class="muted" style="font-size:12px">Winning chances (White's view) — click to jump</div>
        <${EvalGraph}
          winPercents=${a.winPercents}
          scores=${a.scores}
          moves=${a.moves}
          division=${a.division}
          current=${node.ply <= a.moves.length ? node.ply : null}
          onSelect=${ply => {
            const main = ctrl.tree.mainline();
            ctrl.goto(main[Math.min(ply, main.length - 1)]);
          }}
        />
        <div class="row wrap">
          <button class="btn small" onClick=${() => coach.send?.('Review this game with me.', { task: 'review', label: 'Review this game with me.' })}>Review with coach</button>
          <button class="btn small ghost" onClick=${analyse} disabled=${busy || !!job}>Re-analyse</button>
        </div>`
      : html`<div class="col">
          <p class="muted">This game has no engine analysis yet. Analysis adds accuracy, mistakes and the evaluation graph${me ? ', and feeds your reports' : ''}.</p>
          ${job
            ? html`<div class="row"><span class="spinner"></span> Analysing… ${job.progress?.positionsDone || 0}/${job.progress?.positionsTotal || '?'} positions</div>`
            : html`<button class="btn primary" onClick=${analyse} disabled=${busy}>Analyse with Stockfish</button>`}
        </div>`}
  </div>`;
}

/** A game of the game database: who played it, and saving it to the student's games (to analyse it, for example). */
function DatabaseGameTab({ game, node }) {
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/games/import${qs({ name: game.database || 'Game database' })}`, { method: 'POST', body: game.pgn, raw: true });
      const id = r.ids?.[0];
      if (!id) throw new Error(r.duplicates ? 'It is already in your games.' : 'It could not be imported.');
      toast('Saved to your games.', 'success');
      navigate(`#/analysis?game=${id}&ply=${node.ply}`);
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  };
  return html`<div style="padding:10px 12px" class="col">
    <div>
      <div style="font-weight:600;color:var(--strong)">${game.white}${game.white_elo ? ` (${game.white_elo})` : ''} – ${game.black}${game.black_elo ? ` (${game.black_elo})` : ''}</div>
      <div class="muted">${game.result} · ${String(game.date || '').replace(/\.\?\?/g, '')}${game.eco ? ` · ${game.eco}` : ''}</div>
      <div class="muted">${[game.event, game.site, game.round && game.round !== '?' ? `round ${game.round}` : ''].filter(Boolean).join(' · ')}</div>
    </div>
    <p class="muted">A game from your game database${game.database ? ` ${game.database}` : ''} (game #${game.dbGame}). Save it to your games to analyse it with Stockfish or keep it in your library.</p>
    <div class="row wrap"><button class="btn small primary" disabled=${busy} onClick=${save}>Save to my games</button></div>
  </div>`;
}

function LoadModal({ onClose, onLoadTree }) {
  const [text, setText] = useState('');
  const load = () => {
    const t = text.trim();
    if (!t) return;
    try {
      const pos = tryPos(t);
      if (pos) {
        onLoadTree(new Tree(fenOf(pos)));
      } else {
        const { tree } = Tree.fromPgn(t);
        onLoadTree(tree);
      }
      onClose();
    } catch (e) {
      toast(`Could not read that: ${e.message}`, 'error');
    }
  };
  return html`<div class="modal-backdrop" onClick=${onClose}>
    <div class="modal" onClick=${e => e.stopPropagation()}>
      <h2>Load a position or game</h2>
      <p class="muted">Paste a FEN or a PGN (the first game is loaded, with variations and comments). To analyse many games, use the <a href="#/games" onClick=${onClose}>Games</a> page.</p>
      <textarea rows="10" style="width:100%" value=${text} onInput=${e => setText(e.currentTarget.value)} placeholder="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1&#10;or&#10;1. e4 e5 2. Nf3 Nc6 …"></textarea>
      <div class="actions"><button class="btn ghost" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${load}>Load</button></div>
    </div>
  </div>`;
}

/** New training game: colour, Stockfish's strength, the coach's comments and the starting position. */
function PlayModal({ onClose, onStart }) {
  const [list, setList] = useState(levels);
  const [colorChoice, setColorChoice] = useState(() => stored('play.colorChoice', 'white'));
  const [level, setLevel] = useState(() => Number(stored('play.level', 5)));
  const [coachMode, setCoachMode] = useState(() => stored('play.coach', 'mistakes'));
  const [startPos, setStartPos] = useState(() => stored('play.start', 'initial'));
  const [fen, setFen] = useState('');
  useEffect(() => {
    if (!levels)
      get('/api/engine/levels')
        .then(l => {
          levels = l;
          setList(l);
        })
        .catch(e => toast(e.message, 'error'));
  }, []);

  const start = () => {
    let f = INITIAL_FEN;
    if (startPos === 'board') f = ctrl.node.fen;
    else if (startPos === 'openings') f = openingsCtrl.node.fen;
    else if (startPos === 'fen') {
      const pos = tryPos(fen.trim());
      if (!pos) return toast('That FEN is not a valid position.', 'error');
      f = fenOf(pos);
    }
    if (gameOver(posFromFen(f))) return toast('The game is already over in that position.', 'error');
    store('play.colorChoice', colorChoice);
    store('play.level', level);
    store('play.coach', coachMode);
    store('play.start', startPos);
    const color = colorChoice === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : colorChoice;
    const levelLabel = list?.find(l => l.id === level)?.label || `level ${level}`;
    onStart({ color, level, levelLabel, coachMode, fen: f });
    onClose();
  };

  return html`<div class="modal-backdrop" onClick=${onClose}>
    <div class="modal" onClick=${e => e.stopPropagation()}>
      <h2>Play a training game against Stockfish</h2>
      <div class="settings-grid">
        <label class="field"><span>Your colour</span>
          <select value=${colorChoice} onChange=${e => setColorChoice(e.currentTarget.value)}>
            <option value="white">White</option><option value="black">Black</option><option value="random">Random</option>
          </select></label>
        <label class="field"><span>Opponent strength</span>
          <select value=${level} onChange=${e => setLevel(Number(e.currentTarget.value))}>
            ${(list || []).map(l => html`<option value=${l.id}>${l.label}</option>`)}
          </select></label>
        <label class="field"><span>Coach comments</span>
          <select value=${coachMode} onChange=${e => setCoachMode(e.currentTarget.value)}>
            <option value="mistakes">On my mistakes</option><option value="all">On every move</option><option value="off">Off (review at the end)</option>
          </select></label>
        <label class="field"><span>Start from</span>
          <select value=${startPos} onChange=${e => setStartPos(e.currentTarget.value)}>
            <option value="initial">The initial position</option><option value="board">The position on the board now</option><option value="openings">The position on the Openings board</option><option value="fen">A FEN…</option>
          </select></label>
      </div>
      ${startPos === 'fen' && html`<input type="text" style="width:100%;margin-top:10px" placeholder="FEN" value=${fen} onInput=${e => setFen(e.currentTarget.value)} />`}
      <p class="muted" style="margin:12px 0 0">Every move you play is judged by Stockfish. The engine lines and the evaluation bar are hidden until the game ends${coachReady() ? '; your coach comments as you go' : ''}.</p>
      <div class="actions"><button class="btn ghost" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!list} onClick=${start}>Start game</button></div>
    </div>
  </div>`;
}

export { ctrl as analysisCtrl };
