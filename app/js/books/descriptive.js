// Descriptive notation (Book reader): how older English books write moves — "P-K4", "Kt-KB3", "PxP", "B-N5 ch",
// "Castles", spaced as "Kt - Kt 6 ch", or the older "P to K 4", "K. Kt. to B. 3rd", "Q. takes P. (ch.)". A square is
// named from the side of the player moving (K4 is e4 for White and e5 for Black), its file by the piece that starts
// there (QR a, QKt/QN b, QB c, Q d, K e, KB f, KKt/KN g, KR h) — "B4" is c4 or f4 —, and a piece or pawn by its kind
// and file ("KBP": the pawn of the f-file; "QB": the bishop that started on c1/c8). Such a move only says which moves
// it may be: the board plays the one that is legal where it is read (moves.js).
import { posFromFen, uciOf, parseSan } from '../chess.js';

const L = '(?:Kt|KT|[KQRBNP])'; // a letter of the notation
const SP = "(?:['’]s\\s?|\\.?\\s?)"; // between letters: "KB", "K B", "K. B.", "K's B"
const NAME = `${L}(?:${SP}${L}){0,2}`; // a piece or a pawn: "P", "KBP", "K. Kt.", "Q R"
const FILE = `(?:[KQ](?:${SP}(?:Kt|KT|[RBN]))?|Kt|KT|[RBN])`; // "K", "QB", "K. Kt."
// a rank: "4", "4th", "sq" (the first; a scan may read it "eq")
const RANK = '(?:[1-8](?:st|nd|rd|th|d)?|[se]q(?:uare)?)(?![\\p{L}\\p{N}])';
const SQUARE = `${FILE}\\.?\\s?${RANK}`;
// (what a capture takes ends where the next move's piece begins: "KxQ B-K3")
const NOT_NEXT = '(?!\\.?\\s?(?:[-–—x×:]|to(?!\\p{L})|takes))';
const WING = "(?:[KQ]['’]?s?\\.?|[Kk]ing['’]?s?|[Qq]ueen['’]?s?)";
const SIDE = '\\s?(?:side|R(?:ook)?\\.?)';
const MOVE = new RegExp(
  '(?<![\\p{L}\\p{N}.])' +
    // a move number ("12.", "12", "12...", "12. …" — Black's —; a scan's 7 read as T, 1 as l or I, 2 as Z, glued to the
    // move), or Black's "...", "…"
    `(?:(?<num>\\d{1,3}|[TlIZ](?=${L}))(?<dots>\\s?(?:\\.\\s?){1,3}(?:…\\s{0,6})?|\\s?…\\s{0,6}|\\s{0,6})|(?<bdots>\\.{2,3}|…)\\s?)?` +
    '(?<core>' +
    // castling: "Castles", "Castles (K R)", "castles Q side"
    `(?<castle>[Cc]astles?(?:\\s?\\((?:on\\s(?:the\\s)?)?${WING}(?:${SIDE})?\\s?\\)|\\s(?:on\\s(?:the\\s)?)?${WING}${SIDE})?)` +
    '|' +
    // the piece, where it stands when more than one could go ("R(1)", "N/Q2"), and where it goes or what it takes
    `(?<piece>${NAME})(?<from>\\s?\\((?:${NAME}\\s?)?[1-8]\\)|\\/(?:${NAME})?[1-8])?\\.?` +
    `(?:(?:\\s?[-–—]\\s?|\\s?to\\s?)(?<target>${SQUARE})` +
    `|(?<xsep>\\s?[x×:]\\s?|\\s?takes\\s?)(?<victim>${NAME}(?:\\s?[/(]\\s?(?:${SQUARE}|[1-8])\\)?)?)${NOT_NEXT})` +
    '(?<promo>\\s?(?:=|\\/|\\()\\s?(?:Q|R|B|N|Kt)\\)?)?' +
    "(?<ep>\\s?e\\.\\s?p\\.?|\\s?ep(?![\\p{L}])|\\s?en\\spas(?:s(?:ant)?)?\\.?)?" +
    ')' +
    // check ("ch", "dis ch", "(ch.)", "+"), mate, and the annotator's ! and ?
    '(?<check>[.,]?\\s?\\(?(?:dis(?:c(?:overed)?)?\\.?\\s?|dbl\\.?\\s?|double\\s)?(?:ch(?:eck)?(?:\\s?mate)?(?:\\.(?=\\)))?|mate)\\)?(?![\\p{L}\\p{N}])|\\s?[+#†‡]{1,2})?' +
    '(?<nag>\\s?[!?]{1,2})?' +
    '(?![\\p{L}\\p{N}])',
  'gu',
);
const OCR_NUMBERS = { T: 7, l: 1, I: 1, Z: 2 };

