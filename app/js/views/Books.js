// Book reader: chess books (PDF or EPUB) the student adds, read aloud with the app's voices. The page is on one side,
// the board on the other: the sentence being read and the moves are marked on the page, and the board plays each
// move as the reading gets to it, and shows each diagram's position — with Stockfish's evaluation, lines and best move
// (the Book reader's own switch). A click on the page reads from there (or shows a move or a diagram); the student may
// play moves of their own on the board, or go back and on through the board's moves (the reading pauses; going on, the
// book's next move brings its position back), and go to a page by its number; scanned books are read by OCR; the books
// stay on the student's computer (books/library.js).
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { toast, useStore } from '../store.js';
import { navigate } from '../router.js';
import { cls, stored, store } from '../util.js';
import { useForce } from '../ctrl.js';
import { Board } from '../components/Board.js';
import { BoardEditor } from '../components/BoardEditor.js';
import { MoveList } from '../components/MoveList.js';
import { EvalBar } from '../components/EvalBar.js';
import { EnginePanel } from '../components/EnginePanel.js';
import { engine, useLiveEval, engineSwitches, setEngineSwitch, useEngineSwitch } from '../engine.js';
import { moveSound } from '../sound.js';
import { readingEngine, warmReading, stopSpeaking } from '../voice.js';
import { useCoachScreen } from '../coachTerm.js';
import { Tree, placeCoachPosition } from '../tree.js';
import { INITIAL_FEN } from '../chess.js';
import { listBooks, addBook, removeBook, getBook, saveBook, coverUrl } from '../books/library.js';
import { openBook, Reading } from '../books/reader.js';
import { hiddenSquares } from '../books/moves.js';
import { PdfPage, EpubPage, ZOOM } from '../books/page.js';

const SPEEDS = [1, 1.25, 1.5, 2];

/** Whether move `a` is `b` or comes before it on its line. */
function leadsTo(a, b) {
  for (let n = b; n; n = n.parent) if (n === a) return true;
  return false;
}

/**
 * Where the board's line goes on from: the furthest move it was at on the line through `node` (a move the student went
 * back from, `view.end`, or the board's own), so that going on again goes the way it came — along a variation too.
 */
const endOf = (node, view) => [view?.end, view?.node].find(e => e && leadsTo(node, e)) || node;

/** The move after `node`: towards `end`, else its line's next move. */
function nextOf(node, end) {
  if (end === node || !leadsTo(node, end)) return node.children[0] || null;
  let n = end;
  while (n.parent !== node) n = n.parent;
  return n;
}

export function Books({ route }) {
  // (the coach does not talk in the Book reader: what it was saying stops — voice.js says nothing new here)
  useEffect(() => stopSpeaking(), []);
  return route.id ? html`<${Reader} key=${route.id} id=${route.id} />` : html`<${Library} />`;
}

// ---------------------------------------------------------------------------------------------
// The books

