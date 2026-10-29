// The text of a chess book, for the Book reader: the moves written in it — the way books write them: move numbers
// ("12." for White, "12..." or "12…" for Black), letters or figurines (Nf3, ♘f3), x or : for captures, castling with O
// or 0, long algebraic (Ng1-f3), check signs and annotation glyphs; older books' descriptive notation: descriptive.js —,
// its sentences, and what the voice says for them.
import { findDescriptive, findSpelled } from './descriptive.js';

const FIGURINES = { '♔': 'K', '♚': 'K', '♕': 'Q', '♛': 'Q', '♖': 'R', '♜': 'R', '♗': 'B', '♝': 'B', '♘': 'N', '♞': 'N' };
const PIECE = '[KQRBN♔♕♖♗♘♚♛♜♝♞]';
const PROMO = '[QRBN♕♖♗♘♛♜♝♞]';
const MOVE = new RegExp(
  '(?<![\\w♔-♟.\\-–])' +
    // a move number (with one dot for White, two or three — or "…" — for Black, none in "12 Nf3"), or Black's "...Nf6"
    '(?:(?<num>\\d{1,3})(?:\\s?(?<dots>(?:\\.\\s?){1,4}(?:…\\s?)?|…\\s?)|\\s(?=[KQRBNa-hO0♔-♞]))|(?<bdots>\\.{2,3}|…)\\s?)?' +
    '(?<san>[O0](?:-[O0]){1,2}' +
    `|${PIECE}?[a-h][1-8][-–x:×][a-h][1-8](?:=?${PROMO})?` +
    `|${PIECE}[a-h]?[1-8]?[x:×]?[a-h][1-8]` +
    `|[a-h](?:[x:×][a-h][1-8]|[1-8])(?:=?${PROMO})?)` +
    '(?<check>[+#†‡]{0,2})(?<nag>[!?]{1,2})?' +
    '(?![\\w♔-♟])',
  'gu',
);

/**
 * The moves written in `text`: [{ start, end, num, side ('white' | 'black' | null when the text does not say), san
 * (as chessops reads it), check, pawn (a pawn move — or a square named in the text: "the d5 square"), words (what the
 * voice says) }]. A scanned page's text (`ocr`) has moves read wrongly too: see ocrMoves. Moves in descriptive
 * notation ("P-K4", "Kt to B 3") have `desc` instead of a SAN the board can read, and moves spelled out ("Pawn to King's
 * fourth", "knight to f3") are `spelled`: see descriptive.js.
 */
export function findMoves(text, { ocr = false } = {}) {
  const spelled = findSpelled(text);
  const overlap = (a, b) => a.start < b.end && a.end > b.start;
  // (a move spelled out holds its square: "knight to f3" is one move, not a pawn's)
  const outside = t => !spelled.some(s => overlap(s, t));
  const lettered = strictMoves(text).filter(outside);
  // (a lost figurine before a square: a piece's move, not the pawn move the square alone would be)
  const glyphs = glyphMoves(text, lettered).filter(outside);
  const strict = [...lettered.filter(t => !glyphs.some(g => overlap(g, t))), ...glyphs].sort((a, b) => a.start - b.start);
  const moves = (ocr ? ocrMoves(text, strict) : strict).filter(outside);
  const desc = findDescriptive(text).filter(d => outside(d) && !strict.some(t => overlap(t, d)));
  if (!desc.length && !spelled.length) return moves;
  // (a page in descriptive notation: what the OCR's guesses took for algebraic moves there are words)
  const words = desc.length >= 3 && !strict.length;
  const kept = moves.filter(t => !t.ocr || (!words && !desc.some(d => overlap(d, t))));
  return [...kept, ...desc, ...spelled].sort((a, b) => a.start - b.start);
}

