// Tiny global store: profile, settings, status, running jobs, toasts, the coach's state.
import { useState, useEffect } from '../vendor/preact.js';

const listeners = new Set();

export const state = {
  user: null, // the profile { id } (the desktop app has one)
  settings: null,
  status: null,
  desktop: null, // the app: { version, home (data folder), storage, portable, exe, electron, chrome, sourceUrl }
  banner: null,
  jobs: [],
  toasts: [],
  exercisesDue: 0,
  // the coach (run by the app's coach host): { state: offline | connecting | outdated | idle | running | exited |
  // missing | error, busy, starting, provider, label, message }
  coachStatus: null,
  host: null, // the coach host's details { version, providers, settings, defaultInitialPrompt, home } once connected
  coachSpeaking: false, // the coach's voice is playing (voice.js)
};

export function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  for (const l of [...listeners]) l();
}

/** Re-renders the calling component whenever the store changes. */
export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force(x => x + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return state;
}

let toastId = 0;
export function toast(text, kind = 'info', ms = 4500) {
  const id = ++toastId;
  setState(s => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), ms);
}

/** Can the coach take requests? (connected to the coach host, and the coach program is installed) */
export const coachReady = () => !['offline', 'connecting', 'outdated', 'missing', undefined].includes(state.coachStatus?.state);
