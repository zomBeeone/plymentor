// The coach's voice in its panel, read like a book (coachReading.js): what the coach is saying, the sentence being said
// marked and its moves too; ▶/⏸, a sentence back or on, the speed, a slider to anywhere in the text, a click on a
// sentence to listen from there, the coach's earlier texts (‹ ›). The text folds away to its sentence being said. Keys
// while the panel has the focus: Space, ← →.
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { cls, stored, store } from '../util.js';
import { useCoachReading, SPEEDS } from '../coachReading.js';

/** A sentence's text, its moves marked. */
function sentenceText(block, s) {
  const out = [];
  let at = s.start;
  for (const m of block.marks) {
    if (m.end <= s.start || m.start >= s.end) continue;
    const a = Math.max(m.start, s.start);
    const b = Math.min(m.end, s.end);
    if (a > at) out.push(block.text.slice(at, a));
    out.push(html`<span class="cv-m">${block.text.slice(a, b)}</span>`);
    at = b;
  }
  if (at < s.end) out.push(block.text.slice(at, s.end));
  return out;
}

/** The text's blocks, each sentence a span (data-s: its number) — the one being said `cur`. */
function textOf(t, cur) {
  const sentencesOf = t.blocks.map(() => []);
  t.sentences.forEach((s, i) => sentencesOf[s.block].push(i));
  return t.blocks.map((b, bi) => {
    const kids = [];
    let prev = 0;
    for (const i of sentencesOf[bi]) {
      const s = t.sentences[i];
      if (s.start > prev) kids.push(b.text.slice(prev, s.start));
      kids.push(html`<span data-s=${i} class=${cls(i === cur && 'cv-cur', !s.parts.length && 'cv-quiet')}>${sentenceText(b, s)}</span>`);
      prev = s.end;
    }
    if (prev < b.text.length) kids.push(b.text.slice(prev));
    return html`<div class=${`cv-${b.kind}`} data-mark=${b.mark || undefined}>${kids}</div>`;
  });
}

export function CoachVoice() {
  const r = useCoachReading();
  const [open, setOpen] = useState(() => stored('coach.voice.open', true) !== false);
  const [drag, setDrag] = useState(null); // (the slider's place while it is dragged)
  const box = useRef(null);
  const scrolled = useRef(0); // (when the student last scrolled the text: the reading leaves it where they put it a while)
  const t = r.text;
  const n = t?.sentences.length || 0;
  const cur = t ? (drag ?? (t.at.s < n ? t.at.s : -1)) : -1;

  // the sentence being said stays in sight
  useEffect(() => {
    const b = box.current;
    const el = b?.querySelector('.cv-cur');
    if (!el || Date.now() - scrolled.current < 4000) return;
    const top = el.offsetTop;
    if (top < b.scrollTop + 4 || top + el.offsetHeight > b.scrollTop + b.clientHeight - 4) b.scrollTo({ top: Math.max(0, top - b.clientHeight / 3), behavior: 'smooth' });
  }, [t?.id, cur, open]);

  if (!t) return null;
  const fold = on => {
    setOpen(on);
    store('coach.voice.open', on);
  };
  const click = e => {
    const el = e.target.closest?.('[data-s]');
    const sel = globalThis.getSelection?.();
    // (a selection being made is for copying, not for listening)
    if (!el || (sel && !sel.isCollapsed && box.current?.contains(sel.anchorNode))) return;
    r.seek(r.cur, Number(el.dataset.s), true);
  };
  const keys = e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const field = e.target.closest?.('input');
    const button = e.target.closest?.('button');
    if (e.key === ' ' && !field && !button) r.toggle();
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !field) r.step(e.key === 'ArrowRight' ? 1 : -1);
    else {
      // (a button's own Space or Enter: not the screen's — the Board's Space switches Stockfish)
      if (button && (e.key === ' ' || e.key === 'Enter')) e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const left = r.minutesLeft();
  const newer = r.texts.slice(r.cur + 1).some(x => !x.heard);
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(r.speed) + 1) % SPEEDS.length];
  const said = cur >= 0 ? t.sentences[cur] : null;

  return html`<div class=${cls('coach-voice', open && 'open')} tabindex="0" aria-label="What your coach says" onKeyDown=${keys}>
    <input
      type="range"
      class="cv-seek"
      min="0"
      max=${Math.max(0, n - 1)}
      step="1"
      value=${drag ?? Math.min(t.at.s, n - 1)}
      aria-label="Where to listen from"
      title="Drag to listen from anywhere in the text"
      onInput=${e => setDrag(Number(e.currentTarget.value))}
      onChange=${e => {
        setDrag(null);
        r.seek(r.cur, Number(e.currentTarget.value));
      }}
    />
    <div class="cv-bar">
      <button class="btn icon" title="Previous sentence (←)" onClick=${() => r.step(-1)}>⏮</button>
      <button class="btn small primary cv-play" title="Listen / pause (Space)" onClick=${() => r.toggle()}>${r.playing ? '⏸ Pause' : r.held ? '▶ Continue' : '▶ Listen'}</button>
      <button class="btn icon" title="Next sentence (→)" onClick=${() => r.step(1)}>⏭</button>
      <button class="btn small cv-speed" title=${`Reading speed — click for ${nextSpeed}×`} onClick=${() => r.setSpeed(nextSpeed)}>${r.speed}×</button>
      <span class="muted cv-where" title="The sentence being read, and roughly how long the rest takes">${Math.min(t.at.s + 1, n)} / ${n}${left >= 1 ? ` · ${Math.round(left)} min` : ''}</span>
      <span class="spacer"></span>
      ${r.texts.length > 1 &&
      html`<span class="cv-texts">
        <button class="btn icon ghost" disabled=${r.cur <= 0} title="What your coach said before" onClick=${() => r.show(r.cur - 1)}>‹</button>
        <span class="muted">${r.cur + 1}/${r.texts.length}</span>
        <button class=${cls('btn icon ghost', newer && 'cv-new')} disabled=${r.cur >= r.texts.length - 1} title=${newer ? 'What your coach said after it — not heard yet' : 'What your coach said after it'} onClick=${() => r.show(r.cur + 1)}>›</button>
      </span>`}
      <button class="btn icon ghost cv-fold" title=${open ? 'Fold the text away' : 'Show the whole text'} aria-expanded=${open} onClick=${() => fold(!open)}>${open ? '▾' : '▸'}</button>
    </div>
    ${open
      ? html`<div class="cv-text" ref=${box} onClick=${click} onWheel=${() => (scrolled.current = Date.now())} onTouchMove=${() => (scrolled.current = Date.now())}>${textOf(t, cur)}</div>`
      : html`<div class="cv-line ellipsis" title="Show the whole text" onClick=${() => fold(true)}>${said ? sentenceText(t.blocks[said.block], said) : t.blocks[0]?.text}</div>`}
  </div>`;
}
