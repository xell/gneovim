import { EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createIslandDecorationState } from "./island-decoration-state.js";

function fixture(doc = "a中文b\nsecond") {
  const decorationState = createIslandDecorationState({
    document: { createElement: vi.fn() },
    log: vi.fn(),
  });
  const state = EditorState.create({
    doc,
    extensions: [
      decorationState.islandDecorField,
      decorationState.islandFoldField,
      decorationState.nvimCursorField,
    ],
  });
  return { decorationState, state };
}

function ranges(set) {
  const found = [];
  set.between(0, 100, (from, to) => found.push({ from, to }));
  return found;
}

describe("createIslandDecorationState", () => {
  it("places cursor decorations using Neovim byte columns", () => {
    const { decorationState, state } = fixture();
    const next = state.update({
      effects: decorationState.setNvimCursor.of({
        row: 0,
        col: 4,
        mode: "n",
      }),
    }).state;
    const cursor = next.field(decorationState.nvimCursorField);
    expect(cursor.pos).toEqual({ row: 0, col: 4, mode: "n" });
    expect(ranges(cursor.deco)).toEqual([{ from: 2, to: 3 }]);
  });

  it("maps ordinary decorations through document edits", () => {
    const { decorationState, state } = fixture("abcdef");
    const marked = Decoration.set([
      Decoration.mark({ class: "test" }).range(3, 5),
    ]);
    const withMark = state.update({
      effects: decorationState.setIslandDecor.of(marked),
    }).state;
    const changed = withMark.update({
      changes: { from: 0, insert: "X" },
    }).state;
    expect(ranges(changed.field(decorationState.islandDecorField))).toEqual([
      { from: 4, to: 6 },
    ]);
  });

  it("maps fold endpoints independently and drops collapsed folds", () => {
    const { decorationState, state } = fixture("one\ntwo\nthree");
    const fold = Decoration.set([
      Decoration.replace({}).range(3, 8),
    ]);
    const withFold = state.update({
      effects: decorationState.setIslandFolds.of(fold),
    }).state;
    const mapped = withFold.update({
      changes: { from: 0, insert: "X" },
    }).state;
    expect(ranges(mapped.field(decorationState.islandFoldField))).toEqual([
      { from: 4, to: 9 },
    ]);

    const removed = mapped.update({
      changes: { from: 4, to: 9 },
    }).state;
    expect(removed.field(decorationState.islandFoldField).size).toBe(0);
  });
});
