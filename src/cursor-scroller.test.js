import { Text } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorScroller } from "./cursor-scroller.js";

function fixture() {
  const frames = new Map();
  const timers = new Map();
  let next = 1;
  const classes = new Set();
  const listeners = {};
  const scroller = {
    addEventListener: (type, callback) => {
      listeners[type] = callback;
    },
    clientHeight: 100,
    scrollTop: 50,
    getBoundingClientRect: () => ({ top: 100 }),
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  const view = {
    state: { doc: Text.of(["alpha", "a中文b"]) },
    scrollDOM: scroller,
    contentDOM: { style: {} },
    coordsAtPos: vi.fn(() => ({ top: 105, bottom: 115 })),
    // What CodeMirror has drawn; the fixture document is all of it.
    viewport: { from: 0, to: 11 },
    dispatch: vi.fn(),
  };
  const cursorScroller = new CursorScroller({
    view,
    isHidden: () => false,
    cellHeight: () => 10,
    requestFrame: (callback) => {
      const id = next++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    setTimer: (callback) => {
      const id = next++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return { cursorScroller, frames, timers, classes, listeners, scroller, view };
}

describe("CursorScroller", () => {
  afterEach(() => vi.useRealTimers());

  // `G` in a 3375-line note: the target is far outside what CodeMirror has
  // drawn, so only CodeMirror can place it (it draws, measures and re-aims
  // before painting). Measuring it here landed ~300 lines short, and
  // correcting on later frames showed as a shake (2026-10-09).
  it("hands a target outside the drawn region to CodeMirror's scrollIntoView", () => {
    const { cursorScroller, frames, scroller, view } = fixture();
    view.viewport = { from: 0, to: 3 }; // only "alpha" is drawn
    cursorScroller.keepInView({ row: 1, col: 1 }, 2);
    [...frames.values()][0]();

    expect(view.coordsAtPos).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(50);
    expect(view.dispatch).toHaveBeenCalledOnce();
    const effect = view.dispatch.mock.calls[0][0].effects;
    expect(effect.value.range.head).toBe(7);
    expect(effect.value.y).toBe("nearest");
    expect(effect.value.yMargin).toBe(20);
  });

  // Decorations for the new viewport land ~100-250ms after the jump and
  // change line heights; the same request rides along with them.
  it("offers the far jump's request to decorations for a second, unless the reader moved on", () => {
    vi.useFakeTimers();
    const far = () => {
      const setup = fixture();
      setup.view.viewport = { from: 0, to: 3 };
      setup.cursorScroller.keepInView({ row: 1, col: 1 }, 2);
      [...setup.frames.values()][0]();
      return setup;
    };

    const { cursorScroller, view } = far();
    const effect = view.dispatch.mock.calls[0][0].effects;
    expect(cursorScroller.scrollEffectForRelayout()).toBe(effect);
    vi.advanceTimersByTime(1001);
    expect(cursorScroller.scrollEffectForRelayout()).toBeNull();

    const wheeled = far();
    wheeled.listeners.wheel();
    expect(wheeled.cursorScroller.scrollEffectForRelayout()).toBeNull();

    const moved = far();
    moved.cursorScroller.keepInView({ row: 0, col: 0 }, 2);
    expect(moved.cursorScroller.scrollEffectForRelayout()).toBeNull();
  });

  // Rows above the viewport change height as they enter or leave md_decor's
  // range (a fold opening, a link going raw); the top visible line stays put.
  it("anchors the top visible line, unless a cursor scroll or the wheel owns the position", () => {
    vi.useFakeTimers();
    const { cursorScroller, frames, listeners, view } = fixture();
    const snapshot = { snapshot: true };
    view.scrollSnapshot = vi.fn(() => snapshot);
    expect(cursorScroller.anchorEffect()).toBe(snapshot);

    cursorScroller.keepInView({ row: 0, col: 0 }, 2);
    expect(cursorScroller.anchorEffect()).toBeNull(); // follow-scroll pending
    [...frames.values()][0]();
    expect(cursorScroller.anchorEffect()).toBe(snapshot);

    listeners.wheel();
    expect(cursorScroller.anchorEffect()).toBeNull();
    vi.advanceTimersByTime(251);
    expect(cursorScroller.anchorEffect()).toBe(snapshot);
  });

  it("uses measured geometry and pixel scrolloff", () => {
    const { cursorScroller, frames, timers, classes, scroller, view } = fixture();
    cursorScroller.keepInView({ row: 1, col: 1 }, 2);
    [...frames.values()][0]();

    expect(view.coordsAtPos).toHaveBeenCalledWith(7);
    expect(view.contentDOM.style).toEqual({
      paddingBlockStart: "20px",
      paddingBlockEnd: "20px",
    });
    expect(scroller.scrollTop).toBe(35);
    expect(classes.has("cm-nvim-cursor-scroll")).toBe(true);

    [...timers.values()][0]();
    expect(classes.has("cm-nvim-cursor-scroll")).toBe(false);
  });

  it("unconditionally centers the cursor line on center()", () => {
    const { cursorScroller, frames, scroller, view } = fixture();
    cursorScroller.center({ row: 1, col: 1 }, 2);
    [...frames.values()][0]();

    // Same geometry as the scrolloff test (top: 5, bottom: 15, height: 100),
    // but centered regardless of whether the cursor was already in view.
    expect(view.coordsAtPos).toHaveBeenCalledWith(7);
    expect(scroller.scrollTop).toBe(10);
  });

  it("measures a rendered table's own caret, not the whole table", () => {
    const { cursorScroller, frames, scroller, view } = fixture();
    view.contentDOM.querySelector = vi.fn(() => ({
      getBoundingClientRect: () => ({ top: 185, bottom: 195 }),
    }));
    cursorScroller.keepInView({ row: 1, col: 1 }, 2);
    [...frames.values()][0]();

    expect(view.contentDOM.querySelector).toHaveBeenCalledWith(
      ".cm-markdown-table .nvim-cursor",
    );
    expect(view.coordsAtPos).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(65);
  });

  it("leaves a rect taller than the scrolloff band alone once it spans it", () => {
    const { cursorScroller, frames, scroller, view } = fixture();
    view.coordsAtPos.mockReturnValue({ top: 110, bottom: 190 });
    cursorScroller.keepInView({ row: 1, col: 1 }, 2);
    [...frames.values()][0]();
    expect(scroller.scrollTop).toBe(50);
  });

  it("cancels superseded frames and pending timers on destroy", () => {
    const { cursorScroller, frames, timers } = fixture();
    cursorScroller.keepInView({ row: 0, col: 0 }, 2);
    cursorScroller.keepInView({ row: 1, col: 0 }, 2);
    expect(frames.size).toBe(1);
    const [frameId, callback] = [...frames.entries()][0];
    frames.delete(frameId);
    callback();
    expect(timers.size).toBe(1);

    cursorScroller.destroy();
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);
  });
});
