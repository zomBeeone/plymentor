// Formatting helpers shared by the views.

export function formatScore(score) {
  if (!score) return '';
  if (score.mated) return score.mated === 'white' ? '0-1' : '1-0';
  if (score.mate !== undefined && score.mate !== null) return `#${score.mate}`;
  const v = (score.cp ?? 0) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 10 ? 0 : 1);
}

/** White's win percentage (lichess formula). */
export function winPercent(score) {
  if (!score) return 50;
  if (score.mated) return score.mated === 'white' ? 0 : 100;
  let cp;
  if (score.mate !== undefined && score.mate !== null) cp = (21 - Math.min(10, Math.abs(score.mate))) * 100 * Math.sign(score.mate || 1);
  else cp = Math.max(-1000, Math.min(1000, score.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export const scoreSide = score => (winPercent(score) >= 50 ? 'w' : 'b');

// Only "great" (the only good move, found) and errors get a glyph; plain best moves stay unmarked, as on lichess.
export const GLYPH = { great: '!!', inaccuracy: '?!', mistake: '?', blunder: '??' };
export const JUDGEMENT_LABEL = {
  great: 'Great move',
  best: 'Best move',
  excellent: 'Excellent',
  good: 'Good',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

export function formatDate(d) {
  if (!d) return '';
  return String(d).replace(/\?\?/g, '').replace(/\.+$/, '').replace(/\./g, '-');
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(sec) {
  if (sec === null || sec === undefined) return '';
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatClock(sec) {
  if (sec === null || sec === undefined) return '';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export const money = x => (x >= 1 ? `$${x.toFixed(2)}` : x >= 0.01 ? `$${x.toFixed(3)}` : x > 0 ? '<$0.01' : '$0');

export function resultFor(result, color) {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return color === 'white' ? 'win' : 'loss';
  if (result === '0-1') return color === 'black' ? 'win' : 'loss';
  return 'draw';
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const cls = (...xs) => xs.filter(Boolean).join(' ');

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Read a localStorage value safely (private windows may throw). */
export function stored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
export function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
