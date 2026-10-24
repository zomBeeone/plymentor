// The bridge between the Plymentor window and the app's main process (main.js). The window (sandboxed, no Node.js)
// gets only these few functions as window.plymentor; the coach itself is reached over a message port.
const { contextBridge, ipcRenderer } = require('electron');

// Message ports cannot cross the context bridge, but window.postMessage can hand them to the page (only to the app's
// own page: its origin, app://plymentor).
ipcRenderer.on('coach-port', event => {
  window.postMessage({ plymentor: 'coach-port' }, window.location.origin, event.ports);
});

let onClosing = null;
ipcRenderer.on('app-closing', async () => {
  try {
    if (onClosing) await Promise.race([onClosing(), new Promise(resolve => setTimeout(resolve, 3500))]);
  } catch {
    /* close anyway */
  }
  ipcRenderer.send('app-closed');
});

contextBridge.exposeInMainWorld('plymentor', {
  /** Asks for a message port to the coach host; it arrives as a window 'message' event { plymentor: 'coach-port' }. */
  connectCoach: () => ipcRenderer.send('coach-connect'),
  /** fn runs (and may return a promise) when the window is about to close. */
  onClosing: fn => {
    onClosing = typeof fn === 'function' ? fn : null;
  },
  info: () => ipcRenderer.invoke('app-info'),
  /** 'data' | 'notes' | 'logs' */
  openFolder: which => ipcRenderer.invoke('open-folder', String(which)),
  openExternal: url => ipcRenderer.invoke('open-external', String(url)),
  /**
   * The game database the student added (Scid 5): 'status' | 'add' (Windows' file dialog) | 'reindex' | 'cancel' |
   * 'remove' | 'open-folder' | 'explore' ({ fen, moves }) | 'game' ({ id }).
   */
  gigabase: (method, args) => ipcRenderer.invoke('gigabase', String(method), args && typeof args === 'object' ? args : null),
  /** fn(status) on every change of the game database's state; returns a function that stops listening. */
  onGigabase: fn => {
    const listener = (_e, status) => fn(status);
    ipcRenderer.on('gigabase-status', listener);
    return () => ipcRenderer.removeListener('gigabase-status', listener);
  },
  /**
   * Updates (see desktop/updates.js): 'status' | 'check' | 'download' | 'cancel' | 'later' | 'auto' ({ on }) |
   * 'backup' ({ bytes }: the games, saved before installing) | 'install' | 'show-file' | 'open-page' (the release's page).
   */
  update: (method, args) => ipcRenderer.invoke('update', String(method), args && typeof args === 'object' ? args : null),
  /** fn(status) on every change of the updates' state; returns a function that stops listening. */
  onUpdate: fn => {
    const listener = (_e, status) => fn(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
});
