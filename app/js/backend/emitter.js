// A minimal event emitter (the subset of node:events the backend uses).
export class Emitter {
  #listeners = new Map();

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn);
    return this;
  }

  emit(event, ...args) {
    const set = this.#listeners.get(event);
    if (!set?.size) return false;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`listener for "${event}" failed:`, e);
      }
    }
    return true;
  }

  listenerCount(event) {
    return this.#listeners.get(event)?.size || 0;
  }

  setMaxListeners() {
    return this;
  }
}
