// The handle a screen uses to talk to its coach panel (send, note, stop…), and the app's special links in the coach's
// Markdown (game:ID@PLY, lesson:topic, fen:…).
import { useMemo } from '../../vendor/preact.js';
import { navigate } from '../router.js';

export function useCoachHandle() {
  return useMemo(() => ({ busy: false }), []);
}

export function defaultLinkHandler(href, onPosition) {
  const [scheme, ...rest] = String(href).split(':');
  const value = decodeURIComponent(rest.join(':'));
  if (scheme === 'game') {
    const [id, ply] = value.split('@');
    const gameId = parseInt(id);
    if (!(gameId > 0)) return;
    navigate(`#/analysis?game=${gameId}${ply ? `&ply=${Math.max(0, parseInt(ply) || 0)}` : ''}`);
  } else if (scheme === 'lesson') navigate(`#/train?lesson=${encodeURIComponent(value.replace(/[-_]+/g, ' ').slice(0, 200))}`);
  else if (scheme === 'fen') onPosition?.({ fen: value, shapes: [] });
}
