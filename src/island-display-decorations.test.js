import { EditorState, StateEffect } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { createIslandDecorationState } from "./island-decoration-state.js";
import { IslandDisplayDecorations } from "./island-display-decorations.js";

function fixture(doc = "# Title\n> quote\nbody") {
  const decorationState = createIslandDecorationState({
    document: { createElement: vi.fn() },
    log: vi.fn(),
  });
  const setTableConcealGuard = StateEffect.define();
  const setInteractiveHighlights = StateEffect.define();
  const setInteractiveOverlays = StateEffect.define();
  let state = EditorState.create({
    doc,
    extensions: [
      decorationState.islandDecorField,
      decorationState.islandFoldField,
      decorationState.nvimCursorField,
    ],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch: vi.fn((spec) => {
      state = state.update(spec).state;
    }),
    focus: vi.fn(),
    hasFocus: false,
  };
  const style = {
    removeProperty: vi.fn(),
    setProperty: vi.fn(),
  };
  const frames = [];
  const keepPositionInView = vi.fn();
  const keepCursorInView = vi.fn();
  const forceRepaint = vi.fn();
  const controller = new IslandDisplayDecorations({
    document: {},
    highlights: { islandClass: (group) => `hl-${group}` },
    view,
    element: { style },
    decorationState,
    setTableConcealGuard,
    setInteractiveHighlights,
    setInteractiveOverlays,
    getCursor: () => ({ row: 0, col: 0 }),
    getMode: () => "n",
    cancelPendingZeroScrolloff: vi.fn(),
    keepPositionInView,
    keepCursorInView,
    requestFrame: (callback) => frames.push(callback),
    forceRepaint,
    log: vi.fn(),
  });
  return {
    controller,
    decorationState,
    forceRepaint,
    frames,
    keepCursorInView,
    keepPositionInView,
    style,
    view,
  };
}

describe("IslandDisplayDecorations", () => {
  it("applies structural, highlight, conceal, visual, and fold ranges", () => {
    const {
      controller,
      decorationState,
      forceRepaint,
      view,
    } = fixture();
    controller.set({
      accent_fg: "#123456",
      visual_hl: "#abcdef",
      guard_row: -1,
      heads: [[0, 0, 1]],
      quotes: [[1, 1]],
      conceal: [[2, 0, 1, "x"]],
      visual: [[2, 1, 3]],
      folds: [[1, 2]],
      hl: {
        runs: [[0, 2, 7, "Title"]],
        codespans: [],
        virt: [],
      },
    });

    expect(
      view.state.field(decorationState.islandDecorField).size,
    ).toBeGreaterThan(0);
    expect(
      view.state.field(decorationState.islandFoldField).size,
    ).toBe(1);
    expect(forceRepaint).toHaveBeenCalledOnce();
  });

  it("applies list depth line classes and bullet/ordinal marker decorations", () => {
    const { controller, decorationState, view } = fixture(
      "- item one\n  - nested a\n1. ordered one",
    );
    controller.set({
      guard_row: -1,
      heads: [],
      quotes: [],
      // Row 2 is an ordered item flush against the left margin (no leading
      // whitespace to hide) -- this used to build a zero-width replace
      // decoration that CodeMirror rejects outright; asserting this doesn't
      // throw is the point of the case.
      lists: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
      hl: { runs: [], codespans: [], virt: [] },
    });

    const decor = view.state.field(decorationState.islandDecorField);
    expect(decor.size).toBeGreaterThan(0);

    const classes = [];
    decor.between(0, view.state.doc.length, (from, to, deco) => {
      const cls = deco.spec?.attributes?.class;
      if (cls) classes.push(cls);
    });
    expect(classes).toEqual(
      expect.arrayContaining([
        "cm-list-depth-0",
        "cm-list-depth-1",
        "cm-list-marker-line",
      ]),
    );
  });

  it("coordinates EasyMotion, table highlights, and incremental search", () => {
    const {
      controller,
      frames,
      keepCursorInView,
      keepPositionInView,
      style,
    } = fixture("alpha");
    controller.set({
      accent_fg: "#123456",
      visual_hl: "#abcdef",
      guard_row: 0,
      incsearch: [0, 3],
      hl: {
        runs: [[0, 0, 1, "EasyMotionTarget"]],
      },
    });
    expect(controller.easyMotionOverlay).toBe(true);
    expect(style.setProperty).toHaveBeenCalledWith(
      "--visual-bg",
      "#abcdef",
    );
    expect(keepPositionInView).toHaveBeenCalledWith({ row: 0, col: 3 });

    controller.set({ hl: { runs: [] }, incsearch: null });
    expect(frames).toHaveLength(1);
    frames[0]();
    expect(keepCursorInView).toHaveBeenCalledOnce();
  });
});
