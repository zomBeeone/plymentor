// Test databases in Scid 5 format: a seeded generator of games (openings with shared beginnings and a transposition,
// random legal continuations, variations, comments, NAGs, promotions, a FEN start) and a writer for the format, the
// mirror of desktop/gigabase/scid5.js. Used by the unit tests and by test/fixtures/make-gigabase.mjs (the e2e archive).
import { writeFileSync } from 'node:fs';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseUci, makeUci } from 'chessops/util';
import { parseSan, makeSan } from 'chessops/san';
import { ScidPosition, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, ENTRY_SIZE } from '../../desktop/gigabase/scid5.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Opening families: name, moves (SAN), number of games. QGD and its English move order reach the same position. */
export const FAMILIES = [
  ['Ruy Lopez', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6', 90],
  ['Najdorf', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', 70],
  ['QGD', 'd4 d5 c4 e6 Nc3 Nf6', 60],
  ['QGD by transposition', 'c4 e6 Nc3 d5 d4 Nf6', 25],
  ['English', 'c4 e5 Nc3 Nf6 g3', 40],
  ['French', 'e4 e6 d4 d5', 30],
];

const PLAYERS = ['Carlsen, Magnus', 'Caruana, Fabiano', 'Nakamura, Hikaru', 'Ding, Liren', 'Firouzja, Alireza', 'Gukesh, D', 'So, Wesley', 'Giri, Anish', 'Anand, Viswanathan', 'Kramnik, Vladimir', 'Svidler, Peter', 'Polgar, Judit', 'Hou, Yifan', 'Müller, Jürgen', 'Øst-Hansen, Jacob'];
const EVENTS = ['Test Open', 'Club Championship', 'Grand Tournament', 'Rapid Cup', 'Turnier Ödenburg'];

/** A list of games: { white, black, whiteElo, blackElo, result, date: [y, m, d], event, site, round, fen?, line, comment? }. */
export function makeGames(seed = 1) {
  const rnd = mulberry32(seed);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const games = [];
  const addGame = (prefix, plies, extra = {}) => {
    const pos = extra.fen ? Chess.fromSetup(parseFen(extra.fen).unwrap()).unwrap() : Chess.default();
    const line = [];
    for (const san of prefix) {
      const m = parseSan(pos, san);
      if (!m) throw new Error(`bad prefix move ${san}`);
      line.push({ uci: makeUci(m), san });
      pos.play(m);
    }
    while (line.length < plies && !pos.isEnd()) {
      const moves = [];
      for (const [from, dests] of pos.allDests()) for (const to of dests) moves.push({ from, to });
      const m = pick(moves);
      if (pos.board.getRole(m.from) === 'pawn' && (m.to >> 3 === 7 || m.to >> 3 === 0)) m.promotion = pick(['queen', 'queen', 'queen', 'knight', 'rook', 'bishop']);
      line.push({ uci: makeUci(m), san: makeSan(pos, m) });
      pos.play(m);
    }
    let w = Math.floor(rnd() * PLAYERS.length);
    let b = Math.floor(rnd() * (PLAYERS.length - 1));
    if (b >= w) b++;
    const g = {
      white: PLAYERS[w],
      black: PLAYERS[b],
      whiteElo: rnd() < 0.1 ? 0 : 1800 + Math.floor(rnd() * 1000),
      blackElo: rnd() < 0.1 ? 0 : 1800 + Math.floor(rnd() * 1000),
      result: pick(['1-0', '0-1', '1/2-1/2', '1-0', '0-1', '1/2-1/2', '*']),
      date: [1990 + Math.floor(rnd() * 36), 1 + Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28)],
      event: pick(EVENTS),
      site: pick(['Amsterdam', 'Wijk aan Zee', '?']),
      round: String(1 + Math.floor(rnd() * 9)),
      line,
      ...extra,
    };
    games.push(g);
    return g;
  };
  for (const [, moves, n] of FAMILIES) for (let i = 0; i < n; i++) addGame(moves.split(' '), 16 + Math.floor(rnd() * 70));
  for (let i = 0; i < 25; i++) addGame([], 10 + Math.floor(rnd() * 60)); // anything
  // annotated: variations, comments, NAGs
  const g = addGame('e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+'.split(' '), 30, { comment: 'An old Italian game.' });
  g.line[4].comment = 'The Italian.';
  g.line[4].nags = [1];
  g.line[4].variations = [[{ uci: 'f1b5', san: 'Bb5', comment: 'The Spanish instead', nags: [3] }, { uci: 'a7a6', san: 'a6' }], [{ uci: 'd2d4', san: 'd4', startComment: 'Scotch:' }]];
  g.line[11].nags = [2, 14];
  g.line[11].comment = 'Check! {not a brace}';
  // a promotion race to an underpromotion, and a FEN start
  addGame([], 6, { fen: '8/P6k/8/8/8/8/6Kp/8 w - - 0 1', line: [] });
  const promo = games.at(-1);
  promo.line = [
    { uci: 'a7a8n', san: 'a8=N' },
    { uci: 'h2h1q', san: 'h1=Q+' },
    { uci: 'g2h1', san: 'Kxh1' },
  ];
  promo.result = '1/2-1/2';
  return games;
}

const COMMON_TAGS = ['WhiteCountry', 'BlackCountry', 'Annotator', 'PlyCount', 'EventDate', 'Opening', 'Variation', 'Setup', 'Source', 'SetUp'];
const KNIGHT_CODE = { '-17': 1, '-15': 2, '-10': 3, '-6': 4, 6: 5, 10: 6, 15: 7, 17: 8 };
const KING_CODE = { '-9': 1, '-8': 2, '-7': 3, '-1': 4, 1: 5, 7: 6, 8: 7, 9: 8 };
const PROMO_ADD = { q: 3, r: 6, b: 9, n: 12 };

/** The Scid bytes of a UCI move in `pos` (before it is played). */
export function encodeMove(pos, uci) {
  const sq = s => s.charCodeAt(0) - 97 + (Number(s[1]) - 1) * 8;
  const from = sq(uci.slice(0, 2));
  const to = sq(uci.slice(2, 4));
  const piece = pos.board[from];
  const idx = pos.listPos[from];
  const type = piece & 7;
  const rank = s => s >> 3;
  const file = s => s & 7;
  let code;
  let second = null;
  if (type === KING) {
    const own = pos.board[to] === (ROOK | (piece & 8));
    if (own || Math.abs(to - from) === 2) code = to > from ? 10 : 9;
    else code = KING_CODE[to - from];
  } else if (type === QUEEN || type === ROOK) {
    if (rank(from) === rank(to)) code = file(to);
    else if (file(from) === file(to)) code = 8 + rank(to);
    else {
      code = file(from); // a queen's diagonal: two bytes
      second = to + 64;
    }
  } else if (type === BISHOP) code = (rank(to) - rank(from)) * (file(to) - file(from)) < 0 ? file(to) + 8 : file(to);
  else if (type === KNIGHT) code = KNIGHT_CODE[to - from];
  else if (type === PAWN) {
    const d = Math.abs(to - from);
    code = d === 16 ? 15 : d === 7 ? 0 : d === 8 ? 1 : 2;
    if (uci[4]) code += PROMO_ADD[uci[4]];
  }
  if (code === undefined) throw new Error(`cannot encode ${uci}`);
  return second === null ? [(idx << 4) | code] : [(idx << 4) | code, second];
}

const clonePos = p => {
  const q = new ScidPosition();
  q.board.set(p.board);
  q.list.set(p.list);
  q.listPos.set(p.listPos);
  q.count.set(p.count);
  Object.assign(q, { turn: p.turn, castling: p.castling, ep: p.ep, hi: p.hi, lo: p.lo });
  return q;
};

/** The game data of one game (tags, start, moves with markers, comments). */
export function encodeGame(g, tags = []) {
  const out = [];
  const utf = s => [...Buffer.from(s, 'utf8')];
  for (const [name, value] of tags) {
    const common = COMMON_TAGS.indexOf(name);
    if (common >= 0) out.push(241 + common);
    else out.push(name.length, ...utf(name));
    const v = utf(value).slice(0, 255);
    out.push(v.length, ...v);
  }
  out.push(0);
  const promo = g.line.some(m => m.uci.length > 4);
  const under = g.line.some(m => m.uci.length > 4 && m.uci[4] !== 'q');
  out.push((g.fen ? 1 : 0) | (promo ? 2 : 0) | (under ? 4 : 0));
  if (g.fen) out.push(...utf(g.fen), 0);
  const comments = [];
  const pos = new ScidPosition();
  if (g.fen) pos.setFen(g.fen);
  else pos.standard();
  if (g.comment) {
    out.push(12);
    comments.push(g.comment);
  }
  const writeLine = (p, line) => {
    for (const m of line) {
      const before = clonePos(p);
      out.push(...encodeMove(p, m.uci));
      if (!p.playUci(m.uci)) throw new Error(`illegal ${m.uci}`);
      for (const nag of m.nags || []) out.push(11, nag);
      if (m.comment) {
        out.push(12);
        comments.push(m.comment);
      }
      for (const v of m.variations || []) {
        out.push(13);
        if (v[0].startComment) {
          out.push(12);
          comments.push(v[0].startComment);
        }
        writeLine(clonePos(before), v);
        out.push(14);
      }
    }
  };
  writeLine(pos, g.line);
  out.push(15);
  for (const c of comments) out.push(...utf(c), 0);
  return Buffer.from(out);
}

const RESULT_CODE = { '*': 0, '1-0': 1, '0-1': 2, '1/2-1/2': 3 };

/** Writes base.si5, base.sn5 and base.sg5. */
export function writeScid5(base, games) {
  const names = [new Map(), new Map(), new Map(), new Map()];
  const nameParts = [];
  const nameId = (type, s) => {
    const m = names[type];
    if (!m.has(s)) {
      m.set(s, m.size);
      const bytes = Buffer.from(s, 'utf8');
      let v = bytes.length * 8 + type;
      const head = [];
      while (v >= 128) {
        head.push((v % 128) | 128);
        v = Math.floor(v / 128);
      }
      head.push(v);
      nameParts.push(Buffer.from(head), bytes);
    }
    return m.get(s);
  };
  const datas = [];
  const index = Buffer.alloc(games.length * ENTRY_SIZE);
  let offset = 0;
  games.forEach((g, k) => {
    const data = encodeGame(g, g.tags || [['WhiteFideId', String(1000 + k)]]);
    const u32 = (i, v) => index.writeUInt32LE(v >>> 0, k * ENTRY_SIZE + i);
    const date = (g.date[0] << 9) | (g.date[1] << 5) | g.date[2];
    u32(0, nameId(0, g.white));
    u32(4, nameId(0, g.black));
    u32(8, nameId(1, g.event));
    u32(12, nameId(2, g.site));
    u32(16, nameId(3, g.round));
    u32(20, (Math.min(g.whiteElo, 4000) << 20) | date);
    u32(24, (Math.min(g.blackElo, 4000) << 20) | date);
    u32(28, (Math.min(g.line.length, 1023) << 22) | (g.fen ? 1 : 0));
    u32(32, data.length << 15);
    u32(36, offset);
    u32(40, 0);
    u32(44, RESULT_CODE[g.result] << 16);
    datas.push(data);
    offset += data.length;
  });
  writeFileSync(base + '.si5', index);
  writeFileSync(base + '.sg5', Buffer.concat(datas));
  writeFileSync(base + '.sn5', Buffer.concat(nameParts));
}

/** The position (FEN without the move counters) after the first `ply` moves of a game. */
export function fenAfter(g, ply) {
  const pos = g.fen ? Chess.fromSetup(parseFen(g.fen).unwrap()).unwrap() : Chess.default();
  for (const m of g.line.slice(0, ply)) pos.play(parseUci(m.uci));
  return makeFen(pos.toSetup());
}

/** The files inside test/fixtures/gigabase/files-*.7z (made by test/fixtures/make-gigabase.mjs). */
export function archiveFiles() {
  const rnd = mulberry32(7);
  const bin = Buffer.alloc(5000);
  for (let i = 0; i < bin.length; i++) bin[i] = Math.floor(rnd() * 256);
  return {
    'a.txt': Buffer.from('hello hello hello 7z world\n'.repeat(300)),
    'b.bin': bin,
    'sub/c.txt': Buffer.from('a third file, in a folder\n'),
    'empty.txt': Buffer.alloc(0),
  };
}
