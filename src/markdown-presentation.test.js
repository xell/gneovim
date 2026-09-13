import { EditorState, StateEffect } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { createMarkdownPresentation } from "./markdown-presentation.js";

function fixture(doc, convertFileSrc = vi.fn((path) => `asset:${path}`)) {
  const effects = {
    setCursor: StateEffect.define(),
    setImageBase: StateEffect.define(),
    setTableConcealGuard: StateEffect.define(),
    setTableHighlights: StateEffect.define(),
  };
  const presentation = createMarkdownPresentation({
    document: {},
    textNodeType: 3,
    highlights: { islandClass: (group) => `hl-${group}` },
    convertFileSrc,
    ...effects,
  });
  const state = EditorState.create({
    doc,
    extensions: [
      presentation.markdownImageField,
      presentation.markdownTableField,
    ],
  });
  return { convertFileSrc, effects, presentation, state };
}

function ranges(set) {
  const found = [];
  set.between(0, 10_000, (from, to) => found.push({ from, to }));
  return found;
}

describe("createMarkdownPresentation", () => {
  it("presents standalone images and reveals source on the cursor line", () => {
    const { convertFileSrc, effects, presentation, state } = fixture(
      "![caption](./image.png)",
    );
    const withBase = state.update({
      effects: effects.setImageBase.of("/tmp/note.md"),
    }).state;
    const initial = withBase.field(presentation.markdownImageField);
    expect(ranges(initial.deco)).toEqual([
      { from: 0, to: 23 },
      { from: 23, to: 23 },
    ]);
    expect(convertFileSrc).toHaveBeenCalled();

    const active = withBase.update({
      effects: effects.setCursor.of({ row: 0, col: 0, mode: "n" }),
    }).state;
    expect(
      ranges(active.field(presentation.markdownImageField).deco),
    ).toEqual([{ from: 23, to: 23 }]);
  });

  it("replaces Markdown tables but not tables inside code fences", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { presentation, state } = fixture(
      `${table}\n\n\`\`\`\n${table}\n\`\`\``,
    );
    expect(
      ranges(state.field(presentation.markdownTableField).deco),
    ).toHaveLength(1);
  });

  it("reveals a table when the conceal guard names its cursor line", () => {
    const { effects, presentation, state } = fixture(
      "| A |\n| --- |\n| 1 |",
    );
    const active = state.update({
      effects: [
        effects.setCursor.of({ row: 0, col: 0, mode: "n" }),
        effects.setTableConcealGuard.of(0),
      ],
    }).state;
    expect(
      active.field(presentation.markdownTableField).deco.size,
    ).toBe(0);
  });
});
