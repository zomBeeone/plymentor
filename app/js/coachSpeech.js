// What the coach says with its speak tool, as a text to read aloud like a book (coachReading.js): blocks — paragraphs,
// headings, list items — without their Markdown, each in sentences, with the moves found as the Book reader finds them
// (books/text.js: move numbers, captures, checks, castling, promotions, long algebraic, figurines), and what the voice
// says for each sentence: the moves in words ("14... knight to d7"), signs, results and evaluations in words, nothing
// for what cannot be said (a link, a FEN, an emoji) — in parts, each ending with a move the board plays once it has
// been said (coachMoves.js), as the Book reader's do.
import { findMoves, findSentences, speakable } from './books/text.js';

// ---------------------------------------------------------------------------------------------
// Blocks: the text without its Markdown

const RULE = /^(?:[-*_]\s*){3,}$/; // a horizontal rule
const TABLE_RULE = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/; // the line under a table's head
const HEADING = /^#{1,6}\s+(.*?)(?:\s+#+)?$/;
const BULLET = /^[-*+•·]\s+(.*)$/;
const NUMBERED = /^(\d{1,3}[.)])\s+(.*)$/;
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** A list's number, or a move's ("1. e4 e5 2. Nf3" is no list): the moves of the line begin right after it. */
const movesAfter = (marker, rest) => marker.endsWith('.') && findMoves(rest)[0]?.start === 0;

/** A line's Markdown inside it: links as their text, pictures left out, code and emphasis as their text. */
const inline = s =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(?<![\w*])(\*\*|__)(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, '$2')
    .replace(/(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_m, e) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim();

/** A table's row: its cells one after the other. */
const cells = line =>
  line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim())
    .filter(Boolean)
    .join(', ');

/**
 * The text in blocks: [{ kind: 'p' | 'h' | 'li', text, mark (a list item's bullet or number) }] — the lines of a
 * paragraph joined, code blocks (and boards drawn in them) and rules left out, a table's rows as their cells.
 */