function Library() {
  const [books, setBooks] = useState(null);
  const [covers, setCovers] = useState({});
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef();

  const load = () =>
    listBooks()
      .then(setBooks)
      .catch(e => toast(e.message, 'error'));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    let alive = true;
    const made = [];
    (async () => {
      for (const b of books || []) {
        if (covers[b.id] !== undefined) continue;
        const url = await coverUrl(b).catch(() => null);
        if (url) made.push(url);
        if (alive) setCovers(c => ({ ...c, [b.id]: url }));
      }
    })();
    return () => {
      alive = false;
      made.forEach(URL.revokeObjectURL);
    };
  }, [books]);

  const add = async files => {
    setAdding(true);
    for (const f of files) {
      try {
        const r = await addBook(f);
        toast(r.added ? `Added “${r.meta.title}” to your books.` : `“${r.meta.title}” is in your books already.`, 'success');
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 'error', 8000);
      }
    }
    setAdding(false);
    load();
  };
  const remove = async b => {
    if (!confirm(`Remove “${b.title}” from your books? (The file you added it from stays where it is.)`)) return;
    await removeBook(b.id);
    load();
  };
  const drop = e => {
    e.preventDefault();
    setOver(false);
    const files = [...(e.dataTransfer?.files || [])].filter(f => /\.(pdf|epub)$/i.test(f.name));
    if (files.length) add(files);
    else toast('Drop a PDF or EPUB file.', 'error');
  };

  return html`<div class=${cls('page', over && 'drop-over')} onDragOver=${e => (e.preventDefault(), setOver(true))} onDragLeave=${() => setOver(false)} onDrop=${drop}>
    <div class="page-narrow">
      <div class="row">
        <h1 class="grow" style="margin:0">Book reader</h1>
        <button class="btn primary" disabled=${adding} onClick=${() => input.current.click()}>${adding ? html`<span class="spinner"></span>` : '+'} Add a book</button>
        <input type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" multiple hidden ref=${input} onChange=${e => (add([...e.currentTarget.files]), (e.currentTarget.value = ''))} />
      </div>
      <p class="muted" style="margin:6px 0 16px">
        Add a chess book — a PDF or an EPUB — and Plymentor reads it to you with your coach's voice: the sentence it reads is marked on the page, the moves are marked
        too, and the board plays each move as the reading gets to it and shows the book's diagrams. Click a sentence to read from there, or a move or a diagram to see it on
        the board. Try moves of your own on the board too, or go back and on through the moves with ← and →: the reading pauses, and once it goes on, the board comes
        back to the book with its next move. Type a page's number to go straight to it. Scanned books are read too (their text is recognised on this computer, which
        takes a while). Your books stay on this computer.
      </p>
      ${books && !books.length
        ? html`<div class="card book-drop">
            <h3>No books yet</h3>
            <p class="muted">Drop a PDF or EPUB file here, or press <b>Add a book</b>. Books with copy protection (DRM) can't be read.</p>
          </div>`
        : null}
      <div class="book-grid">
        ${(books || []).map(
          b => html`<div class="book-card" onClick=${() => navigate(`#/books/${b.id}`)} title=${b.title}>
            <div class="book-cover">${covers[b.id] ? html`<img src=${covers[b.id]} alt="" />` : html`<span>${b.format.toUpperCase()}</span>`}</div>
            <div class="book-name">${b.title}</div>
            ${b.author ? html`<div class="muted ellipsis">${b.author}</div>` : null}
            <div class="muted book-facts">${b.format.toUpperCase()} · ${b.pages} ${b.format === 'pdf' ? 'pages' : 'chapters'}${b.progress ? ` · ${Math.round(b.progress * 100)}% read` : ''}</div>
            <button class="btn small ghost danger" onClick=${e => (e.stopPropagation(), remove(b))}>Remove</button>
          </div>`,
        )}
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Reading a book

function Reader({ id }) {
  const rerender = useForce();
  const [opened, setOpened] = useState({ book: null, error: null });
  const [orientation, setOrientation] = useState('white');
  // a position of the move list the student went to, or the coach showed: { tree, node, end } — or the student's own
  // moves (own: true), on a tree of their own
  const [browse, setBrowse] = useState(null);
  const [pageText, setPageText] = useState(null); // (a page number being typed)
  const pageNo = useRef();
  // a PDF page: whole ('page'), as wide as the panel ('width'), or a share of the panel's width (a number, in %)
  const [zoom, setZoom] = useState(() => stored('books.zoom', 'page'));
  // a diagram the student sets right on the board editor: { diagram, placement, side }
  const [editing, setEditing] = useState(null);
  const editingRef = useRef(null);
  editingRef.current = editing;
  const reading = useRef(null);
  const meta = useRef(null);
  const shown = useRef(null); // the move of the text the board shows (with .tree and .node)
  const viewRef = useRef(null); // what the board shows: { tree, node }
  const pageEl = useRef();
  const page = useRef(null);
  const saveTimer = useRef(0);
  const book = opened.book;

  // where the student is in the book, kept for the next time (and the share read, for the list)
  const save = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = 0;
    const r = reading.current;
    const m = meta.current;
    if (!r || !m) return;
    const u = r.book.units[r.at.unit];
    m.at = { unit: r.at.unit, sentence: r.at.sentence };
    m.progress = Math.min(1, (r.at.unit + (u?.sentences.length ? r.at.sentence / u.sentences.length : 0)) / r.book.count);
    m.opened = Date.now();
    saveBook(m).catch(() => {});
  };
  const keep = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 1200);
  };

  useEffect(() => {
    let alive = true;
    let b = null;
    (async () => {
      const m = await getBook(id);
      if (!m) throw new Error('This book is not in your books any more.');
      meta.current = m;
      b = await openBook(m);
      if (!alive) return b.close();
      reading.current = new Reading(b, {
        at: m.at ? { unit: Math.min(m.at.unit, b.count - 1), sentence: m.at.sentence, part: 0 } : undefined,
        onChange: () => (rerender(), keep()),
        onMove: move => {
          if (move.node) {
            shown.current = move;
            setBrowse(null);
            if (move.kind !== 'diagram') moveSound(move.node);
          }
          rerender();
        },
      });
      b.listeners.add(rerender);
      // (the voice is ready, and the first part made, before ▶ is pressed)
      warmReading(b.lang);
      reading.current.warm();
      m.opened = Date.now();
      saveBook(m).catch(() => {});
      setOpened({ book: b, error: null });
    })().catch(e => alive && setOpened({ book: null, error: e.message }));
    return () => {
      alive = false;
      reading.current?.dispose();
      if (saveTimer.current) save(); // (where the student was, now: the screen is going)
      b?.close();
    };
  }, [id]);

  /**
   * Reads from `at` on (or waits there); the board shows the position of the text there — `keep`: the student's own
   * moves stay on it until the reading plays its next move (another page, or ▶ from the page they look at).
   */
  const goTo = (at, keep = false) => {
    const r = reading.current;
    if (!r) return;
    r.seek(at);
    const u = r.book.units[at.unit];
    shown.current = r.book.nodeAt(at.unit, u?.sentences[at.sentence || 0]?.start ?? 0);
    setBrowse(b => (keep && b?.own ? b : null));
  };

  const onSentence = (unit, sentence) => goTo({ unit, sentence });
  /** A move clicked on the page: the board shows it, and the reading goes on after it. */
  const onMove = (unit, i) => {
    const r = reading.current;
    const u = r?.book.units[unit];
    const m = u?.moves[i];
    if (!m) return;
    const sentence = u.sentences.findIndex(s => m.start >= s.start && m.end <= s.end);
    const part = Math.max(0, u.sentences[sentence]?.parts.findIndex(p => p.move === i) ?? 0);
    r.seek(r.after({ unit, sentence, part }) || { unit, sentence, part });
    if (m.node) shown.current = m;
    else shown.current = r.book.nodeAt(unit, m.start);
    setBrowse(null);
  };
  /**
   * The board editor for diagram `d`: the position the board shows for it (or as its picture was read, or an empty
   * board) to set right; the reading pauses meanwhile.
   */
  const edit = d => {
    const r = reading.current;
    if (!d || !r) return;
    if (r.playing) r.pause();
    const fen = d.node?.fen.split(' ');
    setEditing({ diagram: d, placement: fen?.[0] || d.placement || '8/8/8/8/8/8/8/8', side: fen?.[1] || d.side || 'w' });
  };
  /** The position the student set for a diagram: kept with the book, which is followed again from it. */
  const saveFix = async (placement, side) => {
    const r = reading.current;
    const d = editing?.diagram;
    setEditing(null);
    if (!r || !d) return;
    await r.book.fix(d.unit, d.index, placement, side);
    shown.current = d.node ? d : shown.current;
    setBrowse(null);
    rerender();
    toast(d.node ? 'The diagram is set right; the book’s moves are followed again from it.' : 'The position was kept, but no moves follow from it.', d.node ? 'success' : 'info');
  };
  /** A diagram clicked on the page: the board shows its position, and the reading goes on after it. */
  const onDiagram = (unit, i) => {
    const r = reading.current;
    const d = r?.book.units[unit]?.diagrams[i];
    if (!d) return;
    // (one that could not be read: the student may set it up on the board editor)
    if (!d.node) return edit(d);
    const u = r.book.units[unit];
    for (const [sentence, s] of u.sentences.entries()) {
      const part = s.parts?.findIndex(p => p.diagram === i) ?? -1;
      if (part >= 0) {
        r.seek(r.after({ unit, sentence, part }) || { unit, sentence, part });
        break;
      }
    }
    shown.current = d;
    setBrowse(null);
    rerender();
  };
  /** The next or previous page (dir 1 or -1): an EPUB's within its chapter first. */
  const turn = dir => {
    const r = reading.current;
    const p = page.current;
    if (!r || !p) return;
    if (r.book.format === 'epub' && p.unit === r.at.unit && p.page + dir >= 0 && p.page + dir < p.pages) {
      p.turnTo(p.page + dir);
      return rerender();
    }
    const u = (p.unit >= 0 ? p.unit : r.at.unit) + dir;
    if (u < 0 || u >= r.book.count) return;
    goTo({ unit: u, sentence: dir < 0 && r.book.format === 'epub' ? Math.max(0, (r.book.units[u]?.sentences.length || 1) - 1) : 0 }, true);
  };
  /** A page the student typed the number of (a PDF's): read from its start, as a page turned to. */
  const goToPage = text => {
    setPageText(null);
    const r = reading.current;
    const n = Number.parseInt(text, 10);
    if (!r || !Number.isFinite(n)) return;
    const u = Math.max(1, Math.min(r.book.count, n)) - 1;
    if (u !== r.at.unit) goTo({ unit: u, sentence: 0 }, true);
  };
  /** A PDF page's zoom: 'page', 'width', or a share of the panel's width in % (kept for the next time). */
  const zoomTo = z => {
    if (typeof z === 'number') z = Math.max(ZOOM.min, Math.min(ZOOM.max, Math.round(z)));
    setZoom(z);
    store('books.zoom', z);
    page.current?.setZoom?.(z);
  };
  /** Zooms in (dir 1) or out (-1) by a tenth of the panel's width, from the size the page has now. */
  const zoomBy = dir => {
    const p = page.current;
    if (!p || p.percent === undefined) return;
    const now = typeof p.zoom === 'number' ? p.zoom : p.percent || 100;
    zoomTo(dir > 0 ? Math.floor(now / 10) * 10 + 10 : Math.ceil(now / 10) * 10 - 10);
  };
  const toggle = () => {
    const r = reading.current;
    const p = page.current;
    if (!r) return;
    // reading starts from the page the student is looking at
    if (!r.playing && r.book.format === 'epub' && p?.unit === r.at.unit && !p.showsSentence(r.at.sentence)) {
      const first = p.firstSentence();
      if (first !== null) goTo({ unit: r.at.unit, sentence: first }, true);
    }
    r.toggle();
  };
  /** The reading pauses while the student looks at the board (the part it stopped in is made again, for ▶). */
  const hold = () => {
    const r = reading.current;
    if (!r?.playing) return;
    r.pause();
    r.warm();
  };
  /**
   * The board one move back or on (dir -1 or 1) — on the book's line or the student's own moves —: the reading pauses;
   * ▶ goes on from where it stopped, and the book's next move brings its position back.
   */
  const stepMove = dir => {
    const v = viewRef.current;
    if (!v) return;
    const end = endOf(v.node, v);
    const to = dir < 0 ? v.node.parent : nextOf(v.node, end);
    if (!to) return;
    hold();
    if (dir > 0) moveSound(to);
    setBrowse({ tree: v.tree, node: to, own: !!v.own, end });
  };
  /** A move of the move list the student clicked: the board shows it, the reading pauses. */
  const select = n => {
    const v = viewRef.current;
    if (!v) return;
    hold();
    setBrowse({ tree: v.tree, node: n, own: !!v.own, end: endOf(n, v) });
  };
  /**
   * A move the student plays on the board: the reading pauses, and the move goes on a line of the student's own — the
   * moves that led to the board's position, then theirs (the book's trees stay as the book has them). ▶ goes on
   * reading, and the board keeps the student's moves until the reading plays its next move (the Reading's onMove).
   */
  const play = uci => {
    const v = viewRef.current;
    let tree = v?.tree;
    let from = v?.node;
    if (!v?.own) {
      tree = v ? Tree.fromMoves(v.tree.startFen, v.tree.ucis(v.node)) : new Tree();
      // (a king the reader put in where the book's diagram has none stays unseen)
      if (v?.tree.hidden) tree.hidden = v.tree.hidden;
      from = tree.mainline().at(-1);
    }
    const added = tree.addMove(from, uci);
    if (!added) return;
    moveSound(added.node);
    hold();
    setBrowse({ tree, node: added.node, own: true });
  };

  useEffect(() => {
    if (!book || !pageEl.current) return;
    const P = book.format === 'pdf' ? PdfPage : EpubPage;
    const p = new P(pageEl.current, book, { onSentence, onMove, onDiagram, onTurn: turn, onPaged: rerender }, { zoom });
    page.current = p;
    // (Ctrl and the mouse wheel zoom a PDF page)
    const el = pageEl.current;
    const onWheel = e => {
      if (!e.ctrlKey || book.format !== 'pdf') return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      p.destroy();
      page.current = null;
    };
  }, [book]);

  // after every change: the page shows the unit being read and marks the sentence and the move being said
  useEffect(() => {
    const r = reading.current;
    const p = page.current;
    if (!r || !p) return;
    if (!shown.current && r.book.units[r.at.unit]) shown.current = r.book.nodeAt(r.at.unit, r.book.units[r.at.unit].sentences[r.at.sentence]?.start ?? 0);
    r.book.focus = r.at.unit; // (the scanned pages are read from the one the student is at)
    const diagram = shown.current?.kind === 'diagram' ? shown.current : null;
    p.show(r.at.unit).then(() => p.highlight(r.at, r.partAt(r.at)?.move ?? null, diagram));
  });

  // The coach sees the book's position (get_board_state), and a position it shows (set_board) comes on this board.
  useCoachScreen(
    'books',
    () => {
      const r = reading.current;
      const v = viewRef.current;
      if (!r || !meta.current) return null;
      const where = r.book.format === 'pdf' ? `page ${r.at.unit + 1} of ${r.book.count}` : `chapter ${r.at.unit + 1} of ${r.book.count} (“${r.book.titles[r.at.unit]}”)`;
      const board = v?.own
        ? "the student is trying out moves of their own on its board, from the book's position (the reading's next move brings the book's position back)"
        : 'its board shows the position the reading has reached';
      const note = `The student is reading the chess book “${meta.current.title}”${meta.current.author ? ` by ${meta.current.author}` : ''} in the Book reader, ${where}; ${board}.`;
      if (!v) return { mode: 'book', ucis: [], note }; // (the board shows the initial position until the book's first move)
      return { mode: 'book', startFen: v.tree.isStandardStart ? undefined : v.tree.startFen, ucis: v.tree.ucis(v.node), note };
    },
    ev => {
      if (ev.action !== 'set_board') return false;
      const { tree, node } = placeCoachPosition(new Tree(), ev);
      if (ev.line?.length) tree.addLine(node, ev.line.map(m => m.uci));
      setBrowse({ tree, node });
      return true;
    },
  );

  useEffect(() => {
    const onKey = e => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || editingRef.current) return;
      const r = reading.current;
      if (!r) return;
      if (e.key === ' ') toggle();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        // (the board's moves, as on the app's other boards; with Shift, the sentences)
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) r.step(dir);
        else stepMove(dir);
      } else if (e.key === 'PageDown') turn(1);
      else if (e.key === 'PageUp') turn(-1);
      else if (e.key === 'g' && r.book.format === 'pdf') pageNo.current?.focus();
      else if (e.key === 'f') setOrientation(o => (o === 'white' ? 'black' : 'white'));
      else if ((e.key === '+' || e.key === '=' || e.key === '-') && r.book.format === 'pdf') zoomBy(e.key === '-' ? -1 : 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Stockfish on the board (the Book reader's own switch): its evaluation bar, its lines and its best move's arrow
  const s = useStore();
  const engineOn = useEngineSwitch('books');
  const [multipv, setMultipv] = useState(() => stored('books.multipv', 1));
  const boardFen = (browse?.node || shown.current?.node)?.fen || INITIAL_FEN;
  const live = useLiveEval(engineOn ? boardFen : '__off__');
  useEffect(() => {
    if (engineOn) engine.analyze(boardFen, multipv);
    else engine.stop();
  }, [boardFen, engineOn, multipv]);
  useEffect(() => () => engine.stop(), []);

  if (opened.error)
    return html`<div class="page"><div class="page-narrow"><div class="card"><h2>This book can't be opened</h2><p>${opened.error}</p><a class="btn" href="#/books">Back to your books</a></div></div></div>`;
  const r = reading.current;
  const m = meta.current;
  const p = page.current;
  const at = r?.at || { unit: 0, sentence: 0 };
  const unit = book?.units[at.unit];
  const move = shown.current;
  const view = browse || (move?.node ? { tree: move.tree, node: move.node } : null);
  viewRef.current = view;
  const node = view?.node;
  const own = !!browse?.own; // (the student's own moves on the board)
  const away = !!browse; // (the board shows another position than the reading's)
  const next = node ? nextOf(node, endOf(node, view)) : null;
  // (the diagram whose position the board shows: one the student may set right)
  const diagramShown = !browse && move?.kind === 'diagram' && move.node === node ? move : null;
  const best = engineOn && live?.lines?.[0]?.pv?.[0];
  const shapes = best && s.settings?.board?.bestArrow !== false ? [{ orig: best.slice(0, 2), dest: best.slice(2, 4), brush: 'paleBlue' }] : [];
  const scanning = book?.scanning;
  const loading = book && book.loaded < book.count && !scanning;
  const zoomPct = typeof zoom === 'number' ? zoom : p?.percent || 100;
  // (an EPUB's place: a PDF's page is a box its number can be typed in)
  const whereLabel = book ? `${p?.pages > 1 ? `Page ${p.page + 1} of ${p.pages} · ` : ''}chapter ${at.unit + 1} of ${book.count}` : '';
  const status = !book
    ? 'Opening the book…'
    : book.error && !unit
      ? `This part of the book could not be read: ${book.error.message}`
      : !unit && scanning
        ? html`<span class="spinner small"></span> Reading the text of this scanned page…`
      : unit && !unit.text.trim()
      ? 'This page has no text to read (a picture).'
      : r?.playing
        ? `Reading · ${readingEngine(book.lang) === 'natural' ? 'natural voice' : 'system voice'}${away ? ' · the board goes back to the book with its next move' : ''}`
        : away
          ? `Paused${own ? ' for your moves' : ''} — ▶ Continue reads on; the board goes back to the book with its next move`
          : 'Paused — press ▶ or Space to read';

  return html`<div class="book-reader">
    <div class="book-main">
      <div class="book-head">
        <a class="btn small ghost" href="#/books" title="Your books">← Books</a>
        <div class="grow ellipsis book-title" title=${m?.title || ''}>${m?.title || ''}</div>
        ${book?.format === 'epub' &&
        html`<select class="book-chapters" value=${at.unit} onChange=${e => goTo({ unit: Number(e.currentTarget.value), sentence: 0 }, true)}>
          ${book.titles.map((t, i) => html`<option value=${i}>${t}</option>`)}
        </select>`}
        ${book?.format === 'pdf' &&
        html`<div class="book-zoom">
          <div class="btn-group">
            <button class=${cls('btn small', zoom === 'page' && 'active')} title="Show the whole page" onClick=${() => zoomTo('page')}>Whole page</button>
            <button class=${cls('btn small', zoom === 'width' && 'active')} title="Make the page as wide as the panel (it scrolls with the reading)" onClick=${() => zoomTo('width')}>Fit width</button>
          </div>
          <input
            type="range"
            min=${ZOOM.min}
            max=${ZOOM.max}
            step="5"
            value=${zoomPct}
            title="The page's size, in % of the panel's width (also Ctrl + the mouse wheel, or + and −)"
            aria-label="Zoom"
            onInput=${e => zoomTo(Number(e.currentTarget.value))}
          />
          <span class="muted book-zoom-pct">${zoomPct}%</span>
        </div>`}
        <button class="btn icon" title="Previous page (Page Up)" disabled=${!book} onClick=${() => turn(-1)}>◀</button>
        ${book?.format === 'pdf'
          ? html`<label class="muted nowrap book-where" title="Go to a page: type its number, then Enter (g)">
              Page
              <input
                ref=${pageNo}
                class="book-page-no"
                type="text"
                inputmode="numeric"
                aria-label="Page number"
                value=${pageText ?? String(at.unit + 1)}
                onFocus=${e => e.currentTarget.select()}
                onInput=${e => setPageText(e.currentTarget.value)}
                onKeyDown=${e => {
                  if (e.key === 'Escape') e.currentTarget.value = String(at.unit + 1);
                  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                }}
                onBlur=${e => goToPage(e.currentTarget.value)}
              />
              of ${book.count}
            </label>`
          : html`<span class="muted nowrap book-where">${whereLabel}</span>`}
        <button class="btn icon" title="Next page (Page Down)" disabled=${!book} onClick=${() => turn(1)}>▶</button>
      </div>
      <div class="book-page" ref=${pageEl}>${!book ? html`<div class="empty"><span class="spinner"></span></div>` : null}</div>
    </div>
    <div class="book-side">
      ${editing
        ? html`<${BoardEditor}
            key=${`${editing.diagram.unit}/${editing.diagram.index}`}
            placement=${editing.placement}
            side=${editing.side}
            orientation=${orientation}
            title=${editing.diagram.node ? 'Set this diagram right: put the pieces where the book has them' : 'This diagram could not be read: set its position up'}
            onSave=${saveFix}
            onCancel=${() => setEditing(null)}
          />`
        : html`<div class="board-area">
            ${s.settings?.board?.evalBar !== false && html`<${EvalBar} score=${engineOn ? live?.lines?.[0]?.score || null : null} orientation=${orientation} />`}
            <${Board} fen=${node?.fen || INITIAL_FEN} hide=${hiddenSquares(view?.tree, node?.fen)} lastMove=${node?.uci ? [node.uci.slice(0, 2), node.uci.slice(2, 4)] : null} orientation=${orientation} movable="both" onMove=${play} shapes=${shapes} />
          </div>`}
      <div class="book-controls">
        <button class="btn icon" title="Previous sentence (Shift + ←)" disabled=${!r} onClick=${() => r.step(-1)}>⏮</button>
        <button class=${cls('btn', 'primary', 'book-play')} title=${away && !r?.playing ? 'Go on reading (Space): the board shows this position until the book’s next move' : 'Read / pause (Space)'} disabled=${!r} onClick=${toggle}>${
          r?.playing ? '⏸ Pause' : away ? '▶ Continue' : '▶ Read'
        }</button>
        <button class="btn icon" title="Next sentence (Shift + →)" disabled=${!r} onClick=${() => r.step(1)}>⏭</button>
        <div class="btn-group" title="Reading speed">
          ${SPEEDS.map(s => html`<button class=${cls('btn small', r?.speed === s && 'active')} disabled=${!r} onClick=${() => r.setSpeed(s)}>${s}×</button>`)}
        </div>
        <span class="spacer"></span>
        <div class="btn-group book-moves">
          <button class="btn icon" title="Previous move (←): the reading pauses" disabled=${!node?.parent || !!editing} onClick=${() => stepMove(-1)}>◀</button>
          <button class="btn icon" title="Next move (→): the reading pauses" disabled=${!next || !!editing} onClick=${() => stepMove(1)}>▶</button>
        </div>
        ${diagramShown &&
        !editing &&
        html`<button class="btn small" title="The diagram read wrong? Set its pieces right on the board: the book is followed again from it, and its other diagrams are read better" onClick=${() => edit(diagramShown)}>✎ Fix diagram</button>`}
        <button class="btn icon" title="Flip the board (f)" onClick=${() => setOrientation(o => (o === 'white' ? 'black' : 'white'))}>⇅</button>
      </div>
      <div class="book-status muted">
        ${status}${loading ? html` · <span class="spinner small"></span> finding the moves: ${book.format === 'pdf' ? 'page' : 'chapter'} ${book.loaded} of ${book.count}` : ''}${
          scanning ? html` · <span title="The text of a scanned page is recognised on this computer (OCR); what is read is kept for the next time.">scanned pages read: ${scanning.done} of ${scanning.total}</span>` : ''
        }
      </div>
      <div class="panel book-engine">
        <${EnginePanel}
          fen=${boardFen}
          data=${live}
          enabled=${engineOn}
          onToggle=${() => setEngineSwitch('books', !engineSwitches().books)}
          multipv=${multipv}
          onMultipv=${n => {
            setMultipv(n);
            store('books.multipv', n);
          }}
        />
      </div>
      <div class="panel grow">
        <div class="panel-head"><span class="title">Moves</span><span class="spacer"></span>${browse && (move?.node || own) ? html`<button class="btn small ghost" onClick=${() => setBrowse(null)}>↩ Back to the reading</button>` : null}</div>
        <div class="panel-body">
          ${view
            ? html`<${MoveList} tree=${view.tree} current=${view.node} onSelect=${select} />`
            : html`<div class="empty"><p class="muted">The moves of the book appear here as the reading gets to them.</p></div>`}
        </div>
      </div>
    </div>
  </div>`;
}
