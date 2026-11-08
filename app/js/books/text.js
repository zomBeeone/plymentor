// The text of a chess book, for the Book reader: the moves written in it — the way books write them: move numbers
// ("12." for White, "12..." or "12…" for Black), letters or figurines (Nf3, ♘f3), x, X or : for captures, castling
// with O or 0, long algebraic (Ng1-f3), check signs and annotation glyphs; older books' descriptive notation:
// descriptive.js —, its sentences, and what the voice says for them.
import { findDescriptive, findSpelled } from './descriptive.js';

const FIGURINES = { '♔': 'K', '♚': 'K', '♕': 'Q', '♛': 'Q', '♖': 'R', '♜': 'R', '♗': 'B', '♝': 'B', '♘': 'N', '♞': 'N' };
const PIECE = '[KQRBN♔♕♖♗♘♚♛♜♝♞]';
const PROMO = '[QRBN♕♖♗♘♛♜♝♞]';
// (a move starts outside a word, a number or another move — but a move number with its dots may follow a word or a full
// stop right away, where the PDF's text lost a line break: "completely.1...h5", "was2...Ke7"; not a file's letter,
// which makes a square: "Ra1...Kb2"; and a diagram's mark of the side to move: "B?8...h5?" starting a line)
const OUTSIDE = '(?<![\\w♔-♟.\\-–])';
const GLUED = '(?:(?<![\\d_♔-♟\\-–A-Za-h]|(?<!\\p{L})\\.)|(?<=(?:^|\\n)[WB]\\??))';
// (a scan's text, read by the scanner's OCR, has move numbers cut in two — "1 4.Nxe4", "2 1 .Rxc6" —, letters for
// their digits — an l or I for 1, S for 5 (or 8), O for 0, B for 8, G for 6: "l 7 .Re4", "I4.h3", "2S.exf5", "l .e4",
// "S.dxc3", "S . Rb8", "B.Kh7" — and bullets for dots — "20 ••• Rc7": after a space, and with their dots, they are no
// other words)
// (a number cut in two: its digits — or letters for them —, one space at most between them: "1 4", "1 07", "2S"; or a
// number of three digits each on its own, "1 0 1")
const CUT = '(?:\\d \\d \\d|[\\dlIS][\\dlISOBG]? ?[\\dlISOBG]{1,2})';
const APART = '(?<=^|[\\s([,;:])';
const DOTS = '\\s?(?<dots>(?:[.•]\\s?){1,4}(?:…\\s?)?|…\\s?)';
// (one letter for a one-digit number: an l or an I for 1 with its dot — or Black's dots, "l...Kf7" — right before the
// move, "l .e4" — not otherwise: "I... d5" is the word, and an analysis may number its lines from 1 afresh —; S, B, G
// with its dots right after it or with spaces, "S.dxc3", "S . Rb8", "S . . . Rg2", in an OCR's text: letterNumbers)
const LONE_NUMBER = '(?:(?<lone1>[lI])(?<ldots1> ?(?:\\.(?:\\s?\\.){0,2}|…))(?=[KQRBNa-hO0])|(?<lone>[SBG])(?<ldots>(?: ?[.•]){1,3}) ?)';
const LONE = `${LONE_NUMBER}(?=[KQRBNa-hO0])`;
const MOVE = new RegExp(
  // a move number (with one dot for White, two or three — or "…" — for Black, none in "12 Nf3"), or Black's "...Nf6"
  `(?:(?:${GLUED}(?<num>\\d{1,3})|${APART}(?<cut>${CUT}))${DOTS}|${APART}${LONE}` +
    // (not a scan's square whose file was read as a sign — "5.¢6 Ke8" is no move 6 —, as ocrMoves reads it)
    `|${OUTSIDE}(?:(?<![¢£€{$])(?<spaced>\\d{1,3})\\s(?=[KQRBNa-hO0♔-♞])|(?<bdots>\\.{2,3}|…)\\s?)?)` +
    // (castling with a hyphen or a dash — "0–0", "O—O" —, a line break maybe after it: "O-⏎O"; zeros and a dash only
    // where moves stand: castlingWithZeros)
    '(?<san>[O0](?: ?[-–—](?: ?|[ \\t]*\\n[ \\t]*)[O0]){1,2}' +
    `|${PIECE}?[a-h][1-8][-–x:×X][a-h][1-8](?:=?${PROMO})?` +
    `|${PIECE}[a-h]?[1-8]?[x:×X]?[a-h][1-8]` +
    `|[a-h](?:[x:×X][a-h][1-8]|[1-8])(?:=?${PROMO})?)` +
    // (a mate: # — or m, a puzzle book's font's sign for it: "2.Ne7m")
    '(?<check>[+#†‡]{0,2}|m)(?<nag>[!?]{1,2})?' +
    // (not the start of a long move a scan misread: "Nf3-el")
    '(?![\\w♔-♟]|[-–][a-h])',
  'dgu',
);

/**
 * The moves written in `text`: [{ start, end, num, side ('white' | 'black' | null when the text does not say), san
 * (as chessops reads it), check, pawn (a pawn move — or a square named in the text: "the d5 square"), words (what the
 * voice says) }]. A scanned page's text (`ocr`) has moves read wrongly too: see ocrMoves — and the app's own OCR of a
 * scanned page (`scan`: scan.js) reads a bold letter as a digit, see NO_FILE. Moves in descriptive notation ("P-K4",
 * "Kt to B 3") have `desc` instead of a SAN the board can read, and moves spelled out ("Pawn to King's fourth",
 * "knight to f3") are `spelled`: see descriptive.js.
 */
export function findMoves(text, { ocr = false, scan = false } = {}) {
  if (!ocr) return movesIn(text, false, false);
  // (a scan's moves its OCR spelled out with spaces: found where the spaces are left out, put back where they stand)
  const { joined, at } = unspaced(text);
  if (joined === text) return movesIn(text, true, scan);
  return movesIn(joined, true, scan).map(t => ({ ...t, start: at[t.start], end: at[t.end - 1] + 1, ...(t.glyph || t.ocr ? { words: text.slice(at[t.start], at[t.end - 1] + 1) } : {}), ...(t.written ? { written: { ...t.written, at: at[t.written.at] } } : {}) }));
}