const ROLES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
const FILES = { QR: [0], QN: [1], QB: [2], Q: [3], K: [4], KB: [5], KN: [6], KR: [7], R: [0, 7], N: [1, 6], B: [2, 5] };
const letters = s => (s.match(/Kt|KT|[KQRBNP]/g) || []).map(l => (/^K[tT]$/.test(l) ? 'N' : l));

/** A file named by its letters ("K", "QB", "R"): the files it may be (0 = a … 7 = h), or null. */
const fileOf = ls => FILES[ls.join('')] || null;

/** A square name ("KB3", "Q R 4th", "K sq"): { files, rank (1–8, from the side of the player moving) } or null. */
function squareOf(s) {
  const m = new RegExp(`^(.*?)\\.?\\s?(${RANK})\\.?$`, 'u').exec(s.trim());
  if (!m) return null;
  const files = fileOf(letters(m[1]));
  const rank = /^[se]q/.test(m[2]) ? 1 : Number(m[2][0]);
  return files ? { files, rank } : null;
}

/**
 * A piece named by its letters ("P", "KBP", "QR", "Kt"): { role, files (a pawn's: where it stands), wing ('K' or 'Q':
 * the side a piece started on) } or null.
 */
function pieceOf(ls) {
  const role = ROLES[ls.at(-1)];
  if (!role) return null;
  const before = ls.slice(0, -1);
  if (!before.length) return { role };
  if (role === 'pawn') {
    const files = fileOf(before);
    return files ? { role, files } : null;
  }
  if (before.length === 1 && 'KQ'.includes(before[0]) && ['rook', 'knight', 'bishop'].includes(role)) return { role, wing: before[0] };
  return null;
}

/** What a move written in descriptive notation says (the groups of MOVE), or null when it says nothing sensible. */
function describe(g) {
  if (g.castle) {
    const wing = g.castle.replace(/^[Cc]astles?/, '');
    return { castle: /^\W*(?:on\s(?:the\s)?)?[Qq]/.test(wing) ? 'Q' : /^\W*(?:on\s(?:the\s)?)?[Kk]/.test(wing) ? 'K' : null };
  }
  const capture = !!g.xsep;
  const piece = pieceOf(letters(g.piece));
  if (!piece) return null;
  const desc = { ...piece, capture };
  if (g.from) {
    const from = /^\/?\(?\s*(.*?)\)?$/.exec(g.from.trim())[1];
    desc.from = /^[1-8]$/.test(from) ? { rank: Number(from) } : squareOf(from);
    if (!desc.from) return null;
  }
  if (!capture) {
    desc.to = squareOf(g.target);
    if (!desc.to) return null;
  } else {
    // a capture names what it takes ("BxKt", "PxQP"), and where when it must ("RxP/7", "BxP(KB6)")
    const [what, where] = g.victim.split(/\s?[/(]\s?/);
    desc.victim = pieceOf(letters(what));
    if (!desc.victim) return null;
    if (where) {
      const w = where.replace(/\)$/, '').trim();
      desc.to = /^[1-8]$/.test(w) ? { rank: Number(w) } : squareOf(w);
      if (!desc.to) return null;
    }
  }
  if (g.promo) desc.promo = ROLES[letters(g.promo)[0]];
  return desc;
}

