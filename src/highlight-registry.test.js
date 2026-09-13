import { describe, expect, it } from "vitest";
import { HighlightRegistry, colorLuma, rgbHex } from "./highlight-registry.js";

const document = {
  head: { append: () => {} },
  createElement: () => ({ textContent: "" }),
};

describe("HighlightRegistry", () => {
  it("formats grid highlights with blend and decorations", () => {
    const registry = new HighlightRegistry({ document });
    registry.setGrid(2, {
      foreground: 0x112233,
      background: 0x445566,
      special: 0xff0000,
      blend: 20,
      bold: true,
      undercurl: true,
    });

    expect(registry.gridCss(2)).toBe(
      "color:#112233cc;background:#445566cc;font-weight:700;" +
        "text-decoration-line:underline;text-decoration-style:wavy;" +
        "text-decoration-color:#ff0000;",
    );
  });

  it("orders island rules by priority and keeps stable classes", () => {
    const registry = new HighlightRegistry({ document });
    registry.mergeIslandDefinitions({
      High: { fg: "#ffffff", priority: 20 },
      Low: { fg: "#000000", priority: 10 },
    });

    expect(registry.islandStyleElement.textContent).toBe(
      ".island .cm-h-0{color:#000000}\n.island .cm-h-1{color:#ffffff}\n",
    );
    expect(registry.islandClass("High")).toBe("cm-h-1");
  });

  it("converts colors and retains defaults for missing values", () => {
    const registry = new HighlightRegistry({ document });
    registry.setDefaults({ fg: 0xabcdef, bg: -1, sp: null });
    expect(registry.defaults).toEqual({
      fg: "#abcdef",
      bg: "#ffffff",
      sp: "#d40000",
    });
    expect(rgbHex(0x12)).toBe("#000012");
    expect(colorLuma("#000000")).toBe(0);
  });
});