// A scanner's OCR may write a move with spaces between its letters — the figurine (or the piece's letter), the file and
// the rank: "2. * d 4 * d 6", "A x g 5", "# e 2", "K e 4" (Amateur to IM: its figurines read as "*", "A", "H", "^",
// "#") —, and its pawn moves so after a move number or a move: "12. e 5", "* d 4 e 5". Such a move is one word without
// its spaces: a glyph of one to three signs (no letter or digit), one capital letter, or one small letter no file is
// ("l", "i") — no word: "on e 1" is a square in a sentence —, then the file and the rank, an "x" between them maybe.
// The first rank may be read as l or I ("* d l", "H a l": the square d1, a1), but not in a word spelled with spaces
// ("H a l l").
const SPACED = /(?<=^|[\s(])((?:[^\s\p{L}\p{N}()[\]{},;]{1,3}|[A-Zi-wyz]) (?:[x×:] )?)([a-h]) ([1-8lI])(?=[\s,;.)!?+#]|$)/gu;
const SPACED_PAWN = /(?<=(?:^|[\s(])(?:\d{1,3}\s?(?:[.•]\s?){1,3}|[^\s()]{0,3}[a-h][1-8][+#!?]{0,2} ))([a-h]) ([1-8])(?=[\s,;.)!?+#]|$)/gu;
// (a figurine read as a digit — "2 a l", "2 g 6 +" — only where a move stands: after a move number, Black's dots or a
// move)
const SPACED_DIGIT = /(?<=(?:^|[\s(])(?:\d{1,3}\s?(?:[.•]\s?){1,3}|\.{2,3}\s?|[^\s()]{0,3}[a-h][1-8][+#!?]{0,2} ))(\d (?:[x×:] )?)([a-h]) ([1-8lI])(?=[\s,;.)!?+#]|$)/gu;
// (a word spelled with spaces goes on after the letter taken for the rank: "H a l l")
const SPELLED_ON = /^ \p{Ll}(?:\s[^\d\s]|$)/u;
// An OCR may also glue a move to the one before it — "g3*e4", "*e6He4+", "#xg5Ad7", "*d3ie7", "3.1b8la2", "6.1a3sfeb6",
// "f4Nf6" —: a square (its check or glyphs after it, a figurine read as a digit before it) followed at once by a
// figurine (signs, a capital, or small letters the first of them no file nor "x") and a square is two moves.
// Not two squares named together ("a3/b4"), a long move ("e2-e4", "Ra8:e8", "Ng1f3"), a promotion.
const GLUED_MOVES = /(?<![\p{L}\p{N}])((?:[^\s\p{L}\p{N}()[\]{},;]{1,3}|[A-Z]|\d)?[x×:]?[a-h][1-8][+#!?†‡]{0,2})(?=(?:[A-Z]|[i-wyz][a-z]{0,2}|[^\s\p{L}\p{N}\p{Sm}()[\]{},;/\-–—‐‑:.…'"“”‘’!?]{1,3})[x×:]?[a-h][1-8](?![\p{L}\p{N}]))/gu;
// (and two pawn moves glued after a move number — "7.b6f4" —: two squares no pawn's move joins, their files two apart
// or more; "e2e4" may be one move)
const GLUED_PAWNS = /(?<=\d\s?(?:[.•]\s?){1,3})([a-h])[1-8](?=([a-h])[1-8](?![\p{L}\p{N}]))/gu;
// (and a piece's move with a space before its rank only — "2.Re 1 !", "Rb l+" —, the rank maybe a letter for its digit)
const SPACED_RANK = /(?<=^|[\s(.])([KQRBN][x×:]?[a-h]) (?=[1-8lIS](?:[\s,;.)!?+#]|$))/gu;

/**
 * `text` with the spaces of such moves left out, a space put between glued moves and a rank read as l or I put right
 * (`joined`), and where each of its characters stands in `text` (`at`: a space put in stands where the next one does).
 */
function unspaced(text) {
  // (glued moves: a space between them)
  const cuts = [...text.matchAll(GLUED_MOVES)].map(m => m.index + m[1].length);
  for (const m of text.matchAll(GLUED_PAWNS)) if (Math.abs(m[1].charCodeAt(0) - m[2].charCodeAt(0)) > 1) cuts.push(m.index + 2);
  // (most pages have neither: a move spelled with spaces has its file and rank apart)
  if (!cuts.length && !/[a-h] [1-8lIS]/.test(text)) return { joined: text, at: null };
  cuts.sort((a, b) => a - b);
  let chars = [];
  for (let i = 0, k = 0; i < text.length; i++) {
    for (; cuts[k] === i; k++) chars.push({ c: ' ', i });
    chars.push({ c: text[i], i });
  }
  const current = () => chars.map(x => x.c).join('');
  // (the spaces of a match: those between its glyph, its file and its rank — the rank as a digit)
  const join = (re, s, guard) => {
    const drop = new Set();
    for (const m of s.matchAll(re)) {
      const end = m.index + m[0].length;
      if (guard && /[lI]/.test(s[end - 1]) && SPELLED_ON.test(s.slice(end, end + 4))) continue;
      for (let i = m.index + m[1].indexOf(' '); i < end; i++) if (s[i] === ' ') drop.add(i);
      if (/[lI]/.test(s[end - 1])) chars[end - 1] = { ...chars[end - 1], c: '1' };
    }
    if (drop.size) chars = chars.filter((_, i) => !drop.has(i));
  };
  join(SPACED, current(), true);
  // (a piece's move with a space before its rank only: that space)
  const ranked = new Set([...current().matchAll(SPACED_RANK)].map(m => m.index + m[1].length));
  if (ranked.size) chars = chars.filter((_, i) => !ranked.has(i));
  // (a pawn move after a move number, or after a move — once the glyph moves above have been joined)
  const s = current();
  const drop = new Set([...s.matchAll(SPACED_PAWN)].map(m => m.index + 1));
  if (drop.size) chars = chars.filter((_, i) => !drop.has(i));
  // (a figurine read as a digit, after a move number or a move: one after the other — "2 a l 2 g 6 +")
  for (let k = 0; k < 3; k++) {
    const before = chars.length;
    join(SPACED_DIGIT, current(), true);
    if (chars.length === before) break;
  }
  const joined = current();
  if (joined === text) return { joined: text, at: null };
  const at = chars.map(x => x.i);
  at.push(text.length);
  return { joined, at };
}

function movesIn(text, ocr, scan) {
  const spelled = findSpelled(text);
  const overlap = (a, b) => a.start < b.end && a.end > b.start;
  // (a move spelled out holds its square: "knight to f3" is one move, not a pawn's)
  const outside = t => !spelled.some(s => overlap(s, t));
  const lettered = strictMoves(text).filter(outside);
  // (a lost figurine before a square: a piece's move, not the pawn move the square alone would be)
  const glyphs = glyphMoves(text, lettered).filter(outside);
  const strict = [...lettered.filter(t => !glyphs.some(g => overlap(g, t))), ...glyphs].sort((a, b) => a.start - b.start);
  const moves = castlingWithZeros(text, letterNumbers(text, (ocr ? ocrMoves(text, strict, scan) : strict).filter(outside), scan));
  const desc = findDescriptive(text).filter(d => outside(d) && !strict.some(t => overlap(t, d)));
  if (!desc.length && !spelled.length) return moves;
  // (a page in descriptive notation: what the OCR's guesses took for algebraic moves there are words)
  const words = desc.length >= 3 && !strict.length;
  const kept = moves.filter(t => !t.ocr || (!words && !desc.some(d => overlap(d, t))));
  return [...kept, ...desc, ...spelled].sort((a, b) => a.start - b.start);
}

// A move number written as a letter — "S.Kd4", "B . Rb8", "G...Bd7": an OCR's 5 (or 8), 8 and 6 (LONE_NUMBER) — is a
// number in an OCR's text: the app's own (`scan`), or a page whose moves show the OCR's misreadings elsewhere, a square
// written with a letter or a sign for its rank's digit or its file ("KcS", "Ral", "¢6"). In other text the letter is the
// text's ("Plan B. Nd5", "Which is best? A. Kd2 B. Ke2"), unless the moves numbered around it lead to its number ("7.Ke1
// Kd7 B.Ke2", "B. Ke2 Kd6 9.Kd3": 8) and no word stands right before it; the move after it has no number then.
const LONE_LETTER = /^[SBG](?: ?[.•]){1,3} ?/;
const MISREAD = /[a-h][liIzZadgqAsSbéGTB&|$](?!\p{L})|[£{¢€][1-8liIzZadgqAsSbéGTB&|$]/u;
const LETTER_NUMBERS = { S: [5, 8], B: [8], G: [6] };

function letterNumbers(text, moves, scan) {
  const letter = t => (t.num ? LONE_LETTER.exec(text.slice(t.start, t.end)) : null);
  if (scan || !moves.some(letter)) return moves;
  const word = t => text.slice(t.start, t.end).replace(/^(?:\d{1,3}|[lISBG])?\s?(?:[.•…]\s?)*/, '');
  if (moves.some(t => t.ocr && !t.glyph && !t.fileless && !/^[a-h]{2}\W*$/.test(word(t)) && MISREAD.test(word(t)))) return moves;
  const out = [];
  // (the move numbered last before it one less, or the same, or the one numbered next after it the same, or one more —
  // and no word right before it: "Plan B. Nd5" —, unless the letter before or after its own heads an item on its line or
  // the lines around it: a list's, "A. Bb5⏎B. Bc4⏎C. d4")
  const lineStart = k => text.lastIndexOf('\n', k - 1) + 1;
  const lineEnd = k => (text.indexOf('\n', k) + 1 || text.length + 1) - 1;
  const leads = (i, n) => {
    const t = moves[i];
    const last = out.findLast(o => o.num)?.num;
    const next = moves.slice(i + 1).find(o => o.num && !letter(o))?.num;
    const spaces = /\p{L}([ \t]+)$/u.exec(text.slice(lineStart(t.start), t.start));
    const others = String.fromCharCode(n.charCodeAt(0) - 1, n.charCodeAt(0) + 1);
    const listed = new RegExp(`(?:^|\\s)[${others}]\\.\\s`).test(text.slice(lineStart(lineStart(t.start) - 1), lineEnd(lineEnd(t.end) + 1)));
    return !listed && LETTER_NUMBERS[n].some(k => last === k - 1 || last === k || next === k || next === k + 1) && (!spaces || out.some(o => o.end === t.start - spaces[1].length));
  };
  for (const [i, t] of moves.entries()) {
    const m = letter(t);
    if (!m || leads(i, m[0][0])) {
      out.push(t);
      continue;
    }
    // (the move alone, where it is one: after a space, not glued to the letter's dot — nor a word only an OCR's text has)
    const start = t.start + m[0].length;
    if (t.ocr || !/\s/.test(text[start - 1])) continue;
    const move = { ...t, start, num: null, side: null };
    delete move.cut;
    delete move.nums;
    out.push({ ...move, words: spokenMove(move) });
  }
  return out;
}

// (castling written with zeros and a dash — "0–0" — is a move after a move number or Black's dots, or next to another
// move: a score is written so too, "the match stood at 0–0"; with the letter O, or a hyphen, it is one anywhere)
function castlingWithZeros(text, moves) {
  const dashed = t => /^O-O/.test(t.san) && !t.num && !t.side && /^0[ \t]*[–—]/.test(text.slice(t.start, t.end)) && !/O/.test(text.slice(t.start, t.end));
  if (!moves.some(dashed)) return moves;
  const near = (a, b) => !!a && !!b && /^[\s,;()[\]]{0,3}$/.test(text.slice(Math.min(a.end, b.end), Math.max(a.start, b.start)));
  return moves.filter((t, i) => !dashed(t) || near(moves[i - 1], t) || near(t, moves[i + 1]));
}

/** A move number as a scan may write it ("1 4", "l 7", "2S") as a number (`eight`: its S an 8, not a 5). */
const numberOf = (written, eight = false) =>
  Number(written.replace(/[lI]/g, '1').replace(/S/g, eight ? '8' : '5').replace(/O/g, '0').replace(/B/g, '8').replace(/G/g, '6').replace(/\s/g, ''));

/**
 * Two numbers with a space between them ("1 1.Qxg7#") — or three digits each on its own ("1 0 1.e4") — may be a number
 * cut in two or a puzzle's number and its solution's first move number (the last part) — or, of three digits, the last
 * two after a stray one ("3 1 2.a4" after move 11: `pair`) — moves.js tells which from the moves before it:
 * { cut: { whole, label, num, pair } } or {}.
 * A scan's S may be a 5 or an 8 ("S.Kd4", "lS.Rb8": 15 or 18): { nums: [as a 5, as an 8] } — moves.js takes the one the
 * line being read goes on with.
 */
function cutOf(written, whole) {
  const parts = written && /^(\d+(?: \d)*) (\S+)$/.exec(written);
  const pair = written && /^\d ([1-9]) (\d)$/.exec(written);
  if (parts) return { cut: { whole, label: parts[1].replace(/ /g, ''), num: numberOf(parts[2]), ...(pair ? { pair: Number(pair[1] + pair[2]) } : {}) } };
  return written && /S/.test(written) ? { nums: [whole, numberOf(written, true)] } : {};
}

// (a font's own figurine: a character of Unicode's private use area — after a pawn's last square, the piece it becomes,
// a check after it maybe)
const PRIVATE = /^[\uE000-\uF8FF]$/u;
const PROMOTED = /^([\uE000-\uF8FF])([+#]{0,2})(?![\p{L}\p{N}])/u;

/** How many dots (or bullets) a move number has: one for White's move, two or more — or "…" — for Black's. */
const dotsOf = dots => (!dots ? 0 : dots.includes('…') ? 3 : (dots.match(/[.•]/g) || []).length);

/** A king's move written with a file too many ("Keb6"): { sans } with the moves it may be, or {}. */
function kingFiles(san) {
  const m = /^K([a-h])x?([a-h])([1-8])$/.exec(san);
  if (!m) return {};
  const [, a, b, r] = m;
  const x = san.includes('x') ? 'x' : '';
  const order = (RANK_LIKE[b] || '').includes(r) ? [a, b] : [b, a];
  return { sans: [...new Set([san, ...order.map(f => `K${x}${f}${r}`)])] };
}

function strictMoves(text) {
  const out = [];
  for (const m of text.matchAll(MOVE)) {
    const g = m.groups;
    const written = g.num || g.cut || g.spaced || g.lone || g.lone1;
    const num = written ? numberOf(written) : null;
    const dots = dotsOf(g.dots || g.ldots || g.ldots1);
    const side = num ? (dots >= 2 ? 'black' : 'white') : g.bdots ? 'black' : null;
    const san = g.san
      .replace(/[♔-♞]/g, c => FIGURINES[c] || '')
      .replace(/[:×X]/g, 'x')
      .replace(/–/g, '-')
      .replace(/^[O0]\s*[-—]\s*[O0](\s*[-—]\s*[O0])?$/, (c, long) => (long ? 'O-O-O' : 'O-O'))
      .replace(/^0/, 'O')
      .replace(/-0/g, '-O');
    const start = m.index;
    let end = start + m[0].length;
    // (a pawn's move to the last rank whose piece the text lost — an OCR's figurine after "=": "7.a8=#" —: a
    // promotion, to a queen first; a font's own figurine right after the square — a character of Unicode's private use
    // area, the piece it becomes, a check after it maybe — is the move's, and moves.js puts first the piece the book's
    // moves have taught it to be)
    const last = /^(?:[a-h]x)?[a-h][18]$/.test(san);
    const promoted = last && !g.check && !g.nag ? PROMOTED.exec(text.slice(end, end + 4)) : null;
    if (promoted) end += promoted[0].length;
    const after = text.slice(end, end + 8);
    out.push({
      start,
      end,
      num,
      side,
      san: promoted ? `${san}=Q` : san,
      // (a b-pawn's capture written with a capital — "7. Bxc3" for 7.bxc3, as a scan's text may have it —: the
      // bishop's move first, the pawn's where the bishop has none)
      ...(/^Bx[ac][1-8]$/.test(san) ? { sans: [san, `b${san.slice(1)}`] } : {}),
      ...(last ? { sans: ['Q', 'N', 'R', 'B'].map(p => `${san}=${p}`) } : {}),
      ...(promoted ? { promoted: promoted[1] } : {}),
      // (a king's move with a file before its square — a king needs none —: a scan's letter too many, "Keb6", "Kcc7":
      // the square on either file — first the one before it when the other letter is one an OCR reads for the rank's
      // digit, "b" for 6)
      ...kingFiles(san),
      check: promoted ? promoted[2] && (promoted[2].includes('#') ? '#' : '+') : g.check === 'm' ? '#' : g.check || '',
      pawn: /^[a-h]/.test(san) && !/-/.test(san),
      square: /^[a-h][1-8]$/.test(san) && /^(?:-|\s)square/i.test(after),
      words: '',
      ...cutOf(g.cut || g.lone || g.lone1, num),
    });
    out.at(-1).words = spokenMove(out.at(-1));
    out.at(-1).written = writtenOf(out.at(-1), m.indices.groups.san[0]);
  }
  return out;
}

/**
 * What the book wrote of a move, kept as it was (moves.js says the move as it is played, and follows a book's moves
 * again when a board is read again): its check sign, and where the move itself begins in the text, after its number
 * and dots.
 */
const writtenOf = (t, at) => ({ check: t.check, at });

// A scanned page's moves: the OCR often reads a digit as a letter — 4 as a, d, g or q; 5 as s, b or S (S for 8 too);
// 6 as é, b or G; 1 as l, i or I; 2 as z; 8 as B or & —, f as £ or {, c or e as ¢, e as €, a check as t, and castling
// with zeros.
// Such a word, where it stands among moves (after a move number, or next to another move; a capture with a digit
// anywhere — "fixed" is a word —; not a square of a piece's way, "Kc7-b7-a6"), is a move with the readings it may have
// (sans): the board plays the first one that is legal (moves.js), the voice says that one — and the word as it is
// written when none is. Long algebraic too ("Bfl-g2", "RaS-bS"), and a pawn's capture named by its two files ("10 e5
// de": d takes on e), as older books write it.
const RANK_LIKE = { l: '1', i: '1', I: '1', '|': '1', z: '2', Z: '2', a: '4', d: '4', g: '4', q: '4', A: '4', s: '5', S: '58', $: '56', b: '56', é: '6', G: '6', T: '7', B: '8', '&': '8' };
const FILE_LIKE = { '£': 'f', '{': 'f', '¢': 'ce', '€': 'e' };
const R = '[1-8liIzZadgqAsSbéGTB&|$]';
const F = '[a-h£{¢€]';
// (a rank's digit read twice, as a letter and as itself — "KeS5", "Kdé6", "Khl1": the digit)
const TWICE = '[lIiSs$éGbB&][1-8]';
// (an exclamation mark read as l or I: "23. Rc1l"; the move numbers as strict moves have them — cut in two, a letter
// for a digit, bullets for dots: "1 1 . KdS", "l 6.KfS", "S.QdS", "5 • • • Rfl" —; a pawn's promotion: "bI=Q", "¢8=Q";
// its glyphs are the move's: "19 RhB! Rd7", Black's reply right after)
const OCR_MOVE = new RegExp(
  `(?<![\\p{L}\\p{N}.\\-–])(?:${APART}(?<cut>${CUT})(?<cdots>\\s?(?:[.•]\\s?){1,4})|(?<num>\\d{1,3})(?<dots>\\s?(?:[.•]\\s?){1,4}|\\s)|${APART}${LONE_NUMBER}|(?<bdots>\\.{2,3}|…)\\s?)?(?<tok>[KQRBN]?${F}${R}[-–:x×X]${F}${R}|[KQRBN]?${F}?${R}?[x:×X]?${F}(?:${TWICE}|${R})|[O0]-[O0](?:-[O0])?[O0]?|(?<pf>[a-h])(?<pt>[a-h]))(?<promo>=[QRBN])?(?<chk>[+†‡#t]?)(?:[lI](?=[\\s,;)]|$)|[!?]{1,2})?(?![\\p{L}\\p{N}]|[-–][a-h])`,
  'dgu',
);
const OCR_WORDS = new Set(['as', 'ad', 'ha', 'hi', 'Bag', 'Bad', 'Bed', 'Red', 'Rad', 'fixed', 'fixes']); // (said as words unless among moves)

/** The moves a word read by OCR may be (plain SAN), the reading as it is first (`promo`: "=Q" after it, a pawn's). */
function readings(tok, promo = '') {
  if (/^[O0]-/.test(tok)) return promo ? [] : /^[O0]-[O0]-[O0]/.test(tok) ? ['O-O-O', 'O-O'] : ['O-O', 'O-O-O'];
  const out = [];
  const m = new RegExp(`^([KQRBN]?)(${F}?)(${R}?)([-–x:×X]?)(${F})(${TWICE}|${R})$`, 'u').exec(tok);
  if (m && !(/[-–]/.test(m[4]) && !(m[2] && m[3]))) {
    const [, piece, ff, fr, x, file, rank] = m;
    const files = c => (c ? [...(FILE_LIKE[c] || c)] : ['']);
    // (a digit read twice: the digit, when the letter is one the OCR reads for it)
    const ranks = c => (!c ? [''] : c.length === 2 ? ((RANK_LIKE[c[0]] || '').includes(c[1]) ? [c[1]] : []) : /\d/.test(c) ? [c] : [...(RANK_LIKE[c] || '')]);
    for (const a of files(ff)) for (const b of ranks(fr)) for (const c of files(file)) for (const d of ranks(rank)) out.push(`${piece}${a}${b}${x && !/[-–]/.test(x) ? 'x' : ''}${c}${d}`);
  }
  // (a pawn's capture by its files, after the rest — "ed" is e4 first —, from the lowest rank: the board tells)
  if (!promo && /^[a-h]{2}$/.test(tok) && Math.abs(tok.charCodeAt(0) - tok.charCodeAt(1)) === 1) out.push(...[...'2345678'].map(r => `${tok[0]}x${tok[1]}${r}`));
  const valid = out.filter(s => /^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8]$/.test(s) && /[KQRBNx]|^[a-h][1-8]$|^[a-h][1-8][a-h][1-8]$/.test(s));
  // (a promotion: a pawn's move to the last rank)
  return promo ? valid.filter(s => /^[a-h](?:x[a-h])?[18]$/.test(s)).map(s => s + promo) : valid;
}

// A pawn's move after a move number whose file the app's own OCR lost (`scan`: in a PDF's own text such a number is a
// decimal, an evaluation, "14.Nf3 (1.25)") — a bold letter read as a digit ("2.24", "7...56") or not read at all
// ("11.4") —: a move to that rank on a file the board tells (its readings, each file's): played where one file's pawn
// can make it, or where the moves after it say which (as a lost figurine: moves.js); the digit read for a letter is
// learnt as that file, as a figurine's glyph is learnt as its piece. Only next to another move — or, the file read as a
// digit, alone on its line: a game's heading, "(rapid 2.5) 1998", or a section's number, "3.1 Two Bishops", has no move
// there.
const NO_FILE = /(?<![\p{L}\p{N}.])(?:(?<num>\d{1,3})(?<dots>\.{1,3}|…)|(?<bdots>\.{2,3}|…))(?<f>\d)?(?<r>[1-8])(?<promo>=[QRBN])?(?<chk>[+#†]?)(?<nag>[!?]{1,2})?(?=[\s,;:)]|\.(?!\d)|$)/dgu;

function ocrMoves(text, strict, scan) {
  const found = [];
  for (const m of text.matchAll(OCR_MOVE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (strict.some(t => t.start < end && t.end > start)) continue;
    const g = m.groups;
    const sans = readings(g.tok, g.promo);
    const written = g.num || g.cut || g.lone || g.lone1;
    const num = written ? numberOf(written) : null;
    if (!sans.length || (!num && OCR_WORDS.has(g.tok))) continue;
    const side = num ? (dotsOf(g.dots || g.cdots || g.ldots || g.ldots1) >= 2 ? 'black' : 'white') : g.bdots ? 'black' : null;
    found.push({ start, end, num, side, san: sans[0], sans, check: /[+†t]/.test(g.chk) ? '+' : g.chk, pawn: !/^[KQRBNO]/.test(sans[0]), square: false, ocr: true, words: text.slice(start, end), sure: !!num || !!g.bdots || (/x/.test(sans[0]) && /\d/.test(g.tok)) || /^O-O/.test(sans[0]), ...cutOf(g.cut || g.lone || g.lone1, num) });
    found.at(-1).written = writtenOf(found.at(-1), m.indices.groups.tok[0]);
  }
  for (const m of scan ? text.matchAll(NO_FILE) : []) {
    const start = m.index;
    const end = start + m[0].length;
    if ([...strict, ...found].some(t => t.start < end && t.end > start)) continue;
    const g = m.groups;
    const num = g.num ? Number(g.num) : null;
    if (g.num && (g.f === '0' || num === 0)) continue;
    const sans = [...'abcdefgh'].map(f => `${f}${g.r}${g.promo || ''}`);
    const side = num && !/\.{2}|…/.test(g.dots) ? 'white' : 'black';
    // (its digit's key is its own: not a figurine read as that digit, see GLYPH_MOVE)
    found.push({ start, end, num, side, san: sans[0], sans, glyph: g.f ? `file ${g.f}` : '\uFFFD', check: /[+†]/.test(g.chk) ? '+' : g.chk, pawn: true, fileless: true, square: false, ocr: true, words: text.slice(start, end), sure: !!g.f && /(?:^|\n)[ \t]*$/.test(text.slice(Math.max(0, start - 20), start)) && /^[,.;:)]?[ \t]*(?:\n|$)/.test(text.slice(end)) });
    found.at(-1).written = writtenOf(found.at(-1), (m.indices.groups.f || m.indices.groups.r)[0]);
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

// A table of a game's moves on a scan: a line of a move number and a move or two — "12 Rd1 Nf6", "16 ... exd4" — holds
// nothing but moves after its number. A word there that the OCR made no move of ("9 13 Kd?", "27 RfbH Ra7": f3 and
// Kd7, Rf6+) is a move all the same (`fuzzy`: the word as read; the board plays the legal move most like it, if one is:
// moves.js) — White's with the row's number, Black's after it or after the dots. Only short words that may be a move's
// (two to six characters, a piece's letter, a file or a digit first; not a word of three small letters but a capture's
// x: "and", not "axbo"; not a digit alone, "4 4": a number's), and only on a line of such words.
const ROW_LINE = /^(\d{1,3})\.?[ \t]+(\S+)(?:[ \t]+(\S+))?(?:[ \t]+(\S+))?[ \t]*$/gm;
const ROW_WORD = /^(?!.*[a-wyz]{3})[KQRBNa-h1-8lI¢€£{]\S{1,5}$/u;
const ROW_DOTS = /^(?:[.,•]{2,}|…|vs|\.{2,}[,.]*)$/;

export function rowMoves(text, found) {
  const out = [];
  for (const m of text.matchAll(ROW_LINE)) {
    const words = m.slice(2).filter(Boolean);
    const at = [];
    let pos = m.index + m[1].length;
    for (const w of words) {
      const start = text.indexOf(w, pos);
      pos = start + w.length;
      at.push({ w, start, end: pos, move: found.find(t => t.start < pos && t.end > start) });
    }
    // (every word a move, dots, or a word a move may have been read as)
    if (!at.every(x => x.move || ROW_DOTS.test(x.w) || ROW_WORD.test(x.w))) continue;
    let side = 'white';
    let first = true;
    for (const x of at) {
      if (ROW_DOTS.test(x.w)) {
        side = 'black';
        continue;
      }
      if (!x.move) out.push({ start: x.start, end: x.end, num: first ? Number(m[1]) : null, side: first ? side : null, san: x.w, fuzzy: x.w, check: /[+#]/.test(x.w) ? '+' : '', pawn: false, square: false, ocr: true, sure: true, words: x.w, written: { check: '', at: x.start } });
      first = false;
    }
  }
  return out;
}

// How much a word read by OCR looks like a move written in SAN: the characters' edits, a character for another of like
// printed shape cheaper (a small scan's 3, 5, 8 and S; 6, b and o; 7 and ?; c and e…), a sign the OCR added (!, ?, a
// letter doubling its neighbour: "Kdé6", "RaB8") cheaper too. 0 for the same, about 1 for one plain edit.
const SHAPES = ['1lIi|!7ft[]', '2zZ', '358sS$B§9j', '4dAaqg', '56bGéoO0j', '7?T/1', '8B3&$S0', 'ceo¢€(C', 'f1t£{l', 'bh6', 'gq9', 'xX×:%', '+Ht#'];
const ALIKE = new Map(); // (each pair's cost, as asked: a scan's words are compared with many moves)
const alike = (a, b) => {
  let v = ALIKE.get(a + b);
  if (v === undefined) ALIKE.set(a + b, (v = a === b ? 0 : a.toLowerCase() === b.toLowerCase() ? 0.2 : SHAPES.some(c => c.includes(a) && c.includes(b)) ? 0.4 : 1));
  return v;
};
const SIGNS = '!?.,;:\'"’‘-—_~*';

/** (`limit`: a word less like the move than this — Infinity once that is sure, as no row of edits costs less after.) */
export function wordDistance(word, san, limit = Infinity) {
  const n = word.length;
  const m = san.length;
  let prev = new Float64Array(m + 1);
  for (let j = 1; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const c = word[i - 1];
    // (left out: a sign, or a character doubling its neighbour's shape)
    const drop = SIGNS.includes(c) || (i > 1 && alike(c, word[i - 2]) < 1) || (i < n && alike(c, word[i]) < 1) ? 0.5 : 1;
    const cur = new Float64Array(m + 1);
    let least = (cur[0] = prev[0] + drop);
    for (let j = 1; j <= m; j++) least = Math.min(least, (cur[j] = Math.min(prev[j] + drop, cur[j - 1] + 1, prev[j - 1] + alike(c, san[j - 1]))));
    if (least > limit) return Infinity;
    prev = cur;
  }
  return prev[m];
}

/**
 * The strings as like a word read by OCR as half an edit (wordDistance at most 0.5): the word, one of its characters for
 * one of like shape or of the other case, two for the other case, or a sign or a character doubling its neighbour left
 * out — what the word may be, looked up as moves instead of comparing every legal move with it.
 */
export function closeSpellings(word) {
  const out = new Set([word]);
  const n = word.length;
  const other = c => (c.toLowerCase() !== c ? c.toLowerCase() : c.toUpperCase() !== c ? c.toUpperCase() : null);
  const put = (i, c) => `${word.slice(0, i)}${c}${word.slice(i + 1)}`;
  for (let i = 0; i < n; i++) {
    const c = word[i];
    const o = other(c);
    if (o?.length === 1) out.add(put(i, o));
    for (const group of SHAPES) if (group.includes(c)) for (const b of group) if (b !== c && b.toLowerCase() !== c.toLowerCase()) out.add(put(i, b));
    if (SIGNS.includes(c) || (i > 0 && alike(c, word[i - 1]) < 1) || (i < n - 1 && alike(c, word[i + 1]) < 1)) out.add(`${word.slice(0, i)}${word.slice(i + 1)}`);
    for (let j = i + 1; j < n; j++) {
      const p = other(word[j]);
      if (o?.length === 1 && p?.length === 1) out.add(put(j, p).slice(0, i) + o + put(j, p).slice(i + 1));
    }
  }
  return out;
}

// A small scan's digits, as an OCR may read one for another: their printed shapes alike — 3, 5, 6 and 8 (closed or
// open curves), 1 and 7 (a stem).
const DIGIT_LIKE = { 3: '58', 5: '36', 6: '58', 8: '36', 1: '7', 7: '1' };

/**
 * The other readings a move read by the app's own OCR may have, or null: { sans: its readings and, for a stroke it read
 * where a square's rank stands, an l or an I ("Kel": a small scan's 1, 2 or 3 alike), each digit there — the moves after
 * it tell which, as written on a tie (moves.js) —, like: each of its squares' digits read as another of like shape
 * ("g3": g5, g8) — only when no reading is legal: a good scan's digits are read right }.
 */
export function misreadings(t) {
  if (t.desc || t.spelled || t.glyph || t.fuzzy || /^O-O/.test(t.san || '')) return null;
  const read = t.sans || [t.san];
  const unsure = [];
  const like = [];
  // (the word as the OCR read it, from where the move itself begins: see writtenOf)
  const word = t.ocr ? (t.words || '').slice(t.written ? t.written.at - t.start : 0).replace(/[+#†‡t!?]+$/, '') : '';
  for (const san of read)
    for (let i = 0; i < san.length; i++) {
      for (const d of DIGIT_LIKE[san[i]] || '') like.push(`${san.slice(0, i)}${d}${san.slice(i + 1)}`);
      if (word.length === san.length && /[1-8]/.test(san[i]) && /^[lIi|]$/.test(word[i])) for (const d of '12345678') unsure.push(`${san.slice(0, i)}${d}${san.slice(i + 1)}`);
    }
  const sans = [...new Set([...read, ...unsure])];
  const others = [...new Set(like)].filter(s => !sans.includes(s));
  return sans.length > read.length || others.length ? { sans, like: others } : null;
}

// Figurines a PDF's text has lost: a book's figurine font without Unicode for its glyphs, or a scanner's OCR of them,
// gives other characters where the piece's letter goes ("�e5", "i.f6", "ttld1", "'1Wxb6", "l:td1") — the same ones
// for the same piece throughout the book, most often. Such a short word right before a square (a check after it may
// be read as t), where a move stands (after a move number — as a scan writes it too: "1 5.lLld6t" — or Black's dots,
// or next to another move), is a move of an unknown piece (`glyph`: the word): its readings are each piece's moves
// there (with the word's last letter or digit as the piece's file or rank, too); moves.js plays the one that is legal
// — or the one the moves after it can be played after —, and learns from the moves only one piece could make which
// piece the word is.
// (a figurine an OCR read as a digit — "2d3+", "6.2c5+", "16.1acl", Amateur to IM's rook — or a digit and signs —
// "4>a8", its king's "<4>" without its first sign — is one too; and the move number 1 may be read as l or I, "I.*e4",
// "l...*e6")
const GLYPH_MOVE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${APART}(?<cut>${CUT})(?<cdots>\\s?(?:[.•]\\s?){1,4}|\\s?…\\s?)|(?<num>\\d{1,3})(?<dots>\\s?(?:[.•]\\s?){1,4}|\\s?…\\s?|\\s)|${APART}(?<lone>[lI])(?<ldots>\\s?(?:[.•]\\s?){1,3}|\\s?…\\s?)|(?<bdots>\\.{2,3}|…)\\s?)?` +
    '(?<glyph>(?!\\d)[^\\s()[\\]{},;]{1,4}?|\\d(?:[^\\s\\p{L}\\p{N}()[\\]{},;.…•]{1,2}|[a-h])?)(?<x>[x:×X]?)(?<sq>[a-h][1-8lIS])(?<chk>[+#†t]{0,2})(?<nag>[!?]{1,2})?(?![\\p{L}\\p{N}])',
  'dgu',
);

function glyphMoves(text, strict) {
  const found = [];
  for (const m of text.matchAll(GLYPH_MOVE)) {
    const g = m.groups;
    // (a piece's letter or figurine is no lost glyph: strictMoves reads it; nor a pawn's file before its capture —
    // "exd5" — (a file's letter with no capture is a glyph: "gc2"), nor dots, nor a scan's "l." for "1.", nor a word's
    // end, nor quotes, nor a square's — "g5/e4" —, a move number's — "+–6.Bf2" —, a promotion's — "f8=QRa1" —; a
    // square with a letter for its digit, "fl", only after junk: "Tal" and "Abel" are names) — but a piece's letter
    // after a 1 read as l or I, its dots spread, is that piece's move: "I .. .Rb8")
    const letter = !!g.lone && /^[KQRBN]$/.test(g.glyph);
    if ((/^[KQRBN♔-♞]$/.test(g.glyph) && !letter) || /^[KQRBN][a-h1-8]$/.test(g.glyph) || (/^[a-h]$/.test(g.glyph) && g.x) || /^[.…]+$/.test(g.glyph) || /^[lIS]\./.test(g.glyph)) continue;
    // (letters before such a square are a move after a move number or Black's dots — "16.Hgl", "9.lLlbl", "18. flael" —
    // unless they make a name, a capital and small letters with a vowel, after a puzzle's or a game's number: "137. Tal",
    // "7. Abel"; elsewhere — next to a move — only letters no word has, without a vowel: "Hdl", "Wxfl+")
    const word = `${g.glyph}${g.x}${g.sq}`;
    const named = /^[A-Z][a-z]+$/.test(word) && /[aeiouy]/.test(word.slice(1));
    const voiced = /[aeiouy]/i.test(word);
    // (three small letters are a word's end — but a figurine an OCR read so right after a move number's dots or Black's
    // dots: "8.sfeg3!", "12.ttlf3")
    const dotted = !!g.bdots || (!!(g.num || g.cut || g.lone) && /[.•…]/.test(g.dots ?? g.cdots ?? g.ldots ?? ''));
    if ((/^[a-z]{3,}$/.test(g.glyph) && !dotted) || /["“”‘’]/.test(g.glyph) || /[a-h][1-8]|\d\.|^[KQRBN]{2}$/.test(g.glyph) || (/[lIS]$/.test(g.sq) && /^\p{L}+$/u.test(g.glyph) && ((!(g.num || g.cut || g.lone || g.bdots) && voiced) || named))) continue;
    const start = m.index;
    const end = start + m[0].length;
    // (a move the text has with its letter, or a numbered pawn move — "S.dxc3", the scan's 5.dxc3)
    if (strict.some(t => t.start < end && t.end > start && (!t.pawn || t.num))) continue;
    const written = g.num || g.cut;
    const num = written ? numberOf(written) : g.lone ? 1 : null;
    const dots = g.dots ?? g.cdots ?? g.ldots ?? '';
    const extra = /[a-h1-8]$/.test(g.glyph) && g.glyph.length > 1 ? ['', g.glyph.slice(-1)] : [''];
    const sq = g.sq.replace(/[lI]/, '1').replace('S', '5');
    const sans = letter ? [`${g.glyph}${g.x ? 'x' : ''}${sq}`] : [...'NBRQK'].flatMap(p => extra.map(d => `${p}${d}${g.x ? 'x' : ''}${sq}`));
    const side = num ? ((dots.match(/[.•…]/g) || []).length >= 2 || dots.includes('…') ? 'black' : 'white') : g.bdots ? 'black' : null;
    const check = g.chk ? (g.chk.includes('#') ? '#' : '+') : '';
    const glyph = letter ? null : g.glyph.replace(/[a-h1-8]$/, d => (extra.length > 1 ? '' : d));
    // (a character of Unicode's private use area is a font's own figurine — no OCR writes one —: a move wherever it
    // stands, as a piece's letter is — a reply at a sentence's start after the comments on the move before)
    found.push({ start, end, num, side, san: sans[0], sans, ...(glyph ? { glyph } : {}), check, pawn: false, square: false, ocr: true, words: text.slice(start, end), sure: !!num || !!g.bdots || PRIVATE.test(glyph || ''), ...cutOf(g.cut, num) });
    found.at(-1).written = writtenOf(found.at(-1), m.indices.groups.glyph[0]);
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
// Diagrams named in the text

// (a diagram's number: in its caption, "DIAGRAM 10." under it — a scanner's text may space it out, "DIA GRAM 2 7 ." —,
// and where the text names it, "Look at Diagram 10 again", "Exercise 3 (Diagram 58): …", "from diagram (46)", "Diag. 12",
// "Fig. 3")
const DIAGRAM_WORD = String.raw`\b(?:d\s?i\s?a\s?g(?:\s?r\s?a\s?m)?|fig(?:ure)?)\.?\s*(?:\(\s*)?`;
const DIAGRAM_NUMBER = String.raw`((?:\d\s?){1,3})(?!\s?\d)`;

/**
 * The number a diagram's caption gives it ("DIAGRAM 1 0 ." → "10"; `whole`: when the caption is all its line,
 * "Diagram 62" — a line near a board that only begins so is the text's), or null.
 */
export function diagramNumber(caption, whole = false) {
  const m = new RegExp(String.raw`^\s*${DIAGRAM_WORD}${DIAGRAM_NUMBER}${whole ? String.raw`\s*\.?\s*$` : ''}`, 'i').exec(caption);
  return m ? m[1].replace(/\s/g, '') : null;
}

/**
 * Where a page's `text` first names the diagram numbered `number` (by its caption: [start, end] in the text) —
 * "Diagram 4 hides a trap …", "Diagram 14 is the twin of …" —, outside the caption: the start of the sentence naming it
 * (not before a move, a bracket or another sentence), or null.
 */
export function namedAt(text, number, [start, end]) {
  for (const x of text.matchAll(new RegExp(DIAGRAM_WORD + [...number].join(String.raw`\s?`) + String.raw`(?!\s?\d)`, 'gi'))) {
    if (x.index >= start && x.index < end) continue;
    let at = x.index;
    while (at > 0 && !/[\d.!?…:;()[\]-]/.test(text[at - 1])) at--;
    while (/\s/.test(text[at])) at++;
    return at;
  }
  return null;
}

/**
 * The number of the diagram a text names last ("… Exercise 2 (Diagram 59): an old study …" → "59"), or null — `near`:
 * only in the text's last sentence, and not a caption beginning a line ("Diagram 31: Black's turn"): the words that
 * send the move after them there, "If White waits instead (see diagram 62), 1.Kd2 …".
 */
export function namedDiagram(text, near = false) {
  const all = [...text.matchAll(new RegExp(DIAGRAM_WORD + DIAGRAM_NUMBER, 'gi'))];
  const m = near ? all.filter(x => !/(?:^|\n)[ \t]*$/.test(text.slice(0, x.index))).at(-1) : all.at(-1);
  if (!m || (near && /[.!?]["”’)]*\s+[A-Z0-9]/.test(text.slice(m.index + m[0].length)))) return null;
  return m[1].replace(/\s/g, '');
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
    // (a line break within a move — castling cut at a line's end, "O-⏎O" — ends no sentence)
    if (c === '\n' && !inMove[i]) {
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
