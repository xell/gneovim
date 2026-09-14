import { byteToCol } from "./pure/text-geometry.js";

// Owns measured CodeMirror cursor scrolling and its browser scheduling state.
export class CursorScroller {
  constructor({
    view,
    isHidden,
    cellHeight,
    requestFrame,
    cancelFrame,
    setTimer,
    clearTimer,
  }) {
    this.view = view;
    this.isHidden = isHidden;
    this.cellHeight = cellHeight;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.frame = 0;
    this.hideTimer = 0;
    this.padding = null;
  }

  keepInView(position, scrolloff) {
    this.scrollToPosition(position, scrolloff, false);
  }

  // `zz`: unconditionally centers the cursor line, same geometry as
  // keepInView's own scrolloff-filling centre branch (see there). The block
  // padding that branch already relies on is what makes this honour
  // scrolloff "as much as possible" near a document edge: the scroller has
  // no further room to centre into once it runs out of padding.
  center(position, scrolloff) {
    this.scrollToPosition(position, scrolloff, true);
  }

  scrollToPosition(position, scrolloff, force) {
    if (this.frame) this.cancelFrame(this.frame);
    this.frame = this.requestFrame(() => {
      this.frame = 0;
      if (!position || this.isHidden()) return;
      const scroller = this.view.scrollDOM;
      if (!scroller.clientHeight) return;
      const height = scroller.clientHeight;
      const margin = Math.min(scrolloff * this.cellHeight(), height / 2);
      if (this.padding !== margin) {
        const padding = `${margin}px`;
        this.view.contentDOM.style.paddingBlockStart = padding;
        this.view.contentDOM.style.paddingBlockEnd = padding;
        this.padding = margin;
      }

      const line = this.view.state.doc.line(
        Math.min(position.row + 1, this.view.state.doc.lines),
      );
      const offset = Math.min(
        line.from + byteToCol(line.text, position.col),
        line.to,
      );
      const rect = this.view.coordsAtPos(offset);
      if (!rect) return;
      const bounds = scroller.getBoundingClientRect();
      const top = rect.top - bounds.top;
      const bottom = rect.bottom - bounds.top;
      let delta = 0;
      if (force || margin === height / 2) delta = (top + bottom) / 2 - height / 2;
      else if (top < margin) delta = top - margin;
      else if (bottom > height - margin) delta = bottom - (height - margin);
      if (!delta) return;

      scroller.classList.add("cm-nvim-cursor-scroll");
      if (this.hideTimer) this.clearTimer(this.hideTimer);
      this.hideTimer = this.setTimer(() => {
        scroller.classList.remove("cm-nvim-cursor-scroll");
        this.hideTimer = 0;
      }, 180);
      scroller.scrollTop += delta;
    });
  }

  destroy() {
    if (this.frame) this.cancelFrame(this.frame);
    if (this.hideTimer) this.clearTimer(this.hideTimer);
    this.frame = 0;
    this.hideTimer = 0;
  }
}