function strictMoves(text) {
  const out = [];
  for (const m of text.matchAll(MOVE)) {
    const g = m.groups;
    const num = g.num ? Number(g.num) : null;
    const dots = g.dots ? (g.dots.includes('…') ? 3 : g.dots.split('.').length - 1) : 0;
    const side = num ? (dots >= 2 ? 'black' : 'white') : g.bdots ? 'black' : null;
    const san = g.san
      .replace(/[♔-♞]/g, c => FIGURINES[c] || '')
      .replace(/[:×]/g, 'x')
      .replace(/–/g, '-')
      .replace(/^0/, 'O')
      .replace(/-0/g, '-O');
    const start = m.index;
    const end = start + m[0].length;
    const after = text.slice(end, end + 8);
    out.push({
      start,
      end,
      num,
      side,
      san,
      check: g.check || '',
      pawn: /^[a-h]/.test(san) && !/-/.test(san),
      square: /^[a-h][1-8]$/.test(san) && /^(?:-|\s)square/i.test(after),
      words: '',
    });
    out.at(-1).words = spokenMove(out.at(-1));
  }
  return out;
}

// A scanned page's moves: the OCR often reads a digit as a letter — 4 as a, d, g or q; 5 as s or b; 6 as é, b or G; 1
// as l, i or I; 2 as z; 8 as B or & —, f as £ or {, c as ¢, a check as t, and castling with zeros. Such a word, where
// it stands among moves (after a move number, or next to another move; a capture anywhere), is a move with the
// readings it may have (sans): the board plays the first one that is legal (moves.js), the voice says that one — and
// the word as it is written when none is.
const RANK_LIKE = { l: '1', i: '1', I: '1', '|': '1', z: '2', Z: '2', a: '4', d: '4', g: '4', q: '4', A: '4', s: '5', S: '5', b: '56', é: '6', G: '6', T: '7', B: '8', '&': '8' };
const FILE_LIKE = { '£': 'f', '{': 'f', '¢': 'c' };
const R = '[1-8lizZadgqAsSbéGTB&|]';
const F = '[a-h£{¢]';
const OCR_MOVE = new RegExp(
  `(?<![\\p{L}\\p{N}.])(?:(?<num>\\d{1,3})(?<dots>\\s?(?:\\.\\s?){1,4}|\\s)|(?<bdots>\\.{2,3}|…)\\s?)?(?<tok>[KQRBN]?${F}?${R}?[x:×]?${F}${R}|[O0]-[O0](?:-[O0])?[O0]?)(?<chk>[+†‡#t]?)(?![\\p{L}\\p{N}])`,
  'gu',
);
const OCR_WORDS = new Set(['as', 'ad', 'ha', 'hi', 'Bag', 'Bad', 'Bed', 'Red', 'Rad']); // (said as words unless among moves)

/** The moves a word read by OCR may be (plain SAN), the reading as it is first. */
function readings(tok) {
  if (/^[O0]-/.test(tok)) return /^[O0]-[O0]-[O0]/.test(tok) ? ['O-O-O', 'O-O'] : ['O-O', 'O-O-O'];
  const m = new RegExp(`^([KQRBN]?)(${F}?)(${R}?)([x:×]?)(${F})(${R})$`, 'u').exec(tok);
  if (!m) return [];
  const [, piece, ff, fr, x, file, rank] = m;
  const files = c => (c ? [FILE_LIKE[c] || c] : ['']);
  const ranks = c => (!c ? [''] : /\d/.test(c) ? [c] : [...(RANK_LIKE[c] || '')]);
  const out = [];
  for (const a of files(ff)) for (const b of ranks(fr)) for (const c of files(file)) for (const d of ranks(rank)) out.push(`${piece}${a}${b}${x ? 'x' : ''}${c}${d}`);
  return out.filter(s => /^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8]$/.test(s) && /[KQRBNx]|^[a-h][1-8]$/.test(s));
}

