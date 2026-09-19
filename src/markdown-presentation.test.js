import { EditorState, StateEffect } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { createMarkdownPresentation } from "./markdown-presentation.js";

class FakeNode {
  constructor(tagName, text = "") {
    this.nodeType = tagName === "#text" ? 3 : 1;
    this.tagName = tagName;
    this.childNodes = [];
    this.attributes = {};
    this.style = {};
    this.text = text;
  }

  append(...nodes) {
    this.childNodes.push(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  get textContent() {
    return this.nodeType === 3
      ? this.text
      : this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.childNodes = [new FakeNode("#text", value)];
  }
}

const fakeDocument = {
  createElement: (tagName) => new FakeNode(tagName),
  createTextNode: (text) => new FakeNode("#text", text),
};

function fixture(doc, convertFileSrc = vi.fn((path) => `asset:${path}`)) {
  const effects = {
    setCursor: StateEffect.define(),
    setImageBase: StateEffect.define(),
    setTableConcealGuard: StateEffect.define(),
    setInteractiveHighlights: StateEffect.define(),
    setTableInlineHighlights: StateEffect.define(),
    setInteractiveOverlays: StateEffect.define(),
  };
  const presentation = createMarkdownPresentation({
    document: fakeDocument,
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

function tableWidget(state, presentation) {
  let widget;
  state.field(presentation.markdownTableField).deco.between(
    0,
    state.doc.length,
    (_, __, decoration) => {
      widget = decoration.spec.widget;
    },
  );
  return widget;
}

function findTag(node, tagName) {
  if (node.tagName === tagName) return node;
  for (const child of node.childNodes) {
    const found = findTag(child, tagName);
    if (found) return found;
  }
  return null;
}

function findClass(node, className) {
  if (node.className === className) return node;
  for (const child of node.childNodes) {
    const found = findClass(child, className);
    if (found) return found;
  }
  return null;
}

function visibleText(node) {
  if (node.nodeType === 3) return node.text;
  if (node.className === "cm-markdown-source-shadow") return "";
  return node.childNodes.map(visibleText).join("");
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

  it("renders inline Markdown inside table cells", () => {
    const { presentation, state } = fixture(
      "| H | **bold** and `code` [link](https://example.com) |\n" +
        "| --- | --- |\n" +
        "| A | *em* ~~del~~ |",
    );
    const table = tableWidget(state, presentation).toDOM();

    expect(visibleText(findTag(table, "strong"))).toBe("bold");
    expect(visibleText(findTag(table, "code"))).toBe("code");
    expect(visibleText(findTag(table, "em"))).toBe("em");
    expect(visibleText(findTag(table, "del"))).toBe("del");
    expect(visibleText(findTag(table, "a"))).toBe("link");
    expect(findTag(table, "a").href).toBe("https://example.com");
  });

  it("renders resolvable inline images inside table cells", () => {
    const { effects, presentation, state, convertFileSrc } = fixture(
      "| H | Image |\n| --- | --- |\n| A | ![diagram](./image.png) |",
    );
    const withBase = state.update({
      effects: effects.setImageBase.of("/tmp/note.md"),
    }).state;
    const image = findTag(tableWidget(withBase, presentation).toDOM(), "img");

    expect(image.alt).toBe("diagram");
    expect(image.src).toBe("asset:/tmp/image.png");
    expect(convertFileSrc).toHaveBeenCalledWith("/tmp/image.png");
  });

  it("applies the inline code highlight without mirroring other syntax colors", () => {
    const { effects, presentation, state } = fixture(
      "| H | Value |\n| --- | --- |\n| A | `code` |",
    );
    const colored = state.update({
      effects: effects.setTableInlineHighlights.of([[2, 7, 11, "Special"]]),
    }).state;
    const table = tableWidget(colored, presentation).toDOM();

    expect(findClass(findTag(table, "code"), "hl-Special")).not.toBeNull();
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
