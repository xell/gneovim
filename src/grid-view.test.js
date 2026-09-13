import { describe, expect, it, vi } from "vitest";
import { GridView } from "./grid-view.js";

class FakeNode {
  constructor() {
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this.children = [];
  }

  append(child) {
    this.children.push(child);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  insertBefore(child, anchor) {
    this.children = this.children.filter((item) => item !== child);
    const index = anchor == null ? this.children.length : this.children.indexOf(anchor);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
  }
}

const document = {
  createElement: () => new FakeNode(),
  createDocumentFragment: () => new FakeNode(),
};

describe("GridView", () => {
  it("paints highlight runs and pins wide glyphs to two cells", () => {
    const highlightCss = vi.fn((id) => `hl:${id};`);
    const view = new GridView(2, { document, highlightCss, cellWidth: () => 9 });
    view.resize(4, 1);
    view.line(0, 0, [["a", 1], ["中", 2], ["", 2], ["b", 1]]);

    view.repaint();

    const fragment = view.rowEls[0].children[0];
    expect(fragment.children.map((span) => span.textContent)).toEqual(["a", "中", "b"]);
    expect(fragment.children[1].className).toBe("wide");
    expect(fragment.children[1].style.cssText).toBe("hl:2;width:18px");
  });

  it("reuses row nodes during a full-width scroll", () => {
    const view = new GridView(2, {
      document,
      highlightCss: () => "",
      cellWidth: () => 8,
    });
    view.resize(2, 3);
    view.repaint();
    const originalRows = [...view.rowEls];

    view.scroll({ top: 0, bot: 3, left: 0, right: 2, rows: 1 });

    expect(view.rowEls).toEqual([originalRows[1], originalRows[2], originalRows[0]]);
    expect(view.dirtyRows).toEqual(new Set([2]));
  });
});
