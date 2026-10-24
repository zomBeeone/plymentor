// Requests from the screens to the app's local API (/api/games, /api/engine/…, /api/reports, …), answered by the
// backend worker in this window — they never go over the network.
import { request } from './local.js';

export function api(path, { method = 'GET', body } = {}) {
  return request(method, path, body);
}

export const get = path => api(path);
export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const del = path => api(path, { method: 'DELETE' });

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
