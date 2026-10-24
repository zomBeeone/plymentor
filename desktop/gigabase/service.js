// Reading the game database the student added: the opening explorer (from the opening index, or from the games
// themselves in lines beyond it), game summaries and whole games as PGN.

import { readFileSync } from 'node:fs';
import { Chess, normalizeMove } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { makeUci, parseUci } from 'chessops/util';
import { makeSan, makeSanAndPlay, parseSan } from 'chessops/san';
import { makePgn, Node as PgnNode, ChildNode } from 'chessops/pgn';
import * as S from './scid5.js';
import { Book, ScidFiles } from './book.js';

const FALLBACK_SCAN_PLIES = 80; // how far a candidate game is followed when looking for a position

export class GameDatabase {
  /** base: the database path without extension; bookFile: its opening index; info: what to tell about it. */
  constructor({ base, bookFile, info = {} }) {
    this.files = new ScidFiles(base);
    try {
      this.names = new S.Names(readFileSync(base + '.sn5'));
      this.book = new Book(bookFile);
    } catch (e) {
      this.files.close();
      throw e;
    }
    this.info = { ...info, games: this.files.count };
  }

  close() {
    this.files.close();
    this.book.close();
  }

  summary(id) {
    if (!(Number.isInteger(id) && id >= 0 && id < this.files.count)) throw new Error('No such game.');
    const e = this.files.entry(id);
    const n = this.names;
    const year = e.date >>> 9;
    return {
      id,
      white: n.get(S.NAME_PLAYER, e.white) || '?',
      black: n.get(S.NAME_PLAYER, e.black) || '?',
      whiteElo: e.whiteElo || null,
      blackElo: e.blackElo || null,
      result: S.RESULT_PGN[e.result],
      date: S.dateString(e.date),
      year: year || null,
      event: clean(n.get(S.NAME_EVENT, e.event)),
      site: clean(n.get(S.NAME_SITE, e.site)),
      round: clean(n.get(S.NAME_ROUND, e.round)),
      eco: S.ecoString(e.eco),
      plies: e.plies,
    };
  }

  /**
   * The moves played from a position. `moves`: the line from the standard start (UCI), used beyond the index.
   * Returns { source: 'index' | 'games' | 'none', white, draws, black, moves: [...], topGames: [...] }.
   */
  explore({ fen, moves = [] }) {
    const target = new S.ScidPosition().setFen(fen);
    let pos = null;
    try {
      pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
    } catch {}
    const san = uci => {
      try {
        const m = normalizeMove(pos, parseUci(uci));
        return pos.isLegal(m) ? makeSan(pos, m) : null;
      } catch {
        return null;
      }
    };
    const rank = this.book.find(target.hi, target.lo);
    let r;
    if (rank >= 0) {
      const rec = this.book.record(rank);
      r = {
        source: 'index',
        white: rec.white,
        draws: rec.draws,
        black: rec.black,
        moves: rec.moves.map(m => ({
          uci: S.moveToUci(m.move),
          white: m.white,
          draws: m.draws,
          black: m.black,
          averageRating: m.averageRating || null,
          lastYear: m.lastYear || null,
        })),
        topGames: rec.top.map(id => this.summary(id)),
      };
    } else r = this.#fromGames(target, toUcis(moves));
    for (const m of r.moves) m.san = pos ? san(m.uci) : null;
    return r;
  }

