// Optional online sources, called straight from the Plymentor window: download their games from Lichess /
// Chess.com, and the Lichess opening explorer (Masters & Lichess databases — requires a free Lichess personal API
// token, which stays in the student's local settings).
import { getSettings } from './settings.js';
import { PgnImporter } from './games.js';

/** An error to show the user as-is, with an HTTP-like status. */
const userError = (status, message) => Object.assign(new Error(message), { status });

let lichessBusyUntil = 0;

function lichessHeaders(accept) {
  const h = { Accept: accept };
  const token = getSettings().lichessToken;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function streamInto(importer, body) {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      importer.feed(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** Downloads a Lichess user's recent games (with clocks) and imports them as a collection. */
export async function importFromLichess({ username, max = 50, perfType }) {
  username = String(username || '').trim();
  if (!/^[\w-]{2,30}$/.test(username)) throw userError(400, 'Enter a valid Lichess username');
  if (Date.now() < lichessBusyUntil) throw userError(429, 'Lichess asked us to slow down — please wait a minute and try again.');
  const params = new URLSearchParams({ max: String(Math.max(1, Math.min(Number(max) || 50, 1000))), clocks: 'true', opening: 'true', evals: 'false' });
  if (perfType && /^[a-z]+$/.test(perfType)) params.set('perfType', perfType);
  let res;
  try {
    res = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`, { headers: lichessHeaders('application/x-chess-pgn') });
  } catch {
    throw userError(502, 'Could not reach Lichess. Check your internet connection.');
  }
  if (res.status === 429) {
    lichessBusyUntil = Date.now() + 65_000;
    throw userError(429, 'Lichess rate limit — wait a minute and try again. Lichess allows one download at a time per network.');
  }
  if (res.status === 401) throw userError(401, 'Lichess rejected your token — check it in Settings.');
  if (res.status === 404) throw userError(404, `Lichess user "${username}" not found`);
  if (!res.ok) throw userError(502, `Lichess answered ${res.status}`);
  const importer = new PgnImporter({ name: `Lichess: ${username}`, source: 'lichess' });
  try {
    await streamInto(importer, res.body);
    return importer.finish();
  } finally {
    importer.close();
  }
}

/** Downloads the last `months` monthly archives of a Chess.com user. */
export async function importFromChessCom({ username, months = 2 }) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[\w-]{2,30}$/.test(username)) throw userError(400, 'Enter a valid Chess.com username');
  let res;
  try {
    res = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`);
  } catch {
    throw userError(502, 'Could not reach Chess.com. Check your internet connection.');
  }
  if (res.status === 404) throw userError(404, `Chess.com user "${username}" not found`);
  if (res.status === 429) throw userError(429, 'Chess.com asked us to slow down — please wait a minute and try again.');
  if (!res.ok) throw userError(502, `Chess.com answered ${res.status}`);
  const { archives = [] } = await res.json();
  const wanted = (Array.isArray(archives) ? archives : [])
    .filter(u => typeof u === 'string' && u.startsWith('https://api.chess.com/pub/player/'))
    .slice(-Math.max(1, Math.min(Number(months) || 2, 24)));
  if (!wanted.length) throw userError(404, `No games found for "${username}" on Chess.com`);
  const importer = new PgnImporter({ name: `Chess.com: ${username}`, source: 'chesscom' });
  try {
    for (const url of wanted) {
      const r = await fetch(`${url}/pgn`).catch(() => null);
      if (!r?.ok) continue;
      importer.feed(new Uint8Array(await r.arrayBuffer()));
      importer.feed('\n\n');
    }
    return importer.finish();
  } finally {
    importer.close();
  }
}

const explorerCache = new Map();

/** Lichess opening explorer (db: 'masters' | 'lichess'). Returns { error: 'no-token' } when no token is configured. */
export async function lichessExplorer({ db = 'masters', fen, speeds, ratings }) {
  const token = getSettings().lichessToken;
  if (!token) return { error: 'no-token' };
  const params = new URLSearchParams({ fen, moves: '12', topGames: db === 'masters' ? '5' : '0', recentGames: '0' });
  if (db === 'lichess') {
    params.set('speeds', speeds || 'blitz,rapid,classical');
    params.set('ratings', ratings || '1600,1800,2000,2200,2500');
  }
  const key = `${db}?${params}`;
  const cached = explorerCache.get(key);
  if (cached && Date.now() - cached.at < 3600_000) return cached.data;
  let lastError;
  for (const host of ['https://explorer.lichess.org', 'https://explorer.lichess.ovh']) {
    try {
      const res = await fetch(`${host}/${db === 'masters' ? 'masters' : 'lichess'}?${params}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) return { error: 'bad-token' };
      if (res.status === 429) return { error: 'rate-limited' };
      if (!res.ok) {
        lastError = `explorer answered ${res.status}`;
        continue;
      }
      const data = await res.json();
      if (explorerCache.size > 2000) explorerCache.clear();
      explorerCache.set(key, { at: Date.now(), data });
      return data;
    } catch (e) {
      lastError = e.message;
    }
  }
  return { error: lastError || 'unavailable' };
}