function blocksOf(raw) {
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?(?:```|$)/g, '\n\n')
    .replace(/<\/?[a-z][^>\n]*>/gi, '')
    .split('\n');
  const blocks = [];
  let cur = null; // (the block a plain line goes on with)
  const push = (kind, text, mark) => {
    const b = { kind, text, mark };
    blocks.push(b);
    return b;
  };
  for (const raw of lines) {
    const line = raw.replace(/^\s*(?:>\s?)+/, '').trim();
    if (!line || RULE.test(line) || TABLE_RULE.test(line)) {
      cur = null;
      continue;
    }
    let m;
    if ((m = HEADING.exec(line))) {
      push('h', m[1]);
      cur = null;
    } else if (line.startsWith('|')) {
      push('p', cells(line));
      cur = null;
    } else if ((m = BULLET.exec(line))) cur = push('li', m[1], '•');
    else if ((m = NUMBERED.exec(line)) && !movesAfter(m[1], m[2])) cur = push('li', m[2], m[1]);
    else if (cur) cur.text += ` ${line}`;
    else cur = push('p', line);
  }
  return blocks.map(b => ({ ...b, text: inline(b.text) })).filter(b => /[\p{L}\p{N}]/u.test(b.text));
}

// ---------------------------------------------------------------------------------------------
// What the voice says

// (a FEN, a link: nothing to say)
const FEN = /(?<![\w/])[pnbrqkPNBRQK1-8]{1,8}(?:\/[pnbrqkPNBRQK1-8]{1,8}){7}(?:\s+[wb](?:\s+(?:-|[KQkq]{1,4})(?:\s+(?:-|[a-h][36])(?:\s+\d+\s+\d+)?)?)?)?(?![\w/])/g;
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>()]*[^\s<>().,;:!?'"]/gi;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{2653}\u{2660}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}\u{200D}]/gu;
const FIGURINE_WORDS = { '♔': 'king', '♚': 'king', '♕': 'queen', '♛': 'queen', '♖': 'rook', '♜': 'rook', '♗': 'bishop', '♝': 'bishop', '♘': 'knight', '♞': 'knight', '♙': 'pawn', '♟': 'pawn' };
const SIGN = '[+\\-−–]';

/** Signs, results, evaluations and abbreviations in words, the way a coach would say them. */
const inWords = s =>
  s
    .replace(/[♔-♟]/g, c => ` ${FIGURINE_WORDS[c]} `)
    .replace(/(?<![\w./])(?:½|1\/2)\s?[-–]\s?(?:½|1\/2)(?![\w/])/g, 'a draw')
    .replace(/(?<![\w.\-–/])1\s?[-–]\s?0(?![\w\-–/.])/g, '1 to 0')
    .replace(/(?<![\w.\-–/])0\s?[-–]\s?1(?![\w\-–/.])/g, '0 to 1')
    .replace(/(\d)½/g, '$1 and a half')
    .replace(/½|(?<![\d/.])1\/2(?![\d/])/g, 'a half')
    // (a score: "7/10", "6 and a half/9")
    .replace(/(?<![\d/.])(\d{1,3}(?: and a half)?)\s?\/\s?(\d{1,3})(?![\d/])/g, '$1 out of $2')
    // (Stockfish's mates: #3 or +M3 for White, #-3 or -M3 for Black — unless the text says whose)
    .replace(new RegExp(`(^|[\\s(\\[])(?:#(-?)|(${SIGN})M)(\\d{1,3})\\b`, 'g'), (m, a, minus, sign, n, at, all) =>
      `${a}mate in ${n}${(minus || /[-−–]/.test(sign || '')) && !/^\s*(?:for|by)\s+(?:black|white)\b/i.test(all.slice(at + m.length)) ? ' for Black' : ''}`,
    )
    .replace(new RegExp(`(^|[\\s(\\[])(${SIGN})(\\d+(?:\\.\\d+)?)\\b`, 'g'), (_m, a, sign, n) => `${a}${sign === '+' ? 'plus' : 'minus'} ${n}`)
    .replace(/\be\.\s?p\./g, 'en passant')
    .replace(/(^|\s)e\.\s?g\.,?(?=\s|$)/gi, '$1for example')
    .replace(/(^|\s)i\.\s?e\.,?(?=\s|$)/gi, '$1that is')
    .replace(/(^|\s)vs\.?(?=\s)/gi, '$1versus')
    .replace(/\s*(?:→|->|⟶)\s*/g, ' to ')
    .replace(/\s*(?:⇒|=>)\s*/g, ', so ')
    .replace(/\s&\s/g, ' and ')
    .replace(/[*_#|~^]+/g, ' ');

/** What the voice says for a piece of text: signs in words, and nothing for what cannot be said ('' when nothing is left). */
function sayable(out) {
  const said = speakable(inWords(out))
    .replace(EMOJI, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,.;:]+/, '')
    .trim();
  return /[\p{L}\p{N}]/u.test(said) ? said : '';
}

/**
 * What the voice says for the sentence of `text` from `start` to `end`: the moves in words (a comma between moves one
 * after the other and after such a line, a full stop after a move whose ! or ? ended the sentence), the rest in words
 * where a sign stands for them — { said ('' when there is nothing to say), spans: its parts, [{ text, move }], each
 * ending with a move the board plays (`move`: the move, with its `line`), the last with the rest }.
 */
function spoken(text, start, end, moves, silent) {
  const items = [
    ...moves.filter(t => t.start >= start && t.end <= end).map(t => ({ t, start: t.start, end: t.end, words: t.words, move: true })),
    ...silent.filter(r => r.start < end && r.end > start),
  ].sort((a, b) => a.start - b.start);
  const spans = [];
  let out = '';
  let at = start;
  let lastMove = -1;
  let run = 0; // (moves one after the other so far)
  for (const [k, it] of items.entries()) {
    if (it.start < at) continue;
    const gap = text.slice(at, it.start);
    if (it.move) {
      const joined = lastMove === at && /^\s+$/.test(gap);
      run = joined ? run + 1 : 1;
      out += joined ? ', ' : gap;
      out += it.words || text.slice(it.start, it.end);
      const next = items[k + 1];
      const rest = text.slice(it.end, end);
      const word = /^\s+["“(]?\p{L}/u.exec(rest);
      const nextMove = !!word && next?.move && next.start === it.end + word[0].length - 1;
      // ("… played Nf3! Black then …": the sign ended a sentence — not before the next move, "Nf3! Nc6")
      if (/[!?]$/.test(text.slice(it.start, it.end)) && /^\s+["“(]?[A-Z]/.test(rest) && !nextMove) out += '.';
      // ("after 15.f4 exf4 16.Bxf4 White's attack …": a pause after a line of moves)
      else if (run > 1 && word && !nextMove) out += ',';
      lastMove = it.end;
      // (the board plays it once it has been said: a part ends with it)
      if (it.t.line) {
        spans.push({ text: sayable(out), move: it.t });
        out = '';
      }
    } else out += `${gap} `;
    at = Math.min(end, it.end);
  }
  out += text.slice(at, end);
  const last = sayable(out);
  if (last || !spans.length) spans.push({ text: last, move: null });
  return { said: spans.map(s => s.text).filter(Boolean).join(' '), spans };
}

/** Where a block's moves are marked: not a square named alone ("the knight on d5"), unless it stands among moves. */
function marked(text, moves) {
  const bare = t => !t.num && !t.side && !t.desc && !t.spelled && /^[a-h][1-8]$/.test(t.san || '');
  const near = (a, b) => !!a && !!b && /^[\s,;]*$/.test(text.slice(a.end, b.start));
  return moves.filter((t, i) => !bare(t) || near(moves[i - 1], t) || near(t, moves[i + 1])).map(t => ({ start: t.start, end: t.end }));
}

/**
 * What the coach said, to read: { blocks: [{ kind ('p' | 'h' | 'li'), mark, text, marks (its moves: [{ start, end }]) }],
 * sentences: [{ block, start, end (in the block's text), said (what the voice says, '' for nothing), spans (said in
 * parts, each ending with a move the board plays: see spoken) }], chars }. `follow(blocks)`: gives the moves the board
 * plays their `line` (coachMoves.js followMoves), each block's { text, moves, sentences } in order.
 */
export function speechDoc(raw, { follow = null } = {}) {
  const read = blocksOf(raw).map(b => {
    const moves = findMoves(b.text);
    return { ...b, moves, sentences: findSentences(b.text, moves) };
  });
  follow?.(read);
  const blocks = [];
  const sentences = [];
  for (const b of read) {
    const silent = [...b.text.matchAll(LINK), ...b.text.matchAll(FEN)].map(m => ({ start: m.index, end: m.index + m[0].length }));
    const block = blocks.push({ kind: b.kind, mark: b.mark, text: b.text, marks: marked(b.text, b.moves) }) - 1;
    for (const s of b.sentences) {
      let start = s.start;
      let end = s.end;
      while (start < end && /\s/.test(b.text[start])) start++;
      while (end > start && /\s/.test(b.text[end - 1])) end--;
      if (start < end) sentences.push({ block, start, end, ...spoken(b.text, start, end, b.moves, silent) });
    }
  }
  return { blocks, sentences, chars: blocks.reduce((n, b) => n + b.text.length, 0) };
}

/** All that the voice says for a text, in one (a short text: the voice test in Settings). */
export const spokenText = raw =>
  speechDoc(raw)
    .sentences.map(s => s.said)
    .filter(Boolean)
    .join(' ');
