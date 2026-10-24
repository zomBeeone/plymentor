// Board + move-tree controller shared by the board views, and small hooks.
import { useEffect, useState } from '../vendor/preact.js';
import { Tree } from './tree.js';
import { moveSound } from './sound.js';

export class BoardCtrl {
  constructor(startFen) {
    this.tree = new Tree(startFen);
    this.node = this.tree.root;
    this.orientation = 'white';
    this.subs = new Set();
    this.version = 0;
  }
  emit() {
    this.version++;
    for (const s of [...this.subs]) s();
  }
  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  setTree(tree, node) {
    this.tree = tree;
    this.node = node || tree.root;
    this.emit();
  }
  goto(node, { sound = false } = {}) {
    if (!node || node === this.node) return;
    const forward = node.parent === this.node;
    this.node = node;
    if (sound && forward && node.uci) moveSound(node);
    this.emit();
  }
  play(uci, { sound = true } = {}) {
    const r = this.tree.addMove(this.node, uci);
    if (!r) return null;
    this.node = r.node;
    if (sound) moveSound(r.node);
    this.emit();
    return r;
  }
  prev() {
    if (this.node.parent) this.goto(this.node.parent);
  }
  next() {
    if (this.node.children[0]) this.goto(this.node.children[0], { sound: true });
  }
  first() {
    this.goto(this.tree.root);
  }
  last() {
    let n = this.node;
    while (n.children[0]) n = n.children[0];
    this.goto(n);
  }
  flip() {
    this.orientation = this.orientation === 'white' ? 'black' : 'white';
    this.emit();
  }
  get lastMove() {
    const u = this.node.uci;
    return u ? [u.slice(0, 2), u.slice(2, 4)] : null;
  }
}

export function useCtrl(ctrl) {
  const [, force] = useState(0);
  useEffect(() => ctrl.subscribe(() => force(x => x + 1)), [ctrl]);
  return ctrl;
}

/** ← → ↑ ↓ Home End navigate, f flips. Ignored while typing. */
export function useBoardKeys(ctrl, extra) {
  useEffect(() => {
    const onKey = e => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === 'ArrowLeft') ctrl.prev();
      else if (k === 'ArrowRight') ctrl.next();
      else if (k === 'ArrowUp' || k === 'Home') ctrl.first();
      else if (k === 'ArrowDown' || k === 'End') ctrl.last();
      else if (k === 'f') ctrl.flip();
      else if (extra?.(e) !== true) return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctrl]);
}

export function useMedia(query) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const f = () => setMatch(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [query]);
  return match;
}

/** Re-render helper for module-level view state. */
export function useForce() {
  const [, f] = useState(0);
  return () => f(x => x + 1);
}
