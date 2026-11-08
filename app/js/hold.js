// Going through a game's moves by holding ← or → (or pressing ◀ ▶ down): one move at once, as for a tap, and after a
// moment a move every STEP milliseconds, each drawn before the next, until the key is let go. Not the keyboard's own
// repeats: their pace is the operating system's, they start late, and what they ask for piles up when the screen falls
// behind — the board goes on after the key is released.
const DELAY = 230; // (a tap's move has finished its animation by then: 180 ms)
const STEP = 33;

let held = null; // { id (what holds it down), step, at (when its next move is due), frame }
let instant = false;

/** Whether moves are being gone through: the board draws each where it ends, without an animation. */
export const holding = () => instant;

function stop() {
  if (held) cancelAnimationFrame(held.frame);
  held = null;
  instant = false;
}

function tick(now) {
  if (!held) return;
  held.frame = requestAnimationFrame(tick);
  if (now < held.at) return;
  instant = true;
  let moved;
  try {
    moved = held.step();
  } catch (e) {
    stop();
    throw e;
  }
  if (!held) return; // (the move took the student to another screen)
  if (moved === false) return stop();
  // (the pace kept; after a long frame no moves are made up for: one a frame at most, so that each is drawn)
  held.at = Math.max(held.at + STEP, now + STEP / 2);
}

/** Starts going through moves: step() makes one (false: there is none, the end of the line); `id`: what holds it down. */
export function press(id, step) {
  stop();
  if (step() === false) return;
  held = { id, step, at: performance.now() + DELAY, frame: requestAnimationFrame(tick) };
}

/** A key pressed (its own repeats do nothing while it is held). */
export function pressKey(e, step) {
  if (!e.repeat || held?.id !== e.key) press(e.key, step);
}

/** `id` let go (nothing given: whatever is held). */
export function release(id) {
  if (!id || held?.id === id) stop();
}

/** The props of a button that goes through moves while it is pressed down. */
export const holdable = step => ({
  onPointerDown: e => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    press('pointer', step);
  },
  onPointerUp: () => release('pointer'),
  onPointerCancel: () => release('pointer'),
  onLostPointerCapture: () => release('pointer'),
  onClick: e => !e.detail && step(), // (Enter or Space on the button: a press of the pointer has made its move)
});

if (typeof window !== 'undefined') {
  window.addEventListener('keyup', e => release(e.key));
  window.addEventListener('blur', () => release());
}
