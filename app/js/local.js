// The page's side of the backend worker (js/backend/worker.js): requests in, responses and pushed events out.
let worker = null;
let seq = 0;
const pending = new Map();
const topics = new Map(); // topic -> Set(fn)

function onMessage(e) {
  const m = e.data || {};
  if (m.type === 'response') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(Object.assign(new Error(m.error), { status: m.status }));
    else p.resolve(m.data);
  } else if (m.type === 'push') {
    for (const fn of [...(topics.get(m.topic) || [])]) {
      try {
        fn(m.data);
      } catch (err) {
        console.error(`handler for ${m.topic} failed`, err);
      }
    }
  } else if (m.type === 'ready' || m.type === 'fatal' || m.type === 'closed') {
    for (const fn of [...(topics.get(`worker:${m.type}`) || [])]) fn(m);
  }
}

/** Starts the backend for a profile. Resolves with { storage } once the database is open. */
export function startBackend(userId) {
  if (worker) throw new Error('The backend is already running');
  worker = new Worker('/js/backend.js', { type: 'module', name: 'plymentor-backend' });
  worker.onmessage = onMessage;
  return new Promise((resolve, reject) => {
    const offReady = subscribe('worker:ready', m => {
      offReady();
      offFatal();
      resolve({ storage: m.storage });
    });
    const offFatal = subscribe('worker:fatal', m => {
      offReady();
      offFatal();
      reject(Object.assign(new Error(m.message), { name: m.name || 'Error' }));
    });
    worker.onerror = e => {
      offReady();
      offFatal();
      reject(new Error(e.message || 'The app could not start its background worker.'));
    };
    worker.postMessage({ type: 'init', userId });
  });
}

/** Closes the database and stops the engines (the window is closing, or a start-up attempt failed). */
export function stopBackend() {
  const w = worker;
  if (!w) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      w.terminate();
      if (worker === w) worker = null;
      resolve();
    };
    const off = subscribe('worker:closed', finish);
    const timer = setTimeout(finish, 3000);
    w.postMessage({ type: 'close' });
  });
}

/** One request to the local API. body may be a File/Blob (sent as is). */
export function request(method, path, body) {
  if (!worker) return Promise.reject(new Error('The app is not ready yet.'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'request', id, method, path, body });
  });
}

export function subscribe(topic, fn) {
  if (!topics.has(topic)) topics.set(topic, new Set());
  topics.get(topic).add(fn);
  return () => topics.get(topic)?.delete(fn);
}

export function send(msg) {
  worker?.postMessage(msg);
}
