import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { byteLen } from "./text-geometry.js";
import { visualRanges } from "./visual-ranges.js";

describe("visualRanges", () => {
  const doc = Text.of(["alpha", "a中文b", "last line"]);

  it("maps one English character", () => {
    expect(visualRanges(doc, [[0, 2, 3]])).toEqual([{ from: 2, to: 3 }]);
  });

  it("maps one CJK character without selecting adjacent text", () => {
    expect(visualRanges(doc, [[1, 1, 4]])).toEqual([{ from: 7, to: 8 }]);
    expect(visualRanges(doc, [[1, 4, 7]])).toEqual([{ from: 8, to: 9 }]);
  });

  it("maps multiple multibyte characters", () => {
    expect(visualRanges(doc, [[1, 1, 7]])).toEqual([{ from: 7, to: 9 }]);
  });

  it("maps a linewise payload to the complete physical line", () => {
    expect(visualRanges(doc, [[2, 0, byteLen("last line")]])).toEqual([
      { from: 11, to: 20 },
    ]);
  });

  it("excludes ranges hidden by a fold", () => {
    expect(visualRanges(doc, [[0, 0, 1]], () => true)).toEqual([]);
  });
});