/**
 * The moves in descriptive notation written in `text`: [{ start, end, num, side, san (as written, until the board
 * knows the move), desc (what it says: see descriptiveMoves), check, pawn: false, words }]. A move numbered like the
 * one before it on the same line ("3 P to Q 4  3 P takes P", a game in two columns) is Black's.
 */
export function findDescriptive(text) {
  const out = [];
  for (const m of text.matchAll(MOVE)) {
    const g = m.groups;
    const desc = describe(g);
    if (!desc) continue;
    const num = g.num ? OCR_NUMBERS[g.num] || Number(g.num) : null;
    const dots = g.dots || '';
    const black = /…/.test(dots) || (dots.match(/\./g) || []).length >= 2 || !!g.bdots;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      num,
      side: black ? 'black' : num ? 'white' : null,
      san: g.core.replace(/\s+/g, ' '),
      desc,
      check: g.check ? (/mate|#|‡/.test(g.check) ? '#' : '+') : '',
      pawn: false,
      square: false,
      words: '',
    });
  }
  // two columns, White's and Black's: the second of a number on a line is Black's (on the next line, another move)
  for (let i = 1; i < out.length; i++) {
    const [a, b] = [out[i - 1], out[i]];
    if (b.num && b.num === a.num && a.side === 'white' && b.side === 'white' && !text.slice(a.end, b.start).includes('\n')) b.side = 'black';
  }
  // "Castles" is a move only where moves are — numbered, or next to another —, else a word ("White castles")
  const near = (a, b) => /^[\s,;]{0,3}$/.test(text.slice(a.end, b.start));
  const castles = t => 'castle' in t.desc;
  const moves = out.filter((t, i) => !castles(t) || t.num || (out[i - 1] && !castles(out[i - 1]) && near(out[i - 1], t)) || (out[i + 1] && !castles(out[i + 1]) && near(t, out[i + 1])));
  for (const t of moves) t.words = spokenDescriptive(t);
  return moves;
}

// ---------------------------------------------------------------------------------------------
// Moves spelled out in words, as older books write them (in their notes, or under a game's moves — Cook's primer says
// each move again so: "(Pawn to Queen's fourth.)"): "Pawn to King's fourth", "King's Knight to Bishop's third", "Queen
// takes Pawn, check", "Castle to King's square", "Bishop takes Knight at Queen's Bishop's sixth" — or with a square's
// name: "knight to f3", "the bishop takes on e5". The voice says them as they are written.

const W_OWN = "(?:['’]s)?";
const W_WING = `(?:[Kk]ing|[Qq]ueen)${W_OWN}`;
const W_SIDE = `(?:[Rr]ook|[Bb]ishop|[Kk]night|[Kk]t\\.?)${W_OWN}`;
const W_PIECE = '(?:[Kk]ing|[Qq]ueen|[Rr]ook|[Cc]astle|[Bb]ishop|[Kk]night|[Pp]awn)';
const W_NAME = `(?:${W_WING}\\s)?(?:${W_SIDE}\\s)?${W_PIECE}`; // "Pawn", "King's Bishop's Pawn", "Queen's Knight"
const W_RANK = '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|[1-8](?:st|nd|rd|th)|square|sq\\.?)';
const W_SQUARE = `(?:${W_WING}\\s(?:${W_SIDE}\\s)?|${W_SIDE}\\s)${W_RANK}`; // "King's fourth", "Queen's Bishop's third", "Rook's square"
const SQ = '[a-h][1-8]';
const SPELLED = new RegExp(
  '(?<![\\p{L}\\p{N}])' +
    '(?:(?<num>\\d{1,3})(?<dots>\\s?(?:\\.\\s?){1,3}|\\s))?' +
    `(?:(?:[Tt]he|[Hh]is|[Hh]er)\\s)?(?<piece>${W_NAME})\\s` +
    `(?:(?:moves\\s|goes\\s|plays\\s)?to\\s(?:the\\s)?(?:(?<square>${W_SQUARE})|(?<sq>${SQ}))` +
    `|(?<x>takes|captures)\\s(?:the\\s)?(?:(?<victim>${W_NAME})(?:,?\\s(?:on|at)\\s(?:the\\s)?(?:(?<at>${W_SQUARE})|(?<atsq>${SQ})))?|(?:on\\s)?(?<xsq>${SQ})))` +
    '(?<check>,?\\s\\(?(?:giving\\s)?check(?:mate)?\\)?|,?\\s(?:and\\s)?mates?|\\s?[+#])?' +
    '(?![\\p{L}\\p{N}])',
  'gu',
);
const WORD_LETTERS = { king: 'K', queen: 'Q', rook: 'R', castle: 'R', bishop: 'B', knight: 'N', kt: 'N', pawn: 'P' };
const wordLetters = s => (s.toLowerCase().match(/king|queen|rook|castle|bishop|knight|kt|pawn/g) || []).map(w => WORD_LETTERS[w]);
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 };

