// Hash router: #/view/id?params
import { useEffect, useState } from '../vendor/preact.js';

export function parseHash() {
  const h = location.hash.slice(1) || '/analysis';
  const [path, q] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  return { view: parts[0] || 'analysis', id: parts[1] || null, params: Object.fromEntries(new URLSearchParams(q || '')) };
}

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const f = () => setRoute(parseHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return route;
}

/** Removes one-shot params (game, ply, fen, lesson…) from the hash without triggering navigation. */
export function clearParams() {
  const r = parseHash();
  const base = `#/${r.view}${r.id ? `/${r.id}` : ''}`;
  history.replaceState(null, '', base);
}