function ocrMoves(text, strict) {
  const found = [];
  for (const m of text.matchAll(OCR_MOVE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (strict.some(t => t.start < end && t.end > start)) continue;
    const g = m.groups;
    const sans = readings(g.tok);
    const num = g.num ? Number(g.num) : null;
    if (!sans.length || (!num && OCR_WORDS.has(g.tok))) continue;
    const side = num ? ((g.dots.match(/\./g) || []).length >= 2 ? 'black' : 'white') : g.bdots ? 'black' : null;
    found.push({ start, end, num, side, san: sans[0], sans, check: /[+†t]/.test(g.chk) ? '+' : g.chk, pawn: !/^[KQRBNO]/.test(sans[0]), square: false, ocr: true, words: text.slice(start, end), sure: !!num || !!g.bdots || /x/.test(sans[0]) || /^O-O/.test(sans[0]) });
  }
  // the others only next to a move (with no more than a space, a comma or a bracket between them)
  const all = [...strict, ...found].sort((a, b) => a.start - b.start);
  const near = (a, b) => /^[\s,;()[\]]{0,3}$/.test(text.slice(Math.min(a.end, b.end), Math.max(a.start, b.start)));
  for (let changed = true; changed; ) {
    changed = false;
    all.forEach((t, i) => {
      if (!t.ocr || t.sure) return;
      if ((all[i - 1] && (!all[i - 1].ocr || all[i - 1].sure) && near(all[i - 1], t)) || (all[i + 1] && (!all[i + 1].ocr || all[i + 1].sure) && near(t, all[i + 1]))) changed = t.sure = true;
    });
  }
  return all.filter(t => !t.ocr || t.sure);
}

// Figurines a PDF's text has lost: a book's figurine font without Unicode for its glyphs, or a scanner's OCR of them,
// gives other characters where the piece's letter goes ("�e5", "i.f6", "ttld1") — the same ones for the same piece
// throughout the book. Such a short word right before a square, where a move stands (after a move number or Black's
// dots, or next to another move), is a move of an unknown piece (`glyph`: the word): its readings are each piece's
// moves there (with the word's last letter or digit as the piece's file or rank, too); moves.js plays the one that is
// legal, and learns from the moves only one piece could make which piece the word is.
const GLYPH_MOVE = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:(?<num>\\d{1,3})(?<dots>\\s?(?:\\.\\s?){1,4}|\\s?…\\s?|\\s)|(?<bdots>\\.{2,3}|…)\\s?)?' +
    '(?<glyph>[^\\s\\p{N}()[\\]{},;:]{1,3}?)(?<x>[x:×]?)(?<sq>[a-h][1-8])(?<chk>[+#†]{0,2})(?<nag>[!?]{1,2})?(?![\\p{L}\\p{N}])',
  'gu',
);

