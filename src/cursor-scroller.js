import { EditorView } from "@codemirror/view";
import { byteToCol } from "./pure/text-geometry.js";

// How long after a far jump (see below) a decoration change still carries the
// same scroll request. md_decor's payload for the new viewport lands about
// 100-250ms after the cursor echo, and it changes line heights: headings grow,
// conceal shortens lines, and CodeMirror re-estimates every undrawn line.
const FAR_JUMP_WINDOW_MS = 1000;
// How long after a wheel event the reader still owns the scroll position:
// macOS keeps sending wheel events through trackpad momentum, so this only
// has to bridge the gap between two of them.
const WHEEL_QUIET_MS = 250;

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
    // The target of the last far jump, until `until`. A wheel scroll is the
    // reader moving away on purpose: drop it.
    this.farJump = null;
    this.wheelAt = 0;
    view.scrollDOM?.addEventListener?.(
      "wheel",
      () => {
        this.farJump = null;
        this.wheelAt = Date.now();
      },
      { passive: true },
    );
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

  // For a decoration transaction: while a far jump is recent, the same scroll
  // request rides along, so CodeMirror applies the new line heights and the
  // scroll in one measure cycle instead of painting the drifted view first.
  scrollEffectForRelayout() {
    const jump = this.farJump;
    if (!jump || Date.now() > jump.until) return null;
    return jump.effect;
  }

  // For any other decoration transaction: keep the top visible line where it
  // is. Decorations only cover rows near the viewport (md_decor.lua), so rows
  // above it change height as they enter or leave that range: a closed fold
  // opening (4cf040c), a long link going from concealed to raw (ddc5444).
  // Without an anchor each such change moved everything below it, the view
  // with it. CodeMirror restores the snapshot in the same measure cycle that
  // applies the new heights, before anything paints. Not while a cursor scroll
  // is pending (it measures after this update and would be undone), and not
  // while the reader is wheel-scrolling (the snapshot would pull them back).
  anchorEffect() {
    if (this.frame || this.isHidden()) return null;
    if (Date.now() - this.wheelAt < WHEEL_QUIET_MS) return null;
    return this.view.scrollSnapshot();
  }

  scrollToPosition(position, scrolloff, force) {
    this.farJump = null;
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
      const centre = force || margin === height / 2;

      // A target outside what CodeMirror has drawn (`G` in a long note) can
      // only be placed from estimated line heights, and headings and rendered
      // tables are taller than the estimate: measuring it here and scrolling
      // once landed about 300 lines above the end of a 3375-line note, and
      // correcting on the next frames showed as a shake (2026-10-09).
      // CodeMirror's own scrollIntoView draws the target, measures and
      // re-aims within one measure cycle, before anything is painted. Only
      // for these jumps: inside the drawn region the measured path below is
      // exact, and it is the one that knows a rendered table's own caret.
      const { from, to } = this.view.viewport;
      if (offset < from || offset > to) {
        const effect = EditorView.scrollIntoView(offset, {
          y: centre ? "center" : "nearest",
          yMargin: margin,
        });
        this.hideScrollbarBriefly(scroller);
        this.view.dispatch({ effects: effect });
        this.farJump = { effect, until: Date.now() + FAR_JUMP_WINDOW_MS };
        return;
      }

      // A cursor behind a rendered table measures as the whole table block,
      // so prefer the caret the table draws into its own cursor cell (only
      // the table holding Neovim's cursor renders one).
      const rect =
        this.view.contentDOM
          .querySelector?.(".cm-markdown-table .nvim-cursor")
          ?.getBoundingClientRect() ?? this.view.coordsAtPos(offset);
      if (!rect) return;
      const bounds = scroller.getBoundingClientRect();
      const top = rect.top - bounds.top;
      const bottom = rect.bottom - bounds.top;
      let delta = 0;
      if (centre) delta = (top + bottom) / 2 - height / 2;
      // A rect taller than the scrolloff band (e.g. a tall image) can never
      // satisfy both margins; once it spans the band, leave it, or each
      // keystroke would flip between aligning its top and its bottom.
      else if (top < margin && bottom > height - margin) delta = 0;
      else if (top < margin) delta = top - margin;
      else if (bottom > height - margin) delta = bottom - (height - margin);
      if (!delta) return;

      this.hideScrollbarBriefly(scroller);
      scroller.scrollTop += delta;
    });
  }

  hideScrollbarBriefly(scroller) {
    scroller.classList.add("cm-nvim-cursor-scroll");
    if (this.hideTimer) this.clearTimer(this.hideTimer);
    this.hideTimer = this.setTimer(() => {
      scroller.classList.remove("cm-nvim-cursor-scroll");
      this.hideTimer = 0;
    }, 180);
  }

  destroy() {
    this.farJump = null;
    if (this.frame) this.cancelFrame(this.frame);
    if (this.hideTimer) this.clearTimer(this.hideTimer);
    this.frame = 0;
    this.hideTimer = 0;
  }
}