  /** Beyond the index: the games that left it on the way to this position, read one by one. */
  #fromGames(target, moves) {
    const none = { source: 'none', white: 0, draws: 0, black: 0, moves: [], topGames: [] };
    if (!Array.isArray(moves) || !moves.length || moves.length > 300) return none;
    const p = new S.ScidPosition().standard();
    const path = [[p.hi, p.lo, -1]];
    for (const uci of moves) {
      if (typeof uci !== 'string' || !p.playUci(uci)) return none;
      path.push([p.hi, p.lo, p.move16()]);
    }
    if (p.hi !== target.hi || p.lo !== target.lo) return none;
    let candidates = null;
    for (let j = path.length - 2; j >= 0; j--) {
      const rank = this.book.find(path[j][0], path[j][1]);
      if (rank < 0) continue;
      const edge = this.book.record(rank).moves.find(m => m.move === path[j + 1][2]);
      candidates = edge?.games || [];
      break;
    }
    if (!candidates?.length) return none;
    const byMove = new Map();
    const found = [];
    let white = 0;
    let draws = 0;
    let black = 0;
    for (const id of candidates) {
      const e = this.files.entry(id);
      if (e.flags & S.FLAG_START) continue;
      let data;
      try {
        data = this.files.gameData(e);
      } catch {
        continue;
      }
      const at = S.skipTags(data, 0);
      if (at < 0 || data[at] & 1) continue;
      const pos = new S.ScidPosition().standard();
      let hit = false;
      let next = -1;
      S.playMainline(pos, data, at + 1, FALLBACK_SCAN_PLIES + moves.length, q => {
        if (hit) {
          next = q.move16();
          return false;
        }
        if (q.hi === target.hi && q.lo === target.lo) hit = true;
      });
      if (!hit) continue;
      found.push({ id, e });
      if (e.result === S.RESULT_WHITE) white++;
      else if (e.result === S.RESULT_BLACK) black++;
      else if (e.result === S.RESULT_DRAW) draws++;
      if (next < 0) continue;
      let m = byMove.get(next);
      if (!m) byMove.set(next, (m = { uci: S.moveToUci(next), white: 0, draws: 0, black: 0, eloSum: 0, eloN: 0, lastYear: 0, n: 0 }));
      m.n++;
      if (e.result === S.RESULT_WHITE) m.white++;
      else if (e.result === S.RESULT_BLACK) m.black++;
      else if (e.result === S.RESULT_DRAW) m.draws++;
      if (e.whiteElo && e.blackElo) {
        m.eloSum += (e.whiteElo + e.blackElo) / 2;
        m.eloN++;
      }
      m.lastYear = Math.max(m.lastYear, e.date >>> 9);
    }
    if (!found.length) return none;
    const rating = e => (e.whiteElo && e.blackElo ? Math.min(e.whiteElo, e.blackElo) : 0); // as the index ranks top games
    const best = found.sort((a, b) => rating(b.e) - rating(a.e) || b.e.date - a.e.date);
    return {
      source: 'games',
      white,
      draws,
      black,
      moves: [...byMove.values()]
        .sort((a, b) => b.n - a.n)
        .map(m => ({ uci: m.uci, white: m.white, draws: m.draws, black: m.black, averageRating: m.eloN ? Math.round(m.eloSum / m.eloN) : null, lastYear: m.lastYear || null })),
      topGames: best.slice(0, 15).map(x => this.summary(x.id)),
    };
  }

  /** A whole game: its summary and PGN (with its variations, comments and NAGs). */
  game(id) {
    const summary = this.summary(id);
    const e = this.files.entry(id);
    const tree = S.decodeGameTree(this.files.gameData(e));
    const headers = new Map([
      ['Event', summary.event || '?'],
      ['Site', summary.site || '?'],
      ['Date', summary.date],
      ['Round', summary.round || '?'],
      ['White', summary.white],
      ['Black', summary.black],
      ['Result', summary.result],
    ]);
    if (summary.whiteElo) headers.set('WhiteElo', String(summary.whiteElo));
    if (summary.blackElo) headers.set('BlackElo', String(summary.blackElo));
    if (summary.eco) headers.set('ECO', summary.eco);
    if (e.eventDate) headers.set('EventDate', S.dateString(e.eventDate));
    for (const [k, v] of tree.tags) {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(k) || headers.has(k) || k === 'FEN' || k === 'SetUp' || k === 'Setup') continue;
      headers.set(k, String(v).replace(/["\\\r\n]/g, ' ').slice(0, 200));
    }
    let pos;
    if (tree.fen) {
      headers.set('SetUp', '1');
      headers.set('FEN', tree.fen);
      pos = Chess.fromSetup(parseFen(tree.fen).unwrap()).unwrap();
    } else pos = Chess.default();
    const moves = new PgnNode();
    const add = (scidNode, pgnNode, position) => {
      for (const child of scidNode.children) {
        const p = position.clone();
        const raw = parseUci(child.uci);
        if (!raw) return;
        const move = normalizeMove(p, raw);
        if (!p.isLegal(move)) return;
        const data = { san: makeSanAndPlay(p, move) };
        if (child.comment) data.comments = [cleanComment(child.comment)];
        if (child.startComment) data.startingComments = [cleanComment(child.startComment)];
        if (child.nags?.length) data.nags = [...child.nags];
        const node = new ChildNode(data);
        pgnNode.children.push(node);
        add(child, node, p);
      }
    };
    add(tree.root, moves, pos);
    const game = { headers, moves, comments: tree.root.comment ? [cleanComment(tree.root.comment)] : [] };
    return { ...summary, database: this.info.title || '', pgn: makePgn(game) };
  }
}

/** Moves from the initial position in SAN or UCI → UCI (castling as king takes rook), or null if one is illegal. */
export function toUcis(moves) {
  if (!Array.isArray(moves)) return null;
  const pos = Chess.default();
  const out = [];
  for (const raw of moves) {
    const s = String(raw).trim();
    let move = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(s) ? parseUci(s) : parseSan(pos, s.replace(/[+#!?]+$/, ''));
    if (!move) return null;
    move = normalizeMove(pos, move);
    if (!pos.isLegal(move)) return null;
    out.push(makeUci(move));
    pos.play(move);
  }
  return out;
}

const clean = s => (s && s !== '?' ? s : '');
const cleanComment = s => String(s).replace(/[{}]/g, '').slice(0, 2000);
