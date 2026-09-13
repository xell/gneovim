import { describe, expect, it, vi } from "vitest";
import {
  GutterController,
  formatGutterNumber,
} from "./gutter-controller.js";

function fixture() {
  const frames = new Map();
  let nextFrame = 1;
  const style = {
    setProperty: vi.fn(),
    removeProperty: vi.fn(),
  };
  const compartment = {
    of: vi.fn((extensions) => ({ initial: extensions })),
    reconfigure: vi.fn((extensions) => ({ reconfigure: extensions })),
  };
  const cursorField = {};
  const view = { dispatch: vi.fn() };
  const controller = new GutterController({
    element: { style },
    compartment,
    cursorField,
    requestFrame: (callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
  });
  controller.attach(view);
  return { compartment, controller, cursorField, frames, style, view };
}

function state(cursorField, row) {
  return {
    field: (field) => field === cursorField ? { pos: { row } } : undefined,
  };
}

describe("formatGutterNumber", () => {
  it("preserves absolute numbering", () => {
    expect(
      formatGutterNumber(
        { number: true, relativenumber: false },
        { row: 4 },
        2,
        10,
      ),
    ).toBe("2");
  });

  it("formats relative and hybrid number columns", () => {
    const relative = { number: false, relativenumber: true };
    expect(formatGutterNumber(relative, { row: 4 }, 5, 10)).toBe("0");
    expect(formatGutterNumber(relative, { row: 4 }, 2, 10)).toBe("3");

    const hybrid = { number: true, relativenumber: true };
    expect(formatGutterNumber(hybrid, { row: 4 }, 5, 10)).toBe("5");
  });
});

describe("GutterController", () => {
  it("reconfigures the gutter and mirrors numberwidth", () => {
    const { compartment, controller, style, view } = fixture();
    expect(controller.extension()).toEqual({ initial: [] });

    controller.set({ number: true, relativenumber: false, numberwidth: 6 });
    expect(style.setProperty).toHaveBeenCalledWith("--gutter-numw", "6");
    expect(compartment.reconfigure).toHaveBeenCalledOnce();
    expect(view.dispatch).toHaveBeenCalledOnce();

    controller.set({ number: false, relativenumber: false });
    expect(style.removeProperty).toHaveBeenCalledWith("--gutter-numw");
  });

  it("coalesces relative-number refreshes and cancels them on destroy", () => {
    const { controller, cursorField, frames, view } = fixture();
    controller.set({ number: false, relativenumber: true });
    view.dispatch.mockClear();

    controller.onUpdate({
      startState: state(cursorField, 1),
      state: state(cursorField, 2),
    });
    controller.onUpdate({
      startState: state(cursorField, 2),
      state: state(cursorField, 3),
    });
    expect(frames.size).toBe(1);

    const [frameId, callback] = [...frames.entries()][0];
    frames.delete(frameId);
    callback();
    expect(view.dispatch).toHaveBeenCalledOnce();

    controller.onUpdate({
      startState: state(cursorField, 3),
      state: state(cursorField, 4),
    });
    expect(frames.size).toBe(1);
    controller.destroy();
    expect(frames.size).toBe(0);
  });
});
