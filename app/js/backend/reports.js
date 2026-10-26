// The reports of the Reports screen: statistics over the student's analysed games, and the coach's written report.
// The student makes them on the Reports screen, the coach with create_report.
import { run, now } from './db.js';
import { playerStats } from './analysis/stats.js';
import { allGameIds } from './games.js';

/**
 * Saves a new report for the players `names` over the games `gameIds` (default: all their analysed games); `display`
 * names them in the default title. Returns { id, title, stats } — id null and nothing saved when none of the games is
 * an analysed game of theirs (stats.notAnalyzed and stats.skipped say why).
 */
export function createReport({ names, gameIds, title, display = names[0], narrative = null }) {
  const stats = playerStats({ names, gameIds: gameIds?.length ? gameIds : allGameIds({ player: names.join(','), analyzed: '1' }) });
  if (!stats.games) return { id: null, title: null, stats };
  const t = String(title || `${display} — ${stats.games} games`).slice(0, 200);
  const { id } = run(
    'INSERT INTO reports (title, player, game_ids, stats, narrative, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    t,
    names.join(', '),
    JSON.stringify(stats.gameList.map(g => g.id)),
    JSON.stringify(stats),
    narrative,
    now(),
    now(),
  );
  return { id, title: t, stats };
}