function glyphMoves(text, strict) {
  const found = [];
  for (const m of text.matchAll(GLYPH_MOVE)) {
    const g = m.groups;
    // (a piece's letter or figurine is no lost glyph: strictMoves reads it; nor a pawn's file before its capture —
    // "exd5" —, nor a word's end, nor brackets or quotes)
    if (/^[KQRBN♔-♞]$/.test(g.glyph) || /^[KQRBN][a-h1-8]$/.test(g.glyph) || /^[a-h]$/.test(g.glyph) || /^[.…]/.test(g.glyph) || /^[a-z]{3}$/.test(g.glyph) || /["“”‘’]/.test(g.glyph)) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (strict.some(t => t.start < end && t.end > start && !t.pawn)) continue;
    const num = g.num ? Number(g.num) : null;
    const extra = /[a-h1-8]$/.test(g.glyph) && g.glyph.length > 1 ? ['', g.glyph.slice(-1)] : [''];
    const sans = [...'NBRQK'].flatMap(p => extra.map(d => `${p}${d}${g.x ? 'x' : ''}${g.sq}`));
    const side = num ? ((g.dots.match(/\.|…/g) || []).length >= 2 || g.dots.includes('…') ? 'black' : 'white') : g.bdots ? 'black' : null;
    found.push({ start, end, num, side, san: sans[0], sans, glyph: g.glyph.replace(/[a-h1-8]$/, d => (extra.length > 1 ? '' : d)), check: g.chk ? '+' : '', pawn: false, square: false, ocr: true, words: text.slice(start, end), sure: !!num || !!g.bdots });
  }
  // the others only next to a move (with no more than a space, a comma or a bracket between them)
  const all = [...strict, ...found].sort((a, b) => a.start - b.start);
  const near = (a, b) => /^[\s,;()[\]]{0,3}$/.test(text.slice(Math.min(a.end, b.end), Math.max(a.start, b.start)));
  for (let changed = true; changed; ) {
    changed = false;
    all.forEach((t, i) => {
      if (!t.glyph || t.sure) return;
      if ((all[i - 1] && (!all[i - 1].glyph || all[i - 1].sure) && near(all[i - 1], t)) || (all[i + 1] && (!all[i + 1].glyph || all[i + 1].sure) && near(t, all[i + 1]))) changed = t.sure = true;
    });
  }
  return found.filter(t => t.sure);
}

const PIECE_WORDS = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };

/** "12. knight to f3", "12... bishop takes e5, check", "castles kingside" (the words of the coach's voice). */
export function spokenMove(t) {
  let w;
  const castle = /^O-O(-O)?$/.exec(t.san);
  const m = /^([KQRBN])?([a-h])?([1-8])?([-x])?([a-h][1-8])(?:=?([QRBN]))?$/.exec(t.san);
  if (castle) w = castle[1] ? 'castles queenside' : 'castles kingside';
  else if (!m) w = t.san;
  else {
    const [, piece, file, rank, sep, to, promo] = m;
    const from = `${file || ''}${rank || ''}`;
    if (piece) w = `${PIECE_WORDS[piece]}${from ? ` from ${from}` : ''} ${sep === 'x' ? 'takes' : 'to'} ${to}`;
    else if (sep === 'x') w = `${from} takes ${to}`;
    else if (sep === '-') w = `${from} to ${to}`;
    else w = to;
    if (promo) w += `, promoting to a ${PIECE_WORDS[promo]}`;
  }
  if (t.check) w += /[#‡]/.test(t.check) ? ', checkmate' : ', check';
  return t.num ? `${t.num}${t.side === 'black' ? '...' : '.'} ${w}` : w;
}

// ---------------------------------------------------------------------------------------------
// Sentences

const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|cf|vs|viz|Mr|Mrs|Dr|St|No|Nos|Fig|Figs|Diag|Ch|ch|p|pp|ed|eds|Vol|vol|approx|ca|Jr|Sr)$/;

/**
 * The sentences of `text` — [{ start, end }], covering it — with the moves (findMoves) kept whole: their dots and
 * glyphs end no sentence. A short line without a full stop (a heading) is a sentence of its own, and so is a list of
 * moves after about 25 of them.
 */
export function findSentences(text, moves) {
  const inMove = new Uint8Array(text.length + 1);
  for (const t of moves) inMove.fill(1, t.start, t.end);
  const out = [];
  let start = 0;
  let movesIn = 0;
  let nextMove = 0;
  const cut = end => {
    if (/\S/.test(text.slice(start, end))) out.push({ start, end });
    else if (out.length) out.at(-1).end = end;
    start = end;
    movesIn = 0;
  };
  for (let i = 0; i < text.length; i++) {
    while (nextMove < moves.length && moves[nextMove].end <= i) {
      nextMove++;
      movesIn++;
    }
    const c = text[i];
    if (c === '\n') {
      const line = text.slice(text.lastIndexOf('\n', i - 1) + 1, i).trim();
      if (text[i + 1] === '\n' || (line && line.length < 40 && !/[.!?:;,…]["'”’)\]]*$/.test(line) && /^\s*[A-Z0-9"“(]/.test(text.slice(i + 1, i + 12)))) cut(i + 1);
      continue;
    }
    if (inMove[i] || !'.!?…'.includes(c)) {
      // a long list of moves: a new sentence before White's move after 25 moves
      if (movesIn >= 25 && moves[nextMove]?.start === i && moves[nextMove].num && moves[nextMove].side === 'white') cut(i);
      continue;
    }
    let j = i + 1;
    while (j < text.length && '.!?…"\'”’)]'.includes(text[j])) j++;
    if (j < text.length && !/\s/.test(text[j])) continue;
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (k < text.length && !/[A-Z0-9"“‘'(\[À-ɏЀ-ӿ♔-♟]/.test(text[k])) continue;
    if (c === '.' && ABBREVIATION.test(text.slice(Math.max(0, i - 8), i))) continue;
    if (c === '.' && /(?:^|\s)[A-Za-z]$/.test(text.slice(Math.max(0, i - 2), i))) continue; // an initial: "B. Spassky"
    cut(j);
    i = j - 1;
  }
  cut(text.length);
  return out;
}

// ---------------------------------------------------------------------------------------------
// What the voice says

const EVALUATIONS = [
  ['+-', 'White is winning'],
  ['+–', 'White is winning'],
  ['-+', 'Black is winning'],
  ['–+', 'Black is winning'],
  ['±', 'White is better'],
  ['∓', 'Black is better'],
  ['⩲', 'White is slightly better'],
  ['⩱', 'Black is slightly better'],
  ['+=', 'White is slightly better'],
  ['=+', 'Black is slightly better'],
  ['=∞', 'with compensation'],
  ['∞', 'unclear'],
  ['=', 'equal'],
];
const EVALUATION = new RegExp(`(?<=^|[\\s(,;])(${EVALUATIONS.map(([s]) => s.replace(/[+=]/g, '\\$&')).join('|')})(?=$|[\\s),;.])`, 'g');
const EVALUATION_WORDS = Object.fromEntries(EVALUATIONS);

/** Text as the voice should say it: lines joined (and words broken at their ends), brackets as pauses, evaluation signs in words. */
export function speakable(text) {
  return text
    .replace(/([A-Za-zÀ-ɏ])[-‐]\s*\n\s*([a-zà-ɏ])/g, '$1$2')
    .replace(/\s*\n\s*/g, ' ')
    .replace(EVALUATION, (_m, e) => EVALUATION_WORDS[e])
    .replace(/[()[\]{}]/g, ', ')
    .replace(/\s*,(\s*,)+/g, ',')
    .replace(/(^|[.!?…]\s*),\s*/g, '$1')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,([.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
}

/**
 * What the voice says for one sentence, in parts: each part ends with a move the board plays (`plays(move)`: once the
 * part has been said) or a diagram it shows (at its place in the text, `plays(diagram)` too: one that was read), the
 * last one with the rest of the sentence; the other moves (and squares) are said in words within their part.
 * [{ text, move (index into moves) | null, diagram (index into diagrams, when it ends with one) }]
 */
export function spokenParts(text, sentence, moves, plays = () => true, diagrams = []) {
  const parts = [];
  let said = '';
  let at = sentence.start;
  const events = [];
  moves.forEach((t, i) => t.start >= sentence.start && t.end <= sentence.end && events.push({ at: t.start, move: i }));
  // (a diagram at the very end of the text goes with the last sentence)
  const last = sentence.end >= text.length;
  diagrams.forEach((d, i) => d.at >= sentence.start && (d.at < sentence.end || (last && d.at === text.length)) && plays(d) && events.push({ at: d.at, diagram: i }));
  events.sort((a, b) => a.at - b.at || (a.diagram !== undefined ? -1 : 1));
  for (const e of events) {
    if (e.diagram !== undefined) {
      said += text.slice(at, Math.max(at, e.at));
      at = Math.max(at, e.at);
      parts.push({ text: speakable(said), move: null, diagram: e.diagram });
      said = '';
      continue;
    }
    const t = moves[e.move];
    said += `${text.slice(at, t.start)} ${t.words} `;
    at = t.end;
    if (!plays(t)) continue;
    parts.push({ text: speakable(said), move: e.move });
    said = '';
  }
  const rest = speakable(said + text.slice(at, sentence.end));
  if (/[\p{L}\p{N}]/u.test(rest)) parts.push({ text: rest, move: null });
  return parts;
}
