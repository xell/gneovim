import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { CursorScroller } from "./cursor-scroller.js";

function fixture() {
  const frames = new Map();
  const timers = new Map();
  let next = 1;
  const classes = new Set();
  const scroller = {
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
  return { cursorScroller, frames, timers, classes, scroller, view };
}

describe("CursorScroller", () => {
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
