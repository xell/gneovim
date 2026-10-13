// EasyMotion's marker prompt temporarily sets its window's 'scrolloff' to zero,
// then restores it after the hint is chosen. It never moved the cursor, so
// feeding that short-lived zero to the pixel scrolloff code causes a
// distracting out-and-back jump. So a drop to zero waits a moment for the
// display bridge to identify the EasyMotion matches; a real :set scrolloff=0
// has no such overlay and is applied once the wait is over.
//
// Only the scrolloff waits. Before this lived here, the island re-ran its whole
// cursor update after the wait, with the cursor and mode captured when the zero
// arrived; the zero had never been recorded, so that update deferred itself
// again, forever. Every 80ms the island reset itself to that old position and
// mode: after one such zero in Normal mode, Insert-mode j/k/w became motions
// and Escape seemed dead until the island was rebuilt (2026-10-14).
export class ZeroScrolloffGate {
  constructor({ setTimer, clearTimer, isEasyMotion, applyZero, delay = 80 }) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.isEasyMotion = isEasyMotion;
    this.applyZero = applyZero;
    this.delay = delay;
    this.timer = 0;
  }

  // The scrolloff to use right now, given the current one and the one Neovim
  // just reported.
  next(current, reported) {
    if (reported === 0 && current !== 0 && !this.isEasyMotion()) {
      this.cancel();
      this.timer = this.setTimer(() => {
        this.timer = 0;
        if (!this.isEasyMotion()) this.applyZero();
      }, this.delay);
      return current;
    }
    // The window's real scrolloff, zero or not, supersedes a pending zero.
    this.cancel();
    return reported;
  }

  // EasyMotion identified, or the island is going away.
  cancel() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = 0;
  }
}