/** A square in words ("King's Bishop's third", "Rook's square"): { files, rank (from the mover's side) } or null. */
function wordSquare(s) {
  const m = new RegExp(`${W_RANK}$`, 'i').exec(s.trim());
  const files = m && fileOf(wordLetters(s.trim().slice(0, m.index)));
  if (!files) return null;
  const r = m[0].toLowerCase();
  return { files, rank: ORDINALS[r] || (/^sq/.test(r) ? 1 : Number(r[0])) };
}

/**
 * The moves spelled out in `text`, as findDescriptive's — with `desc`, or, for a square named as "f3", `san` and
 * `sans` (a pawn's capture from either file next to it) — `spelled`, and the words as written.
 */
export function findSpelled(text) {
  const out = [];
  for (const m of text.matchAll(SPELLED)) {
    const g = m.groups;
    const piece = pieceOf(wordLetters(g.piece));
    if (!piece) continue;
    const capture = !!g.x;
    const sq = g.sq || g.xsq || g.atsq;
    let move;
    if (sq) {
      const letter = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N' }[piece.role] || '';
      const files = [-1, 1].map(d => String.fromCharCode(sq.charCodeAt(0) + d)).filter(f => f >= 'a' && f <= 'h');
      const sans = piece.role !== 'pawn' ? [`${letter}${capture ? 'x' : ''}${sq}`] : capture ? files.map(f => `${f}x${sq}`) : [sq];
      move = { san: sans[0], sans };
    } else {
      const desc = { ...piece, capture };
      if (capture) {
        desc.victim = pieceOf(wordLetters(g.victim));
        if (!desc.victim) continue;
        if (g.at && !(desc.to = wordSquare(g.at))) continue;
      } else if (!(desc.to = wordSquare(g.square))) continue;
      move = { san: g.piece, desc };
    }
    const dots = g.dots || '';
    const num = g.num ? Number(g.num) : null;
    // its side: from its number, or as the words before it say ("If Black play Pawn to Queen's third", "White answers")
    const said = /\b(white|black)\b[^.;:!?()\n]{0,25}$/i.exec(text.slice(Math.max(0, m.index - 40), m.index))?.[1].toLowerCase();
    const side = num ? ((dots.match(/\./g) || []).length >= 2 ? 'black' : 'white') : said || null;
    const words = m[0].replace(/\s+/g, ' ');
    out.push({ start: m.index, end: m.index + m[0].length, num, side, ...move, check: g.check ? (/mate|#/.test(g.check) ? '#' : '+') : '', pawn: false, square: false, spelled: true, words });
  }
  return out;
}

const FILE_WORDS = ["queen's rook", "queen's knight", "queen's bishop", 'queen', 'king', "king's bishop", "king's knight", "king's rook"];

/** The words of a descriptive move the board does not know: "1. pawn to king 4", "knight takes bishop, check". */
export function spokenDescriptive(t) {
  const d = t.desc;
  const file = files => (files.length === 1 ? FILE_WORDS[files[0]] : ['rook', 'knight', 'bishop'][Math.min(files[0], 7 - files[0])]);
  const square = s => (s.files ? `${file(s.files)} ${s.rank}` : `the ${s.rank}`);
  let w;
  if ('castle' in d) w = d.castle === 'Q' ? 'castles queenside' : d.castle === 'K' ? 'castles kingside' : 'castles';
  else {
    w = d.role;
    if (d.capture) w += ` takes ${d.victim ? d.victim.role : square(d.to)}`;
    else w += ` to ${square(d.to)}`;
    if (d.promo) w += `, promoting to a ${d.promo}`;
  }
  if (t.check) w += t.check === '#' ? ', checkmate' : ', check';
  return t.num ? `${t.num}${t.side === 'black' ? '...' : '.'} ${w}` : w;
}

const LIGHT = sq => ((sq >> 3) + (sq & 7)) % 2 === 1;

/**
 * The legal moves a descriptive move (`desc` of findDescriptive) may be in the position `fen`, as UCI, the likeliest
 * first: of the pieces of a kind, the one of the wing named ("KB": the bishop of the squares of f1/f8; "QR": the rook
 * on the queen's side). A move with "-" goes to an empty square — or, when none does, takes there.
 */
export function descriptiveMoves(fen, desc) {
  let pos;
  try {
    pos = posFromFen(fen);
  } catch {
    return [];
  }
  const white = pos.turn === 'white';
  if ('castle' in desc) {
    const out = [];
    for (const san of desc.castle === 'Q' ? ['O-O-O'] : desc.castle === 'K' ? ['O-O'] : ['O-O', 'O-O-O']) {
      const m = parseSan(pos, san);
      if (m && pos.isLegal(m)) out.push(uciOf(pos, m));
    }
    return out;
  }
  const rank = sq => (white ? (sq >> 3) + 1 : 8 - (sq >> 3));
  const on = (sq, s) => (!s.files || s.files.includes(sq & 7)) && (!s.rank || rank(sq) === s.rank);
  const found = [];
  for (const [from, dests] of pos.allDests()) {
    const piece = pos.board.get(from);
    if (piece.role !== desc.role || (desc.files && !desc.files.includes(from & 7)) || (desc.from && !on(from, desc.from))) continue;
    for (const to of dests) {
      const there = pos.board.get(to);
      if (there?.color === pos.turn) continue; // (castling, as chessops gives it)
      const victim = there || (piece.role === 'pawn' && to === pos.epSquare ? { role: 'pawn' } : null);
      if (desc.to && !on(to, desc.to)) continue;
      if (desc.capture && (!victim || (desc.victim && (victim.role !== desc.victim.role || (desc.victim.files && !desc.victim.files.includes(to & 7)))))) continue;
      const promotion = piece.role === 'pawn' && rank(to) === 8 ? desc.promo || 'queen' : undefined;
      let score = 0;
      if (desc.wing === 'K' || desc.wing === 'Q') {
        // (a bishop keeps its squares' colour: the king's bishop is White's light one, Black's dark one)
        if (desc.role === 'bishop') score = LIGHT(from) === (desc.wing === 'K' ? white : !white) ? 1 : 0;
        else score = (from & 7) >= 4 === (desc.wing === 'K') ? 1 : 0;
      }
      found.push({ uci: uciOf(pos, { from, to, promotion }), score, takes: !!victim });
    }
  }
  const quiet = found.filter(f => !f.takes);
  return (desc.capture || !quiet.length ? found : quiet).sort((a, b) => b.score - a.score).map(f => f.uci);
}
